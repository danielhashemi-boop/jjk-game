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
    p1Ce: c.maxCe, p2Ce: t.maxCe,
    p1MaxCe: c.maxCe, p2MaxCe: t.maxCe,
    p1Move: null, p2Move: null,
    round: 0, log: [], over: false,
    p1Debuff: null, p2Debuff: null,
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
// ── RANKED SYSTEM ──
const RANKS_PVP = ['Bronze I','Bronze II','Bronze III','Silver I','Silver II','Silver III','Gold I','Gold II','Gold III','Platinum I','Platinum II','Diamond','Special Grade'];
const RANK_POINTS = {}; // pid -> points

function getRankFromPoints(pts) {
  const idx = Math.min(RANKS_PVP.length-1, Math.floor((pts||0)/100));
  return { rank: RANKS_PVP[idx], idx, pts: pts||0 };
}

function adjustRank(pid, won) {
  if (!RANK_POINTS[pid]) RANK_POINTS[pid] = 0;
  RANK_POINTS[pid] = Math.max(0, RANK_POINTS[pid] + (won ? 25 : -15));
  return getRankFromPoints(RANK_POINTS[pid]);
}

// ── FIGHT ACTION — Simultaneous system ──
// Both players submit their move, then resolve at same time
app.post('/api/fights/:fightId/action', (req, res) => {
  const { playerId, action, skillIdx } = req.body;
  let fight = null, roomCode = null;
  for (const code in rooms) {
    if (rooms[code].fights[req.params.fightId]) { fight = rooms[code].fights[req.params.fightId]; roomCode = code; break; }
  }
  if (!fight || fight.over) return res.status(400).json({ error: 'Fight not found or over' });
  const room = rooms[roomCode];

  // ── BOSS FIGHTS (unchanged logic, enhanced) ──
  if (fight.type === 'boss') {
    const player = room.players[fight.p1Id];
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (action === 'dodge') {
      fight.log.push({ text: `💨 ${player.name} dodges! Boss misses next turn!`, color: '#5dade2' });
      fight.bossMissNext = true;
      broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });
      return res.json({ fight: sanitizeFight(fight, room) });
    }
    if (action === 'block') {
      fight.blockNext = true;
      fight.log.push({ text: `🛡 ${player.name} braces for impact! Next hit reduced 60%!`, color: '#5dade2' });
      broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });
      return res.json({ fight: sanitizeFight(fight, room) });
    }
    let dmg = Math.max(1, (player.str || 5) * 2 + Math.floor(Math.random() * 20));
    if (action === 'skill' && player.skills && player.skills[skillIdx]) {
      const sk = player.skills[skillIdx];
      dmg = sk.dmg + Math.floor(Math.random() * sk.dmg * 0.3);
    }
    if (action === 'heavy') dmg = Math.floor(dmg * 1.8);
    const crit = Math.random() < 0.12;
    if (crit) { dmg = Math.floor(dmg * 1.6); fight.log.push({ text: `💥 CRIT! ${player.name} deals ${dmg}!`, color: '#ff6b00' }); }
    else fight.log.push({ text: `⚔ ${player.name} hits ${fight.boss.name} for ${dmg}!`, color: '#e8dfc4' });
    fight.boss.hp = Math.max(0, fight.boss.hp - dmg);
    if (fight.boss.hp <= 0) {
      fight.over = true; fight.winner = 'player';
      const r = fight.boss.rewards;
      fight.log.push({ text: `🏆 ${player.name} defeated ${fight.boss.name}! +${r.xp}XP +${r.coins} coins +${r.spins} spins!`, color: '#d4a843' });
      broadcastRoom(roomCode, { type: 'pvp', fightId: fight.fightId, summary: `${player.name} defeated ${fight.boss.name}!` });
    } else {
      if (!fight.bossMissNext) {
        let bDmg = Math.max(1, fight.boss.atk - Math.floor((player.end || 5) * 0.5) + Math.floor(Math.random() * 20));
        if (fight.blockNext) { bDmg = Math.floor(bDmg * 0.4); fight.log.push({ text: `🛡 Block absorbs damage! (${bDmg})`, color: '#5dade2' }); }
        else fight.log.push({ text: `👁 ${fight.boss.name} strikes for ${bDmg}!`, color: '#ff4444' });
        if (!fight.playerHp) fight.playerHp = player.maxHp;
        fight.playerMaxHp = player.maxHp;
        fight.playerHp = Math.max(0, fight.playerHp - bDmg);
        if (fight.playerHp <= 0) {
          fight.over = true; fight.winner = 'boss';
          fight.log.push({ text: `💀 ${player.name} was defeated!`, color: '#ff4444' });
          broadcastRoom(roomCode, { type: 'pvp', fightId: fight.fightId, summary: `${fight.boss.name} defeated ${player.name}!` });
        }
      } else {
        fight.log.push({ text: `💨 Boss swings and misses!`, color: '#5dade2' });
      }
      fight.bossMissNext = false; fight.blockNext = false;
    }
    broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });
    return res.json({ fight: sanitizeFight(fight, room) });
  }

  // ── PvP — SIMULTANEOUS SYSTEM ──
  if (fight.type === 'pvp' || fight.type === 'ranked') {
    const isP1 = fight.p1Id === playerId;
    const isP2 = fight.p2Id === playerId;
    if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this fight' });

    // Store the player's move
    if (isP1) fight.p1Move = { action, skillIdx };
    else fight.p2Move = { action, skillIdx };

    fight.log.push({ text: `⏳ ${room.players[playerId]?.name || '?'} locked in their move...`, color: '#7a6e5a' });
    broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });

    // If BOTH players have submitted, resolve the round
    if (fight.p1Move && fight.p2Move) {
      resolvePvpRound(fight, room, roomCode);
    }

    return res.json({ fight: sanitizeFight(fight, room) });
  }
});

