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
  console.log(line);
  try {
    ensureDir(PETBOOK_HOME);
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}
