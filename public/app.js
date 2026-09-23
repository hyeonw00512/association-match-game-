const socket = io();
const $ = (selector) => document.querySelector(selector);
let state = null;
let myId = null;
let isSpectator = false;
let playerToken = sessionStorage.getItem('association-player-token') || crypto.randomUUID();
const spectatorSessionKey = 'association-spectator-session';
sessionStorage.setItem('association-player-token', playerToken);
const categories = ['자연과 날씨', '음식과 음료', '동물과 식물', '장소와 여행', '일상과 물건', '취미와 놀이', '문화와 예술', '감정과 관계', '직업과 사회', '상상과 이야기'];
categories.forEach((category) => { const option = document.createElement('option'); option.value = category; option.textContent = category; $('#category').append(option); });
const invitedRoomCode = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
const platformJoinToken = new URLSearchParams(location.search).get('joinToken');
const platformNickname = new URLSearchParams(location.search).get('platformNickname')?.trim() || '';
const platformHomeUrl = () => new URLSearchParams(location.search).get('platformUrl') || document.referrer || '/';
const platformActivityToken = new URLSearchParams(location.search).get('platformActivityToken');
let platformJoinAttempted = false;
let lastPlatformActivity = '';
function reportPlatformActivity(status, force = false) {
  if (!platformActivityToken || (!force && lastPlatformActivity === status)) return;
  lastPlatformActivity = status;
  let endpoint;
  try { endpoint = new URL('/api/activity', platformHomeUrl()).toString(); } catch { return; }
  fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: platformActivityToken, status }), keepalive: true }).catch(() => { lastPlatformActivity = ''; });
}
if (platformNickname) {
  $('#name').value = platformNickname.slice(0, 16);
  $('#name').closest('label').hidden = true;
}
if (/^[A-Z0-9]{6}$/.test(invitedRoomCode || '')) {
  $('#room-code').value = invitedRoomCode;
  $('#join').textContent = '초대 방 참가하기';
  note(`방 코드 ${invitedRoomCode} 초대를 받았어요. 닉네임을 입력해 참가하세요.`);
}

socket.on('connect', () => {
  myId = socket.id;
  const savedRoomCode = sessionStorage.getItem('association-room-code');
  const spectatorSession = JSON.parse(sessionStorage.getItem(spectatorSessionKey) || 'null');
  if (platformJoinToken && !platformJoinAttempted) {
    platformJoinAttempted = true;
    sessionStorage.removeItem('association-room-code');
    sessionStorage.removeItem(spectatorSessionKey);
    socket.emit('platform-join', { joinToken: platformJoinToken }, (result) => {
      if (!result?.ok) return note(result?.message || '플랫폼 자동 입장에 실패했어요.');
      state = result.state;
      isSpectator = Boolean(result.isSpectator);
      if (isSpectator) sessionStorage.setItem(spectatorSessionKey, JSON.stringify({ code: state.code, name: '관전자', spectatorToken: result.spectatorToken }));
      else sessionStorage.setItem('association-room-code', state.code);
      if (!isSpectator && result.playerToken) { playerToken = result.playerToken; sessionStorage.setItem('association-player-token', result.playerToken); }
      history.replaceState(null, '', `?room=${state.code}`);
      render();
    });
  } else if (savedRoomCode) socket.emit('rejoin-room', { code: savedRoomCode, token: playerToken }, (result) => {
    if (result?.ok) { state = result.state; render(); }
    else sessionStorage.removeItem('association-room-code');
  });
  else if (spectatorSession) socket.emit('spectate-room', spectatorSession, (result) => {
    if (result?.ok) { isSpectator = true; state = result.state; render(); }
    else sessionStorage.removeItem(spectatorSessionKey);
  });
});
socket.on('room-state', (next) => { state = next; render(); });
socket.on('chat-message', (message) => {
  if (!state) return;
  state.chat = [...(state.chat || []), message].slice(-50);
  renderChat();
});
socket.on('room-cancelled', ({ message }) => { state = null; sessionStorage.removeItem('association-room-code'); $('#game').classList.add('hidden'); $('#lobby').classList.remove('hidden'); note(message); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
});

