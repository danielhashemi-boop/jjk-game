const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));
app.use(express.static('.'));

// rooms[roomCode][playerId] = playerData
const rooms = {};
// connections[playerId] = { ws, roomCode, name }
const connections = {};

function getRoomPlayers(roomCode) {
  return Object.values(rooms[roomCode] || {});
}

function broadcastToRoom(roomCode, excludeId, msg) {
  const str = JSON.stringify(msg);
  for (const [pid, conn] of Object.entries(connections)) {
    if (conn.roomCode === roomCode && pid !== excludeId) {
      if (conn.ws && conn.ws.readyState === 1) {
        try { conn.ws.send(str); } catch(e) {}
      }
    }
  }
}

function broadcastAll(roomCode, msg) {
  broadcastToRoom(roomCode, null, msg);
}

// ── API ──
app.post('/api/rooms/join', (req, res) => {
  const { name, roomCode } = req.body;
  if (!name || !roomCode) return res.json({ error: 'Missing fields' });
  const playerId = name + '_' + roomCode + '_' + Date.now();
  const player = {
    playerId, name, roomCode,
    level: 1, xp: 0, maxXp: 100,
    str: 5, agi: 5, end: 5,
    hp: 100, maxHp: 100,
    ce: 100, maxCe: 100,
    coins: 100, spins: 3,
    kills: 0, rankIdx: 0, trainCount: 0
  };
  if (!rooms[roomCode]) rooms[roomCode] = {};
  rooms[roomCode][playerId] = player;
  res.json({ player });
});

app.post('/api/rooms/:room/save', (req, res) => {
  const { player } = req.body;
  if (player && player.roomCode && player.playerId) {
    if (!rooms[player.roomCode]) rooms[player.roomCode] = {};
    rooms[player.roomCode][player.playerId] = player;
    // Broadcast updated player to room
    broadcastToRoom(player.roomCode, player.playerId, {
      type: 'player_update',
      player
    });
  }
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const all = Object.values(rooms).flatMap(r => Object.values(r));
  all.sort((a, b) => (b.kills || 0) - (a.kills || 0));
  res.json(all.slice(0, 20));
});

app.post('/api/rooms/:room/pvp', (req, res) => res.json({ fightId: null }));
app.post('/api/rooms/:room/pvp/boss', (req, res) => res.json({ fightId: null }));
app.post('/api/rooms/:room/pvp/boss/sukuna', (req, res) => res.json({ fightId: null }));
app.post('/api/rooms/:room/pvp/ranked', (req, res) => res.json({ fightId: null }));
app.get('/api/fights/:id', (req, res) => res.json({}));
app.post('/api/fights/:id/action', (req, res) => res.json({ fight: {} }));


// ══ ACCOUNT SYSTEM ══
const crypto = require('crypto');
const accounts = {}; // username -> { passwordHash, token, saveData }

function hashPassword(pass){ return crypto.createHash('sha256').update(pass+'jjba_salt_2026').digest('hex'); }
function makeToken(user){ return crypto.createHash('sha256').update(user+Date.now()+Math.random()).digest('hex'); }
function authToken(req){ 
  const auth = req.headers.authorization||'';
  return auth.replace('Bearer ','').trim();
}

app.post('/api/account/register', (req, res)=>{
  const { username, password } = req.body;
  if(!username||!password) return res.json({error:'Missing fields'});
  if(username.length<3) return res.json({error:'Username too short (min 3)'});
  if(password.length<6) return res.json({error:'Password too short (min 6)'});
  if(accounts[username.toLowerCase()]) return res.json({error:'Username already taken!'});
  const token = makeToken(username);
  accounts[username.toLowerCase()] = {
    username, 
    passwordHash: hashPassword(password), 
    token, 
    saveData: null,
    createdAt: Date.now()
  };
  console.log('New account:', username);
  res.json({ ok:true, token });
});

