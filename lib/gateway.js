import { execSync } from "child_process";
import { findBin, envForBin } from "./find-bin.js";
import { log } from "./log.js";

let lastGatewayRestart = null;
let onGatewayRestartCallback = null;

export function getLastGatewayRestart() { return lastGatewayRestart; }
export function setOnGatewayRestartCallback(fn) { onGatewayRestartCallback = fn; }

export function restartGateway() {
  log("🔄 게이트웨이 재시작 중...");
  try {
    const bin = findBin("openclaw");
    if (bin) {
      const env = envForBin(bin);
      execSync(`${bin} gateway restart`, { timeout: 300000, stdio: "pipe", env });
      lastGatewayRestart = new Date().toISOString();
      log("✓ 게이트웨이 재시작 완료");
      if (onGatewayRestartCallback) onGatewayRestartCallback(lastGatewayRestart);
    } else {
      log("⚠ openclaw 명령어를 찾을 수 없음");
    }
  } catch (e) {
    log(`❌ 게이트웨이 재시작 실패: ${e.message}`);
  }
}
