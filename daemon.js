#!/usr/bin/env node

import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken, signInAnonymously } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from "firebase/firestore";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import readline from "readline";

import { firebaseConfig, PETBOOK_CONFIG, CONFIG_FILE, LOG_FILE, OPENCLAW_HOME, CLIENT_URL, CLAIM_DEVICE_URL, REFRESH_SESSION_URL, DECRYPT_SECRETS_URL } from "./lib/config.js";
import { log } from "./lib/log.js";
import {
  loadAuth, saveAuth, savePetbookConfig, loadPetbookConfig,
  generatePetId, deviceInfo, validatePet, setPetOffline
} from "./lib/auth.js";
import { pushToFirestore, listenFirestore, watchLocal, initRemoteHash, setLoadEnvSecretsCallback, setPushRef, setGetIdTokenCallback, startHeartbeat } from "./lib/sync.js";
import { listenChats } from "./lib/chat.js";
import { installService, uninstallService } from "./lib/service.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── Helpers ──

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function generateRequestId() {
  return crypto.randomBytes(16).toString("base64url");
}

async function restoreSession(refreshToken) {
  const tokenResp = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    }
  );
  if (!tokenResp.ok) throw new Error("refresh token 만료");
  const tokenData = await tokenResp.json();

  const resp = await fetch(REFRESH_SESSION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: tokenData.id_token }),
  });
  if (!resp.ok) throw new Error("세션 복원 실패");
  const { customToken } = await resp.json();

  const cred = await signInWithCustomToken(auth, customToken);
  const saved = loadAuth();
  if (cred.user.refreshToken !== saved.refreshToken) {
    saveAuth({ ...saved, refreshToken: cred.user.refreshToken });
  }
}

// ── 환경변수 & 시크릿 로딩 ──

async function loadEnvAndSecrets(uid, petId) {
  try {
    // 1. 계정 레벨
    const userSnap = await getDoc(doc(db, "users", uid));
    const userData = userSnap.exists() ? userSnap.data() : {};

    // 2. 디바이스 레벨 (pet 메인 doc)
    const petSnap = await getDoc(doc(db, "users", uid, "pets", petId));
    const petData = petSnap.exists() ? petSnap.data() : {};

    // 환경변수 머지 (계정 < 디바이스)
    const envVars = {
      ...(userData.envVars || {}),
      ...(petData.deviceEnvVars || {}),
    };

    // 시크릿 머지 (계정 < 디바이스)
    const allSecrets = {
      ...(userData.secrets || {}),
      ...(petData.deviceSecrets || {}),
    };

    // 시크릿 복호화
    if (Object.keys(allSecrets).length > 0) {
      try {
        const idToken = await auth.currentUser.getIdToken();
        const resp = await fetch(DECRYPT_SECRETS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, secrets: allSecrets }),
        });
        if (resp.ok) {
          const { values } = await resp.json();
          for (const [key, value] of Object.entries(values)) {
            if (value !== null) envVars[key] = String(value);
          }
        } else {
          log("⚠️ 시크릿 복호화 실패");
        }
      } catch (e) {
        log(`⚠️ 시크릿 복호화 에러: ${e.message}`);
      }
    }

    // .env 파일에 쓰기 → openclaw gateway가 읽음
    if (Object.keys(envVars).length > 0) {
      const envPath = path.join(OPENCLAW_HOME, ".env");
      const lines = Object.entries(envVars)
        .filter(([k, v]) => k && v !== undefined)
        .map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
      fs.chmodSync(envPath, 0o600);
      log(`🔑 .env 업데이트 (${lines.length}개 변수)`);
    }
  } catch (e) {
    log(`⚠️ 환경변수 로드 실패: ${e.message}`);
  }
}

// ── Commands ──

