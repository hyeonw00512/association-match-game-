const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { io } = require('socket.io-client');

let port;
let server;
let baseUrl;
let serverError = '';
const clients = [];

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: openPort } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(openPort));
    });
  });
}

function connect() {
  const socket = io(baseUrl, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function ask(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3_000).emit(event, payload, (error, response) => {
      if (error) return reject(new Error(`${event}: ${error.message}\n${serverError}`));
      if (!response) return reject(new Error(`${event} did not return an acknowledgement.`));
      resolve(response);
    });
  });
}

function askWithoutPayload(socket, event) {
  return new Promise((resolve, reject) => {
    socket.timeout(3_000).emit(event, (error, response) => {
      if (error) return reject(new Error(`${event}: ${error.message}\n${serverError}`));
      if (!response) return reject(new Error(`${event} did not return an acknowledgement.`));
      resolve(response);
    });
  });
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

test.before(async () => {
  port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start.')), 5_000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Game server:')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
  });
});

test.after(async () => {
  clients.forEach((socket) => socket.disconnect());
  if (server && !server.killed) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('room flow protects turns and allows a tokenless spectator to chat after a match', async () => {
  const host = await connect();
  const guest = await connect();
  const created = await ask(host, 'create-room', { name: '방장', token: 'host-token', maxPlayers: 2 });
  assert.equal(created.ok, true);

  const joined = await ask(guest, 'join-room', { code: created.state.code, name: '참가자', token: 'guest-token' });
  assert.equal(joined.ok, true);
  assert.equal(joined.state.players.length, 2);

  assert.equal((await ask(host, 'set-start-word', { word: '여행' })).ok, true);
  assert.equal((await ask(host, 'submit-word', { word: '바다' })).ok, true);
  const duplicate = await ask(host, 'submit-word', { word: '산' });
  assert.equal(duplicate.ok, false);

  const finished = once(host, 'room-state');
  assert.equal((await ask(guest, 'submit-word', { word: '바다' })).ok, true);
  assert.equal((await finished).status, 'won');

  const spectator = await connect();
  const watched = await ask(spectator, 'spectate-room', { code: created.state.code, name: '관전자' });
  assert.equal(watched.ok, true);
  assert.equal(watched.isSpectator, true);

  const chat = once(host, 'chat-message');
  assert.equal((await ask(spectator, 'send-chat', { message: '축하합니다!' })).ok, true);
  assert.equal((await chat).message, '축하합니다!');
});

test('a reconnect keeps a submitted word, and a three-player round continues when one player leaves', async () => {
  const host = await connect();
  const guest = await connect();
  const third = await connect();
  const created = await ask(host, 'create-room', { name: '방장', token: 'reconnect-host', maxPlayers: 3 });
  const code = created.state.code;
  assert.equal((await ask(guest, 'join-room', { code, name: '참가자', token: 'reconnect-guest' })).ok, true);
  assert.equal((await ask(third, 'join-room', { code, name: '세번째', token: 'reconnect-third' })).ok, true);

  assert.equal((await ask(host, 'set-start-word', { word: '여행' })).ok, true);
  assert.equal((await ask(host, 'submit-word', { word: '바다' })).ok, true);

  host.disconnect();
  const reconnectedHost = await connect();
  const restored = await ask(reconnectedHost, 'rejoin-room', { code, token: 'reconnect-host' });
  assert.equal(restored.ok, true);
  assert.equal(restored.state.submittedIds.length, 1);

  assert.equal((await ask(guest, 'submit-word', { word: '바다' })).ok, true);
  const finalState = once(reconnectedHost, 'room-state');
  assert.equal((await askWithoutPayload(third, 'leave-room')).ok, true);
  const result = await finalState;
  assert.equal(result.status, 'won');
  assert.equal(result.result.matched, true);
  assert.equal(result.players.length, 2);
});
