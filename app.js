/* Yig'ilish — Zoom uslubidagi video uchrashuvlar.
   Server o'rnatish shart emas: video LiveKit Cloud orqali, kirish tokeni Vercel funksiyasidan (/api/*).
   Birinchi odam yig'ilish yaratadi (nomi + vaqti) va havolani yuboradi; havolani ochganlar vaqtida avtomatik qo'shiladi. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LK = window.LivekitClient;
const REACTIONS = ['👏', '👍', '❤️', '😂', '😮', '🎉'];
const COLORS = ['#e8590c', '#0e72ed', '#12b76a', '#7048e8', '#d6336c', '#0c8599', '#f08c00', '#5c7cfa'];
const EARLY_MS = 5 * 60e3;
// API (token xizmati) Vercel'da; mahalliy sinovda shu serverning o'zi
const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '' : 'https://yigilish-api.vercel.app';
const BASE_PATH = location.pathname.replace(/[^/]*$/, ''); // masalan /mahalla-yigilish/
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

// ---------------- Holat ----------------
let ctx = null;            // {code, m:{r,t,s}, host}
let me = null;             // {identity, name, isHost}
let room = null;
let inMeeting = false, leaving = false;
const roster = new Map();  // identity -> {name, host, state}
let joinedAt = 0, timerInt = null, view = 'speaker', pinned = null, activeSpeaker = null, lastSwitch = 0, unread = 0;
let waitTimer = null, countInt = null;

// ---------------- Yordamchilar ----------------
function show(id) { for (const s of $$('.screen')) s.classList.add('hidden'); $(id).classList.remove('hidden'); }
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const colorOf = (s) => COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
const pad = (n) => String(n).padStart(2, '0');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function fmtWhen(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 864e5);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `Bugun, ${hm}`;
  if (diff === 1) return `Ertaga, ${hm}`;
  if (diff === -1) return `Kecha, ${hm}`;
  return `${d.getDate()}-${MONTHS[d.getMonth()]} ${d.getFullYear() !== now.getFullYear() ? d.getFullYear() + ' ' : ''}${hm}`;
}
function decodeCode(code) {
  try {
    const body = String(code).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(body))));
  } catch { return null; }
}
const linkOf = (code) => `${location.origin}${BASE_PATH}?m=${code}`;
async function api(path, body) {
  try {
    const r = await fetch(`${API_BASE}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.error || `Xatolik (${r.status})` };
  } catch { return { error: "Internet aloqasi yo'q" }; }
}
async function copy(text, msg = 'Nusxa olindi') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Nusxalang:', text); }
}
function modal(text, buttons) {
  return new Promise((res) => {
    $('#modal-text').textContent = text;
    $('#modal-btns').innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = `btn ${b.cls || ''}`; el.textContent = b.label;
      el.onclick = () => { $('#modal').classList.add('hidden'); res(b.value); };
      $('#modal-btns').appendChild(el);
    }
    $('#modal').classList.remove('hidden');
  });
}

// ---------------- Ovoz (chime) ----------------
let actx = null;
function unlockAudio() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {}
  room?.startAudio().catch(() => {});
  $('#unlock').classList.add('hidden');
}
function beep(f, t, d, v = 0.15) {
  if (!actx || actx.state !== 'running') return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + .02); g.gain.linearRampToValueAtTime(0, t + d);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d);
}
const chime = (up) => { if (actx) { const t = actx.currentTime; beep(up ? 660 : 880, t, .12); beep(up ? 880 : 660, t + .13, .16); } };
document.addEventListener('pointerdown', unlockAudio);
$('#unlock').onclick = unlockAudio;

// ================= MENING YIG'ILISHLARIM =================
const myMeetings = () => (store.get('my') || []).filter((x) => x.s > Date.now() - 30 * 864e5);
function saveMine(entry) {
  const list = myMeetings().filter((x) => x.r !== entry.r);
  list.unshift(entry); store.set('my', list.slice(0, 20));
}
function deviceId() {
  let id = store.get('cid');
  if (!id) { id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''); store.set('cid', id); }
  return id;
}
const hostKeyFor = (r) => (store.get('hosts') || {})[r] || null;
function saveHostKey(r, k) { const h = store.get('hosts') || {}; h[r] = k; store.set('hosts', h); }
function renderMine() {
  const list = myMeetings().sort((a, b) => b.s - a.s);
  $('#my-box').classList.toggle('hidden', !list.length);
  $('#my-list').innerHTML = list.map((x) => `
    <li data-code="${esc(x.code)}">
      <div class="who"><b>${esc(x.t)}</b><small>${fmtWhen(x.s)}${hostKeyFor(x.r) ? ' · host' : ''}</small></div>
      <button class="btn sm" data-a="copy" title="Havolani nusxalash">${icon('i-send')}</button>
      <button class="btn sm primary" data-a="open">Kirish</button>
    </li>`).join('');
  $$('#my-list button').forEach((b) => b.onclick = () => {
    const code = b.closest('li').dataset.code;
    if (b.dataset.a === 'copy') copy(linkOf(code), 'Havoladan nusxa olindi');
    else openMeeting(code, true);
  });
}

// ================= BOSH SAHIFA =================
function tickClock() {
  const d = new Date();
  $('#home-clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
setInterval(tickClock, 10000); tickClock();
function localInputValue(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
$$('input[name=when]').forEach((r) => r.onchange = () => {
  const later = $('input[name=when]:checked').value === 'later';
  $('#c-time').classList.toggle('hidden', !later);
  if (later && !$('#c-time').value) $('#c-time').value = localInputValue(Math.ceil((Date.now() + 3600e3) / 900e3) * 900e3);
});
$('#form-create').onsubmit = async (e) => {
  e.preventDefault(); unlockAudio();
  const name = $('#c-name').value.trim();
  const title = $('#c-title').value.trim() || `${name} yig'ilishi`;
  const later = $('input[name=when]:checked').value === 'later';
  const startAt = later ? new Date($('#c-time').value).getTime() : Date.now();
  if (later && !(startAt > 0)) return ($('#create-error').textContent = 'Sana va vaqtni tanlang');
  store.set('name', name);
  $('#btn-create').disabled = true; $('#create-error').textContent = '';
  const r = await api('create', { title, startAt });
  $('#btn-create').disabled = false;
  if (r.error) return ($('#create-error').textContent = r.error);
  saveHostKey(r.room, r.host);
  saveMine({ code: r.code, r: r.room, t: r.title, s: r.startAt });
  showCreated(r.code);
};
$('#form-open').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#o-link').value.trim();
  const m = v.match(/[?&]m=([\w.-]+)/) || v.match(/^([\w-]+\.[\w-]+)$/);
  if (!m || !decodeCode(m[1])) return toast("Havola noto'g'ri");
  openMeeting(m[1]);
};

// ================= YARATILDI =================
function showCreated(code) {
  const m = decodeCode(code);
  ctx = { code, m, host: hostKeyFor(m.r) };
  history.replaceState(null, '', BASE_PATH);
  $('#cr-title').textContent = m.t;
  $('#cr-time').textContent = m.s > Date.now() + 60e3 ? `Boshlanish vaqti: ${fmtWhen(m.s)}` : 'Hozir boshlanadi';
  const link = linkOf(code);
  $('#cr-link').textContent = link;
  const text = `"${m.t}" video yig'ilishiga taklif qilinasiz. Vaqti: ${fmtWhen(m.s)}. Havolani bosing:`;
  $('#cr-tg').href = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  $('#cr-share').classList.toggle('hidden', !navigator.share);
  $('#cr-copy').onclick = () => copy(link, 'Havoladan nusxa olindi');
  $('#cr-share').onclick = () => navigator.share({ title: m.t, text, url: link }).catch(() => {});
  $('#cr-start').onclick = () => openMeeting(code, true);
  $('#cr-hostlink').onclick = (e) => { e.preventDefault(); copy(`${link}&h=${ctx.host}`, 'Host havolasi nusxalandi — uni hech kimga bermang'); };
  show('#screen-created');
}
$('#cr-home').onclick = goHome;

// ================= HAVOLA ORQALI KIRISH / KUTISH =================
function goHome() {
  clearTimeout(waitTimer); clearInterval(countInt); waiting = false;
  history.replaceState(null, '', BASE_PATH);
  ctx = null;
  $('#c-name').value = store.get('name') || '';
  renderMine();
  show('#screen-home');
}
function openMeeting(code, auto = false, manual = false) {
  const m = decodeCode(code);
  if (!m) return goHome();
  clearTimeout(waitTimer); clearInterval(countInt); waiting = false;
  ctx = { code, m, host: hostKeyFor(m.r) };
  history.replaceState(null, '', `${BASE_PATH}?m=${code}`);
  $('#j-title').textContent = m.t;
  $('#j-time').textContent = m.s > Date.now() ? `Boshlanish: ${fmtWhen(m.s)}` : `Boshlangan: ${fmtWhen(m.s)}`;
  $('#j-name').value = store.get('name') || '';
  $('#j-error').textContent = '';
  $('#j-wait').classList.add('hidden');
  $('#form-join').classList.remove('hidden');
  $('#j-btn').textContent = ctx.host ? "Yig'ilishni boshlash" : "Qo'shilish";
  show('#screen-join');
  if (!manual && $('#j-name').value) tryJoin();
}
$('#j-home').onclick = goHome;
$('#form-join').onsubmit = (e) => { e.preventDefault(); unlockAudio(); store.set('name', $('#j-name').value.trim()); tryJoin(); };

let joining = false, waiting = false, lastTry = 0, clockSkew = 0;
async function tryJoin() {
  clearTimeout(waitTimer);
  if (joining || inMeeting || !ctx) return;
  const name = $('#j-name').value.trim() || store.get('name');
  if (!name) return;
  const myCtx = ctx;
  joining = true; lastTry = Date.now();
  $('#j-btn').disabled = true; $('#j-error').textContent = '';
  const r = await api('join', { code: myCtx.code, name, host: myCtx.host, cid: deviceId() });
  joining = false;
  $('#j-btn').disabled = false;
  if (ctx !== myCtx || inMeeting) return; // foydalanuvchi boshqa sahifaga o'tib ketgan
  if (r.error) {
    $('#j-error').textContent = r.error;
    // Kutish paytida internet uzilsa — to'xtab qolmasdan qayta urinamiz
    if (waiting || /Internet|Xatolik \(5/.test(r.error)) waitTimer = setTimeout(tryJoin, 10000);
    return;
  }
  if (r.wait) { if (r.now) clockSkew = r.now - Date.now(); return showWaiting(r.startAt); }
  waiting = false;
  clearInterval(countInt);
  if (!ctx.host) saveMine({ code: ctx.code, r: ctx.m.r, t: ctx.m.t, s: ctx.m.s });
  enterMeeting(r, name);
}
function showWaiting(startAt) {
  waiting = true;
  $('#form-join').classList.add('hidden');
  const w = $('#j-wait'); w.classList.remove('hidden');
  clearInterval(countInt);
  const tick = () => {
    const left = Math.max(0, startAt - (Date.now() + clockSkew)); // server soati bo'yicha
    const h = Math.floor(left / 3600e3), mi = Math.floor(left % 3600e3 / 60e3), s = Math.floor(left % 60e3 / 1000);
    w.innerHTML = `Yig'ilish <b>${fmtWhen(startAt)}</b> da boshlanadi.<div class="countdown">${h ? h + ':' : ''}${pad(mi)}:${pad(s)}</div>
      Vaqti kelganda (yoki tashkilotchi ertaroq boshlasa) <b>avtomatik qo'shilasiz</b>. Sahifani yopmang.`;
    // Vaqti keldi — so'raymiz (soat farqi bo'lsa ham 10 soniyada bir martadan ko'p emas)
    if (left <= EARLY_MS && Date.now() - lastTry > 10000) tryJoin();
  };
  tick(); countInt = setInterval(tick, 1000);
  waitTimer = setTimeout(tryJoin, 20000); // host ertaroq boshlagan bo'lsa
}

// ================= YIG'ILISH (LiveKit) =================
const participantOf = (id) => (id === me?.identity ? room?.localParticipant : room?.remoteParticipants.get(id));
function stateOf(p) {
  const a = p.attributes || {};
  return { mic: p.isMicrophoneEnabled, cam: p.isCameraEnabled, sharing: p.isScreenShareEnabled, hand: a.hand === '1', recording: a.rec === '1' };
}
function isHostP(p) { try { return !!JSON.parse(p.metadata || '{}').host; } catch { return false; } }
function syncRoster() {
  if (!room) return;
  const seen = new Set();
  for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
    seen.add(p.identity);
    roster.set(p.identity, { name: p.name || p.identity, host: isHostP(p), state: stateOf(p) });
  }
  for (const id of [...roster.keys()]) if (!seen.has(id)) { roster.delete(id); $(`#tile-${CSS.escape(id)}`)?.remove(); if (pinned === id) pinned = null; }
}
const myState = () => roster.get(me?.identity)?.state || {};

async function enterMeeting(r, name) {
  me = { identity: r.identity, name, isHost: r.isHost };
  if (r.isHost) saveHostKey(ctx.m.r, ctx.host);
  inMeeting = true; leaving = false;
  document.body.classList.toggle('is-admin', r.isHost);
  $('#btn-rec').classList.toggle('hidden', !r.isHost);
  $('#leave-label').textContent = r.isHost ? 'Tugatish' : 'Chiqish';
  $('#meet-title').textContent = r.title;
  $('#grid').innerHTML = ''; roster.clear(); $('#chat-list').innerHTML = ''; unread = 0; updateBadge();
  view = 'speaker'; pinned = null; activeSpeaker = null;
  show('#screen-meeting');
  joinedAt = Date.now();
  clearInterval(timerInt);
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - joinedAt) / 1000), h = Math.floor(s / 3600);
    $('#meet-timer').textContent = (h ? `${h}:` : '') + `${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
  }, 1000);

  const E = LK.RoomEvent;
  room = new LK.Room({
    adaptiveStream: true, dynacast: true,
    videoCaptureDefaults: { resolution: LK.VideoPresets.h720.resolution },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    publishDefaults: { simulcast: true, videoSimulcastLayers: [LK.VideoPresets.h180, LK.VideoPresets.h360] },
  });
  const refresh = () => { syncRoster(); renderAll(); };
  room
    .on(E.ParticipantConnected, (p) => { refresh(); chime(true); toast(`${p.name} qo'shildi`, 2000); })
    .on(E.ParticipantDisconnected, (p) => { refresh(); chime(false); toast(`${p.name} chiqib ketdi`, 2000); })
    .on(E.TrackSubscribed, (track, _pub, p) => {
      if (track.kind === 'audio') { const el = track.attach(); el.dataset.id = p.identity; $('#lk-audio').appendChild(el); }
      refreshTile(p.identity); refresh();
    })
    .on(E.TrackUnsubscribed, (track, _pub, p) => { track.detach().forEach((el) => el.tagName === 'AUDIO' && el.remove()); refreshTile(p.identity); refresh(); })
    .on(E.TrackPublished, refresh).on(E.TrackUnpublished, refresh)
    .on(E.TrackMuted, (_pub, p) => {
      if (p.identity === me.identity && _pub.source === LK.Track.Source.Microphone && !leaving) toast("Ovozingiz o'chirildi");
      refresh();
    })
    .on(E.TrackUnmuted, refresh)
    .on(E.LocalTrackPublished, () => { refreshTile(me.identity); refresh(); })
    .on(E.LocalTrackUnpublished, () => { refreshTile(me.identity); refresh(); })
    .on(E.ParticipantAttributesChanged, (changed, p) => {
      if (changed.hand === '1' && p.identity !== me.identity) toast(`✋ ${p.name} qo'l ko'tardi`);
      refresh();
    })
    .on(E.ActiveSpeakersChanged, (sp) => {
      const s = sp[0]?.identity || null;
      if (s && s !== activeSpeaker && Date.now() - lastSwitch > 1200) { activeSpeaker = s; lastSwitch = Date.now(); renderTiles(); }
    })
    .on(E.DataReceived, onData)
    .on(E.AudioPlaybackStatusChanged, () => { if (!room.canPlaybackAudio) $('#unlock').classList.remove('hidden'); })
    .on(E.Reconnecting, () => toast('Aloqa sustlashdi, qayta ulanmoqda…', 5000))
    .on(E.Reconnected, () => toast('Qayta ulandi', 1500))
    .on(E.Disconnected, (reason) => onDisconnected(reason));

  try { await room.connect(r.url, r.token); }
  catch (e) {
    inMeeting = false; room?.removeAllListeners(); room = null;
    openMeeting(ctx.code, false, true); // avtomatik takrorlamaymiz — foydalanuvchi o'zi bosadi
    $('#j-error').textContent = "Video serverga ulanib bo'lmadi. Internetni tekshirib, qayta bosing.";
    return;
  }
  autoRejoins = 0;
  syncRoster(); renderAll();
  try { await room.localParticipant.setMicrophoneEnabled(true); } catch { toast("Mikrofonga ruxsat berilmadi"); }
  try { await room.localParticipant.setCameraEnabled(true); } catch { toast("Kameraga ruxsat berilmadi"); }
  room.startAudio().catch(() => {});
  refresh();
  if (me.isHost && innerWidth > 860) openPane('people');
  clearInterval(levelInt);
  levelInt = setInterval(() => $('#mic-lvl').style.setProperty('--lvl', Math.min(1, (room?.localParticipant.audioLevel || 0) * 3).toFixed(2)), 200);
}
let levelInt = null;

function refreshTile(id) {
  if (!roster.has(id) && id !== me?.identity) return;
  const p = participantOf(id); if (!p) return;
  const T = LK.Track.Source;
  const t = p.getTrackPublication(T.ScreenShare)?.track || p.getTrackPublication(T.Camera)?.track;
  const v = $('video', ensureTile(id));
  if (v._lkTrack === t) return;
  v._lkTrack?.detach(v);
  v._lkTrack = t || null;
  if (t) t.attach(v);
}

let autoRejoins = 0;
async function onDisconnected(reason) {
  const R = LK.DisconnectReason || {};
  const wasLeaving = leaving;
  cleanupMeeting();
  if (wasLeaving) return;
  let text = 'Aloqa uzildi';
  if (reason === R.ROOM_DELETED) text = "Tashkilotchi yig'ilishni yakunladi";
  else if (reason === R.PARTICIPANT_REMOVED) text = "Tashkilotchi sizni yig'ilishdan chiqardi";
  else if (reason === R.DUPLICATE_IDENTITY) text = "Siz boshqa oynadan (yoki qurilmadan) kirdingiz";
  showLeft(text, reason !== R.PARTICIPANT_REMOVED);
  const final = [R.ROOM_DELETED, R.PARTICIPANT_REMOVED, R.DUPLICATE_IDENTITY, R.CLIENT_INITIATED].includes(reason);
  if (!final && autoRejoins < 3) {
    autoRejoins++;
    $('#left-text').textContent = 'Aloqa uzildi — qayta ulanmoqda…';
    setTimeout(() => { if (!inMeeting && ctx && $('#screen-left').offsetParent !== null) openMeeting(ctx.code, true); }, 3000);
  }
}
function cleanupMeeting() {
  if (recorder) stopRecording();
  inMeeting = false;
  clearInterval(timerInt); clearInterval(levelInt);
  room?.removeAllListeners();
  room = null;
  $('#lk-audio').innerHTML = '';
  roster.clear(); $('#grid').innerHTML = '';
  closePanes(); closePops();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function showLeft(text, canRejoin = true) {
  $('#left-text').textContent = text;
  $('#btn-rejoin').classList.toggle('hidden', !canRejoin);
  show('#screen-left');
}
$('#btn-rejoin').onclick = () => { unlockAudio(); openMeeting(ctx.code, true); };
$('#btn-left-home').onclick = goHome;

async function leave(endForAll) {
  leaving = true;
  if (endForAll) await api('host', { code: ctx.code, host: ctx.host, action: 'end' });
  await room?.disconnect().catch(() => {});
  cleanupMeeting();
  showLeft(endForAll ? "Yig'ilish hamma uchun yakunlandi" : "Yig'ilishdan chiqdingiz", true);
}
$('#btn-leave').onclick = async () => {
  const opts = me.isHost
    ? [{ label: "Hamma uchun yig'ilishni tugatish", cls: 'red', value: 'end' }, { label: "Yig'ilishdan chiqish", value: 'leave' }, { label: 'Bekor qilish', cls: 'link', value: null }]
    : [{ label: "Yig'ilishdan chiqish", cls: 'red', value: 'leave' }, { label: 'Bekor qilish', cls: 'link', value: null }];
  const v = await modal(me.isHost ? "Yig'ilishni tugatish yoki chiqish?" : "Yig'ilishdan chiqmoqchimisiz?", opts);
  if (v) leave(v === 'end');
};
addEventListener('beforeunload', () => { leaving = true; room?.disconnect(); });

// ---------------- Ma'lumot almashish (chat, reaksiya, host so'rovlari) ----------------
const enc = new TextEncoder(), dec = new TextDecoder();
function send(topic, data, to) {
  if (!room) return;
  room.localParticipant.publishData(enc.encode(JSON.stringify(data)), { reliable: true, topic, ...(to ? { destinationIdentities: [to] } : {}) }).catch(() => {});
}
function onData(payload, p, _kind, topic) {
  let d; try { d = JSON.parse(dec.decode(payload)); } catch { return; }
  if (!p) return;
  if (topic === 'chat') addChat({ ...d, from: p.identity, name: p.name });
  else if (topic === 'react') showReaction(p.identity, d.emoji);
  else if (topic === 'cmd' && isHostP(p)) {
    if (d.cmd === 'askUnmute' && !myState().mic) modal("Tashkilotchi ovozingizni yoqishingizni so'rayapti", [{ label: 'Ovozni yoqish', cls: 'primary', value: 1 }, { label: 'Hozir emas', value: 0 }]).then((v) => v && setMic(true));
    else if (d.cmd === 'lowerHand') setHand(false);
  }
}

// ================= PLITKALAR =================
function ensureTile(id) {
  let t = document.getElementById(`tile-${id}`);
  if (t) return t;
  const p = roster.get(id) || { name: participantOf(id)?.name || '?' };
  t = document.createElement('div');
  t.className = 'tile' + (id === me?.identity ? ' me' : '');
  t.id = `tile-${id}`; t.dataset.sid = id;
  t.innerHTML = `<video autoplay playsinline muted></video>
    <div class="avatar"><span class="ini" style="background:${colorOf(p.name)}">${esc(initials(p.name))}</span></div>
    <div class="hand">✋</div><div class="react"></div>
    <div class="name"><span class="mi">${icon('i-mic-off')}</span><em></em></div>
    <button class="tmenu" title="Amallar">${icon('i-more')}</button>`;
  $('.tmenu', t).onclick = (e) => { e.stopPropagation(); tileMenu(id, e.currentTarget); };
  t.ondblclick = () => { pinned = pinned === id ? null : id; if (pinned) view = 'speaker'; renderAll(); };
  $('#grid').appendChild(t);
  return t;
}
function renderTiles() {
  const grid = $('#grid');
  const ids = [...roster.keys()];
  for (const id of ids) refreshTile(id);
  const sharingId = ids.find((s) => roster.get(s).state?.sharing);
  const others = ids.filter((s) => s !== me.identity);
  const main = sharingId || (pinned && roster.has(pinned) ? pinned : null) || (activeSpeaker && activeSpeaker !== me.identity && roster.has(activeSpeaker) ? activeSpeaker : null) || others[0] || me.identity;
  const speakerMode = view === 'speaker' || !!sharingId;
  grid.className = 'grid ' + (speakerMode ? 'speaker' : 'gallery');
  grid.classList.toggle('solo', speakerMode && ids.length === 1);
  for (const id of ids) {
    const t = ensureTile(id), p = roster.get(id), st = p.state || {};
    t.classList.toggle('main', speakerMode && id === main);
    t.classList.toggle('cam-off', !st.cam && !st.sharing);
    t.classList.toggle('mic-off', !st.mic);
    t.classList.toggle('hand-up', !!st.hand);
    t.classList.toggle('sharing', !!st.sharing);
    t.classList.toggle('me', id === me.identity && !st.sharing);
    t.classList.toggle('speaking', id === activeSpeaker && st.mic && ids.length > 1);
    $('.name em', t).textContent = p.name + (id === me.identity ? ' (Siz)' : '') + (p.host ? ' · Host' : '');
    $('.tmenu', t).style.visibility = id === me.identity ? 'hidden' : '';
    t.style.gridColumn = '';
  }
  const n = ids.length;
  if (speakerMode) {
    const strip = ids.filter((s) => s !== main);
    grid.style.gridTemplateColumns = strip.length ? `minmax(0,1fr) repeat(${strip.length}, minmax(0,180px)) minmax(0,1fr)` : '1fr';
    strip.forEach((id, i) => { ensureTile(id).style.gridColumn = String(i + 2); });
  } else {
    grid.style.gridTemplateColumns = '';
    const W = grid.clientWidth || innerWidth, H = grid.clientHeight || innerHeight - 120;
    let best = 1, bestArea = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols), w = Math.min(W / cols, (H / rows) * 16 / 9);
      if (w * w * 9 / 16 > bestArea) { bestArea = w * w * 9 / 16; best = cols; }
    }
    grid.style.setProperty('--cols', best);
    grid.style.setProperty('--rowh', `${Math.floor(Math.min(H / Math.ceil(n / best), (W / best) * 9 / 16))}px`);
  }
  $('#view-label').textContent = view === 'speaker' ? 'Spiker' : 'Galereya';
  $('#btn-view use').setAttribute('href', view === 'speaker' ? '#i-speaker' : '#i-grid');
  $('#people-count').textContent = n;
}
addEventListener('resize', () => inMeeting && renderTiles());
$('#btn-view').onclick = () => { view = view === 'speaker' ? 'gallery' : 'speaker'; pinned = null; renderTiles(); };
$('#btn-full').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : $('#screen-meeting').requestFullscreen?.().catch(() => {}); };

// ---------------- Host amallari ----------------
function hostMute(id, source) {
  const pub = participantOf(id)?.getTrackPublication(source);
  if (pub?.trackSid) api('host', { code: ctx.code, host: ctx.host, action: 'mute', identity: id, trackSid: pub.trackSid }).then((r) => r.error && toast(r.error));
}
async function kick(id) {
  const p = roster.get(id);
  if (await modal(`${p?.name} ni yig'ilishdan chiqarasizmi?`, [{ label: 'Chiqarish', cls: 'red', value: 1 }, { label: 'Bekor qilish', value: 0 }])) {
    const r = await api('host', { code: ctx.code, host: ctx.host, action: 'kick', identity: id });
    if (r.error) toast(r.error);
  }
}
function tileMenu(id, anchor) {
  const p = roster.get(id); if (!p) return;
  const S = LK.Track.Source;
  const items = [{ label: pinned === id ? 'Mahkamlashni olib tashlash' : 'Mahkamlash (Pin)', fn: () => { pinned = pinned === id ? null : id; view = 'speaker'; renderAll(); } }];
  if (me.isHost) {
    items.push(p.state.mic ? { label: "Ovozini o'chirish", fn: () => hostMute(id, S.Microphone) } : { label: "Ovozni yoqishni so'rash", fn: () => send('cmd', { cmd: 'askUnmute' }, id) });
    if (p.state.cam) items.push({ label: "Videosini to'xtatish", fn: () => hostMute(id, S.Camera) });
    if (p.state.hand) items.push({ label: "Qo'lini tushirish", fn: () => send('cmd', { cmd: 'lowerHand' }, id) });
    items.push({ label: "Yig'ilishdan chiqarish", fn: () => kick(id) });
  }
  items.push({ label: 'Shaxsiy xabar yozish', fn: () => { openPane('chat'); $('#chat-to').value = id; $('#chat-input').focus(); } });
  openMenu(items, anchor);
}

// ================= BOSHQARUV TUGMALARI =================
function updateControls() {
  const st = myState();
  $('#btn-mic').classList.toggle('off', !st.mic);
  $('#btn-mic use').setAttribute('href', st.mic ? '#i-mic' : '#i-mic-off');
  $('#mic-label').textContent = st.mic ? "Ovozni o'chirish" : 'Ovozni yoqish';
  $('#btn-cam').classList.toggle('off', !st.cam);
  $('#btn-cam use').setAttribute('href', st.cam ? '#i-cam' : '#i-cam-off');
  $('#cam-label').textContent = st.cam ? "Videoni to'xtatish" : 'Videoni yoqish';
  $('#btn-share').classList.toggle('active', !!st.sharing);
  $('#share-banner').classList.toggle('hidden', !st.sharing);
  $('#btn-hand').textContent = st.hand ? "✋ Qo'lni tushirish" : "✋ Qo'l ko'tarish";
  $('#btn-rec').classList.toggle('rec-on', !!recorder);
  $('#rec-label').textContent = recorder ? "To'xtatish" : 'Yozib olish';
  $('#rec-ind').classList.toggle('hidden', ![...roster.values()].some((p) => p.state?.recording));
}
function renderAll() { if (!inMeeting || !me) return; renderTiles(); updateControls(); renderPeople(); renderChatTo(); }

async function setMic(on) {
  try { await room?.localParticipant.setMicrophoneEnabled(on); } catch { toast("Mikrofonni yoqib bo'lmadi"); }
  syncRoster(); renderAll();
}
async function setCam(on) {
  try { await room?.localParticipant.setCameraEnabled(on); } catch { toast("Kamerani yoqib bo'lmadi"); }
  refreshTile(me.identity); syncRoster(); renderAll();
}
async function setHand(on) {
  await room?.localParticipant.setAttributes({ hand: on ? '1' : '' }).catch(() => {});
  syncRoster(); renderAll();
}
$('#btn-mic').onclick = () => setMic(!myState().mic);
$('#btn-cam').onclick = () => setCam(!myState().cam);

$$('.tb-caret').forEach((b) => b.onclick = async (e) => {
  e.stopPropagation();
  const kind = b.dataset.menu, want = kind === 'audio' ? 'audioinput' : 'videoinput';
  const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const cur = room?.getActiveDevice(want);
  const items = [{ head: kind === 'audio' ? 'Mikrofonni tanlang' : 'Kamerani tanlang' }];
  list.filter((d) => d.kind === want).forEach((d, i) => items.push({
    label: d.label || `${kind === 'audio' ? 'Mikrofon' : 'Kamera'} ${i + 1}`, sel: d.deviceId === cur,
    fn: () => room.switchActiveDevice(want, d.deviceId).then(() => refreshTile(me.identity)).catch(() => toast("Almashtirib bo'lmadi")),
  }));
  if (items.length === 1) items.push({ label: 'Qurilma topilmadi', fn: () => {} });
  items.push({ hr: true });
  const st = myState();
  items.push(kind === 'video' ? { label: st.cam ? "Videoni to'xtatish" : 'Videoni yoqish', fn: () => setCam(!st.cam) } : { label: st.mic ? "Ovozni o'chirish" : 'Ovozni yoqish', fn: () => setMic(!st.mic) });
  openMenu(items, b);
});

function openMenu(items, anchor) {
  const pop = $('#menu-pop');
  pop.innerHTML = '';
  for (const it of items) {
    if (it.head) { pop.insertAdjacentHTML('beforeend', `<h6>${esc(it.head)}</h6>`); continue; }
    if (it.hr) { pop.insertAdjacentHTML('beforeend', '<hr>'); continue; }
    const b = document.createElement('button');
    b.textContent = it.label; if (it.sel) b.className = 'sel';
    b.onclick = () => { closePops(); it.fn(); };
    pop.appendChild(b);
  }
  const host = anchor.closest('.toolbar') ? $('.toolbar') : $('#screen-meeting');
  host.appendChild(pop);
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect(), hr = host.getBoundingClientRect();
  if (host.classList.contains('toolbar')) { pop.style.left = `${Math.max(6, r.left - hr.left)}px`; pop.style.top = ''; pop.style.bottom = '68px'; }
  else { pop.style.left = `${Math.min(r.left, innerWidth - 270)}px`; pop.style.top = `${r.bottom + 4}px`; pop.style.bottom = 'auto'; }
}
function closePops() { $$('.pop').forEach((p) => p.classList.add('hidden')); }
document.addEventListener('click', (e) => { if (!e.target.closest('.pop, .tb-caret, #btn-react, #btn-info, .tmenu, [data-a=more]')) closePops(); });

// Reaksiyalar va qo'l ko'tarish
$('.emojis').innerHTML = REACTIONS.map((r) => `<button>${r}</button>`).join('');
$$('.emojis button').forEach((b) => b.onclick = () => { send('react', { emoji: b.textContent }); showReaction(me.identity, b.textContent); closePops(); });
$('#btn-react').onclick = () => { const p = $('#react-pop'); const was = p.classList.contains('hidden'); closePops(); p.classList.toggle('hidden', !was); };
$('#btn-hand').onclick = () => { setHand(!myState().hand); closePops(); };
function showReaction(id, emoji) {
  if (!roster.has(id) || !REACTIONS.includes(emoji)) return;
  const r = $('.react', ensureTile(id));
  r.textContent = emoji; r.classList.remove('pop'); void r.offsetWidth; r.classList.add('pop');
}

// Ekranni ulashish
if (!navigator.mediaDevices?.getDisplayMedia) $('#btn-share').classList.add('hidden');
$('#btn-share').onclick = () => setShare(!myState().sharing);
$('#btn-stop-share').onclick = () => setShare(false);
async function setShare(on) {
  if (on && [...roster.entries()].some(([s, p]) => s !== me.identity && p.state?.sharing)) return toast('Boshqa qatnashchi ekranini ulashyapti');
  try { await room.localParticipant.setScreenShareEnabled(on, { audio: false }); } catch { /* bekor qilindi */ }
  refreshTile(me.identity); syncRoster(); renderAll();
}

