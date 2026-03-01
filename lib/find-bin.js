// 다양한 Node.js 환경에서 CLI 바이너리를 안전하게 찾는 유틸리티.
//
// 탐색 순서:
// 1. process.execPath 기반 (현재 실행 중인 Node와 같은 bin 디렉토리)
// 2. nvm
// 3. fnm
// 4. volta
// 5. 일반 경로 (/usr/local/bin, /opt/homebrew/bin 등)
// 6. which (마지막 수단)
//
// launchd/systemd 환경에서 PATH가 제한적이므로 which에 의존하지 않음.
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();

function semverSort(versions) {
  return versions
    .filter(v => v.startsWith("v"))
    .sort((a, b) => {
      const pa = a.slice(1).split(".").map(Number);
      const pb = b.slice(1).split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });
}

function searchDirs(baseDir, name) {
  try {
    const versions = semverSort(fs.readdirSync(baseDir));
    for (const v of versions) {
      const bin = path.join(baseDir, v, "bin", name);
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}
  return null;
}

export function findBin(name) {
  // 1. 현재 프로세스의 Node와 같은 디렉토리 (가장 신뢰할 수 있음)
  const selfBinDir = path.dirname(process.execPath);
  const selfCandidate = path.join(selfBinDir, name);
  if (fs.existsSync(selfCandidate)) return selfCandidate;

  // 2. nvm
  const nvmResult = searchDirs(path.join(HOME, ".nvm/versions/node"), name);
  if (nvmResult) return nvmResult;

  // 3. fnm (Linux/macOS 위치 둘 다)
  for (const fnmBase of [
    path.join(HOME, ".local/share/fnm/node-versions"),
    path.join(HOME, "Library/Application Support/fnm/node-versions"),
  ]) {
    try {
      const versions = semverSort(fs.readdirSync(fnmBase));
      for (const v of versions) {
        const bin = path.join(fnmBase, v, "installation/bin", name);
        if (fs.existsSync(bin)) return bin;
      }
    } catch {}
  }

  // 4. volta
  const voltaBin = path.join(HOME, ".volta/bin", name);
  if (fs.existsSync(voltaBin)) return voltaBin;

  // 5. 일반 설치 경로
  const commonPaths = [
    "/opt/homebrew/bin",     // macOS ARM Homebrew
    "/usr/local/bin",        // macOS Intel Homebrew / 일반
    path.join(HOME, ".local/bin"),
    path.join(HOME, "bin"),
    "/usr/bin",
  ];
  for (const dir of commonPaths) {
    const bin = path.join(dir, name);
    if (fs.existsSync(bin)) return bin;
  }

  // 6. which (마지막 수단 — 서비스 환경에서 PATH 제한적일 수 있음)
  try {
    const result = execSync(`which ${name}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}

  return null;
}

// 찾은 바이너리를 실행할 때 사용할 env 객체.
// bin의 디렉토리를 PATH 앞에 추가해서 올바른 Node를 사용하도록 보장.
export function envForBin(binPath) {
  const binDir = path.dirname(binPath);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` };
}
