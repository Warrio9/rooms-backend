const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

/**
 * rooms[code] = {
 *   clients: Set<WebSocket>,
 *   locked: boolean,
 *   hostId: string | null,
 *   answers: Map<clientId, { nickname: string, answer: string }>,
 *   roundOver: boolean,
 *   shuffled: Array<{ nickname: string, answer: string }>,
 *   revealCount: number
 * }
 */
const rooms = {};

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      clients: new Set(),
      locked: false,
      hostId: null,
      answers: new Map(),
      roundOver: false,
      shuffled: [],
      revealCount: 0,
    };
  }
  return rooms[code];
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function buildSharedState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;

  const users = [...room.clients].map(c => c.nickname);

  const revealedAnswers = room.roundOver
    ? room.shuffled.slice(0, room.revealCount)
    : [];

  return {
    type: "room_update",
    room: roomCode,
    users,
    locked: room.locked,
    hostId: room.hostId,
    roundOver: room.roundOver,
    submittedCount: room.answers.size,
    totalPlayers: room.clients.size,
    revealedAnswers,
    revealCount: room.revealCount,
    totalAnswers: room.roundOver ? room.shuffled.length : 0,
  };
}

/**
 * IMPORTANT: room_update is personalized per-client via "youSubmitted"
 * so everyone stays in sync correctly.
 */
function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const shared = buildSharedState(roomCode);

  room.clients.forEach(client => {
    const youSubmitted = room.answers.has(client.id);
    send(client, { ...shared, youSubmitted });
  });
}

function maybeAssignNewHost(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const hostStillHere = [...room.clients].some(c => c.id === room.hostId);
  if (room.hostId && hostStillHere) return;

  const first = [...room.clients][0];
  room.hostId = first ? first.id : null;
}

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.room = null;
  ws.nickname = null;

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ===== JOIN =====
    if (data.type === "join") {
      const roomCode = String(data.room || "LOBBY").trim().toUpperCase();
      const nickname = String(data.nickname || "Anonymous").trim().slice(0, 18);

      const room = getRoom(roomCode);

      if (room.locked) {
        send(ws, { type: "join_rejected", reason: "Game already started. Room is locked." });
        ws.close();
        return;
      }

      ws.room = roomCode;
      ws.nickname = nickname;
      room.clients.add(ws);

      if (!room.hostId) room.hostId = ws.id;

      console.log("JOIN:", roomCode, nickname, "id=", ws.id, "host=", room.hostId);

      send(ws, { type: "you_are", clientId: ws.id });
      broadcastRoom(roomCode);
      return;
    }

    // ignore everything until joined
    if (!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // ===== START GAME (HOST ONLY) =====
    if (data.type === "start_game") {
      if (ws.id !== room.hostId) {
        send(ws, { type: "error", message: "Only the host can start the game." });
        return;
      }

      room.locked = true;
      room.answers.clear();
      room.roundOver = false;
      room.shuffled = [];
      room.revealCount = 0;

      console.log("START_GAME:", ws.room, "by", ws.nickname);
      broadcastRoom(ws.room);
      return;
    }

    // ===== SUBMIT ANSWER =====
    if (data.type === "submit_answer") {
      if (!room.locked) {
        send(ws, { type: "error", message: "Game not started yet." });
        return;
      }
      if (room.roundOver) {
        send(ws, { type: "error", message: "Round is already over." });
        return;
      }

      const answer = String(data.answer || "").trim();
      if (!answer) return;

      // prevent multiple submissions changing the count logic unpredictably
      if (room.answers.has(ws.id)) {
        send(ws, { type: "submitted_ok" });
        return;
      }

      room.answers.set(ws.id, { nickname: ws.nickname, answer });
      send(ws, { type: "submitted_ok" });

      const totalPlayers = room.clients.size;
      const submitted = room.answers.size;

      console.log("ANSWER:", ws.room, ws.nickname, `(${submitted}/${totalPlayers})`);

      broadcastRoom(ws.room);

      // Round ends when everyone currently connected has submitted
      if (totalPlayers > 0 && submitted >= totalPlayers) {
        room.roundOver = true;

        room.shuffled = [...room.answers.values()];
        shuffleInPlace(room.shuffled);
        room.revealCount = 0;

        console.log("ROUND_OVER:", ws.room, "answers=", room.shuffled.length);

        room.clients.forEach(client => send(client, { type: "round_over" }));
        broadcastRoom(ws.room);
      }
      return;
    }

    // ===== NEXT ANSWER (HOST ONLY) =====
    if (data.type === "next_answer") {
      if (!room.roundOver) return;

      if (ws.id !== room.hostId) {
        send(ws, { type: "error", message: "Only the host can reveal the next answer." });
        return;
      }

      if (room.revealCount < room.shuffled.length) {
        room.revealCount += 1;
        console.log("REVEAL_NEXT:", ws.room, `${room.revealCount}/${room.shuffled.length}`);
        broadcastRoom(ws.room);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.room || !rooms[ws.room]) return;

    const room = rooms[ws.room];
    room.clients.delete(ws);

    // If someone leaves mid-round, remove their answer too
    room.answers.delete(ws.id);

    maybeAssignNewHost(ws.room);

    if (room.clients.size === 0) {
      delete rooms[ws.room];
    } else {
      broadcastRoom(ws.room);
    }
  });
});

console.log("WebSocket server running on port", PORT);