async function cmdLogin() {
  const codeArg = process.argv[3];
  const petId = generatePetId();
  const info = deviceInfo();

  // 코드가 직접 주어진 경우 → 바로 등록
  if (codeArg) {
    return doClaimDevice(codeArg, petId, info);
  }

  // 1. 익명 로그인
  await signInAnonymously(auth);
  const requestId = generateRequestId();

  // 2. loginRequests 문서 생성
  await setDoc(doc(db, "loginRequests", requestId), {
    petId,
    ...info,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  // 3. URL 표시
  const url = `${CLIENT_URL}/auth/device?requestId=${requestId}`;

  console.log("");
  console.log("  \x1b[1m🐾 OhMyPetBook 기기 등록\x1b[0m");
  console.log("");
  console.log("  아래 URL을 브라우저에서 열어주세요:");
  console.log(`  \x1b[4m\x1b[36m${url}\x1b[0m`);
  console.log("");

  // 4. Firestore 구독 + 수동 입력 동시 대기
  const result = await new Promise((resolve, reject) => {
    let settled = false;

    // Firestore 실시간 구독
    const unsub = onSnapshot(doc(db, "loginRequests", requestId), (snap) => {
      const data = snap.data();
      if (data?.status === "approved" && data?.customToken && !settled) {
        settled = true;
        unsub();
        resolve({ type: "auto", customToken: data.customToken, uid: data.uid, email: data.email });
      }
    });

    // 수동 코드 입력 (폴백)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("  브라우저에서 승인하면 자동으로 진행됩니다.");
    console.log("  또는 등록 코드를 직접 입력하세요:");
    console.log("");
    rl.question("  등록 코드 (자동 대기 중...): ", (code) => {
      rl.close();
      if (!settled && code.trim()) {
        settled = true;
        unsub();
        resolve({ type: "manual", code: code.trim() });
      }
    });

    // 10분 타임아웃
    setTimeout(() => {
      if (!settled) {
        settled = true;
        unsub();
        reject(new Error("등록 시간 초과 (10분)"));
      }
    }, 10 * 60 * 1000);
  });

  if (result.type === "auto") {
    // 자동 승인 — customToken으로 바로 로그인
    console.log("\n  ✅ 브라우저에서 승인됨!");
    const cred = await signInWithCustomToken(auth, result.customToken);
    const petName = info.hostname || os.hostname();

    saveAuth({
      uid: result.uid,
      email: result.email,
      petId,
      petName,
      refreshToken: cred.user.refreshToken,
      savedAt: new Date().toISOString()
    });

    printSuccess(result.email, petName, petId);
    process.exit(0);
  } else {
    // 수동 코드 입력
    await doClaimDevice(result.code, petId, info);
  }
}

async function doClaimDevice(code, petId, info) {
  console.log("  🔐 등록 중...");

  const resp = await fetch(CLAIM_DEVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, petId, deviceInfo: info }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`  ❌ ${err.error || `등록 실패 (${resp.status})`}`);
    process.exit(1);
  }

  const { customToken, uid, email } = await resp.json();
  const cred = await signInWithCustomToken(auth, customToken);
  const petName = info.hostname || os.hostname();

  saveAuth({
    uid,
    email,
    petId,
    petName,
    refreshToken: cred.user.refreshToken,
    savedAt: new Date().toISOString()
  });

  printSuccess(email, petName, petId);
  process.exit(0);
}

function printSuccess(email, petName, petId) {
  console.log(`  ✓ 계정: \x1b[1m${email}\x1b[0m`);
  console.log(`  ✓ Pet: \x1b[1m${petName}\x1b[0m (\x1b[2m${petId.slice(0, 16)}...\x1b[0m)`);
  console.log("");
  console.log("  다음 단계:");
  console.log("    \x1b[1mohmypetbook install\x1b[0m  — 서비스 등록 (자동 시작)");
  console.log("    \x1b[1mohmypetbook run\x1b[0m      — 포그라운드 실행");
  console.log("");
}

