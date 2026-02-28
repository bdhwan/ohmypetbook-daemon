import os from "os";
import path from "path";
import fs from "fs";

export const HOME = os.homedir();
export const PETBOOK_HOME = path.join(HOME, ".ohmypetbook");
export const PETBOOK_CONFIG = path.join(PETBOOK_HOME, "ohmypetbook.json");
export const LOG_FILE = path.join(PETBOOK_HOME, "ohmypetbook.log");

// ohmypetbook.json에서 openclaw 경로 읽기 (기본: ~/.openclaw)
function loadPetbookConfig() {
  try { return JSON.parse(fs.readFileSync(PETBOOK_CONFIG, "utf-8")); } catch { return {}; }
}

const petbookConfig = loadPetbookConfig();

// openclaw 실제 설치 여부 감지
function detectOpenclawPath() {
  const candidate = petbookConfig.openclawPath || process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
  // openclaw.json 존재 여부로 판단
  if (fs.existsSync(path.join(candidate, "openclaw.json"))) return candidate;
  // openclaw 바이너리 존재 여부
  try {
    const { execSync } = await import("child_process");
    execSync("which openclaw", { encoding: "utf-8", timeout: 3000 });
    return candidate;
  } catch {}
  return null;
}

let _detectedPath = null;
try {
  const candidate = petbookConfig.openclawPath || process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
  if (fs.existsSync(path.join(candidate, "openclaw.json"))) {
    _detectedPath = candidate;
  }
} catch {}

export const HAS_OPENCLAW = _detectedPath !== null;
export const OPENCLAW_HOME = _detectedPath || petbookConfig.openclawPath || process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
export const CONFIG_FILE = path.join(OPENCLAW_HOME, "openclaw.json");
export const CONFIG_DIR = path.join(OPENCLAW_HOME, "openclaw");
export const WORKSPACE_DIR = path.join(OPENCLAW_HOME, "workspace");
export const CLIENT_URL = "https://ohmypetbook.com";
export const TOKEN_EXPIRY_DAYS = 365;
export const CLAIM_DEVICE_URL = "https://claimdevice-gkspcxvo6q-du.a.run.app";
export const REFRESH_SESSION_URL = "https://refreshsession-gkspcxvo6q-du.a.run.app";
export const ENCRYPT_SECRET_URL = "https://asia-northeast3-openclaw-petbook.cloudfunctions.net/encryptSecret";
export const DECRYPT_SECRETS_URL = "https://asia-northeast3-openclaw-petbook.cloudfunctions.net/decryptSecrets";

// 데몬 버전 (package.json에서 읽기)
let _daemonVersion = 'unknown';
try {
  const pkgPath = new URL('../package.json', import.meta.url);
  _daemonVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
} catch {}
export const DAEMON_VERSION = _daemonVersion;

export const firebaseConfig = {
  apiKey: "AIzaSyDaOWYC3U3nMNVoO1hSwE4IndGavOdpr9o",
  authDomain: "openclaw-petbook.firebaseapp.com",
  projectId: "openclaw-petbook",
  storageBucket: "openclaw-petbook.firebasestorage.app",
  messagingSenderId: "724877033848",
  appId: "1:724877033848:web:e364e397bb8a71cb00088d",
  measurementId: "G-W0MB718DVQ"
};
