const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));
app.use(express.static('.'));

// ── DATA STORES ──
const rooms = {};       // rooms[roomCode][playerId] = playerData
const connections = {}; // connections[playerId] = { ws, roomCode, name }
const accounts = {};    // accounts[username] = { passwordHash, token, saveData }
const pvpQueues = {};   // pvpQueues[key] = [{ id, ws, name, room, tech }]
const pvpMatches = {};  // pvpMatches[matchId] = { p1Id, p2Id, p1Move, p2Move }

// ── HELPERS ──
function broadcast(roomCode, excludeId, msg){
  const str = JSON.stringify(msg);
  for(const [pid, conn] of Object.entries(connections)){
    if(conn.roomCode === roomCode && pid !== excludeId){
      if(conn.ws && conn.ws.readyState === WebSocket.OPEN){
        try{ conn.ws.send(str); } catch(e){}
      }
    }
  }
}

function getRoom(code){ if(!rooms[code]) rooms[code]={}; return rooms[code]; }
function hash(s){ return crypto.createHash('sha256').update(s+'jjba_salt_2026').digest('hex'); }
function makeToken(u){ return crypto.createHash('sha256').update(u+Date.now()+Math.random()).digest('hex'); }

// ── API ROUTES ──
app.post('/api/rooms/join', (req, res) => {
  const { name, roomCode } = req.body;
  if(!name || !roomCode) return res.json({ error: 'Missing fields' });

  const playerId = name + '_' + roomCode + '_' + Date.now();
  const player = {
    playerId, name, roomCode,
    level:1, xp:0, maxXp:100,
    str:5, agi:5, end:5,
    hp:100, maxHp:100, ce:100, maxCe:100,
    coins:100, spins:3, kills:0, rankIdx:0, trainCount:0
  };

  getRoom(roomCode)[playerId] = player;
  res.json({ player });
});

app.post('/api/rooms/:room/save', (req, res) => {
  const { player } = req.body;
  if(player && player.roomCode && player.playerId){
    getRoom(player.roomCode)[player.playerId] = player;
  }
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const all = Object.values(rooms).flatMap(r => Object.values(r));
  all.sort((a,b) => (b.kills||0) - (a.kills||0));
  res.json(all.slice(0, 20));
});



// ── CHAT STORAGE ──
const chats = {}; // chats[roomCode] = [{id, name, msg, time}]
let chatIdCounter = 0;

function getRoomChat(code){
  if(!chats[code]) chats[code] = [];
  return chats[code];
}

// POST chat message
app.post('/api/rooms/:room/chat', (req, res) => {
  const { name, msg } = req.body;
  const room = req.params.room;
  if(!name || !msg) return res.json({ok:false});
  const chat = getRoomChat(room);
  const entry = { id: ++chatIdCounter, name, msg, time: Date.now() };
  chat.push(entry);
  // Keep only last 100 messages
  if(chat.length > 100) chat.shift();
  res.json({ ok: true, id: entry.id });
});

// GET chat messages since id
app.get('/api/rooms/:room/chat', (req, res) => {
  const room = req.params.room;
  const since = parseInt(req.query.since || '0');
  const chat = getRoomChat(room);
  const messages = chat.filter(m => m.id > since);
  res.json({ messages });
});


// GET all players in a room (for HTTP polling fallback)
app.get('/api/rooms/:room/players', (req, res) => {
  const room = req.params.room;
  const players = Object.values(rooms[room] || {});
  res.json({ players });
});

// Stub PvP routes
app.post('/api/rooms/:room/pvp', (req,res) => res.json({fightId:null}));
app.post('/api/rooms/:room/pvp/boss', (req,res) => res.json({fightId:null}));
app.post('/api/rooms/:room/pvp/boss/sukuna', (req,res) => res.json({fightId:null}));
app.post('/api/rooms/:room/pvp/ranked', (req,res) => res.json({fightId:null}));
app.get('/api/fights/:id', (req,res) => res.json({}));
app.post('/api/fights/:id/action', (req,res) => res.json({fight:{}}));

