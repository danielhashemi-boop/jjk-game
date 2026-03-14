const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ── In-memory state ──
const rooms = {}; // roomCode -> { players: {pid -> playerData}, fights: {fightId -> fight} }
const leaderboard = []; // top players by kills

function getOrCreateRoom(code) {
  if (!rooms[code]) rooms[code] = { players: {}, fights: {} };
  return rooms[code];
}

function broadcast(room, msg, excludePid = null) {
  const data = JSON.stringify(msg);
  for (const pid in room.players) {
    if (pid === excludePid) continue;
    const p = room.players[pid];
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function broadcastRoom(roomCode, msg, excludePid = null) {
  const room = rooms[roomCode];
  if (!room) return;
  broadcast(room, msg, excludePid);
}

function updateLeaderboard(player) {
  const idx = leaderboard.findIndex(e => e.pid === player.playerId);
  const entry = { pid: player.playerId, name: player.name, kills: player.kills, level: player.level, clan: player.clan, tech: player.tech, techRarity: player.techRarity, ascensions: player.ascensions || 0 };
  if (idx >= 0) leaderboard[idx] = entry;
  else leaderboard.push(entry);
  leaderboard.sort((a, b) => b.kills - a.kills);
  if (leaderboard.length > 100) leaderboard.length = 100;
}

// ── REST endpoints ──

// Join / create room
app.post('/api/rooms/join', (req, res) => {
  const { name, roomCode } = req.body;
  if (!name || !roomCode) return res.status(400).json({ error: 'Missing name or roomCode' });
  const room = getOrCreateRoom(roomCode);
  const playerId = uuidv4();
  const player = {
    playerId, name, roomCode,
    level: 1, xp: 0, maxXp: 100,
    hp: 100, maxHp: 100,
    ce: 100, maxCe: 100,
    str: 5, agi: 5, end: 5,
    spins: 3, coins: 0,
    kills: 0, trainCount: 0,
    clan: null, tech: null, techRarity: null, skills: [],
    ascensions: 0, xpMult: 1, coinMult: 1,
    rankIdx: 0,
    outfitId: null,
    ariseStacks: 0,
  };
  room.players[playerId] = { ...player, ws: null };
  res.json({ player });
});

// Save player state
app.post('/api/rooms/:code/save', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { player } = req.body;
  if (!player || !room.players[player.playerId]) return res.status(404).json({ error: 'Player not found' });
  const ws = room.players[player.playerId].ws;
  room.players[player.playerId] = { ...player, ws };
  updateLeaderboard(player);
  res.json({ ok: true });
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  res.json(leaderboard.slice(0, 50));
});

// Boss fight: Toji
app.post('/api/rooms/:code/pvp/boss', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { playerId } = req.body;
  const player = room.players[playerId];
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const fightId = uuidv4();
  const boss = {
    id: 'toji', name: 'Toji Zenin', hp: 2000, maxHp: 2000,
    atk: 45, def: 15, grade: 'Special Grade',
    rewards: { xp: 800, coins: 500, spins: 10 }
  };
  room.fights[fightId] = { fightId, type: 'boss', bossId: 'toji', boss, p1Id: playerId, log: [], turn: 'player', over: false };
  broadcastRoom(req.params.code, { type: 'pvp_start', fightId, p1Name: player.name, p2Name: 'Toji Zenin', isBoss: true });
  res.json({ fightId });
});

// Boss fight: Sukuna
app.post('/api/rooms/:code/pvp/boss/sukuna', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { playerId } = req.body;
  const player = room.players[playerId];
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const fightId = uuidv4();
  const boss = {
    id: 'sukuna', name: 'Ryomen Sukuna', hp: 5000, maxHp: 5000,
    atk: 120, def: 30, grade: 'King of Curses',
    rewards: { xp: 3000, coins: 2000, spins: 30 }
  };
  room.fights[fightId] = { fightId, type: 'boss', bossId: 'sukuna', boss, p1Id: playerId, log: [], turn: 'player', over: false };
  broadcastRoom(req.params.code, { type: 'pvp_start', fightId, p1Name: player.name, p2Name: 'Ryomen Sukuna', isBoss: true });
  res.json({ fightId });
});