// ================= QATNASHCHILAR PANELI =================
function openPane(name) {
  $('#side').classList.remove('hidden');
  $(`#pane-${name}`).classList.remove('hidden');
  if (name === 'chat') { unread = 0; updateBadge(); setTimeout(() => $('#chat-list').scrollTop = 1e9); }
  setTimeout(renderTiles, 50);
}
function togglePane(name) {
  const p = $(`#pane-${name}`);
  if (p.classList.contains('hidden')) openPane(name);
  else { p.classList.add('hidden'); if (!$$('.pane:not(.hidden)').length) $('#side').classList.add('hidden'); setTimeout(renderTiles, 50); }
}
function closePanes() { $$('.pane').forEach((p) => p.classList.add('hidden')); $('#side').classList.add('hidden'); }
$('#btn-people').onclick = () => togglePane('people');
$('#btn-chat').onclick = () => togglePane('chat');
$$('[data-close]').forEach((b) => b.onclick = () => togglePane(b.dataset.close));

function renderPeople() {
  const list = [...roster.entries()].sort(([a, pa], [b, pb]) =>
    (b === me.identity) - (a === me.identity) || pb.host - pa.host || (!!pb.state?.hand) - (!!pa.state?.hand));
  $('#people-title').textContent = `Qatnashchilar (${list.length})`;
  $('#people-list').innerHTML = list.map(([id, p]) => {
    const st = p.state || {}, host = me.isHost && id !== me.identity;
    return `<li data-sid="${id}">
      <span class="av" style="background:${colorOf(p.name)}">${esc(initials(p.name))}</span>
      <div class="who"><b>${esc(p.name)}</b><small>${[id === me.identity ? 'Siz' : '', p.host ? 'Host' : ''].filter(Boolean).join(', ')}</small></div>
      <span class="ics ${host ? 'hide-on-hover' : ''}">${st.hand ? '✋' : ''}${icon(st.mic ? 'i-mic' : 'i-mic-off', st.mic ? '' : 'off')}${icon(st.cam ? 'i-cam' : 'i-cam-off', st.cam ? '' : 'off')}</span>
      ${host ? `<span class="acts">
        ${st.mic ? `<button class="btn sm" data-a="mute">Ovozini o'chirish</button>` : `<button class="btn sm" data-a="ask">Ovozni so'rash</button>`}
        <button class="btn sm" data-a="more">${icon('i-more')}</button></span>` : ''}
    </li>`;
  }).join('');
  $$('#people-list button[data-a]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const id = b.closest('li').dataset.sid;
    if (b.dataset.a === 'mute') hostMute(id, LK.Track.Source.Microphone);
    else if (b.dataset.a === 'ask') send('cmd', { cmd: 'askUnmute' }, id);
    else tileMenu(id, b);
  });
}
$('#btn-mute-all').onclick = () => {
  for (const [id, p] of roster) if (id !== me.identity && p.state.mic) hostMute(id, LK.Track.Source.Microphone);
  toast("Hammaning ovozi o'chirildi");
};
$('#btn-lower-all').onclick = () => { for (const [id, p] of roster) if (id !== me.identity && p.state.hand) send('cmd', { cmd: 'lowerHand' }, id); };

