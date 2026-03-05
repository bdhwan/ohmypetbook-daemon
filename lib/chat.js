import { collection, doc, updateDoc, onSnapshot, query, where, orderBy, addDoc } from "firebase/firestore";
import { CONFIG_FILE, OPENCLAW_HOME } from "./config.js";
import { log } from "./log.js";
import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { randomUUID } from "crypto";

// ── .env 파일에서 환경변수 읽기 ──

function readEnvFile() {
  const result = {};
  try {
    const envPath = path.join(OPENCLAW_HOME, ".env");
    if (!fs.existsSync(envPath)) return result;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) result[key] = value;
    }
  } catch {}
  return result;
}

// ── ${VAR_NAME} 패턴을 .env 값으로 치환 ──

function resolveEnvVar(value) {
  if (!value || typeof value !== "string") return value;
  const match = value.match(/^\$\{(.+)\}$/);
  if (!match) return value;
  const varName = match[1];
  if (process.env[varName]) return process.env[varName];
  const envVars = readEnvFile();
  return envVars[varName] || value;
}

// ── Gateway 설정 읽기 ──

function getGatewayConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const gw = config.gateway || {};
    const port = gw.port || 18789;
    const token = resolveEnvVar(gw.auth?.token || "");
    return { port, token };
  } catch {
    return { port: 18789, token: "" };
  }
}

// ── Gateway WebSocket 클라이언트 ──

class GatewayWSClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.reconnectTimer = null;
    this.backoffMs = 1000;
    this.closed = false;
  }

  connect() {
    if (this.ws) return;
    this.closed = false;
    const { port, token } = getGatewayConfig();
    const url = `ws://127.0.0.1:${port}`;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      log(`❌ WS 연결 실패: ${e.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      log("🔌 Gateway WS 연결됨");
      // connect 핸드셰이크
      this.request("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "gateway-client", version: "1.0", platform: "node", mode: "backend" },
        role: "operator",
        scopes: ["operator", "operator.write", "operator.read", "operator.admin"],
        auth: token ? { token } : undefined,
      }).then(() => {
        this.connected = true;
        this.backoffMs = 1000;
        log("✅ Gateway WS 인증 완료");
      }).catch((e) => {
        log(`❌ Gateway WS connect 실패: ${e.message}`);
        this.ws?.close();
      });
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "res") {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.payload);
            else p.reject(new Error(msg.error?.message || "request failed"));
          }
        } else if (msg.type === "event") {
          log(`📡 event: ${msg.event} payload_keys=${Object.keys(msg.payload || {}).join(",")}`);
          const handlers = this.eventHandlers.get(msg.event) || [];
          for (const h of handlers) {
            try { h(msg.payload); } catch {}
          }
        }
      } catch {}
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.ws = null;
      this.flushPending(new Error("WS disconnected"));
      if (!this.closed) {
        log("🔌 Gateway WS 연결 끊김, 재연결 예정...");
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", () => {});
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.5, 15000);
  }

  flushPending(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WS not connected"));
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event).push(handler);
  }

  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.flushPending(new Error("client closed"));
  }
}

// 싱글턴 WS 클라이언트
let gwClient = null;

function getGWClient() {
  if (!gwClient) {
    gwClient = new GatewayWSClient();
    gwClient.connect();
  }
  return gwClient;
}

// ── Gateway에 메시지 전송 (WebSocket chat.send) ──

async function sendToGateway(message, chatId) {
  const client = getGWClient();

  if (!client.connected) {
    log("⏳ Gateway WS 연결 대기 중...");
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (client.connected) break;
    }
    if (!client.connected) {
      throw new Error("Gateway WS not connected (10s 대기 후 실패)");
    }
    log("✅ Gateway WS 연결 복구됨");
  }

  const idempotencyKey = randomUUID();
  const sessionKey = `petbook-chat-${chatId}`;

  // chat.send는 non-blocking — 즉시 ack, 응답은 chat 이벤트로 스트리밍
  log(`📤 chat.send 요청: sessionKey=${sessionKey}`);
  let result;
  try {
    result = await client.request("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey,
    });
    log(`📥 chat.send 응답: runId=${result?.runId || "none"}`);
  } catch (e) {
    log(`❌ chat.send 실패: ${e.message}`);
    throw e;
  }

  return { runId: result?.runId || idempotencyKey, sessionKey, client };
}

// ── 채팅 리스너 (새 user 메시지 감지 → Gateway WS → 응답) ──

export function listenChats(db, uid, petId) {
  const chatsRef = collection(db, "users", uid, "pets", petId, "chats");
  const activeChatListeners = new Map();

  // Gateway WS 클라이언트 초기화
  const client = getGWClient();

  const unsubChats = onSnapshot(chatsRef, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const chatId = change.doc.id;

      if (change.type === "removed") {
        const unsub = activeChatListeners.get(chatId);
        if (unsub) { unsub(); activeChatListeners.delete(chatId); }
        continue;
      }

      if (activeChatListeners.has(chatId)) continue;

      // 이 chat의 pending 메시지 리스너
      const messagesRef = collection(db, "users", uid, "pets", petId, "chats", chatId, "messages");
      const q = query(messagesRef, where("status", "==", "pending"), where("role", "==", "user"));

      const unsubMsg = onSnapshot(q, async (msgSnap) => {
        for (const change of msgSnap.docChanges()) {
          if (change.type !== "added") continue;
          const msgDoc = change.doc;
          const msgData = msgDoc.data();

          log(`💬 채팅 메시지 수신: ${msgData.content?.slice(0, 50)}...`);

          // user 메시지 → sent로 변경
          log(`📝 메시지 처리 시작: docId=${msgDoc.id}`);
          const userOrder = msgData.order || new Date(msgData.createdAt).getTime() || Date.now();
          await updateDoc(msgDoc.ref, { status: "sent" });
          log(`✓ user 메시지 status → sent`);

          // assistant 응답 문서 생성
          const assistantRef = await addDoc(messagesRef, {
            role: "assistant",
            content: "",
            status: "streaming",
            createdAt: new Date().toISOString(),
            order: userOrder + 1,
          });

          try {
            // chat 이벤트 핸들러를 먼저 등록 (send 전에 등록해야 이벤트 누락 방지)
            let fullContent = "";
            let lastFlush = Date.now();
            let expectedRunId = null;
            const sessionKey = `petbook-chat-${chatId}`;

            const streamPromise = new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                client.off("chat", chatHandler);
                reject(new Error("응답 타임아웃 (120s)"));
              }, 120000);

              function chatHandler(payload) {
                if (!payload) return;
                // Gateway broadcasts sessionKey as "agent:main:<key>" — match suffix
                if (payload.sessionKey !== sessionKey && !payload.sessionKey?.endsWith(sessionKey)) return;
                // runId가 있으면 매칭 (설정된 이후에만)
                if (expectedRunId && payload.runId && payload.runId !== expectedRunId) return;

                if (payload.state === "delta") {
                  const content = extractContent(payload.message);
                  if (content && content.length > fullContent.length) {
                    fullContent = content;
                    const now = Date.now();
                    if (now - lastFlush > 500) {
                      updateDoc(assistantRef, { content: fullContent }).catch(() => {});
                      lastFlush = now;
                    }
                  }
                } else if (payload.state === "final") {
                  clearTimeout(timeout);
                  client.off("chat", chatHandler);
                  const finalContent = extractContent(payload.message);
                  if (finalContent) fullContent = finalContent;
                  resolve();
                } else if (payload.state === "error" || payload.state === "aborted") {
                  clearTimeout(timeout);
                  client.off("chat", chatHandler);
                  reject(new Error(payload.errorMessage || "응답 에러"));
                }
              }

              client.on("chat", chatHandler);
            });

            // Gateway WS로 전송
            const { runId } = await sendToGateway(msgData.content, chatId);
            expectedRunId = runId;

            // 스트리밍 응답 대기
            await streamPromise;

            // 최종 업데이트
            await updateDoc(assistantRef, {
              content: fullContent,
              status: "done",
              completedAt: new Date().toISOString(),
            });

            log(`✓ 채팅 응답 완료 (${fullContent.length}자)`);
          } catch (e) {
            log(`❌ 채팅 응답 실패: ${e.message}`);
            await updateDoc(assistantRef, {
              content: `⚠️ 응답 실패: ${e.message}`,
              status: "error",
              completedAt: new Date().toISOString(),
            });
          }
        }
      });

      activeChatListeners.set(chatId, unsubMsg);
    }
  });

  log("💬 채팅 리스너 시작 (WebSocket 모드)");

  return () => {
    unsubChats();
    for (const unsub of activeChatListeners.values()) unsub();
    activeChatListeners.clear();
    gwClient?.close();
    gwClient = null;
  };
}

// ── 메시지 내용 추출 헬퍼 ──

function extractContent(message) {
  if (!message) return null;
  if (typeof message === "string") return message;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  if (typeof message.text === "string") return message.text;
  return null;
}
