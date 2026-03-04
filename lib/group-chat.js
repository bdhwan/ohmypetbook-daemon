import { collection, doc, getDoc, updateDoc, onSnapshot, query, where, orderBy, getDocs, addDoc, limit, deleteDoc } from "firebase/firestore";
import { CONFIG_FILE, OPENCLAW_HOME } from "./config.js";
import { log } from "./log.js";
import fs from "fs";
import path from "path";

// ── Gateway 유틸 ──

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
    return { url: `http://127.0.0.1:${port}`, token };
  } catch {
    return { url: "http://127.0.0.1:18789", token: "" };
  }
}

async function callGateway(messages, user, stream = true) {
  const { url, token } = getGatewayConfig();
  const resp = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ model: "openclaw", messages, stream, user }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gateway ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp;
}

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

// ── 대화 히스토리 로드 ──

async function loadGroupHistory(db, groupId, maxMessages = 50) {
  const messagesRef = collection(db, "groups", groupId, "messages");
  const q = query(messagesRef, where("status", "in", ["sent", "done"]), orderBy("order", "desc"), limit(maxMessages));
  const snap = await getDocs(q);
  return snap.docs.map(d => {
    const data = d.data();
    const role = data.type === "user" ? "user" : "assistant";
    const prefix = data.type === "bot" ? `[${data.senderName}] ` : "";
    return { role, content: prefix + data.text };
  }).reverse();
}

// ── 봇 응답: 자기 gateway로 스트리밍 → Firestore 메시지에 기록 ──

async function handleBotRequest(db, groupId, reqData, reqRef) {
  const messagesRef = collection(db, "groups", groupId, "messages");

  // 메시지 문서 생성 (streaming)
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

  try {
    await updateDoc(reqRef, { status: "processing", messageId: msgRef.id });

    const botMessages = [
      { role: "system", content: `너는 "${reqData.targetPetName}"이다. 그룹 대화에서 요청받은 내용에 응답해라.` },
      ...(reqData.history || []),
      { role: "user", content: reqData.message },
    ];

    const resp = await callGateway(botMessages, `group-bot-${reqData.targetPetId}`, true);
    let fullContent = "";
    let lastFlush = Date.now();

    for await (const chunk of parseSSE(resp)) {
      fullContent += chunk;
      const now = Date.now();
      if (now - lastFlush > 500 || fullContent.length % 200 < chunk.length) {
        await updateDoc(msgRef, { text: fullContent });
        lastFlush = now;
      }
    }

    await updateDoc(msgRef, { text: fullContent, status: "done", completedAt: new Date().toISOString() });
    await updateDoc(reqRef, { status: "done", response: fullContent, completedAt: new Date().toISOString() });
    log(`✓ 봇 응답 완료: ${reqData.targetPetName} (${fullContent.length}자)`);
  } catch (e) {
    await updateDoc(msgRef, { text: `⚠️ 응답 실패: ${e.message}`, status: "error" });
    await updateDoc(reqRef, { status: "error", error: e.message, completedAt: new Date().toISOString() });
    log(`❌ 봇 응답 실패: ${reqData.targetPetName} — ${e.message}`);
  }
}

// ── 마스터봇 오케스트레이션 프롬프트 ──

function buildOrchestratorPrompt(members, masterPetId) {
  const botList = members
    .map(m => `- ${m.petName} (petId: ${m.petId})${m.petId === masterPetId ? " [마스터봇/너]" : ""}`)
    .join("\n");

  return `You are a group chat orchestrator bot. You MUST respond with ONLY a JSON object, nothing else. No explanation, no markdown, no text before or after the JSON.

Group member bots:
${botList}

Analyze the user's message and respond with exactly one JSON object:

Option 1 - Route to another bot:
{"action":"route","targetPetIds":["petId1"],"message":"instruction for the bot","goal":"purpose"}

Option 2 - You respond directly:
{"action":"respond","message":"your response in Korean","goal":"purpose"}

Option 3 - Conversation complete:
{"action":"complete","message":"completion message in Korean","goal":"achieved purpose"}

Rules:
- OUTPUT ONLY VALID JSON. No other text whatsoever.
- When user mentions a specific bot name, use "route" to that bot's petId.
- For simple greetings or general chat, use "respond" and reply in Korean.
- The "message" field in "respond" and "complete" should be in Korean (natural, friendly tone).
- targetPetIds must contain only valid petIds from the member list above.`;
}

