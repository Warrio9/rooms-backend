const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

/**
 * rooms[code] = {
 *   clients: Set<WebSocket>,
 *   locked: boolean,
 *   hostId: string|null,
 *
 *   phase: "lobby" | "answering" | "reveal" | "voting" | "results",
 *
 *   // answers
 *   answers: Map<clientId, { nickname: string, answer: string }>,
 *   shuffled: Array<{ id: string, ownerId: string, nickname: string, answer: string }>,
 *   revealCount: number, // for reveal phase (anonymous)
 *
 *   // voting
 *   votes: Map<clientId, string>, // clientId -> answerId
 *   tallies: Map<string, number>, // answerId -> voteCount
 *
 *   // scoring
 *   scores: Map<string, number>, // ownerId (clientId or "AI") -> score
 *
 *   // results reveal
 *   resultsRevealCount: number
 * }
 */

const rooms = {};

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      clients: new Set(),
      locked: false,
      hostId: null,

      phase: "lobby",

      answers: new Map(),
      shuffled: [],
      revealCount: 0,

      votes: new Map(),
      tallies: new Map(),

      scores: new Map(), // persistent across rounds unless reset

      resultsRevealCount: 0,
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

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function ensureScore(room, ownerId) {
  if (!room.scores.has(ownerId)) room.scores.set(ownerId, 0);
}

function computeTallies(room) {
  const t = new Map();
  for (const answerId of room.votes.values()) {
    t.set(answerId, (t.get(answerId) || 0) + 1);
  }
  room.tallies = t;
}

function applyScoring(room) {
  // rules:
  // - voter: +1 if voted AI, else -1
  // - owner: +1 for each vote their answer received (including AI if you want)
  for (const [voterId, answerId] of room.votes.entries()) {
    const picked = room.shuffled.find(a => a.id === answerId);
    if (!picked) continue;

    ensureScore(room, voterId);
    ensureScore(room, picked.ownerId);

    if (picked.ownerId === "AI") room.scores.set(voterId, room.scores.get(voterId) + 1);
    else room.scores.set(voterId, room.scores.get(voterId) - 1);

    room.scores.set(picked.ownerId, room.scores.get(picked.ownerId) + 1);
  }
}

function buildScoresPayload(room) {
  // return array of { id, name, score }
  const list = [];

  // Players (connected or known)
  for (const c of room.clients) {
    ensureScore(room, c.id);
    list.push({ id: c.id, name: c.nickname, score: room.scores.get(c.id) });
  }

  // AI
  ensureScore(room, "AI");
  list.push({ id: "AI", name: "AI", score: room.scores.get("AI") });

  // sort by score desc
  list.sort((a, b) => b.score - a.score);
  return list;
}

function buildSharedState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;

  const users = [...room.clients].map(c => c.nickname);

  // reveal phase: anonymous answers revealed one by one
  const revealedAnswers = (room.phase === "reveal")
    ? room.shuffled.slice(0, room.revealCount).map(a => ({ text: a.answer }))
    : [];

  // voting phase: all options available (anonymous)
  const voteOptions = (room.phase === "voting" || room.phase === "results")
    ? room.shuffled.map(a => ({ id: a.id, text: a.answer }))
    : [];

  // results phase: host reveals one-by-one
  const revealedResults = (room.phase === "results")
    ? room.shuffled.slice(0, room.resultsRevealCount).map(a => ({
        id: a.id,
        text: a.answer,
        votes: room.tallies.get(a.id) || 0,
        author: a.nickname,
        isAI: a.ownerId === "AI",
      }))
    : [];

  return {
    type: "room_update",
    room: roomCode,
    users,

    locked: room.locked,
    hostId: room.hostId,
    phase: room.phase,

    submittedCount: room.answers.size,
    totalPlayers: room.clients.size,

    revealCount: room.revealCount,
    totalAnswers: room.shuffled.length,
    revealedAnswers,

    voteOptions,
    totalVotes: room.votes.size,

    resultsRevealCount: room.resultsRevealCount,
    revealedResults,

    scores: buildScoresPayload(room),
  };
}

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

function resetRound(room) {
  room.answers.clear();
  room.shuffled = [];
  room.revealCount = 0;

  room.votes.clear();
  room.tallies.clear();

  room.resultsRevealCount = 0;
}

