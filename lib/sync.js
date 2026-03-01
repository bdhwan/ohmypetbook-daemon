import { doc, setDoc, updateDoc, getDoc, onSnapshot, collection, query, where } from "firebase/firestore";
import { watch } from "chokidar";
import fs from "fs";
import path from "path";
import os from "os";
import { CONFIG_FILE, CONFIG_DIR, OPENCLAW_HOME, WORKSPACE_DIR, ENCRYPT_SECRET_URL, DECRYPT_SECRETS_URL, DAEMON_VERSION, hasOpenclaw, refreshOpenclawDetection } from "./config.js";
import { deviceInfo } from "./auth.js";
import { ensureDir, log } from "./log.js";
import { restartGateway, setOnGatewayRestartCallback } from "./gateway.js";
import { findBin, envForBin } from "./find-bin.js";
import { execSync as _execSync } from "child_process";

// ── Firestore 경로 ──
// users/{uid}/pets/{petId}                   ← 모든 데이터 (프로필, 시스템, config, env)
// users/{uid}/pets/{petId}/runtime/heartbeat  ← lastSeen, status (60초마다, 분리)
// users/{uid}/pets/{petId}/commands/{id}      ← 커맨드

const petDoc = (db, uid, petId) => doc(db, "users", uid, "pets", petId);
const heartbeatDoc = (db, uid, petId) => doc(db, "users", uid, "pets", petId, "runtime", "heartbeat");

// ── .env 파일 관리 ──

const ENV_FILE = path.join(OPENCLAW_HOME, ".env");

let loadEnvSecretsCallback = null;
export function setLoadEnvSecretsCallback(fn) { loadEnvSecretsCallback = fn; }

let getIdTokenCallback = null;
export function setGetIdTokenCallback(fn) { getIdTokenCallback = fn; }

// ── config 암호화/복호화 ──

async function encryptConfig(configObj) {
  if (!getIdTokenCallback) return null;
  try {
    const idToken = await getIdTokenCallback();
    const configStr = JSON.stringify(configObj);
    const resp = await fetch(ENCRYPT_SECRET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, value: configStr }),
    });
    if (!resp.ok) throw new Error(`encrypt failed: ${resp.status}`);
    const { encData } = await resp.json();
    return encData;
  } catch (e) {
    log(`⚠️ config 암호화 실패: ${e.message}`);
    return null;
  }
}

async function decryptConfig(encData) {
  if (!getIdTokenCallback || !encData) return null;
  try {
    const idToken = await getIdTokenCallback();
    const resp = await fetch(DECRYPT_SECRETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, secrets: { _config: encData } }),
    });
    if (!resp.ok) throw new Error(`decrypt failed: ${resp.status}`);
    const { values } = await resp.json();
    return values._config ? JSON.parse(values._config) : null;
  } catch (e) {
    log(`⚠️ config 복호화 실패: ${e.message}`);
    return null;
  }
}

// ── 로컬 파일 읽기/쓰기 ──

function readEnvFile() {
  const result = {};
  try {
    if (!fs.existsSync(ENV_FILE)) return result;
    const lines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // 따옴표 제거
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) result[key] = value;
    }
  } catch {}
  return result;
}

let skipLocalWatch = false;
let skipRemoteWatch = false;
let lastRemoteHash = "";

export function initRemoteHash() {
  lastRemoteHash = JSON.stringify(readConfig());
}

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch { return {}; }
}

function writeConfig(data) {
  skipLocalWatch = true;
  ensureDir(OPENCLAW_HOME);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
  log("✓ openclaw.json 업데이트");
  setTimeout(() => { skipLocalWatch = false; }, 500);
}

function readOpenclawDir() {
  ensureDir(CONFIG_DIR);
  const result = {};
  for (const f of fs.readdirSync(CONFIG_DIR)) {
    const fp = path.join(CONFIG_DIR, f);
    if (fs.statSync(fp).isFile()) result[f] = fs.readFileSync(fp, "utf-8");
  }
  return result;
}

function writeOpenclawDir(files) {
  ensureDir(CONFIG_DIR);
  skipLocalWatch = true;
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(CONFIG_DIR, name), content, "utf-8");
  }
  log(`✓ openclaw/ 업데이트 (${Object.keys(files).length} files)`);
  setTimeout(() => { skipLocalWatch = false; }, 500);
}

