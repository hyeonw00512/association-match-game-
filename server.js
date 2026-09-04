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
    result: room.result
  };
}

function broadcast(room) {
  io.to(room.code).emit('room-state', publicState(room));
}

function getRoomFor(socket) {
  return rooms.get(socket.data.roomCode);
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name, maxPlayers }, reply) => {
    name = cleanName(name);
    if (!name) return reply({ ok: false, message: '닉네임을 입력해 주세요.' });
    const code = roomCode();
    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name }],
      maxPlayers: cleanMaxPlayers(maxPlayers),
      status: 'waiting',
      startWord: '',
      round: 0,
      history: [],
      submissions: {},
      result: null,
      usedTopics: []
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    reply({ ok: true, state: publicState(room) });
  });

  socket.on('join-room', ({ code, name }, reply) => {
    code = String(code || '').trim().toUpperCase();
    name = cleanName(name);
    const room = rooms.get(code);
    if (!name) return reply({ ok: false, message: '닉네임을 입력해 주세요.' });
    if (!room) return reply({ ok: false, message: '존재하지 않는 방 코드예요.' });
    if (room.players.length >= room.maxPlayers) return reply({ ok: false, message: '이 방은 이미 가득 찼어요.' });
    if (room.status !== 'waiting') return reply({ ok: false, message: '이미 진행 중인 방이에요.' });
    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.data.roomCode = code;
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
    room.submissions[socket.id] = word;
    if (Object.keys(room.submissions).length < room.players.length) {
      broadcast(room);
      return reply({ ok: true });
    }
    const entries = room.players.map((player) => ({ playerId: player.id, name: player.name, word: room.submissions[player.id] }));
    const matched = entries.every((entry) => normalize(entry.word) === normalize(entries[0].word));
    room.history.push({ round: room.round, entries, matched });
    room.result = { entries, matched };
    room.status = matched ? 'won' : 'revealed';
    room.submissions = {};
    io.to(room.code).emit('room-state', publicState(room, true));
    reply({ ok: true });
  });

  socket.on('next-round', (reply) => {
    const room = getRoomFor(socket);
    if (!room || room.status !== 'revealed') return reply({ ok: false, message: '다음 라운드를 시작할 수 없어요.' });
    room.round += 1;
    room.status = 'playing';
    room.result = null;
    broadcast(room);
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

  socket.on('disconnect', () => {
    const room = getRoomFor(socket);
    if (!room) return;
    room.players = room.players.filter((p) => p.id !== socket.id);
    delete room.submissions[socket.id];
    if (room.players.length === 0) return rooms.delete(room.code);
    room.hostId = room.players[0].id;
    room.status = 'waiting';
    room.startWord = '';
    room.round = 0;
    room.history = [];
    room.submissions = {};
    room.result = null;
    broadcast(room);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Game server: http://localhost:${port}`));
