const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ================= 游戏常量 ================= */
const WORLD = { xMin: -16, xMax: 16, yMin: -10, yMax: 10 };
const TMAX = 42;
const STEP = 0.02;
const HIT_RADIUS = 0.75;
const DAMAGE = 25;

/* ================= 静态文件 ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ================= 工具 ================= */
const rnd = (a, b) => a + Math.random() * (b - a);

const BANNED = /[;{}]|=>|\.\.|function|window|document|globalThis|eval|fetch|import|this|constructor|__proto__|process|require|global|with/i;

const MATH_NAMES = Object.getOwnPropertyNames(Math)
  .filter(k => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k));
const DESTRUCTURE = `const { ${MATH_NAMES.join(', ')} } = Math;`;

function compile(expr) {
  let src = String(expr).trim();
  if (!src) throw new Error('表达式为空');
  if (src.length > 120) throw new Error('表达式过长');
  if (BANNED.test(src)) throw new Error('包含不允许的内容');
  src = src.replace(/\^/g, '**');

  let fn;
  try {
    fn = new Function(`"use strict"; ${DESTRUCTURE} return function(x) { return (${src}); };`)();
  } catch (e) {
    throw new Error('语法错误');
  }
  const probe = fn(1.7);
  if (typeof probe !== 'number') throw new Error('结果不是数字');
  return fn;
}

function trace(fn, px, py, obstacles) {
  const segs = [];
  let cur = [];

  for (let t = -TMAX; t <= TMAX; t += STEP) {
    let y;
    try { y = fn(t); } catch (e) { y = NaN; }

    if (typeof y !== 'number' || !isFinite(y)) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
      continue;
    }

    const X = px + t;
    const Y = py + y;

    if (X < WORLD.xMin - 0.6 || X > WORLD.xMax + 0.6 ||
        Y < WORLD.yMin - 0.6 || Y > WORLD.yMax + 0.6) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
      continue;
    }

    let blocked = false;
    for (const o of obstacles) {
      const dx = X - o.x, dy = Y - o.y;
      if (dx * dx + dy * dy < o.r * o.r) { blocked = true; break; }
    }
    if (blocked) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
      continue;
    }

    cur.push([+X.toFixed(3), +Y.toFixed(3)]);
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

function checkHit(segs, shooter, players) {
  const target = players[1 - shooter];
  const R2 = HIT_RADIUS * HIT_RADIUS;
  for (const seg of segs) {
    for (const [x, y] of seg) {
      const dx = x - target.x, dy = y - target.y;
      if (dx * dx + dy * dy < R2) return { x, y };
    }
  }
  return null;
}

function generateObstacles(players) {
  const obs = [];
  let guard = 0;
  while (obs.length < 3 && guard++ < 400) {
    const o = {
      x: +rnd(-7.5, 7.5).toFixed(2),
      y: +rnd(-7, 7).toFixed(2),
      r: +rnd(1.2, 2.3).toFixed(2),
    };
    if (obs.some(q => Math.hypot(q.x - o.x, q.y - o.y) < q.r + o.r + 1.4)) continue;
    if (players.some(p => Math.hypot(p.x - o.x, p.y - o.y) < o.r + 3.2)) continue;
    obs.push(o);
  }
  return obs;
}

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ================= 房间 ================= */
const rooms = new Map();
let trailCounter = 0;

class Room {
  constructor(id) {
    this.id = id;
    this.players = [];
    this.current = 0;
    this.phase = 'waiting'; // waiting | aim | firing | over
    this.obstacles = [];
    this.winner = null;
    this.fireTimer = null;
  }

  addPlayer(ws) {
    if (this.players.length >= 2) return -1;
    const idx = this.players.length;
    this.players.push({
      ws,
      name: idx === 0 ? '蓝方' : '红方',
      color: idx === 0 ? '#4da3ff' : '#ff5c5c',
      x: 0, y: 0, hp: 100,
    });
    ws.roomId = this.id;
    ws.playerIndex = idx;
    return idx;
  }