const WORKSPACE_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md", "HEARTBEAT.md"];

function readWorkspace() {
  const result = {};
  for (const name of WORKSPACE_FILES) {
    const fp = path.join(WORKSPACE_DIR, name);
    try { result[name] = fs.readFileSync(fp, "utf-8"); } catch {}
  }
  return result;
}

function writeWorkspace(files) {
  if (!files) return;
  skipLocalWatch = true;
  ensureDir(WORKSPACE_DIR);
  for (const [name, content] of Object.entries(files)) {
    if (WORKSPACE_FILES.includes(name) && typeof content === "string") {
      fs.writeFileSync(path.join(WORKSPACE_DIR, name), content, "utf-8");
    }
  }
  log(`✓ workspace 업데이트`);
  setTimeout(() => { skipLocalWatch = false; }, 500);
}

function readSkillsInfo() {
  const config = readConfig();
  const entries = config?.skills?.entries || {};
  const skills = {};
  for (const [name, data] of Object.entries(entries)) {
    skills[name] = typeof data === "object" ? { ...data } : { enabled: true };
    for (const key of Object.keys(skills[name])) {
      if (/key|token|secret|password/i.test(key)) {
        skills[name][key] = "***";
      }
    }
  }
  return skills;
}

// ── OpenClaw 버전 감지 ──

function getOpenclawVersion() {
  const bin = findBin('openclaw');
  if (!bin) return '';
  try {
    const env = envForBin(bin);
    return _execSync(`${bin} --version`, { encoding: 'utf-8', timeout: 60000, env }).trim();
  } catch {}
  return '';
}

// ── Firestore Push (메인 doc에 전부, heartbeat만 분리) ──

export async function pushToFirestore(db, uid, petId) {
  if (skipRemoteWatch) return;
  skipRemoteWatch = true;
  try {
    const now = new Date().toISOString();

    const info = deviceInfo();
    const data = {
      ...info,
      openclawPath: hasOpenclaw() ? OPENCLAW_HOME : null,
      hasOpenclaw: hasOpenclaw(),
      daemonVersion: DAEMON_VERSION,
      openclawVersion: getOpenclawVersion(),
      uptime: Math.floor(process.uptime()),
      memTotal: Math.round(os.totalmem() / 1024 / 1024),
      memFree: Math.round(os.freemem() / 1024 / 1024),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || '',
      osRelease: os.release(),
      updatedAt: now,
    };


    // openclaw 설치된 경우에만 관련 데이터 동기화
    if (hasOpenclaw()) {
      const rawConfig = readConfig();
      const encryptedConfig = await encryptConfig(rawConfig);

      data.openclawFiles = readOpenclawDir();
      data.workspace = readWorkspace();
      data.skills = readSkillsInfo();

      if (encryptedConfig) {
        data.encryptedConfig = encryptedConfig;
        data.config = null;
      } else {
        data.config = rawConfig;
      }
    }

    await setDoc(petDoc(db, uid, petId), data, { merge: true });

    // heartbeat은 별도 doc
    await setDoc(heartbeatDoc(db, uid, petId), {
      lastSeen: now,
      status: "online",
    }, { merge: true });

    log("⬆ 로컬 → Firestore 동기화");
  } catch (e) {
    log(`❌ Push 실패: ${e.message}`);
  }
  setTimeout(() => { skipRemoteWatch = false; }, 1000);
}

// ── 커맨드 핸들러 ──

let _pushRef = null;
export function setPushRef(fn) { _pushRef = fn; }