wss.on("connection", (ws) => {
  ws.id = genId();
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

      // init score
      ensureScore(room, ws.id);
      ensureScore(room, "AI");

      send(ws, { type: "you_are", clientId: ws.id });

      console.log("JOIN:", roomCode, nickname, "id=", ws.id, "host=", room.hostId);
      broadcastRoom(roomCode);
      return;
    }

    if (!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // ===== START GAME (HOST ONLY) =====
    if (data.type === "start_game") {
      if (ws.id !== room.hostId) {
        send(ws, { type: "error", message: "Only the host can start the game." });
        return;
      }

      room.locked = true;
      room.phase = "answering";
      resetRound(room);

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

      if (room.answers.has(ws.id)) {
        send(ws, { type: "submitted_ok" });
        return;
      }

      room.answers.set(ws.id, { nickname: ws.nickname, answer });
      send(ws, { type: "submitted_ok" });

      broadcastRoom(ws.room);

      const totalPlayers = room.clients.size;
      const submitted = room.answers.size;

      if (totalPlayers > 0 && submitted >= totalPlayers) {
        // Build shuffled answers + 1 fake AI answer
        room.shuffled = [...room.answers.entries()].map(([ownerId, v]) => ({
          id: genId(),
          ownerId,
          nickname: v.nickname,
          answer: v.answer,
        }));

        room.shuffled.push({
          id: genId(),
          ownerId: "AI",
          nickname: "AI",
          answer: "LOREM IPSUM (fake AI answer)",
        });

        shuffleInPlace(room.shuffled);

        room.phase = "reveal";
        room.revealCount = 0;

        console.log("ROUND_OVER -> REVEAL:", ws.room, "answers=", room.shuffled.length);
        room.clients.forEach(c => send(c, { type: "round_over" }));
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

        // When finished revealing -> voting starts
        if (room.revealCount >= room.shuffled.length) {
          room.phase = "voting";
          room.votes.clear();
          room.tallies.clear();
          room.resultsRevealCount = 0;
          console.log("REVEAL DONE -> VOTING:", ws.room);
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

      const picked = room.shuffled.find(a => a.id === answerId);
      if (!picked) return;

      // Optional anti-cheese: cannot vote for your own answer
      if (picked.ownerId === ws.id) {
        send(ws, { type: "error", message: "You cannot vote for your own answer." });
        return;
      }

      room.votes.set(ws.id, answerId);
      send(ws, { type: "vote_ok" });

      broadcastRoom(ws.room);

      // If all players voted -> compute score but DO NOT reveal results automatically
      const totalPlayers = room.clients.size;
      const votes = room.votes.size;

      if (totalPlayers > 0 && votes >= totalPlayers) {
        computeTallies(room);
        applyScoring(room);

        room.phase = "results";
        room.resultsRevealCount = 0;

        console.log("VOTING DONE -> RESULTS (host reveals):", ws.room);
        broadcastRoom(ws.room);
      }
      return;
    }

    // ===== NEXT RESULT (HOST ONLY) =====
    if (data.type === "next_result") {
      if (room.phase !== "results") return;

      if (ws.id !== room.hostId) {
        send(ws, { type: "error", message: "Only the host can reveal the next result." });
        return;
      }

      if (room.resultsRevealCount < room.shuffled.length) {
        room.resultsRevealCount += 1;
        broadcastRoom(ws.room);
      }
      return;
    }

    // ===== NEW ROUND (HOST ONLY) =====
    if (data.type === "new_round") {
      if (ws.id !== room.hostId) {
        send(ws, { type: "error", message: "Only the host can start a new round." });
        return;
      }

      // Keep room locked (no new players). Keep scores.
      room.phase = "answering";
      resetRound(room);

      console.log("NEW_ROUND:", ws.room);
      broadcastRoom(ws.room);
      return;
    }

    // ===== RESET GAME (HOST ONLY) =====
    if (data.type === "reset_game") {
      if (ws.id !== room.hostId) {
        send(ws, { type: "error", message: "Only the host can reset the game." });
        return;
      }

      // Unlock room, reset scores, go back to lobby (players stay connected)
      room.locked = false;
      room.phase = "lobby";
      resetRound(room);

      room.scores.clear();
      for (const c of room.clients) ensureScore(room, c.id);
      ensureScore(room, "AI");

      console.log("RESET_GAME:", ws.room);
      broadcastRoom(ws.room);
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.room || !rooms[ws.room]) return;

    const room = rooms[ws.room];
    room.clients.delete(ws);

    // remove their answer & vote if present
    room.answers.delete(ws.id);
    room.votes.delete(ws.id);

    maybeAssignNewHost(ws.room);

    if (room.clients.size === 0) {
      delete rooms[ws.room];
    } else {
      // If voting and someone leaves, we may now be "complete"
      if (room.phase === "voting") {
        const totalPlayers = room.clients.size;
        const votes = room.votes.size;
        if (totalPlayers > 0 && votes >= totalPlayers) {
          computeTallies(room);
          applyScoring(room);
          room.phase = "results";
          room.resultsRevealCount = 0;
        }
      }
      broadcastRoom(ws.room);
    }
  });
});

console.log("WebSocket server running on port", PORT);
