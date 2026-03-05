import fs from "fs";
import { LOG_FILE, PETBOOK_HOME } from "./config.js";

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function ts() {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

export function log(msg) {
  const line = `[${ts()}] ${msg}`;
  try {
    ensureDir(PETBOOK_HOME);
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
  // stdout은 서비스 모드에서 같은 파일로 리다이렉트되므로 TTY일 때만 출력
  if (process.stdout.isTTY) console.log(line);
}