const COMMAND_HANDLERS = {
  check_openclaw_update: async () => {
    const current = getOpenclawVersion();
    let latest = '';
    try {
      const resp = await fetch('https://registry.npmjs.org/openclaw/latest');
      if (resp.ok) {
        const data = await resp.json();
        latest = data.version || '';
      }
    } catch {}
    const updateAvailable = latest && current && latest !== current;
    return { message: updateAvailable ? `업데이트 가능: ${current} → ${latest}` : `최신 버전입니다 (${current})`, current, latest, updateAvailable };
  },
  update_openclaw: async (params, { db, uid, petId }) => {
    const oldVersion = getOpenclawVersion();
    try {
      const npmBin = findBin('npm');
      if (!npmBin) throw new Error('npm을 찾을 수 없습니다');
      const env = envForBin(npmBin);
      _execSync(`${npmBin} install -g openclaw@latest`, { encoding: 'utf-8', timeout: 120000, env });
    } catch (e) {
      return { message: `업데이트 실패: ${e.message}`, oldVersion, newVersion: oldVersion, updated: false };
    }
    const newVersion = getOpenclawVersion();
    const updated = oldVersion !== newVersion;
    await setDoc(petDoc(db, uid, petId), { openclawVersion: newVersion }, { merge: true });
    if (updated) {
      log(`✓ OpenClaw 업데이트: ${oldVersion} → ${newVersion}`);
      restartGateway();
    }
    return { message: updated ? `업데이트 완료: ${oldVersion} → ${newVersion}` : `최신 버전입니다 (${oldVersion})`, oldVersion, newVersion, updated };
  },
  restart_gateway: async () => {
    restartGateway();
    return { message: "게이트웨이 재시작 완료" };
  },
  update_daemon: async (params, { db, uid, petId }) => {
    const { execSync } = await import('child_process');
    const oldVersion = DAEMON_VERSION;
    let method = 'unknown';
    let newVersion = oldVersion;
    const errors = [];

    try {
      const npmBin = findBin('npm');
      if (npmBin) {
        const env = envForBin(npmBin);
        const npmRoot = _execSync(`${npmBin} root -g`, { encoding: 'utf-8', timeout: 10000, env }).trim();
        const npmPkgPath = path.join(npmRoot, 'ohmypetbook', 'package.json');
        if (fs.existsSync(npmPkgPath)) {
          method = 'npm';
          log('📦 npm install -g ohmypetbook@latest 실행 중...');
          const output = _execSync(`${npmBin} install -g ohmypetbook@latest 2>&1`, { encoding: 'utf-8', timeout: 120000, env });
          log(output);
          newVersion = JSON.parse(fs.readFileSync(npmPkgPath, 'utf-8')).version;
        }
      }
    } catch (e) {
      errors.push(`npm: ${e.message}`);
      log(`⚠️ npm update 실패: ${e.message}`);
    }

    if (method === 'unknown') {
      try {
        const daemonDir = new URL('..', import.meta.url).pathname;
        if (fs.existsSync(path.join(daemonDir, '.git'))) {
          method = 'git';
          log('📦 git pull 실행 중...');
          _execSync('git pull', { cwd: daemonDir, encoding: 'utf-8', timeout: 30000 });
          newVersion = JSON.parse(fs.readFileSync(path.join(daemonDir, 'package.json'), 'utf-8')).version;
        }
      } catch (e) {
        errors.push(`git: ${e.message}`);
        log(`⚠️ git pull 실패: ${e.message}`);
      }
    }

    await setDoc(petDoc(db, uid, petId), { daemonVersion: newVersion }, { merge: true });

    const updated = oldVersion !== newVersion;
    if (updated) {
      log(`✓ 데몬 업데이트: ${oldVersion} → ${newVersion}`);
      setTimeout(() => {
        try {
          const platform = os.platform();
          if (platform === 'darwin') {
            _execSync('launchctl kickstart -k gui/$(id -u)/com.ohmypetbook.daemon', { timeout: 10000 });
          } else if (platform === 'linux') {
            _execSync('systemctl --user restart ohmypetbook-daemon', { timeout: 10000 });
          }
        } catch (e) {
          log(`⚠️ 서비스 재시작 실패: ${e.message}. 수동 재시작 필요.`);
        }
      }, 1000);
    }

    let message;
    if (updated) {
      message = `업데이트 완료: ${oldVersion} → ${newVersion} (${method})`;
    } else if (errors.length > 0) {
      message = `업데이트 실패: ${errors.join('; ')}`;
    } else {
      message = `최신 버전입니다 (${oldVersion})`;
    }

    return { message, oldVersion, newVersion, method, updated, errors };
  },
  detect_openclaw: async (params, { db, uid, petId }) => {
    const { hasOpenclaw: hasIt } = refreshOpenclawDetection();
    await setDoc(petDoc(db, uid, petId), {
      hasOpenclaw: hasIt,
      openclawPath: hasIt ? OPENCLAW_HOME : null,
    }, { merge: true });
    if (hasIt && _pushRef) await _pushRef();
    return { message: hasIt ? `OpenClaw 감지됨: ${OPENCLAW_HOME}` : "OpenClaw 미설치", hasOpenclaw: hasIt };
  },
  refresh_info: async (params, { db, uid, petId }) => {
    refreshOpenclawDetection(); // 캐시 갱신
    const info = deviceInfo();
    const uptime = Math.floor(process.uptime());
    const memTotal = Math.round(os.totalmem() / 1024 / 1024);
    const memFree = Math.round(os.freemem() / 1024 / 1024);

    const openclawVersion = getOpenclawVersion();

    const data = {
      ...info, uptime, memTotal, memFree,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || '',
      osRelease: os.release(),
      openclawVersion,
      daemonVersion: DAEMON_VERSION,
      hasOpenclaw: hasOpenclaw(),
      openclawPath: hasOpenclaw() ? OPENCLAW_HOME : null,
      lastSeen: new Date().toISOString(),
      status: "online",
    };

    // .env 키값 암호화 → Firestore에 없는 것만 추가
    let envSynced = 0;
    if (hasOpenclaw() && getIdTokenCallback) {
      try {
        const envKeys = readEnvFile();
        if (Object.keys(envKeys).length > 0) {
          // 현재 Firestore에 저장된 암호화된 env 가져오기
          const petSnap = await getDoc(petDoc(db, uid, petId));
          const existing = petSnap.exists() ? (petSnap.data().deviceSecrets || {}) : {};

          const newSecrets = {};
          for (const [key, value] of Object.entries(envKeys)) {
            if (!existing[key] && value) {
              // 암호화
              try {
                const idToken = await getIdTokenCallback();
                const resp = await fetch(ENCRYPT_SECRET_URL, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ idToken, value }),
                });
                if (resp.ok) {
                  const { encData } = await resp.json();
                  newSecrets[key] = { encData, description: '' };
                  envSynced++;
                }
              } catch (e) {
                log(`⚠️ env 암호화 실패 (${key}): ${e.message}`);
              }
            }
          }

          if (Object.keys(newSecrets).length > 0) {
            data.deviceSecrets = { ...existing, ...newSecrets };
            log(`🔐 .env 시크릿 ${envSynced}개 암호화 저장`);
          }
        }
      } catch (e) {
        log(`⚠️ .env 동기화 실패: ${e.message}`);
      }
    }

    await setDoc(petDoc(db, uid, petId), data, { merge: true });
    if (_pushRef) await _pushRef();
    return { message: `디바이스 정보 업데이트 완료${envSynced ? ` (시크릿 ${envSynced}개 동기화)` : ''}`, ...data };
  },
};