function calcMoveDmg(player, move) {
  const base = (player.str || 5) * 2 + Math.floor(Math.random() * 15);
  if (move.action === 'attack') return base;
  if (move.action === 'heavy') return Math.floor(base * 2.2);
  if (move.action === 'skill' && player.skills && player.skills[move.skillIdx]) {
    const sk = player.skills[move.skillIdx];
    return sk.dmg + Math.floor(Math.random() * sk.dmg * 0.3);
  }
  if (move.action === 'domain') return Math.floor(base * 4);
  return 0;
}

function resolvePvpRound(fight, room, roomCode) {
  const p1 = room.players[fight.p1Id];
  const p2 = room.players[fight.p2Id];
  const m1 = fight.p1Move;
  const m2 = fight.p2Move;
  fight.p1Move = null; fight.p2Move = null;
  fight.round = (fight.round || 0) + 1;

  fight.log.push({ text: `━━ ROUND ${fight.round} ━━`, color: '#c9a227' });

  // ── CLASH DETECTION ──
  const bothAttacking = ['attack','heavy','skill','domain'].includes(m1.action) && ['attack','heavy','skill','domain'].includes(m2.action);
  if (bothAttacking && Math.random() < 0.2) {
    fight.log.push({ text: `⚡ TECHNIQUE CLASH! Cursed energy collides!`, color: 'rainbow' });
    const p1Power = calcMoveDmg(p1, m1);
    const p2Power = calcMoveDmg(p2, m2);
    const clashDmg = Math.floor(Math.min(p1Power, p2Power) * 0.3);
    fight.p1Hp = Math.max(0, fight.p1Hp - clashDmg);
    fight.p2Hp = Math.max(0, fight.p2Hp - clashDmg);
    fight.log.push({ text: `Both take ${clashDmg} from the clash!`, color: '#bb8fce' });
    fight.p1Move = null; fight.p2Move = null;
    checkPvpOver(fight, p1, p2, room, roomCode);
    broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });
    return;
  }

  // ── RESOLVE P1 MOVE vs P2 DEFENSE ──
  resolveMove(fight, p1, p2, m1, m2, 'p1', room, roomCode);
  if (!fight.over) resolveMove(fight, p2, p1, m2, m1, 'p2', room, roomCode);
  if (!fight.over) checkPvpOver(fight, p1, p2, room, roomCode);
  broadcastRoom(roomCode, { type: 'fight_update', fight: sanitizeFight(fight, room) });
}

