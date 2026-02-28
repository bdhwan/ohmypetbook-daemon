import { doc, setDoc, updateDoc, onSnapshot, collection, query, where } from "firebase/firestore";
import { watch } from "chokidar";
import fs from "fs";
import path from "path";
import os from "os";
import { CONFIG_FILE, CONFIG_DIR, OPENCLAW_HOME, WORKSPACE_DIR, ENCRYPT_SECRET_URL, DECRYPT_SECRETS_URL, HAS_OPENCLAW, DAEMON_VERSION } from "./config.js";
import { deviceInfo } from "./auth.js";
import { ensureDir, log } from "./log.js";
import { restartGateway } from "./gateway.js";

// ── Firestore 경로 헬퍼 ──
// users/{uid}/pets/{petId}                  ← 프로필 (name, bio, image, hostname, platform, createdAt)
// users/{uid}/pets/{petId}/runtime/heartbeat ← lastSeen, status (60초)
// users/{uid}/pets/{petId}/runtime/system    ← hasOpenclaw, openclawPath, versions, cpu, mem
// users/{uid}/pets/{petId}/runtime/sync      ← encryptedConfig, workspace, skills, openclawFiles
// users/{uid}/pets/{petId}/runtime/env       ← deviceEnvVars, deviceSecrets
// users/{uid}/pets/{petId}/commands/{id}     ← 커맨드

const petDoc = (db, uid, petId) => doc(db, "users", uid, "pets", petId);
const runtimeDoc = (db, uid, petId, name) => doc(db, "users", uid, "pets", petId, "runtime", name);

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

// ── Firestore Push (분리된 문서별 쓰기) ──