// ── 마스터봇: 오케스트레이션 실행 ──

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
  log(`🎭 오케스트레이션 시작: ${orchId} (그룹: ${group.name})`);

  const consecutiveBotCalls = {};
  let turnCount = 0;
  const orchStart = Date.now();

  try {
    let history = await loadGroupHistory(db, groupId);

    while (turnCount < 100) {
      // TTL 체크 (30분)
      if (Date.now() - orchStart > 30 * 60 * 1000) {
        log(`⏰ 오케스트레이션 TTL 초과: ${orchId}`);
        break;
      }

      turnCount++;
      await updateDoc(orchRef, { turnCount });

      // 마스터봇에게 판단 요청 (non-streaming JSON)
      const systemPrompt = buildOrchestratorPrompt(members, masterPetId);
      const resp = await callGateway(
        [{ role: "system", content: systemPrompt }, ...history],
        `group-orchestrator-${orchId}`,
        false
      );
      const result = await resp.json();
      const content = result.choices?.[0]?.message?.content || "";

      let action;
      try {
        // Try direct parse first
        action = JSON.parse(content.trim());
      } catch {
        // Try extracting JSON from markdown code block or surrounding text
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                          content.match(/(\{[\s\S]*"action"\s*:\s*"[^"]+[\s\S]*\})/);
        if (jsonMatch) {
          try {
            action = JSON.parse(jsonMatch[1].trim());
          } catch {
            log(`⚠️ JSON 추출 실패: ${content.slice(0, 200)}`);
            action = { action: "respond", message: content, goal: "응답" };
          }
        } else {
          log(`⚠️ JSON 없음 (텍스트 응답): ${content.slice(0, 100)}`);
          action = { action: "respond", message: content, goal: "응답" };
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

      // ── route (봇에게 전달 — Firestore 메시지 큐) ──
      } else if (action.action === "route") {
        const targetPetIds = action.targetPetIds || [];
        const routeMessage = action.message || "";
        const participants = new Set((await getDoc(orchRef)).data()?.participantPetIds || []);

        for (const targetPetId of targetPetIds) {
          consecutiveBotCalls[targetPetId] = (consecutiveBotCalls[targetPetId] || 0) + 1;
          if (consecutiveBotCalls[targetPetId] > 3) {
            log(`⚠️ 봇 ${targetPetId} 연속 3회 초과, 스킵`);
            continue;
          }
          for (const k of Object.keys(consecutiveBotCalls)) {
            if (k !== targetPetId) consecutiveBotCalls[k] = 0;
          }

          const botMember = members.find(m => m.petId === targetPetId);
          if (!botMember) { log(`⚠️ 봇 ${targetPetId} 없음`); continue; }
          participants.add(targetPetId);

          // botRequests 문서 생성 → 해당 봇 daemon이 감지하여 처리
          const reqRef = await addDoc(collection(db, "groups", groupId, "botRequests"), {
            targetPetId,
            targetUid: botMember.uid,
            targetPetName: botMember.petName,
            targetImage: botMember.profileImage || "",
            message: routeMessage,
            history: history.slice(-30), // 최근 30개만 전달
            orchestrationId: orchId,
            groupId,
            status: "pending",
            createdAt: new Date().toISOString(),
          });

          log(`📨 봇 요청 생성: ${botMember.petName} (${reqRef.id})`);

          // 응답 대기 (최대 60초)
          await new Promise((resolve) => {
            const timeout = setTimeout(() => { unsub(); resolve(); }, 60000);
            const unsub = onSnapshot(reqRef, (snap) => {
              const data = snap.data();
              if (data?.status === "done" || data?.status === "error") {
                clearTimeout(timeout);
                unsub();
                if (data.response) {
                  history.push({ role: "assistant", content: `[${botMember.petName}] ${data.response}` });
                }
                resolve();
              }
            });
          });
        }

        await updateDoc(orchRef, { participantPetIds: [...participants] });
        // 최신 히스토리 다시 로드
        history = await loadGroupHistory(db, groupId);

      } else {
        log(`⚠️ 알 수 없는 액션: ${action.action}`);
        break;
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
// 메인 리스너: 마스터봇 역할 + 봇 요청 응답 역할 모두 처리
// ══════════════════════════════════════════════════

export function listenGroupChats(db, uid, petId) {
  const groupsRef = collection(db, "groups");
  const q = query(groupsRef, where("memberUids", "array-contains", uid));

  const masterListeners = new Map();   // 마스터봇으로서 메시지 감시
  const botReqListeners = new Map();   // 내 petId 대상 봇 요청 감시

  const unsubGroups = onSnapshot(q, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const groupId = change.doc.id;
      const groupData = change.doc.data();

      if (change.type === "removed") {
        masterListeners.get(groupId)?.(); masterListeners.delete(groupId);
        botReqListeners.get(groupId)?.(); botReqListeners.delete(groupId);
        continue;
      }

      // ── 마스터봇 리스너 (이 pet이 마스터봇인 그룹만) ──
      if (groupData.masterPetId === petId && !masterListeners.has(groupId)) {
        log(`👥 [마스터] 그룹 리스너: ${groupData.name}`);
        const messagesRef = collection(db, "groups", groupId, "messages");
        const msgQ = query(messagesRef, where("type", "==", "user"), where("status", "==", "sent"));

        const unsub = onSnapshot(msgQ, async (msgSnap) => {
          for (const ch of msgSnap.docChanges()) {
            if (ch.type !== "added") continue;
            const msgDoc = ch.doc;
            log(`👥 [마스터] 메시지 수신: ${msgDoc.data().text?.slice(0, 50)}...`);
            const groupSnap = await getDoc(doc(db, "groups", groupId));
            if (!groupSnap.exists()) continue;
            await runOrchestration(db, groupId, { id: groupId, ...groupSnap.data() }, msgDoc.data(), msgDoc);
          }
        });
        masterListeners.set(groupId, unsub);
      } else if (groupData.masterPetId !== petId) {
        masterListeners.get(groupId)?.(); masterListeners.delete(groupId);
      }

      // ── 봇 요청 리스너 (내 petId 대상 요청 감시) ──
      if (!botReqListeners.has(groupId)) {
        const reqRef = collection(db, "groups", groupId, "botRequests");
        const reqQ = query(reqRef, where("targetPetId", "==", petId), where("status", "==", "pending"));

        const unsub = onSnapshot(reqQ, async (reqSnap) => {
          for (const ch of reqSnap.docChanges()) {
            if (ch.type !== "added") continue;
            const reqDoc = ch.doc;
            const reqData = reqDoc.data();
            log(`📥 [봇] 요청 수신: ${reqData.message?.slice(0, 50)}... (from 그룹)`);
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