function note(message = '') { $('#notice').textContent = message; }
function roomCodeFrom(value) {
  const raw = String(value || '').trim();
  try {
    const code = new URL(raw).searchParams.get('room');
    if (code) return code.trim().toUpperCase();
  } catch { /* 6자리 방 코드로 처리 */ }
  return raw.toUpperCase();
}
function call(event, data) {
  return new Promise((resolve) => {
    if (data === undefined) socket.emit(event, resolve);
    else socket.emit(event, data, resolve);
  });
}
function isHost() { return state?.hostId === myId; }
function myPlayer() { return state?.players.find((p) => p.id === myId); }
function renderChat() {
  const panel = $('#chat-panel');
  const visible = ['waiting', 'won'].includes(state?.status);
  panel.classList.toggle('hidden', !visible);
  if (!visible) return;
  $('#chat-panel h2').textContent = state.status === 'waiting' ? '💬 대기방 채팅' : '🎈 함께 이야기하기';
  const messages = state.chat || [];
  $('#chat-messages').innerHTML = messages.length
    ? messages.map((message) => `<div class="chat-message ${message.playerId === myId ? 'mine' : ''}"><small>${message.playerId === myId ? '나' : escapeHtml(message.name)}</small>${escapeHtml(message.message)}</div>`).join('')
    : '<div class="chat-message"><small>아직 메시지가 없어요.</small>첫 소감을 남겨 보세요!</div>';
  $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
}

function render() {
  if (!state) { reportPlatformActivity('LOBBY'); return; }
  reportPlatformActivity(isSpectator ? 'SPECTATING' : state.status === 'playing' ? 'PLAYING' : 'LOBBY');
  $('#lobby').classList.add('hidden'); $('#game').classList.remove('hidden');
  const isWaiting = state.status === 'waiting';
  $('#code-display').textContent = state.code;
  $('#code-display').classList.toggle('hidden', !isWaiting);
  $('#copy').classList.toggle('hidden', !isWaiting);
  $('#room-info').textContent = isWaiting ? `${state.players.length} / ${state.maxPlayers}명 · ${state.players.map((p) => p.name).join(' · ')}` : `${state.players.length}명 플레이 중`;
  $('#round-label').textContent = state.status === 'waiting' ? '참가자 대기 중' : `ROUND ${state.round}`;
  $('#start-panel').classList.add('hidden'); $('#play-panel').classList.add('hidden'); $('#result-panel').classList.add('hidden');
  const status = $('#status');
  const lastRound = state.history[state.history.length - 1];
  const clue = $('#round-clue');
  clue.classList.toggle('hidden', !lastRound || state.status === 'waiting');
  if (lastRound && state.status !== 'waiting') {
    clue.innerHTML = `<small>${lastRound.round}R에서 나온 단어 — 이 단어들을 보고 다음 단어를 떠올려 보세요</small><div class="clue-words">${lastRound.entries.map((entry) => `<div class="clue-word"><small>${entry.playerId === myId ? '내 단어' : `${escapeHtml(entry.name)}의 단어`}</small><b>${escapeHtml(entry.word)}</b></div>`).join('')}</div>`;
  }
  const enoughPlayers = state.players.length >= 2;
  $('#cancel-room').classList.toggle('hidden', !(state.status === 'waiting' && isHost()));
  if (state.status === 'waiting') {
    status.textContent = enoughPlayers ? (isHost() ? '참가자가 준비됐어요. 시작 단어를 정해 주세요.' : '방장이 시작 단어를 정하고 있어요.') : '친구에게 큰 방 코드를 보내고 최소 한 명의 입장을 기다려 주세요.';
    if (enoughPlayers && isHost()) $('#start-panel').classList.remove('hidden');
  } else if (state.status === 'playing') {
    const mineSubmitted = state.submittedIds.includes(myId);
    const submissionCount = `<span class="submission-count">제출 현황 ${state.submittedIds.length} / ${state.players.length}명</span>`;
    if (state.round === 1) {
      status.innerHTML = `<span class="topic-label">시작 단어</span><strong class="topic-word">“${escapeHtml(state.startWord)}”</strong>${submissionCount}<span class="status-guide">${mineSubmitted ? '제출 완료! 다른 참가자의 단어를 기다리는 중이에요.' : '모든 사람이 제출하기 전까지 서로의 단어를 볼 수 없어요.'}</span>`;
    } else {
      status.innerHTML = mineSubmitted
        ? `${submissionCount}<span class="status-guide">제출 완료! 다른 참가자의 단어를 기다리는 중이에요.</span>`
        : `${submissionCount}<span class="status-guide">${state.round - 1}R 단어들을 보고 다음 단어를 떠올려 보세요.</span>`;
    }
    if (!mineSubmitted && !isSpectator) $('#play-panel').classList.remove('hidden');
  } else if (state.status === 'won') {
    const { entries, matched } = state.result;
    status.textContent = '';
    const panel = $('#result-panel'); panel.classList.remove('hidden');
    panel.innerHTML = `<div class="win-card"><div>🎉</div><h2>${state.round}R만에 마음이 통했어요!</h2><p>모든 참가자가 같은 단어를 선택했습니다.</p><div class="result-words">${entries.map((e) => `<div><small>${e.playerId === myId ? '내 단어' : `${escapeHtml(e.name)}의 단어`}</small><b>${escapeHtml(e.word)}</b></div>`).join('')}</div>${isHost() ? '<button id="restart">새 게임</button>' : '<p>방장이 새 게임을 시작할 수 있어요.</p>'}</div>`;
    $('#restart')?.addEventListener('click', () => call('restart-game').then(handle));
  }
  $('#history').innerHTML = state.history.map((h) => `<div class="history-row"><strong>${h.round}R ${h.matched ? '✓ 정답' : ''}</strong><span class="history-prompt">제시어: ${(h.prompt || []).map((item) => escapeHtml(item.word)).join(' · ')}</span><span class="history-answer">${h.entries.map((e) => `${e.playerId === myId ? '내 단어' : `${escapeHtml(e.name)}의 단어`}: ${escapeHtml(e.word)}`).join(' · ')}</span></div>`).join('');
  renderChat();
}
window.setInterval(() => reportPlatformActivity(!state ? 'LOBBY' : isSpectator ? 'SPECTATING' : state.status === 'playing' ? 'PLAYING' : 'LOBBY', true), 45_000);
function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
function handle(result) { if (!result?.ok) note(result?.message || '오류가 발생했어요.'); else note(''); }

