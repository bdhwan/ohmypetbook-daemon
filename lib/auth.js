import {
  signInWithEmailAndPassword,
  signInWithCredential, GoogleAuthProvider
} from "firebase/auth";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import crypto from "crypto";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import { PETBOOK_HOME, PETBOOK_CONFIG, OPENCLAW_HOME, TOKEN_EXPIRY_DAYS } from "./config.js";
import { ensureDir, log } from "./log.js";

// ── ohmypetbook.json 관리 ──

export function savePetbookConfig(data) {
  ensureDir(PETBOOK_HOME);
  const existing = loadPetbookConfig();
  const merged = { ...existing, ...data };
  fs.writeFileSync(PETBOOK_CONFIG, JSON.stringify(merged, null, 2), "utf-8");
  fs.chmodSync(PETBOOK_CONFIG, 0o600);
}

export function loadPetbookConfig() {
  try { return JSON.parse(fs.readFileSync(PETBOOK_CONFIG, "utf-8")); } catch { return {}; }
}

export function saveAuth(data) {
  savePetbookConfig({ auth: data, openclawPath: OPENCLAW_HOME });
}

export function loadAuth() {
  return loadPetbookConfig().auth || null;
}

// ── Token / Verification ──

export function generateVerificationCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

export function getDeviceId() {
  try {
    const platform = os.platform();
    let raw;
    if (platform === "darwin") {
      raw = execSync("/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice", { encoding: "utf-8" });
      const match = raw.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } else if (platform === "linux") {
      raw = fs.readFileSync("/etc/machine-id", "utf-8").trim();
      if (raw) return raw;
    }
  } catch {}
  // fallback: hostname + arch
  return `${os.hostname()}-${os.arch()}`;
}

export function generatePetId() {
  const deviceId = getDeviceId();
  const hash = crypto.createHash("sha256").update(deviceId).digest("hex").slice(0, 16);
  return `pet_${hash}`;
}

// ── Firebase Auth ──

export async function signInFromCredential(auth, credData) {
  if (credData.type === "email") {
    return signInWithEmailAndPassword(auth, credData.email, credData.password);
  } else if (credData.type === "google") {
    const credential = GoogleAuthProvider.credential(credData.googleIdToken);
    return signInWithCredential(auth, credential);
  }
  throw new Error(`지원하지 않는 인증 타입: ${credData.type}`);
}

// ── Pet 등록/검증 (Firestore) ──

export function deviceInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version
  };
}

export async function registerPet(db, uid, petName) {
  const petId = generatePetId();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  await setDoc(doc(db, "users", uid, "pets", petId), {
    name: petName || os.hostname(),
    ...deviceInfo(),
    openclawPath: OPENCLAW_HOME,
    createdAt: now,
    expiresAt,
    lastSeen: now,
    status: "online",
    revoked: false
  }, { merge: true });

  return { petId, expiresAt };
}

export async function validatePet(db, uid, petId) {
  if (!petId) return true;
  const snap = await getDoc(doc(db, "users", uid, "pets", petId));
  if (!snap.exists()) return true;

  const data = snap.data();
  if (data.revoked) {
    log("🚫 이 pet이 폐기되었습니다. 재등록 필요.");
    return false;
  }

  // lastSeen + status 업데이트
  await updateDoc(doc(db, "users", uid, "pets", petId), {
    lastSeen: new Date().toISOString(),
    status: "online",
    ...deviceInfo()
  });
  return true;
}

export async function setPetOffline(db, uid, petId) {
  if (!petId) return;
  try {
    await updateDoc(doc(db, "users", uid, "pets", petId), {
      status: "offline",
      lastSeen: new Date().toISOString()
    });
  } catch {}
}
