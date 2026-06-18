require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const Database = require('better-sqlite3');
const { v4: uuid } = require('uuid');

const PORT = +(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_BOOTSTRAP_KEY = process.env.ADMIN_BOOTSTRAP_KEY || 'dev-admin-key';
const DATA = path.join(__dirname, '..', 'data', 'content');
const DB_PATH = process.env.DATABASE_PATH || './data/bettadayz.sqlite';

const load = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  } catch {
    return fallback;
  }
};

const catalog = load('catalog.json', {});
const bettabukz = load('bettabukz.json', {});
const economy = load('economy.json', {});
const dialogue = load('dialogue.json', {});
const patchNotes = load('patch-notes.json', []);

const JOBS = catalog.jobs || [
  { id: 'taxi', name: 'Taxi Driver', cashReward: 360, bettabukzReward: 6, xpReward: 90, durationMs: 30000 },
  { id: 'police', name: 'Police Patrol', cashReward: 460, bettabukzReward: 8, xpReward: 110, durationMs: 35000 },
  { id: 'delivery', name: 'Delivery Runner', cashReward: 300, bettabukzReward: 5, xpReward: 75, durationMs: 25000 }
];
const MISSIONS = catalog.missions || [
  { id: 'starter_activities', name: 'Street Starter', target: 3, cashReward: 750, bettabukzReward: 25, xpReward: 180 }
];
const BBZ_MAX_EARN_PER_DAY = bettabukz.economyControls?.maxEarnPerDay || 500;
const TIER_ORDER = ['free', 'bronze', 'silver', 'gold', 'platinum', 'founder'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode=WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  role TEXT DEFAULT 'player',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS players(
  user_id TEXT PRIMARY KEY,
  name TEXT,
  cash INTEGER,
  bettabukz INTEGER DEFAULT 0,
  member_tier TEXT DEFAULT 'free',
  x REAL,
  y REAL,
  appearance_json TEXT,
  inventory_json TEXT,
  garage_json TEXT DEFAULT '[]',
  quest_json TEXT DEFAULT '{}',
  settings_json TEXT DEFAULT '{}',
  xp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  last_daily INTEGER DEFAULT 0,
  daily_streak INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at INTEGER
);`);

function cols(table = 'players') {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

for (const [column, schema] of [
  ['bettabukz', 'bettabukz INTEGER DEFAULT 0'],
  ['member_tier', "member_tier TEXT DEFAULT 'free'"],
  ['daily_streak', 'daily_streak INTEGER DEFAULT 0'],
  ['job_state_json', "job_state_json TEXT DEFAULT '{}'"],
  ['mission_json', "mission_json TEXT DEFAULT '{}'"],
  ['bbz_earned_day', 'bbz_earned_day INTEGER DEFAULT 0'],
  ['bbz_earned_amount', 'bbz_earned_amount INTEGER DEFAULT 0']
]) {
  if (!cols().includes(column)) db.exec(`ALTER TABLE players ADD COLUMN ${schema}`);
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60000, max: 320 }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();
const players = {};
const actionBuckets = new Map();

const world = {
  zones: [
    { id: 'granby', name: 'Granby Row', type: 'commercial', x: 300, y: 250, radius: 120 },
    { id: 'neon', name: 'NEON Arts', type: 'creative', x: 620, y: 330, radius: 130 },
    { id: 'attucks', name: 'Attucks Quarter', type: 'culture', x: 830, y: 560, radius: 130 },
    { id: 'waterside', name: 'Waterside', type: 'luxury', x: 1150, y: 420, radius: 120 },
    { id: 'dealership', name: 'Betta Motors', type: 'dealership', x: 1320, y: 580, radius: 135 },
    { id: 'ov', name: 'Ocean View', type: 'beach', x: 1450, y: 850, radius: 150 },
    { id: 'karts', name: 'BettaKarts Luxury Arena', type: 'race', x: 1680, y: 520, radius: 160 }
  ],
  vehicles: [],
  npcs: [],
  catalog
};

for (let i = 0; i < 80; i++) {
  world.vehicles.push({
    id: uuid(),
    type: i % 4 === 0 ? 'lowrider' : i % 5 === 0 ? 'exotic' : 'tuner',
    color: i % 4 === 0 ? '#a855f7' : '#22d3ee',
    x: 100 + Math.random() * 1900,
    y: 100 + Math.random() * 1300,
    vx: 0,
    vy: 0,
    driverId: null
  });
}
for (let i = 0; i < 110; i++) {
  world.npcs.push({ id: uuid(), role: i % 10 ? 'civilian' : i % 3 ? 'rival' : 'mechanic', x: 50 + Math.random() * 2100, y: 50 + Math.random() * 1450 });
}

const sign = (id) => jwt.sign({ sub: id }, JWT_SECRET, { expiresIn: '7d' });
const verify = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
};
const send = (ws, type, payload) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type, payload }));
const sendToPlayer = (playerId, type, payload) => {
  for (const [ws, id] of clients) if (id === playerId) send(ws, type, payload);
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (p, arr, radius) => arr.filter((entity) => dist(p, entity) <= radius).sort((a, b) => dist(p, a) - dist(p, b))[0];

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function tier(id) {
  return (catalog.memberTiers || []).find((item) => item.id === id) || (catalog.memberTiers || [])[0] || { id: 'free', dailyBettaBukz: 10, cashBonusPct: 0, xpBonusPct: 0 };
}

function canTier(player, need) {
  return TIER_ORDER.indexOf(player.member_tier || 'free') >= TIER_ORDER.indexOf(need || 'free');
}

function audit(actorId, action, targetId, details = {}) {
  db.prepare('INSERT INTO audit_log(actor_id,action,target_id,details_json,created_at) VALUES(?,?,?,?,?)')
    .run(actorId || null, action, targetId || null, JSON.stringify(details), Date.now());
}

function authAdmin(req, res, next) {
  const claims = verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(claims.sub);
  if (!user || !['admin', 'moderator'].includes(user.role)) return res.status(403).json({ error: 'Forbidden' });
  req.user = user;
  next();
}

function allCatalog() {
  return [
    ...(catalog.vehicles || []),
    ...(catalog.homes || []),
    ...(catalog.luxuryAssets || []),
    ...(catalog.pets || []),
    ...(catalog.vip || []),
    ...(catalog.exclusivePurchases || []),
    ...(catalog.shops || []).flatMap((shop) => shop.items || [])
  ];
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    cash: p.cash,
    bettabukz: p.bettabukz,
    member_tier: p.member_tier,
    wanted: p.wanted,
    health: p.health,
    xp: p.xp,
    level: p.level,
    appearance: p.appearance,
    permission: p.rolePermission,
    garage: p.garage,
    vehicleId: p.vehicleId,
    daily_streak: p.daily_streak,
    job: p.jobState,
    missions: p.missions,
    bbzEarnedToday: p.bbz_earned_amount || 0
  };
}

function addXp(player, baseXp) {
  const tr = tier(player.member_tier);
  const amount = Math.max(0, Math.floor(baseXp * (1 + (tr.xpBonusPct || 0) / 100)));
  player.xp += amount;
  player.level = Math.max(1, Math.floor(player.xp / 500) + 1);
  return amount;
}

function award(player, source, rewards) {
  const tr = tier(player.member_tier);
  const cash = Math.max(0, Math.floor((rewards.cash || 0) * (1 + (tr.cashBonusPct || 0) / 100)));
  const day = Math.floor(Date.now() / 86400000);
  if (player.bbz_earned_day !== day) {
    player.bbz_earned_day = day;
    player.bbz_earned_amount = 0;
  }
  const requestedBbz = Math.max(0, Math.floor(rewards.bbz || 0));
  const allowedBbz = Math.max(0, Math.min(requestedBbz, BBZ_MAX_EARN_PER_DAY - player.bbz_earned_amount));
  const xp = addXp(player, rewards.xp || 0);

  player.cash += cash;
  player.bettabukz += allowedBbz;
  player.bbz_earned_amount += allowedBbz;
  audit(player.id, source, player.id, { cash, bbz: allowedBbz, xp });
  sendToPlayer(player.id, 'reward', { source, cash, bbz: allowedBbz, xp, capped: allowedBbz < requestedBbz });
  return { cash, bbz: allowedBbz, xp };
}

function defaultMissionState() {
  const mission = MISSIONS[0];
  return { activeId: mission.id, progress: 0, target: mission.target, completedCount: 0 };
}

function advanceStarterMission(player, amount = 1) {
  const mission = MISSIONS.find((item) => item.id === player.missions.activeId) || MISSIONS[0];
  player.missions.progress = Math.min(mission.target, (player.missions.progress || 0) + amount);
  if (player.missions.progress >= mission.target) {
    award(player, 'mission:complete', { cash: mission.cashReward, bbz: mission.bettabukzReward, xp: mission.xpReward });
    player.missions = { activeId: mission.id, progress: 0, target: mission.target, completedCount: (player.missions.completedCount || 0) + 1 };
    sendToPlayer(player.id, 'system', `${mission.name} complete. New starter mission started.`);
  }
}

function loadPlayer(id) {
  const row = db.prepare('SELECT p.*,u.role FROM players p JOIN users u ON u.id=p.user_id WHERE p.user_id=?').get(id);
  if (!row) return null;
  return {
    id,
    name: row.name,
    cash: row.cash,
    bettabukz: row.bettabukz || 0,
    member_tier: row.member_tier || 'free',
    x: row.x,
    y: row.y,
    appearance: parseJson(row.appearance_json, {}),
    inventory: parseJson(row.inventory_json, []),
    garage: parseJson(row.garage_json, []),
    quests: parseJson(row.quest_json, {}),
    settings: parseJson(row.settings_json, {}),
    jobState: parseJson(row.job_state_json, {}),
    missions: Object.assign(defaultMissionState(), parseJson(row.mission_json, {})),
    xp: row.xp || 0,
    level: row.level || 1,
    input: {},
    lastInputAt: Date.now(),
    lastPositionCheck: { x: row.x, y: row.y, at: Date.now() },
    violations: 0,
    wanted: 0,
    health: 100,
    rolePermission: row.role,
    vehicleId: null,
    lastShot: 0,
    last_daily: row.last_daily || 0,
    daily_streak: row.daily_streak || 0,
    bbz_earned_day: row.bbz_earned_day || 0,
    bbz_earned_amount: row.bbz_earned_amount || 0
  };
}

function savePlayer(player) {
  db.prepare(`UPDATE players SET
    cash=?, bettabukz=?, member_tier=?, x=?, y=?, inventory_json=?, garage_json=?,
    quest_json=?, settings_json=?, xp=?, level=?, last_daily=?, daily_streak=?,
    job_state_json=?, mission_json=?, bbz_earned_day=?, bbz_earned_amount=?
    WHERE user_id=?`)
    .run(
      Math.floor(player.cash),
      Math.floor(player.bettabukz),
      player.member_tier,
      player.x,
      player.y,
      JSON.stringify(player.inventory),
      JSON.stringify(player.garage),
      JSON.stringify(player.quests),
      JSON.stringify(player.settings || {}),
      player.xp || 0,
      player.level || 1,
      player.last_daily || 0,
      player.daily_streak || 0,
      JSON.stringify(player.jobState || {}),
      JSON.stringify(player.missions || defaultMissionState()),
      player.bbz_earned_day || 0,
      player.bbz_earned_amount || 0,
      player.id
    );
}

function limited(playerId, action, limit = 8, windowMs = 5000) {
  const now = Date.now();
  const key = `${playerId}:${action}`;
  const bucket = actionBuckets.get(key) || [];
  const fresh = bucket.filter((time) => now - time < windowMs);
  fresh.push(now);
  actionBuckets.set(key, fresh);
  return fresh.length > limit;
}

function startJob(player, jobId) {
  if (limited(player.id, 'job', 5, 10000)) return { error: 'Slow down before starting another job.' };
  const job = JOBS.find((item) => item.id === jobId);
  if (!job) return { error: 'Job not found.' };
  if (player.jobState?.active) return { error: `Already working ${player.jobState.jobName}.` };
  player.jobState = { active: true, jobId: job.id, jobName: job.name, startedAt: Date.now(), completed: 0 };
  audit(player.id, 'job:start', player.id, { jobId: job.id });
  return { ok: true, job };
}

function completeJob(player) {
  if (limited(player.id, 'jobComplete', 8, 10000)) return { error: 'Job action rate limited.' };
  const active = player.jobState || {};
  const job = JOBS.find((item) => item.id === active.jobId);
  if (!active.active || !job) return { error: 'No active job.' };
  if (Date.now() - active.startedAt < Math.max(5000, (job.durationMs || 20000) * 0.4)) return { error: 'Job needs more time in the city.' };
  const rewards = award(player, 'job:complete', { cash: job.cashReward, bbz: job.bettabukzReward, xp: job.xpReward });
  player.jobState = { active: false, lastJobId: job.id, lastCompletedAt: Date.now(), completed: (active.completed || 0) + 1 };
  advanceStarterMission(player, 1);
  audit(player.id, 'job:complete', player.id, { jobId: job.id, ...rewards });
  return { ok: true, job, rewards };
}

function buyVehicle(player, itemId) {
  if (limited(player.id, 'vehicleBuy', 5, 10000)) return { error: 'Purchase rate limited.' };
  const vehicle = (catalog.vehicles || []).find((item) => item.id === itemId);
  if (!vehicle) return { error: 'Vehicle not found.' };
  if (!canTier(player, vehicle.tierRequired || 'free')) return { error: `Requires ${vehicle.tierRequired} membership.` };
  const cash = Math.max(0, Math.floor(vehicle.price || vehicle.cashPrice || 0));
  const bbz = Math.max(0, Math.floor(vehicle.bettabukzPrice || 0));
  if (bbz > 0) {
    if (player.bettabukz < bbz) return { error: 'Not enough BettaBukz.' };
    player.bettabukz -= bbz;
  } else {
    if (player.cash < cash) return { error: 'Not enough cash.' };
    player.cash -= cash;
  }
  const owned = { id: uuid(), catalogId: vehicle.id, type: vehicle.class, name: vehicle.name, integrity: 100, purchasedAt: Date.now() };
  player.garage.push(owned);
  audit(player.id, 'dealership:buy', player.id, { item: vehicle.id, costCash: bbz > 0 ? 0 : cash, costBBZ: bbz });
  advanceStarterMission(player, 1);
  return { ok: true, vehicle: owned };
}

function handleAdmin(player, message) {
  if (!['admin', 'moderator'].includes(player.rolePermission)) return { error: 'Admin only.' };
  if (limited(player.id, 'admin', 15, 10000)) return { error: 'Admin action rate limited.' };
  if (message.type === 'admin:giveCash') {
    const target = players[message.targetId] || player;
    const amount = Math.max(-100000, Math.min(100000, Math.floor(Number(message.amount) || 0)));
    target.cash = Math.max(0, target.cash + amount);
    audit(player.id, 'admin:giveCash', target.id, { amount });
    savePlayer(target);
    sendToPlayer(target.id, 'system', `Admin adjusted cash by $${amount}.`);
    return { ok: true };
  }
  if (message.type === 'admin:spawnVehicle') {
    const kind = String(message.vehicleType || 'admin_cruiser').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    const vehicle = { id: uuid(), type: kind, color: '#facc15', x: player.x + 40, y: player.y + 30, vx: 0, vy: 0, driverId: null };
    world.vehicles.push(vehicle);
    audit(player.id, 'admin:spawnVehicle', player.id, { vehicleType: kind });
    return { ok: true, vehicle };
  }
  return { error: 'Unknown admin action.' };
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: '2.0.0-rp-platform', players: Object.keys(players).length }));
app.get('/api/content', (req, res) => res.json({ catalog, bettabukz, economy, dialogue, patchNotes }));
app.get('/api/catalog', (req, res) => res.json(catalog));
app.get('/api/bettabukz', (req, res) => res.json(bettabukz));
app.get('/api/leaderboard', (req, res) => {
  res.json(db.prepare('SELECT name,cash,bettabukz,member_tier,xp,level FROM players ORDER BY level DESC,cash DESC LIMIT 10').all());
});

app.post('/api/register', (req, res) => {
  try {
    const { username, password, name, gender } = req.body;
    if (!username || !password || password.length < 8) throw Error('Password needs 8+ chars.');
    if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) throw Error('Username exists');
    const id = uuid();
    const appearance = { gender: gender || 'male', complexion: 'brown', hairstyle: gender === 'female' ? 'braids' : 'clean fade', clothing: 'streetwear' };
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, username, bcrypt.hashSync(password, 10), 'player', Date.now());
    db.prepare(`INSERT INTO players(
      user_id,name,cash,bettabukz,member_tier,x,y,appearance_json,inventory_json,garage_json,
      quest_json,settings_json,xp,level,last_daily,daily_streak,job_state_json,mission_json,bbz_earned_day,bbz_earned_amount
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        name || username,
        economy.startingCash || 3250,
        bettabukz.currency?.startingBalance || 250,
        'free',
        140,
        120,
        JSON.stringify(appearance),
        JSON.stringify(['phone', 'wallet', 'starter_sidearm']),
        JSON.stringify([]),
        JSON.stringify({}),
        JSON.stringify({ showMinimap: true }),
        0,
        1,
        0,
        0,
        JSON.stringify({}),
        JSON.stringify(defaultMissionState()),
        Math.floor(Date.now() / 86400000),
        0
      );
    res.json({ token: sign(id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(req.body.username);
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(user.id) });
});