$('#create').addEventListener('click', async () => { const r = await call('create-room', { name: $('#name').value, maxPlayers: $('#max-players').value, token: playerToken }); handle(r); if (r.ok) { sessionStorage.setItem('association-room-code', r.state.code); state = r.state; render(); } });
$('#join').addEventListener('click', async () => { const r = await call('join-room', { name: $('#name').value, code: roomCodeFrom($('#room-code').value), token: playerToken }); handle(r); if (r.ok) { sessionStorage.setItem('association-room-code', r.state.code); state = r.state; render(); } });
$('#spectate').addEventListener('click', async () => { const payload = { code: roomCodeFrom($('#room-code').value), name: $('#name').value }; const r = await call('spectate-room', payload); handle(r); if (r.ok) { isSpectator = true; sessionStorage.removeItem('association-room-code'); sessionStorage.setItem(spectatorSessionKey, JSON.stringify({ ...payload, spectatorToken: r.spectatorToken })); state = r.state; render(); } });
$('#start').addEventListener('click', async () => { const r = await call('set-start-word', { word: $('#start-word').value }); handle(r); if (r.ok) $('#start-word').value = ''; });
$('#random').addEventListener('click', async () => { const r = await call('pick-random-topic', { category: $('#category').value }); handle(r); if (r.ok) { $('#start-word').value = r.word; note(`“${r.word}” (${r.category}) 주제가 뽑혔어요. 게임 시작을 눌러 주세요.`); } });
$('#submit').addEventListener('click', async () => {
  const r = await call('submit-word', { word: $('#word').value });
  if (!r?.ok) { $('#word-error').textContent = r?.message || '단어를 제출하지 못했어요.'; return; }
  $('#word-error').textContent = '';
  $('#word').value = '';
  note('');
});
$('#word').addEventListener('input', () => { $('#word-error').textContent = ''; });
$('#copy').addEventListener('click', async () => {
  const inviteLink = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.code)}`;
  try { await navigator.clipboard.writeText(inviteLink); note('초대 링크가 복사됐어요. 친구에게 보내세요!'); }
  catch { note(`초대 링크: ${inviteLink}`); }
});
$('#platform-home').addEventListener('click', () => window.location.assign(platformHomeUrl()));
$('#chat-send').addEventListener('click', async () => { const r = await call('send-chat', { message: $('#chat-input').value }); handle(r); if (r.ok) $('#chat-input').value = ''; });
$('#cancel-room').addEventListener('click', async () => { if (!confirm('이 방을 취소할까요? 참가자 모두 대기 화면으로 돌아갑니다.')) return; const r = await call('cancel-room'); handle(r); if (r.ok) { state = null; sessionStorage.removeItem('association-room-code'); $('#game').classList.add('hidden'); $('#lobby').classList.remove('hidden'); note('방을 취소했어요.'); } });
$('#leave-room').addEventListener('click', async () => { if (!confirm('방에서 나갈까요?')) return; const r = await call('leave-room'); if (!r?.ok) return handle(r); state = null; isSpectator = false; sessionStorage.removeItem('association-room-code'); sessionStorage.removeItem(spectatorSessionKey); $('#game').classList.add('hidden'); $('#lobby').classList.remove('hidden'); note('방에서 나왔어요.'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { const active = document.activeElement?.id; if (active === 'name' || active === 'room-code') $('#join').click(); if (active === 'start-word') $('#start').click(); if (active === 'word') $('#submit').click(); if (active === 'chat-input') $('#chat-send').click(); } });
