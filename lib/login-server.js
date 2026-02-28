import { createServer } from "http";
import { spawn } from "child_process";
import crypto from "crypto";
import os from "os";
import { CLIENT_URL } from "./config.js";
import { generateVerificationCode } from "./auth.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function waitForBrowserAuth() {
  return new Promise((resolve, reject) => {
    const verifyCode = generateVerificationCode();
    const port = 19876 + crypto.randomInt(1000);

    const server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

      if (req.method === "GET" && req.url === "/info") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          verifyCode,
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch()
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            server.close();
            clearInterval(spinnerInterval);
            process.stdout.write("\r\x1b[K");
            resolve(data);
          } catch {
            res.writeHead(400);
            res.end("Invalid payload");
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(port, () => {
      const authUrl = `${CLIENT_URL}/auth/device?port=${port}`;
      console.log("");
      console.log("  \x1b[1m🔐 OhMyPetBook 로그인\x1b[0m");
      console.log("");
      console.log("  브라우저에서 로그인하세요:");
      console.log(`  \x1b[4m\x1b[36m${authUrl}\x1b[0m`);
      console.log("");
      console.log(`  확인 코드: \x1b[1m\x1b[33m${verifyCode}\x1b[0m`);
      console.log("  (브라우저에 표시되는 코드와 일치하는지 확인하세요)");
      console.log("");

      try {
        const cmd = os.platform() === "darwin" ? "open" : "xdg-open";
        spawn(cmd, [authUrl], { detached: true, stdio: "ignore" }).unref();
      } catch {}
    });

    let si = 0;
    const spinnerInterval = setInterval(() => {
      process.stdout.write(`\r  ${SPINNER[si++ % SPINNER.length]} 대기 중...`);
    }, 100);

    server.on("error", (e) => { clearInterval(spinnerInterval); reject(e); });
    setTimeout(() => {
      clearInterval(spinnerInterval);
      server.close();
      reject(new Error("로그인 타임아웃 (5분)"));
    }, 5 * 60 * 1000);
  });
}
