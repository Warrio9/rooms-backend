const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

/**
 * rooms[code] = {
 *   clients: Set<WebSocket>,
 *   locked: boolean,
 *   hostId: string | null,
 *
 *   // Answering / reveal
 *   answers: Map<clientId, { nickname: string, answer: string }>,
 *   roundOver: boolean,
 *   shuffled: Array<{ id: string, ownerId: string, nickname: string, answer: string }>,
 *   revealCount: number,
 *
 *   // Voting / results
 *   phase: "lobby" | "answering" | "reveal" | "voting" | "results",
 *   votes: Map<clientId, string>, // clientId -> answerId
 *   tallies: Map<string, number>  // answerId -> count
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

      phase: "lobby",
      votes: new Map(),
      tallies: new Map(),
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

function computeTallies(room) {
  const tallies = new Map();
  for (const v of room.votes.values()) {
    tallies.set(v, (tallies.get(v) || 0) + 1);
  }
  room.tallies = tallies;
}

function buildSharedState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;

  const users = [...room.clients].map(c => c.nickname);

  // Reveal: send revealed subset, including nickname (you can hide nickname later easily)
  const revealedAnswers = (room.phase === "reveal" || room.phase === "voting" || room.phase === "results")
    ? room.shuffled.slice(0, room.revealCount).map(a => ({ answer: a.answer, nickname: a.nickname }))
    : [];

  // Voting: send all options, anonymous (text + id)
  const voteOptions = (room.phase === "voting" || room.phase === "results")
    ? room.shuffled.map(a => ({ id: a.id, text: a.answer }))
    : [];

  // Results: send counts per answer id
  const results = (room.phase === "results")
    ? room.shuffled.map(a => ({
        id: a.id,
        text: a.answer,
        votes: room.tallies.get(a.id) || 0
      }))
    : [];

  return {
    type: "room_update",
    room: roomCode,
    users,

    locked: room.locked,
    hostId: room.hostId,

    phase: room.phase,

    // Answering stats
    submittedCount: room.answers.size,
    totalPlayers: room.clients.size,

    // Reveal state
    revealedAnswers,
    revealCount: room.revealCount,
    totalAnswers: room.shuffled.length,

    // Voting
    voteOptions,

    // Results
    results
  };
}

/**
 * IMPORTANT: room_update is personalized per-client via youSubmitted/youVoted
 */
function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const shared = buildSharedState(roomCode);

  room.clients.forEach(client => {
    const youSubmitted = room.answers.has(client.id);
    const youVoted = room.votes.has(client.id);
    const yourVote = room.votes.get(client.id) || null;

    send(client, { ...shared, youSubmitted, youVoted, yourVote });
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

function genAnswerId() {
  return Math.random().toString(36).slice(2, 10);
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

      room.votes.clear();
      room.tallies.clear();

      room.phase = "answering";

      console.log("START_GAME:", ws.room, "by", ws.nickname);
      broadcastRoom(ws.room);
      return;
    }

    // ===== SUBMIT ANSWER =====
    if (data.type === "submit_answer") {
      if (!room.locked || room.phase !== "answering") {
        send(ws, { type: "error", message: "Game not started yet." });
        return;
      }

      const answer = String(data.answer || "").trim();
      if (!answer) return;

      // Only allow one submission
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

      if (totalPlayers > 0 && submitted >= totalPlayers) {
        // round over -> create shuffled reveal list
        room.roundOver = true;

        room.shuffled = [...room.answers.entries()].map(([ownerId, v]) => ({
          id: genAnswerId(),
          ownerId,
          nickname: v.nickname,
          answer: v.answer
        }));

        shuffleInPlace(room.shuffled);
        room.revealCount = 0;
        room.phase = "reveal";

        console.log("ROUND_OVER:", ws.room, "answers=", room.shuffled.length);

        room.clients.forEach(client => send(client, { type: "round_over" }));
        broadcastRoom(ws.room);
      }
      return;
    }

    // ===== NEXT ANSWER (HOST ONLY) =====
    if (data.type === "next_answer") {
      if (room.phase !== "reveal") return;

      if (ws.id !== room.hostId) {
        send(ws, { type: "error", message: "Only the host can reveal the next answer." });
        return;
      }

      if (room.revealCount < room.shuffled.length) {
        room.revealCount += 1;
        console.log("REVEAL_NEXT:", ws.room, `${room.revealCount}/${room.shuffled.length}`);

        // If reveal finished, move to voting
        if (room.revealCount >= room.shuffled.length) {
          room.phase = "voting";
          console.log("PHASE -> VOTING:", ws.room);
        }

        broadcastRoom(ws.room);
      }
      return;
    }

    // ===== SUBMIT VOTE =====
    if (data.type === "submit_vote") {
      if (room.phase !== "voting") {
        send(ws, { type: "error", message: "Voting is not active." });
        return;
      }

      if (room.votes.has(ws.id)) {
        send(ws, { type: "vote_ok" });
        return;
      }

      const answerId = String(data.answerId || "").trim();
      if (!answerId) return;

      // Validate answerId exists
      const picked = room.shuffled.find(a => a.id === answerId);
      if (!picked) return;

      // Optional rule: disallow voting for your own answer
      if (picked.ownerId === ws.id) {
        send(ws, { type: "error", message: "You cannot vote for your own answer." });
        return;
      }

      room.votes.set(ws.id, answerId);
      send(ws, { type: "vote_ok" });

      console.log("VOTE:", ws.room, ws.nickname, "->", answerId);

      broadcastRoom(ws.room);

      // If everyone voted, go to results
      const totalPlayers = room.clients.size;
      const votes = room.votes.size;
      if (totalPlayers > 0 && votes >= totalPlayers) {
        computeTallies(room);
        room.phase = "results";
        console.log("PHASE -> RESULTS:", ws.room);
        broadcastRoom(ws.room);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.room || !rooms[ws.room]) return;

    const room = rooms[ws.room];
    room.clients.delete(ws);

    // if they leave, remove their answer/vote
    room.answers.delete(ws.id);
    room.votes.delete(ws.id);

    maybeAssignNewHost(ws.room);

    if (room.clients.size === 0) {
      delete rooms[ws.room];
    } else {
      // If voting, results threshold changes as people leave; we can auto-finish if now complete
      if (room.phase === "voting") {
        const totalPlayers = room.clients.size;
        const votes = room.votes.size;
        if (totalPlayers > 0 && votes >= totalPlayers) {
          computeTallies(room);
          room.phase = "results";
        }
      }
      broadcastRoom(ws.room);
    }
  });
});

console.log("WebSocket server running on port", PORT);