// ── 커맨드 리스너 ──

function listenCommands(db, uid, petId) {
  const commandsCol = collection(db, "users", uid, "pets", petId, "commands");
  const q = query(commandsCol, where("status", "==", "pending"));

  return onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      const cmdDoc = change.doc;
      const cmd = cmdDoc.data();

      log(`📨 커맨드 수신: ${cmd.action}`);

      const handler = COMMAND_HANDLERS[cmd.action];
      if (!handler) {
        await updateDoc(cmdDoc.ref, {
          status: "error",
          error: `알 수 없는 커맨드: ${cmd.action}`,
          completedAt: new Date().toISOString()
        });
        continue;
      }

      try {
        await updateDoc(cmdDoc.ref, { status: "running" });
        const result = await handler(cmd.params || {}, { db, uid, petId });
        await updateDoc(cmdDoc.ref, {
          status: "done",
          result: result || {},
          completedAt: new Date().toISOString()
        });
        log(`✓ 커맨드 완료: ${cmd.action}`);
      } catch (e) {
        await updateDoc(cmdDoc.ref, {
          status: "error",
          error: e.message,
          completedAt: new Date().toISOString()
        });
        log(`❌ 커맨드 실패: ${cmd.action} — ${e.message}`);
      }
    }
  });
}

// ── Firestore 리스너 (메인 doc + 커맨드) ──