// ================= CHAT =================
function renderChatTo() {
  const sel = $('#chat-to'), cur = sel.value;
  sel.innerHTML = '<option value="">Hammaga</option>' + [...roster.entries()].filter(([s]) => s !== me.identity)
    .map(([s, p]) => `<option value="${s}">${esc(p.name)}</option>`).join('');
  sel.value = roster.has(cur) ? cur : '';
}
function addChat(m) {
  const mine = m.from === me.identity;
  const time = new Date(m.ts || Date.now()).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
  const to = m.to ? `<span class="priv"> → ${mine ? esc(m.toName) : 'Sizga'} (shaxsiy)</span>` : ' → Hammaga';
  $('#chat-list').insertAdjacentHTML('beforeend',
    `<div class="msg"><div class="meta"><b>${mine ? 'Siz' : esc(m.name)}</b>${to} · ${time}</div><div class="txt">${esc(String(m.text || '').slice(0, 2000))}</div></div>`);
  $('#chat-list').scrollTop = 1e9;
  if (!mine && $('#pane-chat').classList.contains('hidden')) { unread++; updateBadge(); toast(`💬 ${m.name}: ${String(m.text).slice(0, 60)}`); }
}
function updateBadge() { $('#chat-badge').textContent = unread; $('#chat-badge').classList.toggle('hidden', !unread); }
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (!text) return;
  const to = $('#chat-to').value || null;
  const msg = { text, ts: Date.now(), to: !!to };
  send('chat', msg, to);
  addChat({ ...msg, from: me.identity, name: me.name, toName: to ? roster.get(to)?.name : '' });
  $('#chat-input').value = '';
};