function resolveMove(fight, attacker, defender, atkMove, defMove, side, room, roomCode) {
  const defHpKey = side === 'p1' ? 'p2Hp' : 'p1Hp';

  if (atkMove.action === 'dodge') {
    fight.log.push({ text: `💨 ${attacker.name} dashes back, creating distance!`, color: '#5dade2' });
    return;
  }
  if (atkMove.action === 'block') {
    fight.log.push({ text: `🛡 ${attacker.name} takes a defensive stance!`, color: '#5dade2' });
    return;
  }
  if (atkMove.action === 'taunt') {
    fight.log.push({ text: `😤 ${attacker.name} taunts ${defender.name}! Next round their guard drops!`, color: '#e8b84b' });
    if (side === 'p1') fight.p2Debuff = 'open'; else fight.p1Debuff = 'open';
    return;
  }

  // Calculate damage
  let dmg = calcMoveDmg(attacker, atkMove);
  const moveName = atkMove.action === 'skill' && attacker.skills?.[atkMove.skillIdx]
    ? attacker.skills[atkMove.skillIdx].name
    : atkMove.action === 'heavy' ? 'Heavy Strike'
    : atkMove.action === 'domain' ? 'Domain Expansion'
    : 'Basic Attack';

  // Debuff bonus
  const atkDebuff = side === 'p1' ? fight.p1Debuff : fight.p2Debuff;
  if (atkDebuff === 'open') { dmg = Math.floor(dmg * 1.4); fight.log.push({ text: `🎯 Opening exploit! +40% DMG!`, color: '#e8b84b' }); }
  if (side === 'p1') fight.p1Debuff = null; else fight.p2Debuff = null;

  // ── DEFENSE RESOLUTION ──
  if (defMove.action === 'dodge') {
    const dodgeSuccess = attacker.agi > defender.agi
      ? Math.random() < 0.35
      : Math.random() < 0.55;
    if (dodgeSuccess) {
      fight.log.push({ text: `💨 ${defender.name} dodges ${attacker.name}'s ${moveName}!`, color: '#5dade2' });
      // Counter window: dodger gets reduced damage counter
      const counterDmg = Math.floor((defender.str||5) * 1.5 + Math.random()*10);
      fight[defHpKey === 'p2Hp' ? 'p1Hp' : 'p2Hp'] = Math.max(0, fight[defHpKey === 'p2Hp' ? 'p1Hp' : 'p2Hp'] - counterDmg);
      fight.log.push({ text: `↩ ${defender.name} counters for ${counterDmg}!`, color: '#58d68d' });
      return;
    } else {
      fight.log.push({ text: `❌ ${defender.name} couldn't dodge in time!`, color: '#e74c3c' });
      dmg = Math.floor(dmg * 1.15); // punish failed dodge
    }
  } else if (defMove.action === 'block') {
    const blockMult = atkMove.action === 'heavy' ? 0.5 : 0.25;
    dmg = Math.floor(dmg * blockMult);
    fight.log.push({ text: `🛡 ${defender.name} blocks! Damage reduced to ${dmg}!`, color: '#5dade2' });
  } else if (defMove.action === 'domain' && atkMove.action !== 'domain') {
    fight.log.push({ text: `💥 DOMAIN CLASH! Domains cancel out!`, color: 'rainbow' });
    return;
  }

  // Crit
  if (Math.random() < 0.1) {
    dmg = Math.floor(dmg * 1.6);
    fight.log.push({ text: `💥 CRITICAL! ${attacker.name}'s ${moveName} for ${dmg}!`, color: '#ff6b00' });
  } else {
    const actionIcon = atkMove.action==='heavy'?'💢':atkMove.action==='domain'?'🌀':atkMove.action==='skill'?'✦':'⚔';
    fight.log.push({ text: `${actionIcon} ${attacker.name}: ${moveName} → ${dmg} dmg!`, color: '#e8dfc4' });
  }

  fight[defHpKey] = Math.max(0, fight[defHpKey] - dmg);

  // Domain bonus: stun
  if (atkMove.action === 'domain') {
    fight.log.push({ text: `🌀 ${attacker.name}'s domain overwhelms ${defender.name}!`, color: '#bb8fce' });
    if (side==='p1') fight.p2Debuff='stunned'; else fight.p1Debuff='stunned';
  }
}