// PvP challenge
app.post('/api/rooms/:code/pvp', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { challengerId, targetId } = req.body;
  const c = room.players[challengerId], t = room.players[targetId];
  if (!c || !t) return res.status(404).json({ error: 'Player not found' });
  const fightId = uuidv4();
  room.fights[fightId] = {
    fightId, type: 'pvp',
    p1Id: challengerId, p2Id: targetId,
    p1Hp: c.maxHp, p2Hp: t.maxHp,
    p1MaxHp: c.maxHp, p2MaxHp: t.maxHp,
    log: [], turn: 'p1', over: false
  };
  broadcastRoom(req.params.code, { type: 'pvp_start', fightId, p1Name: c.name, p2Name: t.name, p1Id: challengerId, p2Id: targetId });
  res.json({ fightId });
});

// Get fight state
app.get('/api/fights/:fightId', (req, res) => {
  for (const code in rooms) {
    const f = rooms[code].fights[req.params.fightId];
    if (f) {
      const room = rooms[code];
      const enriched = { ...f };
      if (f.type === 'pvp') {
        const p1 = room.players[f.p1Id], p2 = room.players[f.p2Id];
        enriched.p1Name = p1?.name; enriched.p2Name = p2?.name;
        enriched.p1Stats = { str: p1?.str, agi: p1?.agi, skills: p1?.skills, tech: p1?.tech };
        enriched.p2Stats = { str: p2?.str, agi: p2?.agi, skills: p2?.skills, tech: p2?.tech };
      }
      return res.json(enriched);
    }
  }
  res.status(404).json({ error: 'Fight not found' });
});

// Fight action (attack / skill)
app.post('/api/fights/:fightId/action', (req, res) => {
  const { playerId, action, skillIdx } = req.body;
  let fight = null, roomCode = null;
  for (const code in rooms) {
    if (rooms[code].fights[req.params.fightId]) { fight = rooms[code].fights[req.params.fightId]; roomCode = code; break; }
  }
  if (!fight || fight.over) return res.status(400).json({ error: 'Fight not found or over' });
  const room = rooms[roomCode];

  if (fight.type === 'boss') {
    const player = room.players[fight.p1Id];
    if (!player) return res.status(404).json({ error: 'Player not found' });
    // Player attacks boss
    let dmg = Math.max(1, (player.str || 5) * 2 + Math.floor(Math.random() * 20));
    if (action === 'skill' && player.skills && player.skills[skillIdx]) {
      const sk = player.skills[skillIdx];
      dmg = sk.dmg + Math.floor(Math.random() * sk.dmg * 0.3);
    }
    // Crit
    if (Math.random() < 0.1) { dmg = Math.floor(dmg * 1.5); fight.log.push({ text: `💥 CRITICAL! ${player.name} deals ${dmg} to ${fight.boss.name}!`, color: '#ff6b00' }); }
    else fight.log.push({ text: `⚔ ${player.name} hits ${fight.boss.name} for ${dmg}!`, color: '#e8dfc4' });
    fight.boss.hp = Math.max(0, fight.boss.hp - dmg);

    if (fight.boss.hp <= 0) {
      fight.over = true; fight.winner = 'player';
      const r = fight.boss.rewards;
      fight.log.push({ text: `🏆 ${player.name} defeated ${fight.boss.name}! +${r.xp} XP +${r.coins} coins +${r.spins} spins!`, color: '#d4a843' });
      broadcastRoom(roomCode, { type: 'pvp', fightId: fight.fightId, summary: `${player.name} defeated ${fight.boss.name}!` });
    } else {
      // Boss attacks back
      const bDmg = Math.max(1, fight.boss.atk - Math.floor((player.end || 5) * 0.5) + Math.floor(Math.random() * 20));
      fight.log.push({ text: `👁 ${fight.boss.name} strikes for ${bDmg}!`, color: '#ff4444' });
      // We track boss fight hp in fight object for display purposes
      if (!fight.playerHp) fight.playerHp = player.maxHp;
      fight.playerMaxHp = player.maxHp;
      fight.playerHp = Math.max(0, fight.playerHp - bDmg);
      if (fight.playerHp <= 0) {
        fight.over = true; fight.winner = 'boss';
        fight.log.push({ text: `💀 ${player.name} was defeated by ${fight.boss.name}...`, color: '#ff4444' });
        broadcastRoom(roomCode, { type: 'pvp', fightId: fight.fightId, summary: `${fight.boss.name} defeated ${player.name}!` });
      }
    }
    broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });
    return res.json({ fight: sanitizeFight(fight, room) });
  }

  if (fight.type === 'pvp') {
    const isP1 = fight.p1Id === playerId;
    const isP2 = fight.p2Id === playerId;
    if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this fight' });
    if ((fight.turn === 'p1' && !isP1) || (fight.turn === 'p2' && !isP2)) return res.status(400).json({ error: 'Not your turn' });

    const attacker = room.players[playerId];
    const defenderId = isP1 ? fight.p2Id : fight.p1Id;
    const defender = room.players[defenderId];
    let dmg = Math.max(1, (attacker.str || 5) * 2 + Math.floor(Math.random() * 15));
    if (action === 'skill' && attacker.skills && attacker.skills[skillIdx]) {
      const sk = attacker.skills[skillIdx];
      dmg = sk.dmg + Math.floor(Math.random() * sk.dmg * 0.25);
    }
    if (Math.random() < 0.1) { dmg = Math.floor(dmg * 1.5); fight.log.push({ text: `💥 CRIT! ${attacker.name} hits ${defender.name} for ${dmg}!`, color: '#ff6b00' }); }
    else fight.log.push({ text: `⚔ ${attacker.name} hits ${defender.name} for ${dmg}!`, color: '#e8dfc4' });

    if (isP1) fight.p2Hp = Math.max(0, fight.p2Hp - dmg);
    else fight.p1Hp = Math.max(0, fight.p1Hp - dmg);

    const p1Dead = fight.p1Hp <= 0, p2Dead = fight.p2Hp <= 0;
    if (p1Dead || p2Dead) {
      fight.over = true;
      const winner = p1Dead ? defender : attacker;
      const loser = p1Dead ? attacker : defender;
      fight.winner = p1Dead ? fight.p2Id : fight.p1Id;
      fight.log.push({ text: `🏆 ${winner.name} wins the duel!`, color: '#d4a843' });
      broadcastRoom(roomCode, { type: 'pvp', fightId: fight.fightId, summary: `${winner.name} defeated ${loser.name} in a duel!` });
    } else {
      fight.turn = fight.turn === 'p1' ? 'p2' : 'p1';
    }
    broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });
    return res.json({ fight: sanitizeFight(fight, room) });
  }
});

