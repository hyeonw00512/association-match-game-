const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const topics = require('./topics.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 16);
}

function cleanWord(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

function cleanMaxPlayers(value) {
  const count = Number.parseInt(value, 10);
  return Number.isInteger(count) && count >= 2 && count <= 8 ? count : 4;
}

function cleanToken(value) {
  return String(value || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80);
}

function normalize(value) {
  return value.replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
}

function publicState(room, reveal = false) {
  const players = room.players.map(({ id, name }) => ({ id, name }));
  return {
    code: room.code,
    players,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    status: room.status,
    startWord: room.startWord,
    round: room.round,
    history: room.history,
    submittedIds: reveal ? [] : Object.keys(room.submissions),
    result: room.result,
    chat: room.chat
  };
}

function broadcast(room) {
  io.to(room.code).emit('room-state', publicState(room));
}

function getRoomFor(socket) {
  return rooms.get(socket.data.roomCode);
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name, maxPlayers, token }, reply) => {
    name = cleanName(name);
    token = cleanToken(token) || socket.id;
    if (!name) return reply({ ok: false, message: '닉네임을 입력해 주세요.' });
    const code = roomCode();
    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name, token, connected: true }],
      maxPlayers: cleanMaxPlayers(maxPlayers),
      status: 'waiting',
      startWord: '',
      round: 0,
      history: [],
      submissions: {},
      result: null,
      chat: [],
      usedTopics: []
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerToken = token;
    reply({ ok: true, state: publicState(room) });
  });

  socket.on('join-room', ({ code, name, token }, reply) => {
    code = String(code || '').trim().toUpperCase();
    name = cleanName(name);
    token = cleanToken(token) || socket.id;
    const room = rooms.get(code);
    if (!name) return reply({ ok: false, message: '닉네임을 입력해 주세요.' });
    if (!room) return reply({ ok: false, message: '존재하지 않는 방 코드예요.' });
    if (room.players.length >= room.maxPlayers) return reply({ ok: false, message: '이 방은 이미 가득 찼어요.' });
    if (room.status !== 'waiting') return reply({ ok: false, message: '이미 진행 중인 방이에요.' });
    room.players.push({ id: socket.id, name, token, connected: true });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerToken = token;
    broadcast(room);
    reply({ ok: true, state: publicState(room) });
  });

  socket.on('spectate-room', ({ code }, reply) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return reply({ ok: false, message: '존재하지 않는 방 코드예요.' });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isSpectator = true;
    reply({ ok: true, state: publicState(room), isSpectator: true });
  });

  socket.on('rejoin-room', ({ code, token }, reply) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    token = cleanToken(token);
    const player = room?.players.find((item) => item.token === token);
    if (!player) return reply({ ok: false });
    const previousSocketId = player.id;
    const previousSubmission = room.submissions[previousSocketId];
    delete room.submissions[previousSocketId];
    player.id = socket.id;
    player.connected = true;
    if (room.hostId === previousSocketId) room.hostId = socket.id;
    if (previousSubmission) room.submissions[socket.id] = previousSubmission;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerToken = token;
    broadcast(room);
    reply({ ok: true, state: publicState(room) });
  });

  socket.on('set-start-word', ({ word }, reply) => {
    const room = getRoomFor(socket);
    word = cleanWord(word);
    if (!room || socket.id !== room.hostId) return reply({ ok: false, message: '방장만 시작할 수 있어요.' });
    if (room.players.length < 2) return reply({ ok: false, message: '최소 두 명이 입장해야 시작할 수 있어요.' });
    if (!word) return reply({ ok: false, message: '시작 단어를 입력해 주세요.' });
    room.status = 'playing';
    room.startWord = word;
    room.round = 1;
    room.history = [];
    room.submissions = {};
    room.result = null;
    broadcast(room);
    reply({ ok: true });
  });

  socket.on('pick-random-topic', ({ category }, reply) => {
    const room = getRoomFor(socket);
    if (!room || socket.id !== room.hostId) return reply({ ok: false, message: '방장만 주제를 뽑을 수 있어요.' });
    if (room.players.length < 2 || room.status !== 'waiting') return reply({ ok: false, message: '최소 두 명이 입장한 뒤 뽑아 주세요.' });
    const selectedCategories = category && topics[category] ? [category] : Object.keys(topics);
    const candidates = selectedCategories.flatMap((key) => topics[key].map((word) => ({ word, category: key })));
    let available = candidates.filter((item) => !room.usedTopics.includes(item.word));
    if (available.length === 0) {
      room.usedTopics = [];
      available = candidates;
    }
    const picked = available[Math.floor(Math.random() * available.length)];
    room.usedTopics.push(picked.word);
    reply({ ok: true, ...picked });
  });

  socket.on('submit-word', ({ word }, reply) => {
    const room = getRoomFor(socket);
    word = cleanWord(word);
    if (!room || room.status !== 'playing') return reply({ ok: false, message: '진행 중인 게임이 아니에요.' });
    if (!room.players.some((p) => p.id === socket.id)) return reply({ ok: false, message: '이 방의 참가자가 아니에요.' });
    if (!word) return reply({ ok: false, message: '연상 단어를 입력해 주세요.' });
    if (room.submissions[socket.id]) return reply({ ok: false, message: '이번 라운드에는 이미 제출했어요.' });
    const usedBefore = [room.startWord, ...room.history.flatMap((round) => round.entries.map((entry) => entry.word))];
    if (usedBefore.some((usedWord) => normalize(usedWord) === normalize(word))) {
      return reply({ ok: false, message: '이미 나온 단어예요. 다른 단어를 입력해 주세요.' });
    }
    room.submissions[socket.id] = word;
    if (Object.keys(room.submissions).length < room.players.length) {
      broadcast(room);
      return reply({ ok: true });
    }
    const entries = room.players.map((player) => ({ playerId: player.id, name: player.name, word: room.submissions[player.id] }));
    const matched = entries.every((entry) => normalize(entry.word) === normalize(entries[0].word));
    const prompt = room.round === 1
      ? [{ label: '시작 단어', word: room.startWord }]
      : room.history[room.history.length - 1].entries.map((entry) => ({ label: entry.name, word: entry.word }));
    room.history.push({ round: room.round, prompt, entries, matched });
    room.result = { entries, matched };
    room.submissions = {};
    if (matched) {
      room.status = 'won';
    } else {
      room.round += 1;
      room.status = 'playing';
    }
    io.to(room.code).emit('room-state', publicState(room, true));
    reply({ ok: true });
  });

  socket.on('restart-game', (reply) => {
    const room = getRoomFor(socket);
    if (!room || socket.id !== room.hostId) return reply({ ok: false, message: '방장만 다시 시작할 수 있어요.' });
    room.status = 'waiting';
    room.startWord = '';
    room.round = 0;
    room.history = [];
    room.submissions = {};
    room.result = null;
    room.usedTopics = [];
    room.chat = [];
    broadcast(room);
    reply({ ok: true });
  });

  socket.on('cancel-room', (reply) => {
    const room = getRoomFor(socket);
    if (!room || socket.id !== room.hostId || room.status !== 'waiting') return reply({ ok: false, message: '대기 중인 방은 방장만 취소할 수 있어요.' });
    io.to(room.code).emit('room-cancelled', { message: '방장이 방을 취소했어요.' });
    rooms.delete(room.code);
    reply({ ok: true });
  });

  socket.on('send-chat', ({ message }, reply) => {
    const room = getRoomFor(socket);
    const player = room?.players.find((item) => item.id === socket.id);
    message = String(message || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!room || !['waiting', 'won'].includes(room.status) || !player) return reply({ ok: false, message: '대기 중이거나 게임이 끝난 뒤에 채팅할 수 있어요.' });
    if (!message) return reply({ ok: false, message: '메시지를 입력해 주세요.' });
    const chatMessage = { id: `${Date.now()}-${socket.id}`, playerId: socket.id, name: player.name, message };
    room.chat.push(chatMessage);
    room.chat = room.chat.slice(-50);
    io.to(room.code).emit('chat-message', chatMessage);
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = getRoomFor(socket);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    player.connected = false;
    setTimeout(() => {
      const currentRoom = rooms.get(room.code);
      const absentPlayer = currentRoom?.players.find((p) => p.token === player.token);
      if (!currentRoom || !absentPlayer || absentPlayer.connected) return;
      currentRoom.players = currentRoom.players.filter((p) => p.token !== player.token);
      if (currentRoom.players.length === 0) return rooms.delete(currentRoom.code);
      currentRoom.hostId = currentRoom.players[0].id;
      currentRoom.status = 'waiting';
      currentRoom.startWord = '';
      currentRoom.round = 0;
      currentRoom.history = [];
      currentRoom.submissions = {};
      currentRoom.result = null;
      broadcast(currentRoom);
    }, 30000);
  });
});

const port = process.env.PORT || 3000;
app.get('/api/platform/rooms', (_request, response) => response.json({
  version: 1,
  gameId: 'echo-words',
  updatedAt: new Date().toISOString(),
  capabilities: { canSpectate: true, canReserveNextRound: false },
  rooms: [...rooms.values()].map((room) => ({
    roomCode: room.code,
    hostNickname: room.players.find((player) => player.id === room.hostId)?.name || '알 수 없음',
    playerCount: room.players.length,
    maxPlayers: room.maxPlayers,
    spectatorCount: 0,
    status: room.status === 'waiting' ? 'WAITING' : room.status === 'playing' ? 'PLAYING' : 'FINISHED',
    requiresPassword: false,
    canJoin: room.status === 'waiting' && room.players.length < room.maxPlayers,
    canSpectate: true,
    canReserveNextRound: false,
    joinUrl: `https://association-match-game.onrender.com/?room=${room.code}`
  }))
}));
server.listen(port, '0.0.0.0', () => console.log(`Game server: http://localhost:${port}`));