async function cmdRun() {
  const saved = loadAuth();
  if (!saved?.refreshToken) {
    log("❌ 인증 정보 없음. `ohmypetbook login` 먼저 실행하세요.");
    process.exit(1);
  }

  log(`🐾 ${saved.petName || "pet"} 시작 (${saved.email})`);

  try {
    await restoreSession(saved.refreshToken);
  } catch (e) {
    log(`❌ 인증 실패: ${e.message}. 재등록 필요: ohmypetbook login`);
    process.exit(1);
  }

  const uid = auth.currentUser.uid;
  const petId = saved.petId;
  log(`✓ 인증 완료: ${auth.currentUser.email}`);

  if (!(await validatePet(db, uid, petId))) {
    process.exit(1);
  }

  await loadEnvAndSecrets(uid, petId);
  setLoadEnvSecretsCallback(() => loadEnvAndSecrets(uid, petId));
  setPushRef(() => pushToFirestore(db, uid, petId));
  setGetIdTokenCallback(() => auth.currentUser.getIdToken());

  initRemoteHash();
  await pushToFirestore(db, uid, petId);
  listenFirestore(db, uid, petId);
  log("👂 Firestore 실시간 리스너 시작");

  watchLocal(db, uid, petId);
  log("👀 로컬 파일 감시 시작");

  startHeartbeat(db, uid, petId);
  log("💓 Heartbeat 시작 (60초)");

  listenChats(db, uid, petId);

  log("🚀 데몬 실행 중...");

  const shutdown = async () => {
    log("종료 중...");
    await setPetOffline(db, uid, petId);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function cmdStatus() {
  const saved = loadAuth();
  console.log("\n  \x1b[1m🐾 OhMyPetBook Status\x1b[0m\n");
  if (saved) {
    const expired = saved.expiresAt && new Date(saved.expiresAt) < new Date();
    console.log(`  Pet:   ${saved.petName || "N/A"} (${saved.petId?.slice(0, 16) || "N/A"}...)`);
    console.log(`  계정:  ${saved.email}`);
    console.log(`  만료:  ${saved.expiresAt ? new Date(saved.expiresAt).toLocaleDateString("ko-KR") : "N/A"} ${expired ? "\x1b[31m(만료됨)\x1b[0m" : "\x1b[32m(유효)\x1b[0m"}`);
    console.log(`  경로:  ${OPENCLAW_HOME}`);
    console.log(`  설정:  ${CONFIG_FILE}`);
  } else {
    console.log("  \x1b[33m등록된 pet 없음. ohmypetbook login 실행하세요.\x1b[0m");
  }

  const platform = os.platform();
  if (platform === "darwin") {
    try {
      execSync("launchctl list | grep ohmypetbook", { stdio: "pipe" });
      console.log("  서비스: \x1b[32m실행 중\x1b[0m");
    } catch { console.log("  서비스: \x1b[33m미등록\x1b[0m"); }
  } else if (platform === "linux") {
    try {
      const s = execSync("systemctl --user is-active petbook-daemon", { encoding: "utf-8" }).trim();
      console.log(`  서비스: \x1b[32m${s}\x1b[0m`);
    } catch { console.log("  서비스: \x1b[33m미등록\x1b[0m"); }
  }
  console.log(`  로그:  ${LOG_FILE}\n`);
}

// ── Main ──

const [,, command] = process.argv;

switch (command) {
  case "login":     await cmdLogin(); break;
  case "run":       await cmdRun(); break;
  case "install": {
    if (!loadAuth()?.refreshToken) { console.error("❌ 먼저 등록: ohmypetbook login"); process.exit(1); }
    installService();
    console.log("\n  ✓ 서비스 등록 완료. 데몬이 백그라운드에서 실행됩니다.\n");
    break;
  }
  case "uninstall":
    uninstallService();
    console.log("  ✓ 서비스 제거 완료\n");
    break;
  case "status":
    cmdStatus();
    break;
  case "config": {
    const [,,, key, ...rest] = process.argv;
    if (key === "openclawPath" && rest.length) {
      savePetbookConfig({ openclawPath: rest.join(" ") });
      console.log(`  ✓ openclawPath = ${rest.join(" ")}`);
    } else {
      const cfg = loadPetbookConfig();
      console.log("\n  \x1b[1m~/.ohmypetbook/ohmypetbook.json\x1b[0m\n");
      console.log(`  openclawPath: ${cfg.openclawPath || "~/.openclaw (기본값)"}`);
      console.log(`  pet:          ${cfg.auth?.petName || "없음"} (${cfg.auth?.petId?.slice(0, 16) || "N/A"})`);
      console.log(`  계정:         ${cfg.auth?.email || "없음"}`);
      console.log("");
      console.log("  변경: ohmypetbook config openclawPath /path/to/.openclaw");
      console.log("");
    }
    break;
  }
  case "update": {
    console.log("📦 업데이트 확인 중...");
    try {
      const current = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8")).version;
      const latest = execSync("npm view ohmypetbook version", { encoding: "utf-8", timeout: 15000 }).trim();
      if (current === latest) {
        console.log(`✅ 이미 최신 버전입니다 (v${current})`);
      } else {
        console.log(`🔄 v${current} → v${latest} 업데이트 중...`);
        execSync("npm update -g ohmypetbook", { encoding: "utf-8", timeout: 60000, stdio: "inherit" });
        console.log(`✅ 업데이트 완료! v${latest}`);
        console.log("   서비스 재시작: launchctl kickstart -k gui/$(id -u)/com.ohmypetbook.daemon");
      }
    } catch (e) {
      console.error(`❌ 업데이트 실패: ${e.message}`);
    }
    break;
  }
  case "logout": {
    const saved = loadAuth();
    if (saved?.petId && saved?.uid && saved?.refreshToken) {
      try {
        await restoreSession(saved.refreshToken);
        await setPetOffline(db, saved.uid, saved.petId);
      } catch {}
    }
    uninstallService();
    if (fs.existsSync(PETBOOK_CONFIG)) fs.unlinkSync(PETBOOK_CONFIG);
    console.log("\n  ✓ 로그아웃 + 서비스 제거 완료\n");
    break;
  }
  default:
    console.log(`
  \x1b[1m🐾 ohmypetbook\x1b[0m — OpenClaw 디바이스 동기화 데몬

  각 디바이스 = 1 pet. Firestore와 실시간 동기화.

  \x1b[1mCommands:\x1b[0m
    ohmypetbook login [코드]  기기 등록 (URL + 자동승인 / 코드 수동입력)
    ohmypetbook install       서비스 등록 (부팅 시 자동 시작)
    ohmypetbook uninstall     서비스 제거
    ohmypetbook run           포그라운드 실행
    ohmypetbook status        상태 확인
    ohmypetbook config        설정 확인/변경 (openclawPath 등)
    ohmypetbook update        최신 버전으로 업데이트
    ohmypetbook logout        pet 해제 + 서비스 제거
    `);
}