// ── ACCOUNT ROUTES ──
app.post('/api/account/register', (req, res) => {
  const { username, password } = req.body;
  if(!username || !password) return res.json({error:'Missing fields'});
  if(username.length < 3) return res.json({error:'Username too short (min 3 chars)'});
  if(password.length < 6) return res.json({error:'Password too short (min 6 chars)'});
  const key = username.toLowerCase();
  if(accounts[key]) return res.json({error:'Username already taken!'});
  const token = makeToken(username);
  accounts[key] = { username, passwordHash: hash(password), token, saveData: null };
  console.log('New account:', username);
  res.json({ ok: true, token });
});

app.post('/api/account/login', (req, res) => {
  const { username, password } = req.body;
  if(!username || !password) return res.json({error:'Missing fields'});
  const acc = accounts[username.toLowerCase()];
  if(!acc) return res.json({error:'Account not found'});
  if(acc.passwordHash !== hash(password)) return res.json({error:'Wrong password'});
  acc.token = makeToken(username);
  console.log('Login:', username);
  res.json({ ok: true, token: acc.token, saveData: acc.saveData || null });
});

app.post('/api/account/save', (req, res) => {
  const { username, saveData } = req.body;
  const token = (req.headers.authorization||'').replace('Bearer ','').trim();
  const acc = accounts[username?.toLowerCase()];
  if(!acc) return res.json({error:'Account not found'});
  if(acc.token !== token) return res.json({error:'Invalid token - please login again'});
  acc.saveData = saveData;
  console.log('Save synced:', username, 'Level:', saveData?.level);
  res.json({ ok: true });
});

app.get('/api/account/load', (req, res) => {
  const username = req.query.username;
  const token = (req.headers.authorization||'').replace('Bearer ','').trim();
  const acc = accounts[username?.toLowerCase()];
  if(!acc) return res.json({error:'Account not found'});
  if(acc.token !== token) return res.json({error:'Invalid token'});
  res.json({ ok: true, saveData: acc.saveData || null });
});