function sanitizeFight(fight, room) {
  const f = { ...fight };
  if (f.type === 'pvp') {
    f.p1Name = room.players[f.p1Id]?.name;
    f.p2Name = room.players[f.p2Id]?.name;
  }
  return f;
}

// ── WebSocket ──
wss.on('connection', (ws) => {
  let myPid = null, myRoom = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        myPid = msg.playerId; myRoom = msg.roomCode;
        const room = rooms[myRoom];
        if (!room || !room.players[myPid]) return;
        room.players[myPid].ws = ws;
        // Send current players
        const others = Object.values(room.players).filter(p => p.playerId !== myPid).map(sanitizePlayer);
        ws.send(JSON.stringify({ type: 'init', players: others }));
        broadcast(room, { type: 'join', name: room.players[myPid].name, playerId: myPid }, myPid);
        broadcast(room, { type: 'player_update', player: sanitizePlayer(room.players[myPid]) }, myPid);
      }
      if (msg.type === 'chat') {
        const room = rooms[myRoom];
        if (!room || !room.players[myPid]) return;
        broadcastRoom(myRoom, { type: 'chat', name: room.players[myPid].name, msg: msg.msg });
      }
      if (msg.type === 'player_update') {
        const room = rooms[myRoom];
        if (!room || !room.players[myPid]) return;
        const ws2 = room.players[myPid].ws;
        room.players[myPid] = { ...msg.player, ws: ws2, playerId: myPid };
        updateLeaderboard(msg.player);
        broadcast(room, { type: 'player_update', player: sanitizePlayer(room.players[myPid]) }, myPid);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (!myPid || !myRoom) return;
    const room = rooms[myRoom];
    if (!room || !room.players[myPid]) return;
    const name = room.players[myPid].name;
    delete room.players[myPid];
    broadcast(room, { type: 'leave', name, playerId: myPid });
    if (Object.keys(room.players).length === 0) delete rooms[myRoom];
  });
});

function sanitizePlayer(p) {
  const { ws, ...rest } = p;
  return rest;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`JJK Game running on port ${PORT}`));