export function listenFirestore(db, uid, petId) {
  // 게이트웨이 재시작 시 Firestore에 기록
  setOnGatewayRestartCallback(async (restartTime) => {
    try {
      await setDoc(petDoc(db, uid, petId), { lastGatewayRestart: restartTime }, { merge: true });
      log("✓ 게이트웨이 재시작 시간 기록");
    } catch (e) { log(`⚠️ 재시작 시간 기록 실패: ${e.message}`); }
  });

  // 메인 doc — config, env, revoked 감시
  const unsubPet = onSnapshot(petDoc(db, uid, petId), async (snap) => {
    if (!snap.exists() || skipRemoteWatch) return;
    const data = snap.data();

    // 폐기 감시
    if (data.revoked) {
      log("🚫 이 pet이 폐기되었습니다. 데몬 종료.");
      process.exit(0);
    }

    // config 복호화
    let config = data.config;
    if (data.encryptedConfig) {
      const decrypted = await decryptConfig(data.encryptedConfig);
      if (decrypted) {
        config = decrypted;
        log("🔓 config 복호화 완료");
      } else {
        log("⚠️ config 복호화 실패, 로컬 변경 건너뜀");
      }
    }

    // config 변경 감지
    const hash = JSON.stringify(config || {});
    const configChanged = hash !== lastRemoteHash && lastRemoteHash !== "";
    lastRemoteHash = hash;

    if (config) writeConfig(config);
    if (data.openclawFiles) writeOpenclawDir(data.openclawFiles);
    if (data.workspace) writeWorkspace(data.workspace);
    log("⬇ Firestore → 로컬 동기화");

    // 환경변수/시크릿 변경 시
    const hasEnvChange = data.deviceEnvVars || data.deviceSecrets;
    if (hasEnvChange && loadEnvSecretsCallback) {
      loadEnvSecretsCallback().then(() => restartGateway()).catch((e) => {
        log(`⚠️ 환경변수 로드 실패: ${e.message}`);
        restartGateway();
      });
    } else if (configChanged) {
      restartGateway();
    }
  }, (error) => {
    log(`❌ Firestore 리스너 에러: ${error.message}`);
  });

  // 커맨드 리스너
  const unsubCmd = listenCommands(db, uid, petId);

  return () => { unsubPet(); unsubCmd(); };
}

// ── 로컬 파일 감시 ──

export function watchLocal(db, uid, petId) {
  const targets = [CONFIG_FILE];
  if (fs.existsSync(CONFIG_DIR)) targets.push(CONFIG_DIR);
  if (fs.existsSync(WORKSPACE_DIR)) {
    for (const f of WORKSPACE_FILES) {
      const fp = path.join(WORKSPACE_DIR, f);
      if (fs.existsSync(fp)) targets.push(fp);
    }
  }
  const watcher = watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 }
  });
  const handler = () => {
    if (skipLocalWatch) return;
    log("📝 로컬 변경 감지");
    pushToFirestore(db, uid, petId);
  };
  watcher.on("change", handler).on("add", handler);
  return watcher;
}

// ── Heartbeat (60초마다 runtime/heartbeat만 업데이트) ──

const HEARTBEAT_INTERVAL = 60 * 1000;
const MAIN_DOC_INTERVAL = 5 * 60 * 1000; // 메인 doc은 5분마다 (대시보드 리스트용)

export function startHeartbeat(db, uid, petId) {
  let elapsed = 0;

  const tick = async () => {
    try {
      const now = new Date().toISOString();

      // runtime/heartbeat — 매 60초 (메인 doc 리스너 트리거 안 됨)
      await setDoc(heartbeatDoc(db, uid, petId), {
        lastSeen: now,
        status: "online",
      }, { merge: true });

      // 메인 doc — 5분마다 (대시보드 온라인 표시용 + openclaw 재감지)
      elapsed += HEARTBEAT_INTERVAL;
      if (elapsed >= MAIN_DOC_INTERVAL) {
        elapsed = 0;

        // openclaw 설치 재감지
        const detection = refreshOpenclawDetection();
        if (detection.changed) {
          log(`🔍 OpenClaw ${detection.hasOpenclaw ? '감지됨' : '감지 해제'}`);
        }

        skipRemoteWatch = true;
        await setDoc(petDoc(db, uid, petId), {
          lastSeen: now,
          status: "online",
          hasOpenclaw: detection.hasOpenclaw,
          openclawPath: detection.hasOpenclaw ? OPENCLAW_HOME : null,
        }, { merge: true });
        setTimeout(() => { skipRemoteWatch = false; }, 1000);
      }
    } catch {}
  };
  const interval = setInterval(tick, HEARTBEAT_INTERVAL);
  return () => clearInterval(interval);
}