function checkPvpOver(fight, p1, p2, room, roomCode) {
  const p1Dead = fight.p1Hp <= 0, p2Dead = fight.p2Hp <= 0;
  if (!p1Dead && !p2Dead) return;
  fight.over = true;
  let winnerId, loserId;
  if (p1Dead && p2Dead) {
    fight.log.push({ text: `💀 DOUBLE KO! Simultaneous defeat!`, color: '#bb8fce' });
    winnerId = fight.p2Id; loserId = fight.p1Id; // p2 wins tiebreak by hp difference... p1 died first
  } else if (p1Dead) {
    winnerId = fight.p2Id; loserId = fight.p1Id;
  } else {
    winnerId = fight.p1Id; loserId = fight.p2Id;
  }
  fight.winner = winnerId;
  const winner = room.players[winnerId], loser = room.players[loserId];

  // Ranked adjustments
  if (fight.type === 'ranked') {
    const winnerRank = adjustRank(winnerId, true);
    const loserRank = adjustRank(loserId, false);
    fight.log.push({ text: `🏆 ${winner?.name} wins! Rank: ${winnerRank.rank} (+25 RP)`, color: '#d4a843' });
    fight.log.push({ text: `📉 ${loser?.name}: ${loserRank.rank} (-15 RP)`, color: '#e74c3c' });
    fight.winnerRank = winnerRank; fight.loserRank = loserRank;
  } else {
    fight.log.push({ text: `🏆 ${winner?.name} wins the duel!`, color: '#d4a843' });
  }
  broadcastRoom(roomCode, { type: 'pvp', fightId: fight.fightId, summary: `${winner?.name} defeated ${loser?.name}${fight.type==='ranked'?' [RANKED]':''}!` });
}

// Get ranked info for player
app.get('/api/ranked/:pid', (req, res) => {
  res.json(getRankFromPoints(RANK_POINTS[req.params.pid]));
});

// Ranked challenge
app.post('/api/rooms/:code/pvp/ranked', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { challengerId, targetId } = req.body;
  const c = room.players[challengerId], t = room.players[targetId];
  if (!c || !t) return res.status(404).json({ error: 'Player not found' });
  const fightId = uuidv4();
  room.fights[fightId] = {
    fightId, type: 'ranked',
    p1Id: challengerId, p2Id: targetId,
    p1Hp: c.maxHp, p2Hp: t.maxHp,
    p1MaxHp: c.maxHp, p2MaxHp: t.maxHp,
    p1Move: null, p2Move: null,
    p1Ce: c.maxCe, p2Ce: t.maxCe,
    p1MaxCe: c.maxCe, p2MaxCe: t.maxCe,
    round: 0, log: [], over: false,
    p1Debuff: null, p2Debuff: null,
  };
  broadcastRoom(req.params.code, { type: 'pvp_start', fightId, p1Name: c.name, p2Name: t.name, p1Id: challengerId, p2Id: targetId, ranked: true });
  res.json({ fightId });
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
