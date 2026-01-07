const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const wss = new WebSocket.Server({ port: PORT });

const rooms = {};

wss.on("connection", (ws) => {
  ws.room = null;
  ws.nickname = null;

  ws.on("message", (raw) => {
    const data = JSON.parse(raw);

    if (data.type === "join") {
      ws.room = data.room;
      ws.nickname = data.nickname;

      if (!rooms[ws.room]) {
        rooms[ws.room] = new Set();
      }

      rooms[ws.room].add(ws);
      broadcastRoom(ws.room);
    }
  });

  ws.on("close", () => {
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room].delete(ws);
      if (rooms[ws.room].size === 0) {
        delete rooms[ws.room];
      } else {
        broadcastRoom(ws.room);
      }
    }
  });
});

function broadcastRoom(room) {
  const users = [...rooms[room]].map(c => c.nickname);

  const payload = JSON.stringify({
    type: "room_update",
    users
  });

  rooms[room].forEach(client => {
    client.send(payload);
  });
}

console.log("WebSocket server running");
