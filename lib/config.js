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

// openclaw 실제 설치 여부 감지 (openclaw.json 또는 which openclaw)
import { execSync } from "child_process";

// openclaw config 경로 탐지
function resolveOpenclawPath() {
  // 1. petbook 수동 설정
  if (petbookConfig.openclawPath) return petbookConfig.openclawPath;
  // 2. 환경변수
  if (process.env.OPENCLAW_HOME?.trim()) return process.env.OPENCLAW_HOME.trim();
  if (process.env.OPENCLAW_STATE_DIR?.trim()) return process.env.OPENCLAW_STATE_DIR.trim();
  // 3. openclaw gateway status에서 파싱 (1회)
  try {
    const out = execSync("openclaw gateway status 2>&1", { encoding: "utf-8", timeout: 5000 });
    const match = out.match(/Config \(cli\):\s*(.+\/openclaw\.json)/);
    if (match) {
      const p = path.dirname(match[1].replace(/^~/, HOME));
      if (fs.existsSync(path.join(p, "openclaw.json"))) return p;
    }
  } catch {}
  // 4. 기본값
  return path.join(HOME, ".openclaw");
}

const _defaultOpenclawPath = resolveOpenclawPath();

function detectOpenclaw() {
  try {
    if (fs.existsSync(path.join(_defaultOpenclawPath, "openclaw.json"))) return true;
    execSync("which openclaw", { encoding: "utf-8", timeout: 3000 });
    return true;
  } catch { return false; }
}

// 초기 감지 (이후 refreshOpenclawDetection()으로 갱신 가능)
let _hasOpenclaw = detectOpenclaw();

export function hasOpenclaw() { return _hasOpenclaw; }
export function refreshOpenclawDetection() {
  const prev = _hasOpenclaw;
  _hasOpenclaw = detectOpenclaw();
  return { changed: prev !== _hasOpenclaw, hasOpenclaw: _hasOpenclaw };
}

// 하위호환: 기존 코드에서 HAS_OPENCLAW 참조 시
export const HAS_OPENCLAW = _hasOpenclaw;
export const OPENCLAW_HOME = _defaultOpenclawPath;
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
