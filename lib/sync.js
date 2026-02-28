import { doc, setDoc, updateDoc, onSnapshot, collection, query, where, onSnapshot as onSnapshotCol } from "firebase/firestore";
import { watch } from "chokidar";
import fs from "fs";
import path from "path";
import os from "os";
import { CONFIG_FILE, CONFIG_DIR, OPENCLAW_HOME, WORKSPACE_DIR, ENCRYPT_SECRET_URL, DECRYPT_SECRETS_URL, HAS_OPENCLAW } from "./config.js";
import { deviceInfo } from "./auth.js";
import { ensureDir, log } from "./log.js";
import { restartGateway } from "./gateway.js";

// ── .env 파일 관리 ──

const ENV_FILE = path.join(OPENCLAW_HOME, ".env");

// 환경변수+시크릿 로드 콜백 (daemon.js에서 설정, 시크릿 복호화 포함)
let loadEnvSecretsCallback = null;
export function setLoadEnvSecretsCallback(fn) { loadEnvSecretsCallback = fn; }

// idToken 콜백 (daemon.js에서 설정)
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

// ── 워크스페이스 파일 읽기/쓰기 ──

const WORKSPACE_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md", "HEARTBEAT.md"];

function readWorkspace() {
  const result = {};
  for (const name of WORKSPACE_FILES) {
    const fp = path.join(WORKSPACE_DIR, name);
    try { result[name] = fs.readFileSync(fp, "utf-8"); } catch {}
  }
  // memory/ 제외 (용량 이슈)
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

// ── skills 정보 읽기 ──

function readSkillsInfo() {
  const config = readConfig();
  const entries = config?.skills?.entries || {};
  const skills = {};
  for (const [name, data] of Object.entries(entries)) {
    skills[name] = typeof data === "object" ? { ...data } : { enabled: true };
    // apiKey 등 민감정보 마스킹
    for (const key of Object.keys(skills[name])) {
      if (/key|token|secret|password/i.test(key)) {
        skills[name][key] = "***";
      }
    }
  }
  return skills;
}

// ── pet 단위로 Firestore 동기화 ──

export async function pushToFirestore(db, uid, petId) {
  if (skipRemoteWatch) return;
  skipRemoteWatch = true;
  try {
    // config 암호화
    const rawConfig = readConfig();
    const encryptedConfig = await encryptConfig(rawConfig);

    const data = {
      openclawPath: HAS_OPENCLAW ? OPENCLAW_HOME : null,
      hasOpenclaw: HAS_OPENCLAW,
      updatedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: "online"
    };

    // openclaw 설치된 경우에만 관련 데이터 동기화
    if (HAS_OPENCLAW) {
      data.openclawFiles = readOpenclawDir();
      data.workspace = readWorkspace();
      data.skills = readSkillsInfo();
    }

    if (encryptedConfig) {
      data.encryptedConfig = encryptedConfig;
      data.config = null; // 평문 제거
    } else {
      // 암호화 실패 시 폴백 (최초 로그인 등 idToken 없을 때)
      data.config = rawConfig;
    }

    await setDoc(doc(db, "users", uid, "pets", petId), data, { merge: true });
    log("⬆ 로컬 → Firestore 동기화" + (encryptedConfig ? " (config 암호화)" : ""));
  } catch (e) {
    log(`❌ Push 실패: ${e.message}`);
  }
  setTimeout(() => { skipRemoteWatch = false; }, 1000);
}

// ── 커맨드 리스너 (웹 → 데몬) ──

// pushToFirestore 참조 (refresh_info에서 사용)
let _pushRef = null;
export function setPushRef(fn) { _pushRef = fn; }

const COMMAND_HANDLERS = {
  restart_gateway: async () => {
    restartGateway();
    return { message: "게이트웨이 재시작 완료" };
  },
  detect_openclaw: async (params, { db, uid, petId }) => {
    const hasIt = HAS_OPENCLAW;
    const data = {
      hasOpenclaw: hasIt,
      openclawPath: hasIt ? OPENCLAW_HOME : null,
    };
    await setDoc(doc(db, "users", uid, "pets", petId), data, { merge: true });
    if (hasIt && _pushRef) await _pushRef();
    return { message: hasIt ? `OpenClaw 감지됨: ${OPENCLAW_HOME}` : "OpenClaw 미설치", hasOpenclaw: hasIt };
  },
  refresh_info: async (params, { db, uid, petId }) => {
    const info = deviceInfo();
    const uptime = Math.floor(process.uptime());
    const memTotal = Math.round(os.totalmem() / 1024 / 1024);
    const memFree = Math.round(os.freemem() / 1024 / 1024);

    // openclaw 버전 정보
    let openclawVersion = '';
    try {
      const { execSync } = await import('child_process');
      const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
      const versions = fs.readdirSync(nvmDir);
      if (versions.length) {
        const bin = path.join(nvmDir, versions[versions.length - 1], 'bin', 'openclaw');
        if (fs.existsSync(bin)) {
          openclawVersion = execSync(`${bin} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
        }
      }
    } catch {}

    const data = {
      ...info,
      uptime,
      memTotal,
      memFree,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || '',
      osRelease: os.release(),
      openclawVersion,
      lastSeen: new Date().toISOString(),
      status: "online",
    };
    await setDoc(doc(db, "users", uid, "pets", petId), data, { merge: true });
    if (_pushRef) await _pushRef();
    return { message: "디바이스 정보 업데이트 완료", ...data };
  },
};

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

export function listenFirestore(db, uid, petId) {
  // pet config 변경 리스너
  const unsubPet = onSnapshot(doc(db, "users", uid, "pets", petId), async (snap) => {
    if (!snap.exists() || skipRemoteWatch) return;
    const data = snap.data();

    // 폐기 감시
    if (data.revoked) {
      log("🚫 이 pet이 폐기되었습니다. 데몬 종료.");
      process.exit(0);
    }

    // config 복호화 (암호화된 경우)
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

    // 환경변수/시크릿 변경 시 → 복호화 포함 .env 쓰기 + 게이트웨이 재시작
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

export function watchLocal(db, uid, petId) {
  const targets = [CONFIG_FILE];
  if (fs.existsSync(CONFIG_DIR)) targets.push(CONFIG_DIR);
  if (fs.existsSync(WORKSPACE_DIR)) {
    // 워크스페이스 .md 파일들만 감시
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

// ── Heartbeat (60초마다 lastSeen 업데이트) ──

const HEARTBEAT_INTERVAL = 60 * 1000;

export function startHeartbeat(db, uid, petId) {
  const tick = async () => {
    try {
      await setDoc(doc(db, "users", uid, "pets", petId), {
        lastSeen: new Date().toISOString(),
        status: "online"
      }, { merge: true });
    } catch {}
  };
  const interval = setInterval(tick, HEARTBEAT_INTERVAL);
  return () => clearInterval(interval);
}
