const socket = io();
const $ = (selector) => document.querySelector(selector);
let state = null;
let myId = null;
const categories = ['자연과 날씨', '음식과 음료', '동물과 식물', '장소와 여행', '일상과 물건', '취미와 놀이', '문화와 예술', '감정과 관계', '직업과 사회', '상상과 이야기'];
categories.forEach((category) => { const option = document.createElement('option'); option.value = category; option.textContent = category; $('#category').append(option); });

socket.on('connect', () => { myId = socket.id; });
socket.on('room-state', (next) => { state = next; render(); });
socket.on('room-cancelled', ({ message }) => { state = null; $('#game').classList.add('hidden'); $('#lobby').classList.remove('hidden'); note(message); });

function note(message = '') { $('#notice').textContent = message; }
function call(event, data) { return new Promise((resolve) => socket.emit(event, data, resolve)); }
function isHost() { return state?.hostId === myId; }
function myPlayer() { return state?.players.find((p) => p.id === myId); }

function render() {
  if (!state) return;
  $('#lobby').classList.add('hidden'); $('#game').classList.remove('hidden');
  $('#code-display').textContent = state.code;
  $('#room-info').textContent = `${state.players.length} / ${state.maxPlayers}명 · ${state.players.map((p) => p.name).join(' · ')}`;
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
    const prompt = state.round === 1 ? `시작 단어: “${state.startWord}”` : `${state.round - 1}R 단어들을 보고 연상해 보세요.`;
    status.textContent = mineSubmitted ? `제출 완료! 다른 ${state.players.length - state.submittedIds.length}명의 단어를 기다리는 중이에요.` : `${prompt} — 모든 사람이 제출하기 전까지 서로 볼 수 없어요.`;
    if (!mineSubmitted) $('#play-panel').classList.remove('hidden');
  } else {
    const { entries, matched } = state.result;
    status.textContent = matched ? '🎉 마음이 통했어요! 모두의 단어가 일치합니다.' : '아쉽지만 달라요. 다음 라운드에서 다시 맞춰 보세요.';
    const panel = $('#result-panel'); panel.classList.remove('hidden');
    panel.innerHTML = `<div class="result-words">${entries.map((e) => `<div><small>${e.playerId === myId ? '내 단어' : `${escapeHtml(e.name)}의 단어`}</small><b>${escapeHtml(e.word)}</b></div>`).join('')}</div>` + (matched ? (isHost() ? '<button id="restart">새 게임</button>' : '<p>방장이 새 게임을 시작할 수 있어요.</p>') : '<button id="next">다음 라운드</button>');
    $('#next')?.addEventListener('click', () => call('next-round').then(handle));
    $('#restart')?.addEventListener('click', () => call('restart-game').then(handle));
  }
  $('#history').innerHTML = state.history.map((h) => `<div class="history-row"><strong>${h.round}R ${h.matched ? '✓' : ''}</strong><span>${h.entries.map((e) => `${e.playerId === myId ? '내 단어' : `${escapeHtml(e.name)}의 단어`}: ${escapeHtml(e.word)}`).join(' · ')}</span></div>`).join('');
}
function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
function handle(result) { if (!result?.ok) note(result?.message || '오류가 발생했어요.'); else note(''); }

$('#create').addEventListener('click', async () => { const r = await call('create-room', { name: $('#name').value, maxPlayers: $('#max-players').value }); handle(r); if (r.ok) { state = r.state; render(); } });
$('#join').addEventListener('click', async () => { const r = await call('join-room', { name: $('#name').value, code: $('#room-code').value }); handle(r); if (r.ok) { state = r.state; render(); } });
$('#start').addEventListener('click', async () => { const r = await call('set-start-word', { word: $('#start-word').value }); handle(r); if (r.ok) $('#start-word').value = ''; });
$('#random').addEventListener('click', async () => { const r = await call('pick-random-topic', { category: $('#category').value }); handle(r); if (r.ok) { $('#start-word').value = r.word; note(`“${r.word}” (${r.category}) 주제가 뽑혔어요. 게임 시작을 눌러 주세요.`); } });
$('#submit').addEventListener('click', async () => { const r = await call('submit-word', { word: $('#word').value }); handle(r); if (r.ok) $('#word').value = ''; });
$('#copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.code); note('방 코드가 복사됐어요.'); } catch { note(`방 코드: ${state.code}`); } });
$('#cancel-room').addEventListener('click', async () => { if (!confirm('이 방을 취소할까요? 참가자 모두 대기 화면으로 돌아갑니다.')) return; const r = await call('cancel-room'); handle(r); if (r.ok) { state = null; $('#game').classList.add('hidden'); $('#lobby').classList.remove('hidden'); note('방을 취소했어요.'); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { const active = document.activeElement?.id; if (active === 'name' || active === 'room-code') $('#join').click(); if (active === 'start-word') $('#start').click(); if (active === 'word') $('#submit').click(); } });
