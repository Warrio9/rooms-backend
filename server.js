const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

/**
 * rooms[code] = {
 *   clients: Set<WebSocket>,
 *   locked: boolean,
 *   hostId: string | null,
 *   answers: Map<clientId, string>,
 *   roundOver: boolean
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
    };
  }
  return rooms[code];
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const users = [...room.clients].map(c => c.nickname);

  const payload = {
    type: "room_update",
    room: roomCode,
    users,
    locked: room.locked,
    hostId: room.hostId,
    roundOver: room.roundOver,
    submittedCount: room.answers.size
  };

  room.clients.forEach(client => send(client, payload));
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
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // ===== JOIN =====
    if (data.type === "join") {
      const roomCode = String(data.room || "LOBBY").trim().toUpperCase();
      const nickname = String(data.nickname || "Anonymous").trim();

      const room = getRoom(roomCode);

      if (room.locked) {
        send(ws, { type: "join_rejected", reason: "Game already started. Room is locked." });
        ws.close();
        return;
      }

      ws.room = roomCode;
      ws.nickname = nickname;

      room.clients.add(ws);

      if (!room.hostId) {
        room.hostId = ws.id;
      }

      console.log("JOIN:", roomCode, nickname, "id=", ws.id, "host=", room.hostId);

      // Tell this client its id (so it can know if it's host)
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
      if (room.roundOver) return;

      const answer = String(data.answer || "").trim();
      if (!answer) return;

      room.answers.set(ws.id, answer);

      const totalPlayers = room.clients.size;
      const submitted = room.answers.size;

      console.log("ANSWER:", ws.room, ws.nickname, `(${submitted}/${totalPlayers})`);

      broadcastRoom(ws.room);

      if (totalPlayers > 0 && submitted >= totalPlayers) {
        room.roundOver = true;
        console.log("ROUND_OVER:", ws.room);

        room.clients.forEach(client => send(client, { type: "round_over" }));
        broadcastRoom(ws.room);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.room || !rooms[ws.room]) return;

    const room = rooms[ws.room];
    room.clients.delete(ws);
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