app.post('/api/account/login', (req, res)=>{
  const { username, password } = req.body;
  if(!username||!password) return res.json({error:'Missing fields'});
  const acc = accounts[username.toLowerCase()];
  if(!acc) return res.json({error:'Account not found'});
  if(acc.passwordHash !== hashPassword(password)) return res.json({error:'Wrong password'});
  // Generate new token
  acc.token = makeToken(username);
  console.log('Login:', username);
  res.json({ ok:true, token:acc.token, saveData: acc.saveData||null });
});

app.post('/api/account/save', (req, res)=>{
  const { username, saveData } = req.body;
  const token = authToken(req);
  const acc = accounts[username?.toLowerCase()];
  if(!acc) return res.json({error:'Account not found'});
  if(acc.token !== token) return res.json({error:'Invalid token — please login again'});
  acc.saveData = saveData;
  acc.lastSaved = Date.now();
  console.log('Save synced for:', username, 'Level:', saveData?.level);
  res.json({ ok:true });
});

app.get('/api/account/load', (req, res)=>{
  const username = req.query.username;
  const token = authToken(req);
  const acc = accounts[username?.toLowerCase()];
  if(!acc) return res.json({error:'Account not found'});
  if(acc.token !== token) return res.json({error:'Invalid token'});
  res.json({ ok:true, saveData: acc.saveData||null });
});


// ── WEBSOCKET ──
wss.on('connection', (ws) => {
  let myId = null;
  let myRoom = null;
  let myName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // AUTH — player connects
    if (msg.type === 'auth') {
      myId = msg.playerId;
      myRoom = msg.roomCode;

      // Find name from rooms data
      const roomData = rooms[myRoom] || {};
      const playerData = roomData[myId];
      myName = playerData?.name || msg.playerId?.split('_')[0] || '?';

      // Register connection
      connections[myId] = { ws, roomCode: myRoom, name: myName };

      // Send existing players in this room to the newcomer
      const others = Object.values(roomData).filter(p => p.playerId !== myId);
      ws.send(JSON.stringify({ type: 'init', players: others }));

      // Tell everyone else this player joined
      broadcastToRoom(myRoom, myId, {
        type: 'join',
        playerId: myId,
        name: myName
      });

      // Send this player's data to everyone else too
      if (playerData) {
        broadcastToRoom(myRoom, myId, {
          type: 'player_update',
          player: playerData
        });
      }

      console.log(`[${myRoom}] ${myName} connected. Room now has ${Object.keys(connections).filter(id => connections[id].roomCode === myRoom).length} players`);
    }

    // PLAYER UPDATE — sync stats
    if (msg.type === 'player_update') {
      if (myRoom && msg.player) {
        // Save updated data
        if (!rooms[myRoom]) rooms[myRoom] = {};
        rooms[myRoom][myId] = msg.player;
        // Broadcast to room
        broadcastToRoom(myRoom, myId, {
          type: 'player_update',
          player: msg.player
        });
      }
    }

    // CHAT
    if (msg.type === 'chat') {
      broadcastToRoom(myRoom, myId, {
        type: 'chat',
        name: myName,
        msg: msg.msg
      });
    }

    // KILL / LEVELUP broadcasts
    if (msg.type === 'kill') {
      broadcastToRoom(myRoom, myId, {
        type: 'kill',
        name: myName,
        enemy: msg.enemy,
        xp: msg.xp
      });
    }

    if (msg.type === 'levelup') {
      broadcastToRoom(myRoom, myId, {
        type: 'levelup',
        name: myName,
        level: msg.level
      });
    }

    // PVP QUEUE
    if (msg.type === 'pvp_queue_join') {
      handlePvpQueue(ws, myId, myRoom, myName, msg);
    }
    if (msg.type === 'pvp_queue_leave') {
      removeFromQueues(myId);
    }

    // DUEL REQUEST
    if (msg.type === 'pvp_duel_request') {
      const target = connections[msg.targetId];
      if (target && target.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: 'pvp_duel_request',
          fromId: myId,
          fromName: myName,
          fromTech: msg.fromTech,
          fromLevel: msg.fromLevel,
          mode: msg.mode
        }));
      }
    }
    if (msg.type === 'pvp_duel_accept') {
      const target = connections[msg.fromId];
      if (target && target.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: 'pvp_duel_accepted',
          byId: myId,
          byName: myName,
          byTech: msg.byTech,
          mode: msg.mode
        }));
      }
    }
    if (msg.type === 'pvp_duel_decline') {
      const target = connections[msg.fromId];
      if (target && target.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: 'pvp_duel_declined',
          byName: myName
        }));
      }
    }

    // PVP TURN MOVE
    if (msg.type === 'pvp_turn_move') {
      if (msg.matchId && pvpMatches[msg.matchId]) {
        const match = pvpMatches[msg.matchId];
        const isP1 = match.p1Id === myId;
        if (isP1) match.p1Move = msg.move;
        else match.p2Move = msg.move;
        // Tell opponent
        const oppId = isP1 ? match.p2Id : match.p1Id;
        const opp = connections[oppId];
        if (opp && opp.ws.readyState === 1) {
          opp.ws.send(JSON.stringify({ type: 'pvp_turn_move', move: msg.move }));
        }
      }
    }

    // MASH TAP
    if (msg.type === 'pvp_mash_tap') {
      if (msg.matchId && pvpMatches[msg.matchId]) {
        const match = pvpMatches[msg.matchId];
        const oppId = match.p1Id === myId ? match.p2Id : match.p1Id;
        const opp = connections[oppId];
        if (opp && opp.ws.readyState === 1) {
          opp.ws.send(JSON.stringify({ type: 'pvp_mash_update' }));
        }
      }
    }
  });

  ws.on('close', () => {
    if (myId) {
      delete connections[myId];
      removeFromQueues(myId);
      if (myRoom) {
        broadcastToRoom(myRoom, myId, {
          type: 'leave',
          playerId: myId,
          name: myName
        });
        console.log(`[${myRoom}] ${myName} disconnected`);
      }
    }
  });

  ws.on('error', () => {});
});

