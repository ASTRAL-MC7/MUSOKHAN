const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

// ── HTTP server (serves the HTML file) ──────────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'public', 'air-hockey.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

// ── WebSocket server ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// rooms: { roomCode: { host: ws, guest: ws | null } }
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role     = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── HOST creates a room ──────────────────────────────────────
      case 'create': {
        const code = msg.code;
        if (rooms.has(code)) {
          send(ws, { type: 'error', text: 'Room already exists' });
          return;
        }
        rooms.set(code, { host: ws, guest: null });
        ws.roomCode = code;
        ws.role = 'host';
        send(ws, { type: 'created', code });
        console.log(`Room created: ${code}`);
        break;
      }

      // ── GUEST joins a room ───────────────────────────────────────
      case 'join': {
        const code = msg.code;
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', text: 'Room not found' });
          return;
        }
        if (room.guest) {
          send(ws, { type: 'error', text: 'Room is full' });
          return;
        }
        room.guest  = ws;
        ws.roomCode = code;
        ws.role     = 'guest';

        const guestName = msg.name || 'Guest';
        const hostName  = msg.hostName || 'Host';

        // Tell guest they joined
        send(ws, { type: 'joined', code, role: 'guest', opponentName: hostName });
        // Tell host that guest joined
        send(room.host, { type: 'opponent_joined', opponentName: guestName });
        console.log(`Room ${code}: guest joined`);
        break;
      }

      // ── PADDLE position (sent every frame) ──────────────────────
      case 'paddle': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        // Forward to opponent
        const opponent = ws.role === 'host' ? room.guest : room.host;
        send(opponent, { type: 'paddle', x: msg.x, y: msg.y });
        break;
      }

      // ── PUCK state (host is authoritative) ──────────────────────
      case 'puck': {
        const room = rooms.get(ws.roomCode);
        if (!room || ws.role !== 'host') return;
        send(room.guest, {
          type: 'puck',
          x: msg.x, y: msg.y,
          vx: msg.vx, vy: msg.vy
        });
        break;
      }

      // ── GOAL scored ─────────────────────────────────────────────
      case 'goal': {
        const room = rooms.get(ws.roomCode);
        if (!room || ws.role !== 'host') return;
        send(room.guest, { type: 'goal', scorer: msg.scorer, s1: msg.s1, s2: msg.s2 });
        break;
      }

      // ── GAME OVER ───────────────────────────────────────────────
      case 'gameover': {
        const room = rooms.get(ws.roomCode);
        if (!room || ws.role !== 'host') return;
        send(room.guest, { type: 'gameover', s1: msg.s1, s2: msg.s2 });
        break;
      }

      // ── RESTART request ─────────────────────────────────────────
      case 'restart': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const opponent = ws.role === 'host' ? room.guest : room.host;
        send(opponent, { type: 'restart_request', from: ws.role });
        break;
      }

      case 'restart_ok': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        send(room.host, { type: 'restart_go' });
        send(room.guest, { type: 'restart_go' });
        break;
      }

      // ── PING / PONG (keep-alive) ─────────────────────────────────
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    // Notify opponent that player left
    const opponent = ws.role === 'host' ? room.guest : room.host;
    send(opponent, { type: 'opponent_left' });

    // Clean up room
    rooms.delete(code);
    console.log(`Room ${code} closed`);
  });

  ws.on('error', () => {});
});

httpServer.listen(PORT, () => {
  console.log(`✅ Air Hockey server running on port ${PORT}`);
});