app.post('/api/admin/bootstrap', (req, res) => {
  if (req.body.key !== ADMIN_BOOTSTRAP_KEY) return res.status(403).json({ error: 'Invalid key' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(req.body.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
  audit(user.id, 'bootstrap_admin', user.id);
  res.json({ ok: true });
});

app.get('/api/admin/players', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT u.id,u.username,u.role,p.name,p.cash,p.bettabukz,p.member_tier,p.xp,p.level,p.daily_streak FROM users u JOIN players p ON p.user_id=u.id').all());
});
app.get('/api/admin/audit', authAdmin, (req, res) => res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 250').all()));

wss.on('connection', (ws, req) => {
  const claims = verify(new URL(req.url, 'http://x').searchParams.get('token') || '');
  if (!claims) return ws.close();
  const player = loadPlayer(claims.sub);
  if (!player) return ws.close();

  players[player.id] = player;
  clients.set(ws, player.id);
  send(ws, 'system', 'Welcome to BettaDayz RP Platform.');

  ws.on('message', (raw) => {
    if (String(raw).length > 4096) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const p = players[clients.get(ws)];
    if (!p) return;

    if (message.type !== 'input' && limited(p.id, message.type || 'unknown', 16, 4000)) {
      return send(ws, 'system', 'Action rate limited.');
    }

    if (message.type === 'input') {
      p.input = { up: !!message.up, down: !!message.down, left: !!message.left, right: !!message.right };
      p.lastInputAt = Date.now();
    }

    if (message.type === 'chat') {
      const text = String(message.text || '').replace(/[<>]/g, '').slice(0, 180);
      for (const [clientWs, id] of clients) if (dist(players[id], p) < 450) send(clientWs, 'chat', `${p.name}: ${text}`);
    }

    if (message.type === 'daily:claim') {
      const day = Math.floor(Date.now() / 86400000);
      if (p.last_daily !== day) {
        p.daily_streak = p.last_daily === day - 1 ? p.daily_streak + 1 : 1;
        p.last_daily = day;
        const tr = tier(p.member_tier);
        const cash = Math.floor((economy.dailyRewards?.baseCash || 250) * (1 + (p.daily_streak - 1) * 0.12) * (1 + (tr.cashBonusPct || 0) / 100));
        const bbz = (tr.dailyBettaBukz || 10) + Math.floor(p.daily_streak / 3) * 5;
        award(p, 'daily:claim', { cash, bbz, xp: 35 });
        advanceStarterMission(p, 1);
        savePlayer(p);
        send(ws, 'system', `Daily reward claimed. Streak ${p.daily_streak}.`);
      } else {
        send(ws, 'system', 'Daily already claimed.');
      }
    }

    if (message.type === 'member:buy') {
      const memberTier = (catalog.memberTiers || []).find((item) => item.id === message.tierId);
      if (memberTier && p.bettabukz >= memberTier.bettabukzCost) {
        p.bettabukz -= memberTier.bettabukzCost;
        p.member_tier = memberTier.id;
        audit(p.id, 'member:buy', p.id, { tier: memberTier.id, costBBZ: memberTier.bettabukzCost });
        savePlayer(p);
        send(ws, 'system', `Member tier unlocked: ${memberTier.name}.`);
      } else send(ws, 'system', 'Not enough BettaBukz for this tier.');
    }

    if (message.type === 'catalog:buy') {
      const item = allCatalog().find((entry) => entry.id === message.itemId);
      if (!item) return send(ws, 'system', 'Item not found.');
      if (!canTier(p, item.tierRequired || 'free')) return send(ws, 'system', `Requires ${item.tierRequired} membership.`);
      const bbz = Math.max(0, Math.floor(item.bettabukzPrice || 0));
      const cash = Math.max(0, Math.floor(item.price || item.cashPrice || 0));
      if (bbz > 0) {
        if (p.bettabukz < bbz) return send(ws, 'system', 'Not enough BettaBukz.');
        p.bettabukz -= bbz;
      } else {
        if (p.cash < cash) return send(ws, 'system', 'Not enough cash.');
        p.cash -= cash;
      }
      p.inventory.push(item.id);
      if (item.class) p.garage.push({ id: uuid(), catalogId: item.id, type: item.class, name: item.name, integrity: 100, purchasedAt: Date.now() });
      audit(p.id, 'purchase', p.id, { item: item.id, costCash: bbz > 0 ? 0 : cash, costBBZ: bbz });
      advanceStarterMission(p, 1);
      savePlayer(p);
      send(ws, 'system', `Purchased ${item.name}.`);
    }

    if (message.type === 'dealership:buy') {
      const result = buyVehicle(p, message.itemId);
      if (!result.ok) return send(ws, 'system', result.error);
      savePlayer(p);
      send(ws, 'system', `Purchased ${result.vehicle.name}. Added to garage.`);
    }

    if (message.type === 'job:start') {
      const result = startJob(p, message.jobId);
      if (!result.ok) return send(ws, 'system', result.error);
      savePlayer(p);
      send(ws, 'system', `Started ${result.job.name}. Complete it after making your city run.`);
    }

    if (message.type === 'job:complete') {
      const result = completeJob(p);
      if (!result.ok) return send(ws, 'system', result.error);
      savePlayer(p);
      send(ws, 'system', `Completed ${result.job.name}: +$${result.rewards.cash}, +${result.rewards.bbz} BBZ, +${result.rewards.xp} XP.`);
    }

    if (message.type === 'race:start') {
      const race = (catalog.races || []).find((item) => item.id === message.raceId) || (catalog.races || [])[0];
      if (race && p.cash >= race.entryFee) {
        p.cash -= race.entryFee;
        const win = Math.random() < 0.65;
        if (win) {
          award(p, 'race:start', { cash: race.rewardCash, bbz: race.rewardBettaBukz || 0, xp: race.rewardXp });
          send(ws, 'system', `Won ${race.name}!`);
        } else {
          addXp(p, Math.floor(race.rewardXp / 3));
          send(ws, 'system', `Finished ${race.name}.`);
        }
        advanceStarterMission(p, 1);
        savePlayer(p);
        audit(p.id, 'race:start', p.id, { race: race.id, entryFee: race.entryFee, win });
      } else send(ws, 'system', 'Not enough cash for race entry.');
    }

    if (message.type === 'vehicle') {
      if (p.vehicleId) {
        const vehicle = world.vehicles.find((item) => item.id === p.vehicleId);
        if (vehicle) vehicle.driverId = null;
        p.vehicleId = null;
        send(ws, 'system', 'Exited vehicle.');
      } else {
        const vehicle = near(p, world.vehicles.filter((item) => !item.driverId), 50);
        if (vehicle) {
          vehicle.driverId = p.id;
          p.vehicleId = vehicle.id;
          send(ws, 'system', `Entered ${vehicle.type}.`);
        } else send(ws, 'system', 'No vehicle nearby.');
      }
    }

    if (message.type === 'interact') {
      const zone = near(p, world.zones, 160);
      if (zone) {
        award(p, 'activity:complete', { cash: zone.type === 'race' ? 50 : zone.type === 'luxury' ? 140 : 110, bbz: 0, xp: 25 });
        advanceStarterMission(p, 1);
        savePlayer(p);
        send(ws, 'system', `Completed activity in ${zone.name}.`);
      } else send(ws, 'system', 'Nothing nearby.');
    }

    if (message.type === 'map:zone:add') {
      const zone = {
        id: uuid(),
        name: String(message.name || 'Custom Zone').replace(/[<>]/g, '').slice(0, 40),
        type: String(message.zoneType || 'custom').replace(/[^a-z0-9_-]/gi, '').slice(0, 24),
        x: Math.max(0, Math.min(2200, Number(message.x) || p.x)),
        y: Math.max(0, Math.min(1500, Number(message.y) || p.y)),
        radius: Math.max(40, Math.min(220, Number(message.radius) || 95)),
        creatorId: p.id
      };
      world.zones.push(zone);
      audit(p.id, 'map:zone:add', p.id, zone);
      send(ws, 'system', `Placed zone: ${zone.name}.`);
    }

    if (message.type === 'voice:signal') {
      const target = players[message.to];
      if (target && dist(p, target) < 300) sendToPlayer(target.id, 'voice:signal', { from: p.id, signal: message.signal });
    }

    if (message.type?.startsWith('admin:')) {
      const result = handleAdmin(p, message);
      send(ws, 'system', result.ok ? 'Admin action complete.' : result.error);
    }
  });

  ws.on('close', () => {
    savePlayer(player);
    delete players[player.id];
    clients.delete(ws);
  });
});

setInterval(() => {
  for (const p of Object.values(players)) {
    p.wanted = Math.max(0, p.wanted - 0.001);
    const before = { x: p.x, y: p.y };
    const dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);

    if (!p.vehicleId) {
      const len = Math.hypot(dx, dy) || 1;
      p.x += (dx / len) * 6;
      p.y += (dy / len) * 6;
    } else {
      const vehicle = world.vehicles.find((item) => item.id === p.vehicleId);
      if (vehicle) {
        vehicle.vx += dx * 1.4;
        vehicle.vy += dy * 1.4;
        vehicle.x += vehicle.vx;
        vehicle.y += vehicle.vy;
        vehicle.vx *= 0.94;
        vehicle.vy *= 0.94;
        p.x = vehicle.x;
        p.y = vehicle.y;
        if (Math.abs(dx) + Math.abs(dy) > 0) addXp(p, 1);
      }
    }

    p.x = Math.max(0, Math.min(2200, p.x));
    p.y = Math.max(0, Math.min(1500, p.y));
    const moved = Math.hypot(p.x - before.x, p.y - before.y);
    const maxFrameSpeed = p.vehicleId ? 36 : 9;
    if (moved > maxFrameSpeed) {
      p.x = before.x;
      p.y = before.y;
      p.violations += 1;
      if (p.violations % 5 === 0) sendToPlayer(p.id, 'system', 'Movement validation corrected an invalid position.');
    } else {
      p.violations = Math.max(0, p.violations - 0.02);
    }
  }

  const snap = {
    players: Object.fromEntries(Object.entries(players).map(([id, p]) => [id, publicPlayer(p)])),
    world
  };
  for (const [ws, id] of clients) send(ws, 'snapshot', { selfId: id, ...snap });
}, 50);

server.listen(PORT, () => console.log(`BettaDayz RP Platform running http://localhost:${PORT}`));
