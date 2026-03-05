import { collection, doc, getDoc, updateDoc, onSnapshot, query, where, orderBy, getDocs, addDoc, limit } from "firebase/firestore";
import { CONFIG_FILE, OPENCLAW_HOME } from "./config.js";
import { log } from "./log.js";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import WebSocket from "ws";

// ══════════════════════════════════════════════════
// Gateway 설정 유틸
// ══════════════════════════════════════════════════

function loadDotEnv() {
  try {
    const envPath = path.join(OPENCLAW_HOME, ".env");
    if (!fs.existsSync(envPath)) return {};
    const vars = {};
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) vars[m[1].trim()] = m[2].trim();
    }
    return vars;
  } catch { return {}; }
}

function resolveEnvVars(value) {
  if (typeof value !== "string") return value;
  const dotEnv = loadDotEnv();
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || dotEnv[name] || "");
}

function getGatewayConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const gw = config.gateway || {};
    const port = gw.port || 18789;
    const token = resolveEnvVars(gw.auth?.token || "");
    return { wsUrl: `ws://127.0.0.1:${port}`, token };
  } catch {
    return { wsUrl: "ws://127.0.0.1:18789", token: "" };
  }
}

// ══════════════════════════════════════════════════
// WebSocket Gateway 클라이언트
// ══════════════════════════════════════════════════

/**
 * 로컬 gateway와 WebSocket 연결 생성
 * OpenClaw gateway JSON-RPC over WebSocket 프로토콜
 */