// ================= MA'LUMOT / TAKLIF =================
$('#btn-invite').onclick = () => copy(linkOf(ctx.code), 'Taklif havolasi nusxalandi');
$('#btn-info').onclick = () => {
  const p = $('#info-pop');
  if (!p.classList.contains('hidden')) return p.classList.add('hidden');
  closePops();
  const host = [...roster.values()].find((x) => x.host);
  p.innerHTML = `<b>${esc(ctx.m.t)}</b>
    <div><span class="k">Vaqti</span>${fmtWhen(ctx.m.s)}</div>
    <div><span class="k">Tashkilotchi</span>${esc(host?.name || '—')}</div>
    <div><span class="k">Qatnashchilar</span>${roster.size}</div>
    <div><span class="k">Havola</span><a href="#" id="info-copy">Nusxa olish</a></div>
    <div style="color:#12b76a;margin-top:6px">🛡 Faqat havolaga ega bo'lganlar qo'shila oladi</div>`;
  $('#info-copy').onclick = (e) => { e.preventDefault(); copy(linkOf(ctx.code), 'Havoladan nusxa olindi'); };
  p.classList.remove('hidden');
};

// ================= YOZIB OLISH (host, kompyuterga) =================
let recorder = null, recChunks = [], recCanvasInt = null;
$('#btn-rec').onclick = () => (recorder ? stopRecording() : startRecording());
function allAudioTracks() {
  const out = [];
  const mine = room?.localParticipant.getTrackPublication(LK.Track.Source.Microphone)?.track?.mediaStreamTrack;
  if (mine) out.push(mine);
  for (const p of room?.remoteParticipants.values() || []) for (const pub of p.audioTrackPublications.values()) if (pub.track) out.push(pub.track.mediaStreamTrack);
  return out;
}
function startRecording() {
  if (!window.MediaRecorder) return toast("Brauzer yozib olishni qo'llab-quvvatlamaydi");
  unlockAudio();
  const W = 1280, H = 720;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d');
  recCanvasInt = setInterval(() => {
    g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, W, H);
    const tiles = $$('#grid .tile');
    const sharing = tiles.find((t) => t.classList.contains('sharing'));
    const list = sharing ? [sharing] : tiles;
    const n = list.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), tw = W / cols, th = H / rows;
    list.forEach((t, i) => {
      const x = (i % cols) * tw, y = Math.floor(i / cols) * th, v = $('video', t);
      g.fillStyle = '#242424'; g.fillRect(x + 2, y + 2, tw - 4, th - 4);
      if (!t.classList.contains('cam-off') && v.videoWidth) {
        const s = Math.min(tw / v.videoWidth, th / v.videoHeight), dw = v.videoWidth * s, dh = v.videoHeight * s;
        g.drawImage(v, x + (tw - dw) / 2, y + (th - dh) / 2, dw, dh);
      } else {
        g.fillStyle = '#fff'; g.font = `bold ${Math.floor(th / 6)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText($('.avatar span', t).textContent, x + tw / 2, y + th / 2);
      }
      g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.font = '16px sans-serif';
      const label = $('.name em', t).textContent;
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x + 8, y + th - 34, g.measureText(label).width + 16, 26);
      g.fillStyle = '#fff'; g.fillText(label, x + 16, y + th - 16);
    });
  }, 50);
  const dest = actx.createMediaStreamDestination();
  for (const t of allAudioTracks()) { try { actx.createMediaStreamSource(new MediaStream([t])).connect(dest); } catch {} }
  const out = new MediaStream([...c.captureStream(20).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(out, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder?.mimeType || 'video/webm' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `yigilish-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`,
    });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    recorder = null; updateControls();
  };
  recorder.start(1000);
  room.localParticipant.setAttributes({ rec: '1' }).catch(() => {});
  updateControls(); toast('Yozib olish boshlandi');
}
function stopRecording() {
  clearInterval(recCanvasInt);
  if (recorder?.state === 'recording') recorder.stop(); else recorder = null;
  room?.localParticipant.setAttributes({ rec: '' }).catch(() => {});
  updateControls(); toast('Yozuv kompyuteringizga saqlanmoqda');
}

// ================= KLAVIATURA =================
document.addEventListener('keydown', (e) => {
  if (!inMeeting || !e.altKey) return;
  const map = { a: () => setMic(!myState().mic), v: () => setCam(!myState().cam), h: () => togglePane('chat'), u: () => togglePane('people'),
    s: () => setShare(!myState().sharing), y: () => setHand(!myState().hand), f: () => $('#btn-full').click() };
  const f = map[e.key.toLowerCase()];
  if (f) { e.preventDefault(); f(); }
});

// ================= ISHGA TUSHIRISH =================
(() => {
  if (!LK) { document.body.innerHTML = '<p style="padding:24px">Video kutubxonasi yuklanmadi. Internetni tekshirib, sahifani yangilang.</p>'; return; }
  const q = new URLSearchParams(location.search);
  const code = q.get('m');
  if (code && q.get('h')) { const m = decodeCode(code); if (m) saveHostKey(m.r, q.get('h')); }
  if (q.has('app') || /MahallaApp/.test(navigator.userAgent)) $('#apps-card').classList.add('hidden');
  if (code && decodeCode(code)) openMeeting(code);
  else goHome();
})();
