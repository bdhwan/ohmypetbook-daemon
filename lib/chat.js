import { collection, doc, setDoc, updateDoc, onSnapshot, query, where, orderBy, getDocs, addDoc, limit } from "firebase/firestore";
import { CONFIG_FILE, OPENCLAW_HOME } from "./config.js";
import { log } from "./log.js";
import fs from "fs";
import path from "path";

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
  // process.env 먼저, 없으면 .env 파일에서
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
    return { url: `http://127.0.0.1:${port}`, token };
  } catch {
    return { url: "http://127.0.0.1:18789", token: "" };
  }
}

// ── Gateway에 메시지 전송 (SSE streaming) ──

async function sendToGateway(messages, chatId) {
  const { url, token } = getGatewayConfig();

  const resp = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: "openclaw",
      messages,
      stream: true,
      user: `petbook-chat-${chatId}`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gateway ${resp.status}: ${body.slice(0, 200)}`);
  }

  return resp;
}

// ── SSE 스트림 파싱 ──

async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {}
      }
    }
  }
}

// ── 채팅 메시지 히스토리 로드 ──

async function loadChatHistory(db, uid, petId, chatId) {
  const messagesRef = collection(db, "users", uid, "pets", petId, "chats", chatId, "messages");
  const q = query(messagesRef, where("status", "in", ["sent", "done"]), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => {
    const data = d.data();
    return { role: data.role, content: data.content };
  });
}

// ── 채팅 리스너 (새 user 메시지 감지 → Gateway → 응답) ──

export function listenChats(db, uid, petId) {
  // 모든 chats 하위의 messages에서 pending 상태 감시
  // Firestore는 subcollection group query 필요 → chat별로 리스너 등록
  const chatsRef = collection(db, "users", uid, "pets", petId, "chats");
  const activeChatListeners = new Map();

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

          // user 메시지 → sent로 변경 (browser가 보낸 order 유지)
          const userOrder = msgData.order || new Date(msgData.createdAt).getTime() || Date.now();
          await updateDoc(msgDoc.ref, { status: "sent" });

          // assistant 응답 문서 생성 (order를 user+1로 보장)
          const assistantRef = await addDoc(messagesRef, {
            role: "assistant",
            content: "",
            status: "streaming",
            createdAt: new Date().toISOString(),
            order: userOrder + 1,
          });

          try {
            // 채팅 히스토리 로드
            const history = await loadChatHistory(db, uid, petId, chatId);

            // Gateway로 전송 (streaming)
            const resp = await sendToGateway(history, chatId);
            let fullContent = "";
            let lastFlush = Date.now();

            for await (const chunk of parseSSE(resp)) {
              fullContent += chunk;

              // 500ms마다 또는 200자마다 Firestore 업데이트
              const now = Date.now();
              if (now - lastFlush > 500 || fullContent.length % 200 < chunk.length) {
                await updateDoc(assistantRef, { content: fullContent });
                lastFlush = now;
              }
            }

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

  log("💬 채팅 리스너 시작");

  return () => {
    unsubChats();
    for (const unsub of activeChatListeners.values()) unsub();
    activeChatListeners.clear();
  };
}