function createGatewayWS() {
  const { wsUrl, token } = getGatewayConfig();
  const ws = new WebSocket(wsUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  const pending = new Map(); // id → { resolve, reject, onDelta }

  ws.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());

      // 응답 프레임: { type: "res", id, ok, payload, error }
      if (frame.type === "res" && frame.id) {
        const p = pending.get(frame.id);
        if (!p) return;
        if (frame.ok) {
          p.resolve(frame.payload);
        } else {
          p.reject(new Error(frame.error?.message || "gateway error"));
        }
        pending.delete(frame.id);
      }

      // 이벤트 프레임: { type: "event", event, payload }
      // chat 스트리밍: { type: "event", event: "chat", payload: { runId, state, message } }
      if (frame.type === "event" && frame.event === "chat") {
        const { runId, state, message } = frame.payload || {};
        const p = pending.get(runId);
        if (!p) return;

        if (state === "delta" && p.onDelta) {
          const text = message?.content?.[0]?.text || message?.content || "";
          if (text) p.onDelta(text);
        } else if (state === "final") {
          const text = message?.content?.[0]?.text || message?.content || "";
          p.resolve(text);
          pending.delete(runId);
        } else if (state === "error" || state === "aborted") {
          p.reject(new Error(`chat ${state}: ${frame.payload?.errorMessage || ""}`));
          pending.delete(runId);
        }
      }
    } catch {}
  });

  ws.on("error", (err) => {
    log(`❌ Gateway WS 오류: ${err.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  /**
   * JSON-RPC 요청 전송
   */
  const request = (method, params) => {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  };

  /**
   * chat.inject: assistant 포맷으로 컨텍스트 주입 (AI 호출 없음)
   * user 메시지 → "[USER] ..." 형태로 주입
   * bot 응답   → "[봇이름] ..." 형태로 주입
   */
  const inject = (sessionKey, message, label) => {
    return request("chat.inject", { sessionKey, message, label });
  };

  /**
   * chat.send: AI 응답 생성 (deliver:false → 채널 전송 없음)
   * 응답을 스트리밍으로 수신하며 onDelta 콜백으로 청크 전달
   */
  const send = (sessionKey, message, idempotencyKey, onDelta) => {
    return new Promise((resolve, reject) => {
      // chat.send 먼저 요청 → runId 받음
      const reqId = randomUUID();
      pending.set(reqId, {
        resolve: (payload) => {
          // chat.send 응답에 runId 포함 → 해당 runId로 스트리밍 추적
          const runId = payload?.runId;
          if (runId) {
            pending.set(runId, { resolve, reject, onDelta });
          } else {
            resolve(payload);
          }
        },
        reject,
      });
      ws.send(JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: idempotencyKey || randomUUID(),
        },
      }));
    });
  };

  const close = () => ws.close();

  return { ws, request, inject, send, close, pending };
}

/**
 * WebSocket 연결이 열릴 때까지 대기
 */
function waitForOpen(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error("WS 연결 타임아웃")), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ══════════════════════════════════════════════════
// 대화 히스토리 로드 (Firestore)
// ══════════════════════════════════════════════════

async function loadGroupHistory(db, groupId, maxMessages = 50) {
  const messagesRef = collection(db, "groups", groupId, "messages");
  const q = query(messagesRef, where("status", "in", ["sent", "done"]), orderBy("order", "desc"), limit(maxMessages));
  const snap = await getDocs(q);
  return snap.docs.map(d => {
    const data = d.data();
    const prefix = data.type === "bot" ? `[${data.senderName}] ` : "[USER] ";
    return prefix + data.text;
  }).reverse();
}

// ══════════════════════════════════════════════════
// 봇 요청 처리: shouldRespond 분기
// ══════════════════════════════════════════════════

async function handleBotRequest(db, groupId, reqData, reqRef) {
  const sessionKey = groupId; // sessionKey = Firestore group chat ID
  const gw = createGatewayWS();

  try {
    await waitForOpen(gw.ws);

    // ── shouldRespond: false → chat.inject로 컨텍스트만 주입 ──
    if (!reqData.shouldRespond) {
      const contextMsg = reqData.senderType === "user"
        ? `[USER] ${reqData.message}`
        : `[${reqData.senderName || "봇"}] ${reqData.message}`;

      await gw.inject(sessionKey, contextMsg, reqData.firestoreDocId);
      await updateDoc(reqRef, {
        status: "injected",
        injectedAt: new Date().toISOString(),
      });
      log(`📥 [${reqData.targetPetName}] 컨텍스트 주입 완료: ${contextMsg.slice(0, 50)}`);
      return;
    }

    // ── shouldRespond: true → chat.send로 AI 응답 생성 ──
    const messagesRef = collection(db, "groups", groupId, "messages");

    // 스트리밍 메시지 문서 생성 (streaming 상태)
    const msgRef = await addDoc(messagesRef, {
      senderPetId: reqData.targetPetId,
      senderUid: reqData.targetUid || "",
      senderName: reqData.targetPetName || "",
      senderImage: reqData.targetImage || "",
      text: "",
      type: "bot",
      status: "streaming",
      createdAt: new Date().toISOString(),
      order: Date.now(),
      orchestrationId: reqData.orchestrationId || "",
    });

    await updateDoc(reqRef, { status: "processing", messageId: msgRef.id });

    // 히스토리를 포함한 지시 메시지 구성
    const history = reqData.history || [];
    const historyText = history.length > 0
      ? `\n\n[대화 흐름]\n${history.join("\n")}`
      : "";
    const fullMessage = `${reqData.message}${historyText}`;

    let fullContent = "";
    let lastFlush = Date.now();

    // chat.send: 스트리밍 수신, delta마다 Firestore 업데이트
    const finalContent = await gw.send(
      sessionKey,
      fullMessage,
      msgRef.id, // idempotencyKey = Firestore doc ID
      async (chunk) => {
        fullContent += chunk;
        const now = Date.now();
        if (now - lastFlush > 500) {
          await updateDoc(msgRef, { text: fullContent });
          lastFlush = now;
        }
      }
    );

    // final content로 덮어쓰기
    const content = finalContent || fullContent;
    await updateDoc(msgRef, {
      text: content,
      status: "done",
      completedAt: new Date().toISOString(),
    });
    await updateDoc(reqRef, {
      status: "done",
      response: content,
      completedAt: new Date().toISOString(),
    });

    log(`✓ 봇 응답 완료: ${reqData.targetPetName} (${content.length}자)`);

  } catch (e) {
    if (reqData.shouldRespond) {
      // 응답 실패 시 에러 메시지 기록
      try {
        const messagesRef = collection(db, "groups", groupId, "messages");
        const msgSnap = await getDocs(query(messagesRef,
          where("orchestrationId", "==", reqData.orchestrationId || ""),
          where("status", "==", "streaming"), limit(1)));
        if (!msgSnap.empty) {
          await updateDoc(msgSnap.docs[0].ref, { text: `⚠️ 응답 실패: ${e.message}`, status: "error" });
        }
      } catch {}
    }
    await updateDoc(reqRef, { status: "error", error: e.message });
    log(`❌ 봇 요청 실패: ${reqData.targetPetName} — ${e.message}`);
  } finally {
    gw.close();
  }
}

// ══════════════════════════════════════════════════
// 마스터봇 오케스트레이터 프롬프트
// ══════════════════════════════════════════════════

function buildOrchestratorPrompt(members, masterPetId) {
  const botList = members
    .map(m => `- ${m.petName} (petId: ${m.petId})${m.petId === masterPetId ? " [마스터봇/너]" : ""}`)
    .join("\n");

  return `You are a group chat orchestrator bot. You MUST respond with ONLY a JSON object, nothing else.

Group member bots:
${botList}

Analyze the conversation and respond with exactly one JSON object:

Option 1 - Route to another bot:
{"action":"route","targetPetIds":["petId1"],"message":"instruction for the bot","goal":"purpose"}

Option 2 - You respond directly:
{"action":"respond","message":"your response in Korean","goal":"purpose"}

Option 3 - Conversation complete:
{"action":"complete","message":"completion message in Korean","goal":"achieved purpose"}

Rules:
- OUTPUT ONLY VALID JSON. No other text.
- When user mentions a specific bot name, use "route" to that bot's petId.
- For simple greetings or general chat, use "respond" and reply in Korean.
- targetPetIds must contain only valid petIds from the member list.`;
}

// ══════════════════════════════════════════════════
// 마스터봇 오케스트레이션
// ══════════════════════════════════════════════════

async function runOrchestration(db, groupId, group, userMsg, msgDoc) {
  const members = group.members || [];
  const masterPetId = group.masterPetId;
  const masterMember = members.find(m => m.petId === masterPetId);
  if (!masterMember) { log(`❌ 그룹 ${groupId}: 마스터봇 없음`); return; }

  await updateDoc(msgDoc.ref, { status: "done" });

  const orchRef = await addDoc(collection(db, "groups", groupId, "orchestrations"), {
    triggerMessageId: msgDoc.id,
    status: "active",
    goal: "",
    participantPetIds: [],
    turnCount: 0,
    maxTurns: 100,
    createdAt: new Date().toISOString(),
    ttlExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  const orchId = orchRef.id;
  log(`🎭 오케스트레이션 시작: ${orchId}`);

  const consecutiveBotCalls = {};
  let turnCount = 0;
  const orchStart = Date.now();

  try {
    let history = await loadGroupHistory(db, groupId);

    // ── Phase 1: 유저 메시지를 전체 봇에 컨텍스트 주입 ──
    const otherMembers = members.filter(m => m.petId !== masterPetId);
    if (otherMembers.length > 0) {
      log(`📡 전체 봇에 유저 메시지 컨텍스트 주입 (${otherMembers.length}명)`);
      await Promise.all(otherMembers.map(async (m) => {
        const reqRef = await addDoc(collection(db, "groups", groupId, "botRequests"), {
          targetPetId: m.petId,
          targetUid: m.uid,
          targetPetName: m.petName,
          targetImage: m.profileImage || "",
          message: userMsg.text,
          senderType: "user",
          senderName: "USER",
          firestoreDocId: msgDoc.id,
          shouldRespond: false,         // ★ 컨텍스트만 주입
          orchestrationId: orchId,
          groupId,
          status: "pending",
          createdAt: new Date().toISOString(),
        });

        // injected 될 때까지 대기 (최대 10초)
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 10000);
          const unsub = onSnapshot(reqRef, (snap) => {
            if (snap.data()?.status === "injected" || snap.data()?.status === "error") {
              clearTimeout(timeout); unsub(); resolve();
            }
          });
        });
      }));
      log(`✅ 전체 봇 컨텍스트 주입 완료`);
    }

    // ── Phase 2: 오케스트레이션 루프 ──
    while (turnCount < 100) {
      if (Date.now() - orchStart > 30 * 60 * 1000) {
        log(`⏰ TTL 초과: ${orchId}`); break;
      }

      turnCount++;
      await updateDoc(orchRef, { turnCount });

      // 마스터봇에게 다음 액션 판단 요청 (WS chat.send)
      const gw = createGatewayWS();
      let actionRaw = "";
      try {
        await waitForOpen(gw.ws);
        const systemPrompt = buildOrchestratorPrompt(members, masterPetId);
        const historyText = history.length > 0 ? `\n\n[대화 흐름]\n${history.join("\n")}` : "";
        const prompt = `${systemPrompt}${historyText}\n\n[현재 유저 메시지] ${userMsg.text}`;

        actionRaw = await gw.send(groupId, prompt, `orch-${orchId}-turn-${turnCount}`, null);
      } finally {
        gw.close();
      }

      // JSON 파싱
      let action;
      try {
        action = JSON.parse(actionRaw.trim());
      } catch {
        const jsonMatch = actionRaw.match(/\{[\s\S]*"action"\s*:[\s\S]*\}/);
        try {
          action = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: "respond", message: actionRaw, goal: "응답" };
        } catch {
          action = { action: "respond", message: actionRaw, goal: "응답" };
        }
      }

      if (action.goal) await updateDoc(orchRef, { goal: action.goal });
      log(`🎭 턴 ${turnCount}: action=${action.action}, target=${(action.targetPetIds || []).join(",")}`);

      // ── complete ──
      if (action.action === "complete") {
        if (action.message) {
          await addDoc(collection(db, "groups", groupId, "messages"), {
            senderPetId: masterPetId, senderUid: masterMember.uid,
            senderName: masterMember.petName, senderImage: masterMember.profileImage || "",
            text: action.message, type: "bot", status: "done",
            createdAt: new Date().toISOString(), order: Date.now(), orchestrationId: orchId,
          });
        }
        break;

      // ── respond (마스터봇 직접 응답) ──
      } else if (action.action === "respond") {
        await addDoc(collection(db, "groups", groupId, "messages"), {
          senderPetId: masterPetId, senderUid: masterMember.uid,
          senderName: masterMember.petName, senderImage: masterMember.profileImage || "",
          text: action.message || "", type: "bot", status: "done",
          createdAt: new Date().toISOString(), order: Date.now(), orchestrationId: orchId,
        });
        break;

      // ── route (봇에게 응답 요청) ──
      } else if (action.action === "route") {
        const targetPetIds = action.targetPetIds || [];
        const routeMessage = action.message || "";
        const participants = new Set((await getDoc(orchRef)).data()?.participantPetIds || []);

        for (const targetPetId of targetPetIds) {
          consecutiveBotCalls[targetPetId] = (consecutiveBotCalls[targetPetId] || 0) + 1;
          if (consecutiveBotCalls[targetPetId] > 3) {
            log(`⚠️ 봇 ${targetPetId} 연속 3회 초과, 스킵`); continue;
          }
          for (const k of Object.keys(consecutiveBotCalls)) {
            if (k !== targetPetId) consecutiveBotCalls[k] = 0;
          }

          const botMember = members.find(m => m.petId === targetPetId);
          if (!botMember) continue;
          participants.add(targetPetId);

          // shouldRespond: true → 해당 봇 응답 요청
          const reqRef = await addDoc(collection(db, "groups", groupId, "botRequests"), {
            targetPetId,
            targetUid: botMember.uid,
            targetPetName: botMember.petName,
            targetImage: botMember.profileImage || "",
            message: routeMessage,
            senderType: "master",
            senderName: masterMember.petName,
            shouldRespond: true,         // ★ 실제 응답 생성
            history: history.slice(-30),
            orchestrationId: orchId,
            groupId,
            status: "pending",
            createdAt: new Date().toISOString(),
          });

          log(`📨 봇 응답 요청: ${botMember.petName}`);

          // 응답 대기 (최대 60초)
          await new Promise((resolve) => {
            const timeout = setTimeout(() => { unsub(); resolve(); }, 60000);
            const unsub = onSnapshot(reqRef, (snap) => {
              const data = snap.data();
              if (data?.status === "done" || data?.status === "error") {
                clearTimeout(timeout); unsub();
                if (data.response) {
                  // Phase 3: 봇 응답을 나머지 봇들에 chat.inject로 주입
                  const responseText = `[${botMember.petName}] ${data.response}`;
                  const othersToInject = members.filter(m =>
                    m.petId !== masterPetId && m.petId !== targetPetId
                  );
                  Promise.all(othersToInject.map(async (m) => {
                    const injectRef = await addDoc(collection(db, "groups", groupId, "botRequests"), {
                      targetPetId: m.petId,
                      targetUid: m.uid,
                      targetPetName: m.petName,
                      message: responseText,
                      senderType: "bot",
                      senderName: botMember.petName,
                      firestoreDocId: data.messageId || "",
                      shouldRespond: false,   // ★ 컨텍스트만 주입
                      orchestrationId: orchId,
                      groupId,
                      status: "pending",
                      createdAt: new Date().toISOString(),
                    });
                  })).catch(() => {});
                  history.push(responseText);
                }
                resolve();
              }
            });
          });
        }

        await updateDoc(orchRef, { participantPetIds: [...participants] });
        history = await loadGroupHistory(db, groupId);

      } else {
        log(`⚠️ 알 수 없는 액션: ${action.action}`); break;
      }
    }

    await updateDoc(orchRef, {
      status: turnCount >= 100 ? "timeout" : "completed",
      completedAt: new Date().toISOString(), turnCount,
    });
    log(`✓ 오케스트레이션 완료: ${orchId} (${turnCount}턴)`);

  } catch (e) {
    log(`❌ 오케스트레이션 에러: ${orchId} — ${e.message}`);
    await updateDoc(orchRef, { status: "error", completedAt: new Date().toISOString(), turnCount });
  }
}

// ══════════════════════════════════════════════════
// 메인 리스너
// ══════════════════════════════════════════════════

export function listenGroupChats(db, uid, petId) {
  const groupsRef = collection(db, "groups");
  const q = query(groupsRef, where("memberUids", "array-contains", uid));

  const masterListeners = new Map();
  const botReqListeners = new Map();

  const unsubGroups = onSnapshot(q, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const groupId = change.doc.id;
      const groupData = change.doc.data();

      if (change.type === "removed") {
        masterListeners.get(groupId)?.(); masterListeners.delete(groupId);
        botReqListeners.get(groupId)?.(); botReqListeners.delete(groupId);
        continue;
      }

      // ── 마스터봇 리스너 ──
      if (groupData.masterPetId === petId && !masterListeners.has(groupId)) {
        log(`👥 [마스터] 그룹 리스너: ${groupData.name}`);
        const messagesRef = collection(db, "groups", groupId, "messages");
        const msgQ = query(messagesRef, where("type", "==", "user"), where("status", "==", "sent"));

        const unsub = onSnapshot(msgQ, async (msgSnap) => {
          for (const ch of msgSnap.docChanges()) {
            if (ch.type !== "added") continue;
            const msgDoc = ch.doc;
            log(`👥 [마스터] 메시지 수신: ${msgDoc.data().text?.slice(0, 50)}`);
            const groupSnap = await getDoc(doc(db, "groups", groupId));
            if (!groupSnap.exists()) continue;
            await runOrchestration(db, groupId, { id: groupId, ...groupSnap.data() }, msgDoc.data(), msgDoc);
          }
        });
        masterListeners.set(groupId, unsub);

      } else if (groupData.masterPetId !== petId) {
        masterListeners.get(groupId)?.(); masterListeners.delete(groupId);
      }

      // ── 봇 요청 리스너 (shouldRespond 분기 처리) ──
      if (!botReqListeners.has(groupId)) {
        const reqRef = collection(db, "groups", groupId, "botRequests");
        const reqQ = query(reqRef, where("targetPetId", "==", petId), where("status", "==", "pending"));

        const unsub = onSnapshot(reqQ, async (reqSnap) => {
          for (const ch of reqSnap.docChanges()) {
            if (ch.type !== "added") continue;
            const reqDoc = ch.doc;
            const reqData = reqDoc.data();
            const action = reqData.shouldRespond ? "응답" : "주입";
            log(`📥 [봇] 요청 수신 (${action}): ${reqData.message?.slice(0, 50)}`);
            await handleBotRequest(db, groupId, reqData, reqDoc.ref);
          }
        });
        botReqListeners.set(groupId, unsub);
        log(`👥 [봇] 요청 리스너: ${groupData.name}`);
      }
    }
  });

  log("👥 그룹 채팅 리스너 시작");

  return () => {
    unsubGroups();
    for (const u of masterListeners.values()) u();
    for (const u of botReqListeners.values()) u();
    masterListeners.clear();
    botReqListeners.clear();
  };
}