// ── PVP MATCHMAKING ──
const pvpQueues = {}; // mode -> [{ id, ws, name, room, ... }]
const pvpMatches = {}; // matchId -> { p1Id, p2Id, mode, ... }

function handlePvpQueue(ws, id, room, name, msg) {
  const mode = msg.mode || 'turn';
  const key = room + '_' + mode + (msg.ranked ? '_ranked' : '');

  if (!pvpQueues[key]) pvpQueues[key] = [];

  // Remove if already in queue
  pvpQueues[key] = pvpQueues[key].filter(p => p.id !== id);

  // Add to queue
  pvpQueues[key].push({ id, ws, name, room, tech: msg.tech, ranked: msg.ranked, mode });

  // Try to match
  if (pvpQueues[key].length >= 2) {
    const p1 = pvpQueues[key].shift();
    const p2 = pvpQueues[key].shift();

    const matchId = 'match_' + Date.now();
    pvpMatches[matchId] = { p1Id: p1.id, p2Id: p2.id, mode, p1Move: null, p2Move: null };

    const matchMsg = {
      type: 'pvp_match_found',
      matchId,
      mode,
      ranked: msg.ranked,
      p1Id: p1.id, p1Name: p1.name, p1Tech: p1.tech,
      p2Id: p2.id, p2Name: p2.name, p2Tech: p2.tech,
    };

    if (p1.ws.readyState === 1) p1.ws.send(JSON.stringify(matchMsg));
    if (p2.ws.readyState === 1) p2.ws.send(JSON.stringify(matchMsg));

    console.log(`[${room}] PvP match: ${p1.name} vs ${p2.name} (${mode})`);
  } else {
    ws.send(JSON.stringify({ type: 'pvp_queue_status', status: 'Waiting for opponent...' }));
  }
}

function removeFromQueues(id) {
  for (const key in pvpQueues) {
    pvpQueues[key] = pvpQueues[key].filter(p => p.id !== id);
  }
}

// ── START ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('JJBA server running on port ' + PORT));
