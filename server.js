const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));
app.use(express.static('.'));

const rooms = {}, players = {}, fights = {};

app.post('/api/rooms/join', (req, res) => {
  const { name, roomCode } = req.body;
  if(!name || !roomCode) return res.json({ error: 'Missing fields' });
  const playerId = name + '_' + Date.now();
  const player = {
    playerId, name, roomCode,
    level:1, xp:0, maxXp:100,
    str:5, agi:5, end:5,
    hp:100, maxHp:100,
    ce:100, maxCe:100,
    coins:100, spins:3,
    kills:0, rankIdx:0
  };
  if(!rooms[roomCode]) rooms[roomCode] = {};
  rooms[roomCode][playerId] = player;
  players[playerId] = { ws:null, roomCode };
  res.json({ player });
});

app.post('/api/rooms/:room/save', (req, res) => {
  const { player } = req.body;
  if(player && rooms[player.roomCode])
    rooms[player.roomCode][player.playerId] = player;
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const all = Object.values(rooms).flatMap(r => Object.values(r));
  all.sort((a,b) => (b.kills||0)-(a.kills||0));
  res.json(all.slice(0,20));
});

app.post('/api/rooms/:room/pvp', (req,res) => res.json({fightId:null}));
app.post('/api/rooms/:room/pvp/boss', (req,res) => res.json({fightId:null}));
app.post('/api/rooms/:room/pvp/boss/sukuna', (req,res) => res.json({fightId:null}));
app.post('/api/rooms/:room/pvp/ranked', (req,res) => res.json({fightId:null}));
app.get('/api/fights/:id', (req,res) => res.json(fights[req.params.id]||{}));
app.post('/api/fights/:id/action', (req,res) => res.json({fight:fights[req.params.id]||{}}));

wss.on('connection', ws => {
  let myId = null, myRoom = null;
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if(msg.type === 'auth') {
        myId = msg.playerId;
        myRoom = msg.roomCode;
        if(players[myId]) players[myId].ws = ws;
        const others = Object.values(rooms[myRoom]||{})
          .filter(p => p.playerId !== myId);
        ws.send(JSON.stringify({ type:'init', players:others }));
        broadcast(myRoom, myId, {
          type:'join',
          name: rooms[myRoom]?.[myId]?.name || '?'
        });
      }
      if(msg.type==='chat') broadcast(myRoom, myId, {
        type:'chat',
        name: rooms[myRoom]?.[myId]?.name,
        msg: msg.msg
      });
      if(msg.type==='player_update') broadcast(myRoom, myId, {
        type:'player_update', player: msg.player
      });
      if(msg.type==='kill') broadcast(myRoom, myId, {
        type:'kill', name:msg.name, enemy:msg.enemy, xp:msg.xp
      });
      if(msg.type==='levelup') broadcast(myRoom, myId, {
        type:'levelup', name:msg.name, level:msg.level
      });
    } catch(e) {}
  });
  ws.on('close', () => {
    if(myId && myRoom) {
      const name = rooms[myRoom]?.[myId]?.name;
      broadcast(myRoom, myId, { type:'leave', playerId:myId, name });
    }
  });
});

function broadcast(room, excludeId, msg) {
  Object.entries(players).forEach(([pid, p]) => {
    if(p.roomCode===room && pid!==excludeId && p.ws?.readyState===1)
      p.ws.send(JSON.stringify(msg));
  });
}

server.listen(process.env.PORT || 3000, () =>
  console.log('JJBA server running!')
);