export async function pushToFirestore(db, uid, petId) {
  if (skipRemoteWatch) return;
  skipRemoteWatch = true;
  try {
    const now = new Date().toISOString();

    // runtime/system — 시스템 정보
    await setDoc(runtimeDoc(db, uid, petId, "system"), {
      openclawPath: HAS_OPENCLAW ? OPENCLAW_HOME : null,
      hasOpenclaw: HAS_OPENCLAW,
      daemonVersion: DAEMON_VERSION,
      updatedAt: now,
    }, { merge: true });

    // runtime/sync — openclaw 설정 동기화 (openclaw 있을 때만)
    if (HAS_OPENCLAW) {
      const rawConfig = readConfig();
      const encryptedConfig = await encryptConfig(rawConfig);

      const syncData = {
        openclawFiles: readOpenclawDir(),
        workspace: readWorkspace(),
        skills: readSkillsInfo(),
        updatedAt: now,
      };

      if (encryptedConfig) {
        syncData.encryptedConfig = encryptedConfig;
        syncData.config = null;
      } else {
        syncData.config = rawConfig;
      }

      await setDoc(runtimeDoc(db, uid, petId, "sync"), syncData, { merge: true });
    }

    // runtime/heartbeat — 온라인 상태
    await setDoc(runtimeDoc(db, uid, petId, "heartbeat"), {
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
  restart_gateway: async () => {
    restartGateway();
    return { message: "게이트웨이 재시작 완료" };
  },
  update_daemon: async (params, { db, uid, petId }) => {
    const { execSync } = await import('child_process');
    const oldVersion = DAEMON_VERSION;
    let method = 'unknown';
    let newVersion = oldVersion;

    try {
      const npmRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 10000 }).trim();
      const npmPkgPath = path.join(npmRoot, 'ohmypetbook', 'package.json');
      if (fs.existsSync(npmPkgPath)) {
        method = 'npm';
        log('📦 npm update 실행 중...');
        execSync('npm update -g ohmypetbook', { encoding: 'utf-8', timeout: 60000 });
        newVersion = JSON.parse(fs.readFileSync(npmPkgPath, 'utf-8')).version;
      }
    } catch (e) {
      log(`⚠️ npm update 실패: ${e.message}`);
    }

    if (method === 'unknown') {
      try {
        const daemonDir = new URL('..', import.meta.url).pathname;
        if (fs.existsSync(path.join(daemonDir, '.git'))) {
          method = 'git';
          log('📦 git pull 실행 중...');
          execSync('git pull', { cwd: daemonDir, encoding: 'utf-8', timeout: 30000 });
          newVersion = JSON.parse(fs.readFileSync(path.join(daemonDir, 'package.json'), 'utf-8')).version;
        }
      } catch (e) {
        log(`⚠️ git pull 실패: ${e.message}`);
      }
    }

    // runtime/system에 새 버전 기록
    await setDoc(runtimeDoc(db, uid, petId, "system"), {
      daemonVersion: newVersion,
    }, { merge: true });

    const updated = oldVersion !== newVersion;
    if (updated) {
      log(`✓ 데몬 업데이트: ${oldVersion} → ${newVersion}`);
      setTimeout(() => {
        try {
          const platform = os.platform();
          if (platform === 'darwin') {
            execSync('launchctl kickstart -k gui/$(id -u)/com.ohmypetbook.daemon', { timeout: 10000 });
          } else if (platform === 'linux') {
            execSync('systemctl --user restart petbook-daemon', { timeout: 10000 });
          }
        } catch (e) {
          log(`⚠️ 서비스 재시작 실패: ${e.message}. 수동 재시작 필요.`);
        }
      }, 1000);
    }

    return {
      message: updated ? `업데이트 완료: ${oldVersion} → ${newVersion} (${method})` : `최신 버전입니다 (${oldVersion})`,
      oldVersion, newVersion, method, updated
    };
  },
  detect_openclaw: async (params, { db, uid, petId }) => {
    const hasIt = HAS_OPENCLAW;
    await setDoc(runtimeDoc(db, uid, petId, "system"), {
      hasOpenclaw: hasIt,
      openclawPath: hasIt ? OPENCLAW_HOME : null,
    }, { merge: true });
    if (hasIt && _pushRef) await _pushRef();
    return { message: hasIt ? `OpenClaw 감지됨: ${OPENCLAW_HOME}` : "OpenClaw 미설치", hasOpenclaw: hasIt };
  },
  refresh_info: async (params, { db, uid, petId }) => {
    const info = deviceInfo();
    const uptime = Math.floor(process.uptime());
    const memTotal = Math.round(os.totalmem() / 1024 / 1024);
    const memFree = Math.round(os.freemem() / 1024 / 1024);

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

    // 메인 doc에 기기 기본 정보
    await setDoc(petDoc(db, uid, petId), {
      ...info,
      lastSeen: new Date().toISOString(),
      status: "online",
    }, { merge: true });

    // runtime/system에 상세 시스템 정보
    const systemData = {
      uptime, memTotal, memFree,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || '',
      osRelease: os.release(),
      openclawVersion,
      daemonVersion: DAEMON_VERSION,
      hasOpenclaw: HAS_OPENCLAW,
      openclawPath: HAS_OPENCLAW ? OPENCLAW_HOME : null,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(runtimeDoc(db, uid, petId, "system"), systemData, { merge: true });

    if (_pushRef) await _pushRef();
    return { message: "디바이스 정보 업데이트 완료", ...systemData };
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

// ── Firestore 리스너 (분리된 문서별) ──

export function listenFirestore(db, uid, petId) {
  // 1. 메인 doc — 폐기 감시만
  const unsubMain = onSnapshot(petDoc(db, uid, petId), (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.revoked) {
      log("🚫 이 pet이 폐기되었습니다. 데몬 종료.");
      process.exit(0);
    }
  }, (error) => {
    log(`❌ 메인 doc 리스너 에러: ${error.message}`);
  });

  // 2. runtime/sync — config, workspace, openclawFiles 변경
  const unsubSync = onSnapshot(runtimeDoc(db, uid, petId, "sync"), async (snap) => {
    if (!snap.exists() || skipRemoteWatch) return;
    const data = snap.data();

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
    log("⬇ Firestore(sync) → 로컬 동기화");

    if (configChanged) {
      restartGateway();
    }
  }, (error) => {
    log(`❌ sync 리스너 에러: ${error.message}`);
  });

  // 3. runtime/env — 환경변수/시크릿 변경
  const unsubEnv = onSnapshot(runtimeDoc(db, uid, petId, "env"), async (snap) => {
    if (!snap.exists() || skipRemoteWatch) return;
    const data = snap.data();

    if ((data.deviceEnvVars || data.deviceSecrets) && loadEnvSecretsCallback) {
      log("⬇ Firestore(env) → 환경변수 업데이트");
      loadEnvSecretsCallback().then(() => restartGateway()).catch((e) => {
        log(`⚠️ 환경변수 로드 실패: ${e.message}`);
        restartGateway();
      });
    }
  }, (error) => {
    log(`❌ env 리스너 에러: ${error.message}`);
  });

  // 4. 커맨드 리스너
  const unsubCmd = listenCommands(db, uid, petId);

  return () => { unsubMain(); unsubSync(); unsubEnv(); unsubCmd(); };
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

// ── Heartbeat (60초마다 runtime/heartbeat 업데이트) ──

const HEARTBEAT_INTERVAL = 60 * 1000;
const MAIN_DOC_HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 메인 doc은 5분마다

export function startHeartbeat(db, uid, petId) {
  let mainDocTick = 0;

  const tick = async () => {
    try {
      const now = new Date().toISOString();
      // runtime/heartbeat — 매 60초
      await setDoc(runtimeDoc(db, uid, petId, "heartbeat"), {
        lastSeen: now,
        status: "online",
      }, { merge: true });

      // 메인 doc — 5분마다 (대시보드 리스트용)
      mainDocTick += HEARTBEAT_INTERVAL;
      if (mainDocTick >= MAIN_DOC_HEARTBEAT_INTERVAL) {
        mainDocTick = 0;
        await setDoc(petDoc(db, uid, petId), {
          lastSeen: now,
          status: "online",
        }, { merge: true });
      }
    } catch {}
  };
  const interval = setInterval(tick, HEARTBEAT_INTERVAL);
  return () => clearInterval(interval);
}
