const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

// ── HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'public', 'air-hockey.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ── WEBSOCKET ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// rooms: Map<code, { host: ws, guest: ws|null }>
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj));
}

wss.on('connection', ws => {
  ws._code = null;
  ws._role = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── HOST creates room ──────────────────────────────────────────
      case 'create': {
        const code = String(msg.code).trim();
        if (!code || rooms.has(code)) {
          send(ws, { type: 'error', text: 'Room already exists or invalid code' });
          return;
        }
        rooms.set(code, { host: ws, guest: null });
        ws._code = code;
        ws._role = 'host';
        send(ws, { type: 'created', code });
        console.log(`[+] Room ${code} created`);
        break;
      }

      // ── GUEST joins room ───────────────────────────────────────────
      case 'join': {
        const code = String(msg.code).trim();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', text: 'Room not found. Check the code!' });
          return;
        }
        if (room.guest) {
          send(ws, { type: 'error', text: 'Room is full!' });
          return;
        }
        room.guest = ws;
        ws._code   = code;
        ws._role   = 'guest';

        const guestName = String(msg.name || 'Guest').slice(0, 20);
        const hostName  = String(room.host._name || 'Host').slice(0, 20);

        // Tell guest they joined — send host's name as opponent
        send(ws, { type: 'joined', code, hostName });

        // Tell host guest joined — send guest's name as opponent
        send(room.host, { type: 'opponent_joined', opponentName: guestName });

        // Store name on host socket for future reference
        ws._name = guestName;
        console.log(`[+] Room ${code}: ${guestName} joined`);
        break;
      }

      // ── PADDLE position (relayed to opponent) ──────────────────────
      // Both host and guest send 'my_paddle' with normalised x,y (0..1)
      // Server relays it to the other player as 'opponent_paddle'
      case 'my_paddle': {
        const room = rooms.get(ws._code);
        if (!room) return;
        const opponent = ws._role === 'host' ? room.guest : room.host;
        send(opponent, { type: 'opponent_paddle', x: msg.x, y: msg.y });
        break;
      }

      // ── PUCK state (host → guest) ──────────────────────────────────
      case 'puck_state': {
        const room = rooms.get(ws._code);
        if (!room || ws._role !== 'host') return;
        send(room.guest, { type: 'puck_state', px: msg.px, py: msg.py, vx: msg.vx, vy: msg.vy });
        break;
      }

      // ── GOAL (host → guest) ────────────────────────────────────────
      case 'goal': {
        const room = rooms.get(ws._code);
        if (!room || ws._role !== 'host') return;
        send(room.guest, {
          type: 'goal',
          scorer_is_guest: msg.scorer_is_guest,
          s_guest: msg.s_guest,
          s_host:  msg.s_host,
          game_over: msg.game_over
        });
        break;
      }

      // ── GAME OVER (host → guest) ───────────────────────────────────
      case 'game_over': {
        const room = rooms.get(ws._code);
        if (!room || ws._role !== 'host') return;
        send(room.guest, { type: 'game_over', s_guest: msg.s_guest, s_host: msg.s_host });
        break;
      }

      // ── RESTART ────────────────────────────────────────────────────
      case 'restart': {
        const room = rooms.get(ws._code);
        if (!room) return;
        // Tell both players to restart
        send(room.host,  { type: 'restart_ok' });
        send(room.guest, { type: 'restart_ok' });
        break;
      }

      // ── KEEP-ALIVE ─────────────────────────────────────────────────
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  // Store name when creating
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'create' && msg.name) ws._name = String(msg.name).slice(0, 20);
    } catch {}
  });

  ws.on('close', () => {
    const code = ws._code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const opponent = ws._role === 'host' ? room.guest : room.host;
    send(opponent, { type: 'opponent_left' });
    rooms.delete(code);
    console.log(`[-] Room ${code} closed`);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`✅  Air Hockey server on port ${PORT}`);
});
