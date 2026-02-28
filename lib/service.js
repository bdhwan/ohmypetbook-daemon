import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { HOME, LOG_FILE } from "./config.js";
import { ensureDir, log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function installService() {
  const platform = os.platform();
  const nodeBin = process.execPath;
  const daemonPath = path.resolve(__dirname, "..", "daemon.js");

  if (platform === "darwin") {
    const label = "com.ohmypetbook.daemon";
    const plistPath = path.join(HOME, "Library/LaunchAgents", `${label}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${daemonPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:${path.dirname(nodeBin)}</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
</dict>
</plist>`;
    ensureDir(path.dirname(plistPath));
    fs.writeFileSync(plistPath, plist);
    try { execSync(`launchctl unload ${plistPath} 2>/dev/null`); } catch {}
    execSync(`launchctl load ${plistPath}`);
    log(`✓ macOS 서비스 등록: ${label}`);

  } else if (platform === "linux") {
    const serviceDir = path.join(HOME, ".config/systemd/user");
    const servicePath = path.join(serviceDir, "ohmypetbook-daemon.service");
    const unit = `[Unit]
Description=PetBook Daemon
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=${nodeBin} ${daemonPath} run
Restart=always
RestartSec=10
Environment=HOME=${HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${path.dirname(nodeBin)}
[Install]
WantedBy=default.target`;
    ensureDir(serviceDir);
    fs.writeFileSync(servicePath, unit);
    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable ohmypetbook-daemon");
    execSync("systemctl --user restart ohmypetbook-daemon");
    log("✓ Linux 서비스 등록: ohmypetbook-daemon");
  }
}

export function uninstallService() {
  if (os.platform() === "darwin") {
    const p = path.join(HOME, "Library/LaunchAgents/com.ohmypetbook.daemon.plist");
    try { execSync(`launchctl unload ${p}`); } catch {}
    try { fs.unlinkSync(p); } catch {}
  } else if (os.platform() === "linux") {
    try { execSync("systemctl --user stop ohmypetbook-daemon"); } catch {}
    try { execSync("systemctl --user disable ohmypetbook-daemon"); } catch {}
    try { fs.unlinkSync(path.join(HOME, ".config/systemd/user/ohmypetbook-daemon.service")); } catch {}
    try { execSync("systemctl --user daemon-reload"); } catch {}
  }
}