  getState() {
    return {
      players: this.players.map(p => ({
        name: p.name,
        color: p.color,
        x: +p.x.toFixed(2),
        y: +p.y.toFixed(2),
        hp: p.hp,
      })),
      current: this.current,
      phase: this.phase,
      obstacles: this.obstacles,
      winner: this.winner,
    };
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players) {
      if (p.ws.readyState === 1) p.ws.send(s);
    }
  }

  start() {
    this.players[0].x = +rnd(-11, -8.5).toFixed(2);
    this.players[0].y = +rnd(-5.5, 5.5).toFixed(2);
    this.players[1].x = +rnd(8.5, 11).toFixed(2);
    this.players[1].y = +rnd(-5.5, 5.5).toFixed(2);
    this.players.forEach(p => { p.hp = 100; });
    this.obstacles = generateObstacles(this.players);
    this.current = 0;
    this.phase = 'aim';
    this.winner = null;
    if (this.fireTimer) { clearTimeout(this.fireTimer); this.fireTimer = null; }
    this.broadcast({ type: 'start', state: this.getState() });
  }

  handleFire(ws, expr) {
    if (this.phase !== 'aim') {
      ws.send(JSON.stringify({ type: 'error', msg: '当前不可开火' }));
      return;
    }
    if (ws.playerIndex !== this.current) {
      ws.send(JSON.stringify({ type: 'error', msg: '还没轮到你' }));
      return;
    }

    const p = this.players[this.current];
    let fn;
    try {
      fn = compile(expr);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', msg: e.message }));
      return;
    }

    const segs = trace(fn, p.x, p.y, this.obstacles);
    const total = segs.reduce((a, s) => a + s.length, 0);
    const dur = total >= 2
      ? Math.min(1.5, Math.max(0.35, 0.35 + total * 0.00045))
      : 0.3;

    this.phase = 'firing';

    let hit = null;
    if (total >= 2) {
      hit = checkHit(segs, this.current, this.players);
    }

    const trailId = ++trailCounter;
    this.broadcast({
      type: 'trail',
      id: trailId,
      segs: total >= 2 ? segs : [],
      color: p.color,
      shooter: this.current,
      dur,
      hit: hit ? { x: +hit.x.toFixed(2), y: +hit.y.toFixed(2), dmg: DAMAGE } : null,
    });

    if (hit) {
      const target = this.players[1 - this.current];
      target.hp = Math.max(0, target.hp - DAMAGE);
    }

    const delay = dur * 1000 + 400;
    this.fireTimer = setTimeout(() => {
      this.fireTimer = null;
      if (this.players[0].hp <= 0 || this.players[1].hp <= 0) {
        this.phase = 'over';
        this.winner = this.players[0].hp <= 0 ? 1 : 0;
      } else {
        this.current = 1 - this.current;
        this.phase = 'aim';
      }
      this.broadcast({ type: 'state', state: this.getState() });
    }, delay);
  }

  removePlayer(ws) {
    const idx = this.players.findIndex(p => p.ws === ws);
    if (idx === -1) return;
    this.players.splice(idx, 1);
    if (this.fireTimer) { clearTimeout(this.fireTimer); this.fireTimer = null; }
    for (const p of this.players) {
      if (p.ws.readyState === 1) {
        p.ws.send(JSON.stringify({ type: 'opponent_left' }));
      }
    }
    if (this.players.length === 0) {
      rooms.delete(this.id);
    }
  }
}

/* ================= WebSocket ================= */
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerIndex = -1;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    if (msg.type === 'create') {
      if (ws.roomId) return;
      let id;
      do { id = genRoomId(); } while (rooms.has(id));
      const room = new Room(id);
      rooms.set(id, room);
      const idx = room.addPlayer(ws);
      ws.send(JSON.stringify({ type: 'room', room: id, role: idx }));
      ws.send(JSON.stringify({ type: 'waiting' }));
      return;
    }

    if (msg.type === 'join') {
      if (ws.roomId) return;
      const id = String(msg.room || '').toUpperCase().trim();
      const room = rooms.get(id);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', msg: '房间不存在' }));
        return;
      }
      if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', msg: '房间已满' }));
        return;
      }
      const idx = room.addPlayer(ws);
      ws.send(JSON.stringify({ type: 'room', room: id, role: idx }));
      room.start();
      return;
    }

    const room = ws.roomId ? rooms.get(ws.roomId) : null;
    if (!room) return;

    if (msg.type === 'fire') {
      room.handleFire(ws, msg.expr);
      return;
    }

    if (msg.type === 'restart') {
      if (room.players.length === 2 && room.phase === 'over') {
        room.start();
      }
      return;
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) room.removePlayer(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`函数大战服务器已启动: http://localhost:${PORT}`);
});