import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { HOME } from "./config.js";
import { log } from "./log.js";

function findBin(name) {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    try {
      const nvmDir = path.join(HOME, ".nvm/versions/node");
      const versions = fs.readdirSync(nvmDir);
      if (versions.length) {
        const bin = path.join(nvmDir, versions[versions.length - 1], "bin", name);
        if (fs.existsSync(bin)) return bin;
      }
    } catch {}
    return null;
  }
}

export function restartGateway() {
  log("🔄 게이트웨이 재시작 중...");
  try {
    const bin = findBin("openclaw");
    if (bin) {
      // openclaw 바이너리의 디렉토리를 PATH 앞에 추가 (launchd 환경에서 올바른 node 사용)
      const binDir = path.dirname(bin);
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` };
      execSync(`${bin} gateway restart`, { timeout: 30000, stdio: "pipe", env });
      log("✓ 게이트웨이 재시작 완료");
    } else {
      log("⚠ openclaw 명령어를 찾을 수 없음");
    }
  } catch (e) {
    log(`❌ 게이트웨이 재시작 실패: ${e.message}`);
  }
}