// ── WEBSOCKET ──
wss.on('connection', (ws) => {
  let myId = null;
  let myRoom = null;
  let myName = null;

  ws.on('message', (raw) => {
    let msg;
    try{ msg = JSON.parse(raw); } catch{ return; }

    // ── AUTH ──
    if(msg.type === 'auth'){
      myId   = msg.playerId;
      myRoom = msg.roomCode;
      myName = msg.name || msg.playerId.split('_')[0];

      // Save player data if provided
      if(msg.player){
        getRoom(myRoom)[myId] = msg.player;
      } else if(!getRoom(myRoom)[myId]){
        getRoom(myRoom)[myId] = { playerId:myId, name:myName, roomCode:myRoom };
      }

      // Register connection
      connections[myId] = { ws, roomCode: myRoom, name: myName };

      // Send all existing players in room to this client
      const existing = Object.values(getRoom(myRoom)).filter(p => p.playerId !== myId);
      ws.send(JSON.stringify({ type: 'init', players: existing }));

      // Tell everyone else in room about this player
      broadcast(myRoom, myId, {
        type: 'join',
        playerId: myId,
        name: myName,
        player: getRoom(myRoom)[myId]
      });

      console.log('['+myRoom+'] '+myName+' connected. Room size: '+
        Object.values(connections).filter(c=>c.roomCode===myRoom).length);
    }

    // ── PLAYER UPDATE ──
    if(msg.type === 'player_update' && myRoom){
      if(msg.player){
        getRoom(myRoom)[myId] = msg.player;
        broadcast(myRoom, myId, { type: 'player_update', player: msg.player });
      }
    }

    // ── CHAT ──
    if(msg.type === 'chat' && myRoom){
      broadcast(myRoom, myId, { type: 'chat', name: myName, msg: msg.msg });
    }

    // ── GAME EVENTS ──
    if(msg.type === 'kill' && myRoom){
      broadcast(myRoom, myId, { type:'kill', name:myName, enemy:msg.enemy, xp:msg.xp });
    }
    if(msg.type === 'levelup' && myRoom){
      broadcast(myRoom, myId, { type:'levelup', name:myName, level:msg.level });
    }

    // ── PVP QUEUE ──
    if(msg.type === 'pvp_queue_join'){
      const mode = msg.mode || 'turn';
      const key = myRoom + '_' + mode + (msg.ranked?'_ranked':'');
      if(!pvpQueues[key]) pvpQueues[key] = [];
      pvpQueues[key] = pvpQueues[key].filter(p => p.id !== myId);
      pvpQueues[key].push({ id:myId, ws, name:myName, room:myRoom, tech:msg.tech, mode, ranked:msg.ranked });

      if(pvpQueues[key].length >= 2){
        const p1 = pvpQueues[key].shift();
        const p2 = pvpQueues[key].shift();
        const matchId = 'match_' + Date.now();
        pvpMatches[matchId] = { p1Id:p1.id, p2Id:p2.id, mode, p1Move:null, p2Move:null };
        const matchMsg = { type:'pvp_match_found', matchId, mode, ranked:msg.ranked,
          p1Id:p1.id, p1Name:p1.name, p1Tech:p1.tech,
          p2Id:p2.id, p2Name:p2.name, p2Tech:p2.tech };
        if(p1.ws.readyState===WebSocket.OPEN) p1.ws.send(JSON.stringify(matchMsg));
        if(p2.ws.readyState===WebSocket.OPEN) p2.ws.send(JSON.stringify(matchMsg));
        console.log('['+myRoom+'] PvP: '+p1.name+' vs '+p2.name+' ('+mode+')');
      } else {
        ws.send(JSON.stringify({ type:'pvp_queue_status', status:'Waiting for opponent...' }));
      }
    }

    if(msg.type === 'pvp_queue_leave'){
      removeFromQueues(myId);
    }

    // ── DUEL DIRECT CHALLENGE ──
    if(msg.type === 'pvp_duel_request'){
      const target = connections[msg.targetId];
      if(target && target.ws.readyState === WebSocket.OPEN){
        target.ws.send(JSON.stringify({
          type:'pvp_duel_request', fromId:myId, fromName:myName,
          fromTech:msg.fromTech, fromLevel:msg.fromLevel, mode:msg.mode
        }));
      }
    }

    if(msg.type === 'pvp_duel_accept'){
      const target = connections[msg.fromId];
      if(target && target.ws.readyState === WebSocket.OPEN){
        target.ws.send(JSON.stringify({
          type:'pvp_duel_accepted', byId:myId, byName:myName,
          byTech:msg.byTech, mode:msg.mode
        }));
      }
    }

    if(msg.type === 'pvp_duel_decline'){
      const target = connections[msg.fromId];
      if(target && target.ws.readyState === WebSocket.OPEN){
        target.ws.send(JSON.stringify({ type:'pvp_duel_declined', byName:myName }));
      }
    }

    // ── PVP TURN MOVE ──
    if(msg.type === 'pvp_turn_move' && msg.matchId){
      const match = pvpMatches[msg.matchId];
      if(match){
        const isP1 = match.p1Id === myId;
        if(isP1) match.p1Move = msg.move; else match.p2Move = msg.move;
        const oppId = isP1 ? match.p2Id : match.p1Id;
        const opp = connections[oppId];
        if(opp && opp.ws.readyState === WebSocket.OPEN){
          opp.ws.send(JSON.stringify({ type:'pvp_turn_move', move:msg.move }));
        }
      }
    }
  });

  ws.on('close', () => {
    if(myId){
      delete connections[myId];
      removeFromQueues(myId);
      if(myRoom){
        broadcast(myRoom, myId, { type:'leave', playerId:myId, name:myName });
        console.log('['+myRoom+'] '+myName+' disconnected');
      }
    }
  });

  ws.on('error', () => {});
});

function removeFromQueues(id){
  for(const key in pvpQueues){
    pvpQueues[key] = pvpQueues[key].filter(p => p.id !== id);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('JJBA server running on port ' + PORT));
