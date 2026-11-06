// Brauzer ichidagi ko'p qatnashchili testlar. Ilova sahifasida ishga tushiriladi:
//   await import('/tests/e2e.js')  yoki  <script src="tests/e2e.js">  →  window.E2E.run()
// "Bot"lar — alohida LiveKit ulanishlari, sun'iy kamera (canvas) va mikrofon (oscillator) bilan.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = [];
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (!c) throw new Error(m || 'shart bajarilmadi'); };
  async function until(fn, ms = 8000, msg = 'kutish vaqti tugadi') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(150); }
    throw new Error(msg);
  }
  async function t(name, fn) {
    try { await fn(); pass++; R.push(`✓ ${name}`); }
    catch (e) { fail++; R.push(`✗ ${name} — ${e.message}`); }
  }
  const visible = () => [...document.querySelectorAll('.screen')].find((s) => !s.classList.contains('hidden'))?.id;

  function fakeTracks() {
    const c = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
    const g = c.getContext('2d'); let f = 0;
    const iv = setInterval(() => { g.fillStyle = `hsl(${f++ % 360},70%,50%)`; g.fillRect(0, 0, 320, 240); }, 100);
    const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination();
    o.connect(d); o.start();
    return { video: c.captureStream(10).getVideoTracks()[0], audio: d.stream.getAudioTracks()[0], stop: () => { clearInterval(iv); o.stop(); ac.close(); } };
  }
  async function bot(name, { cid, code = ctx.code, publish = true } = {}) {
    const j = await api('join', { code, name, cid: cid || `bot-${name}-${Math.random().toString(36).slice(2, 10)}` });
    if (!j.token) throw new Error('bot tokeni yo\'q: ' + JSON.stringify(j));
    const room = new LK.Room();
    const b = { name, room, identity: j.identity, data: [], reason: null };
    room.on(LK.RoomEvent.DataReceived, (p, who, k, topic) => b.data.push({ topic, d: JSON.parse(new TextDecoder().decode(p)), from: who?.identity }));
    room.on(LK.RoomEvent.Disconnected, (r) => { b.reason = r; });
    await room.connect(j.url, j.token);
    if (publish) {
      b.fake = fakeTracks();
      await room.localParticipant.publishTrack(b.fake.video, { source: LK.Track.Source.Camera });
      await room.localParticipant.publishTrack(b.fake.audio, { source: LK.Track.Source.Microphone });
    }
    b.send = (topic, d, to) => room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(d)), { reliable: true, topic, ...(to ? { destinationIdentities: [to] } : {}) });
    b.close = async () => { await room.disconnect().catch(() => {}); b.fake?.stop(); };
    return b;
  }
  const st = (id) => roster.get(id)?.state || {};

  async function run() {
    R.length = 0; pass = 0; fail = 0;
    localStorage.clear();
    const bots = [];

    await t('1. Yig\'ilish yaratish (UI): havola, host kaliti, "Mening yig\'ilishlarim"', async () => {
      goHome();
      $('#c-name').value = 'Test Host'; $('#c-title').value = 'E2E <b>test</b>';
      document.querySelector('input[name=when][value=now]').click();
      $('#form-create').requestSubmit();
      await until(() => visible() === 'screen-created');
      ok($('#cr-title').textContent === 'E2E <b>test</b>', 'nom HTML sifatida emas, matn bo\'lishi kerak');
      ok($('#cr-link').textContent.includes('?m='), 'havola');
      ok(ctx.host, 'host kaliti saqlanmadi');
      ok(myMeetings().length === 1, 'mening yig\'ilishlarim');
      ok($('#cr-tg').href.startsWith('https://t.me/share/url?url='), 'Telegram havolasi');
    });

    await t('2. Host yig\'ilishga kiradi (UI)', async () => {
      $('#cr-start').click();
      await until(() => inMeeting && room?.state === 'connected', 10000);
      ok(me.isHost, 'host emas'); ok($('#leave-label').textContent === 'Tugatish');
      ok(!$('#btn-rec').classList.contains('hidden'), 'yozib olish tugmasi hostda bo\'lishi kerak');
    });

    let B1, B2;
    await t('3. Ikki bot kamera+mikrofon bilan qo\'shiladi; host 3 plitka va videoni ko\'radi', async () => {
      B1 = await bot('Bot Bir'); B2 = await bot('Bot Ikki'); bots.push(B1, B2);
      await until(() => roster.size === 3 && st(B1.identity).cam && st(B1.identity).mic, 10000, `roster=${roster.size}`);
      ok($$('#grid .tile').length === 3, 'plitkalar soni');
      await until(() => $(`#tile-${B1.identity} video`)?._lkTrack, 6000, 'B1 videosi ulanmadi');
      await until(() => $$('#lk-audio audio').length >= 2, 6000, 'audio elementlar');
      ok(+$('#people-count').textContent === 3, 'qatnashchilar soni');
    });

    await t('4. Host B1 ovozini o\'chiradi (server tomonidan)', async () => {
      hostMute(B1.identity, LK.Track.Source.Microphone);
      await until(() => B1.room.localParticipant.getTrackPublication(LK.Track.Source.Microphone)?.isMuted, 8000, 'B1 mikrofoni o\'chmadi');
      await until(() => !st(B1.identity).mic, 5000, 'hostda holat yangilanmadi');
    });

    await t('5. Host B1 videosini to\'xtatadi', async () => {
      hostMute(B1.identity, LK.Track.Source.Camera);
      await until(() => B1.room.localParticipant.getTrackPublication(LK.Track.Source.Camera)?.isMuted, 8000);
      await until(() => $(`#tile-${B1.identity}`).classList.contains('cam-off'), 5000, 'plitka cam-off bo\'lmadi');
    });

    await t('6. Host B1 dan ovozni yoqishni so\'raydi (faqat B1 ga boradi)', async () => {
      send('cmd', { cmd: 'askUnmute' }, B1.identity);
      await until(() => B1.data.some((x) => x.topic === 'cmd' && x.d.cmd === 'askUnmute'), 5000);
      await sleep(500); ok(!B2.data.some((x) => x.topic === 'cmd'), 'B2 ga ham borib qoldi');
    });

    await t('7. B1 qo\'l ko\'taradi → host ko\'radi; host tushiradi', async () => {
      await B1.room.localParticipant.setAttributes({ hand: '1' });
      await until(() => st(B1.identity).hand, 5000, 'qo\'l ko\'rinmadi');
      ok($(`#tile-${B1.identity}`).classList.contains('hand-up'));
      send('cmd', { cmd: 'lowerHand' }, B1.identity);
      await until(() => B1.data.some((x) => x.d.cmd === 'lowerHand'), 5000);
      await B1.room.localParticipant.setAttributes({ hand: '' });
      await until(() => !st(B1.identity).hand, 5000);
    });

    await t('8. Shaxsiy chat: host → B2 (B1 olmaydi)', async () => {
      openPane('chat');
      $('#chat-to').value = B2.identity; $('#chat-input').value = 'Faqat senga';
      $('#chat-form').requestSubmit();
      await until(() => B2.data.some((x) => x.topic === 'chat' && x.d.text === 'Faqat senga'), 5000);
      await sleep(600); ok(!B1.data.some((x) => x.topic === 'chat' && x.d.text === 'Faqat senga'), 'B1 ham oldi!');
      ok($('#chat-list').textContent.includes('(shaxsiy)'));
    });

    await t('9. Ommaviy chat B1 → host; HTML/XSS ekranlanadi', async () => {
      const n = $$('#chat-list .msg').length;
      await B1.send('chat', { text: '<img src=x onerror="window.__xss=1">salom', ts: Date.now() });
      await until(() => $$('#chat-list .msg').length === n + 1, 5000);
      ok(!$('#chat-list img'), 'HTML element paydo bo\'ldi (XSS)'); ok(!window.__xss, 'XSS ishladi');
    });

    await t('10. Chat oynasi yopiq bo\'lsa — o\'qilmagan nishon', async () => {
      togglePane('chat'); ok($('#pane-chat').classList.contains('hidden'));
      await B2.send('chat', { text: 'yangi xabar', ts: Date.now() });
      await until(() => !$('#chat-badge').classList.contains('hidden') && +$('#chat-badge').textContent >= 1, 5000);
      openPane('chat'); ok($('#chat-badge').classList.contains('hidden'), 'ochilganda nishon yo\'qolmadi');
    });

    await t('11. Reaksiya: B2 → host plitkasida; ruxsatsiz belgi rad etiladi', async () => {
      await B2.send('react', { emoji: '🎉' });
      await until(() => $(`#tile-${B2.identity} .react`).textContent === '🎉', 5000);
      await B2.send('react', { emoji: '<script>' });
      await sleep(700); ok($(`#tile-${B2.identity} .react`).textContent === '🎉', 'ruxsatsiz belgi ko\'rsatildi');
    });

    await t('12. Host bo\'lmagan qatnashchi host buyrug\'ini yubora olmaydi', async () => {
      await setHand(true);
      await B1.send('cmd', { cmd: 'lowerHand' }, me.identity);
      await sleep(1200);
      ok(st(me.identity).hand, 'host buyrug\'i mehmondan bajarildi!');
      await setHand(false);
    });

    await t('13. Hammaning ovozini o\'chirish', async () => {
      await B1.room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
      const pub = B1.room.localParticipant.getTrackPublication(LK.Track.Source.Microphone); await pub?.unmute?.();
      await until(() => st(B1.identity).mic && st(B2.identity).mic, 6000, 'mikrofonlar yoqilmadi');
      $('#btn-mute-all').click();
      await until(() => !st(B1.identity).mic && !st(B2.identity).mic, 8000, 'hammasi o\'chmadi');
    });

    await t('14. Ko\'rinish: galereya / spiker / mahkamlash', async () => {
      $('#btn-view').click(); ok($('#grid').classList.contains('gallery'));
      $('#btn-view').click(); ok($('#grid').classList.contains('speaker'));
      pinned = B2.identity; renderAll(); ok($(`#tile-${B2.identity}`).classList.contains('main'));
      pinned = null; renderAll();
    });

    await t('15. Sahifa yangilanganda "arvoh" qolmaydi (bir xil qurilma = bir identity)', async () => {
      const cid = 'qurilma-takror-1234';
      const a = await bot('Takror', { cid }); bots.push(a);
      await until(() => roster.size === 4, 8000);
      const b = await bot('Takror', { cid }); bots.push(b);
      await until(() => a.reason === LK.DisconnectReason.DUPLICATE_IDENTITY, 8000, 'eski ulanish uzilmadi');
      await sleep(1500); ok(roster.size === 4, `roster=${roster.size} (arvoh bor)`);
      await b.close();
      await until(() => roster.size === 3, 8000);
    });

    await t('16. Host B2 ni chiqaradi', async () => {
      const r = await api('host', { code: ctx.code, host: ctx.host, action: 'kick', identity: B2.identity });
      ok(r.ok, JSON.stringify(r));
      await until(() => B2.reason === LK.DisconnectReason.PARTICIPANT_REMOVED, 8000);
      await until(() => roster.size === 2 && !$(`#tile-${B2.identity}`), 6000, 'plitka qoldi');
    });

    await t('17. Yozib olish (host): boshlash/to\'xtatish, REC belgisi botga ko\'rinadi', async () => {
      unlockAudio(); startRecording();
      ok(recorder?.state === 'recording', 'recorder ishlamadi');
      await until(() => [...B1.room.remoteParticipants.values()].some((p) => p.attributes?.rec === '1'), 5000, 'bot REC ni ko\'rmadi');
      ok(!$('#rec-ind').classList.contains('hidden'), 'REC belgisi');
      const origClick = HTMLAnchorElement.prototype.click; let downloaded = null;
      HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
      await sleep(1500); stopRecording();
      await until(() => downloaded, 5000, 'fayl yuklanmadi');
      HTMLAnchorElement.prototype.click = origClick;
      ok(/^yigilish-.*\.(webm|mp4)$/.test(downloaded), downloaded);
    });

    await t('18. Host chiqib ketadi (tugatmasdan) → mehmon qoladi; host qaytadi va yana host', async () => {
      await leave(false);
      ok(visible() === 'screen-left');
      await sleep(1500); ok(B1.room.state === 'connected', 'mehmon uzilib qoldi');
      $('#btn-rejoin').click();
      await until(() => inMeeting && room?.state === 'connected' && roster.size === 2, 12000);
      ok(me.isHost, 'qaytganda host emas');
    });

    await t('19. Hamma uchun tugatish → bot ROOM_DELETED', async () => {
      await leave(true);
      await until(() => B1.reason === LK.DisconnectReason.ROOM_DELETED, 8000);
      ok($('#left-text').textContent.includes('yakunlandi'));
    });

    await t('20. Kutish: 5 daqiqa+6 soniyadan keyin boshlanadigan yig\'ilishga mehmon avtomatik qo\'shiladi', async () => {
      const c = await api('create', { title: 'Kutish testi', startAt: Date.now() + 5 * 60e3 + 6000 });
      localStorage.removeItem('hosts'); localStorage.setItem('name', JSON.stringify('Kutuvchi'));
      openMeeting(c.code);
      await until(() => !$('#j-wait').classList.contains('hidden') && $('#j-wait').textContent.includes('avtomatik'), 6000, 'kutish ekrani yo\'q');
      ok(/\d\d:\d\d/.test($('.countdown').textContent), 'teskari sanoq');
      await until(() => inMeeting && room?.state === 'connected', 20000, 'avtomatik qo\'shilmadi');
      ok(!me.isHost, 'mehmon host bo\'lib qoldi');
      await leave(false);
    });

    await t('21. Kutish: host ertaroq kirsa mehmon ham kiradi', async () => {
      const c = await api('create', { title: 'Erta', startAt: Date.now() + 3600e3 });
      openMeeting(c.code);
      await until(() => !$('#j-wait').classList.contains('hidden'), 6000);
      const h = await api('join', { code: c.code, name: 'Erta host', host: c.host, cid: 'erta-host-1234' });
      const hr = new LK.Room(); await hr.connect(h.url, h.token);
      await tryJoin();
      await until(() => inMeeting && roster.size === 2, 10000, 'host borligida kira olmadi');
      await leave(false); await hr.disconnect();
    });

    const goodCode = ctx.code;
    await t('22. Buzilgan havola: xato xabari; noto\'g\'ri havola: bosh sahifa', async () => {
      const code = ctx.code.slice(0, -3) + 'zzz';
      openMeeting(code); await until(() => $('#j-error').textContent.includes("noto'g'ri"), 6000, $('#j-error').textContent);
      openMeeting('bu-havola-emas'); ok(visible() === 'screen-home');
    });

    await t('23. "Havola orqali qo\'shilish" formasi: to\'liq URL va noto\'g\'ri matn', async () => {
      goHome(); $('#o-link').value = 'salom dunyo'; $('#form-open').requestSubmit();
      ok(visible() === 'screen-home', 'noto\'g\'ri matn qabul qilindi');
      $('#o-link').value = linkOf(goodCode); localStorage.removeItem('name'); $('#form-open').requestSubmit();
      ok(visible() === 'screen-join', 'to\'liq URL ochilmadi');
    });

    await t('24. Ism kiritilmasa kirib bo\'lmaydi', async () => {
      $('#j-name').value = ''; ok(!$('#form-join').checkValidity(), 'bo\'sh ism qabul qilindi');
    });

    await t('25. "Mening yig\'ilishlarim" ro\'yxati va nusxa olish', async () => {
      goHome(); ok($$('#my-list li').length >= 1, 'ro\'yxat bo\'sh');
      ok(!$('#my-list').innerHTML.includes('<b>E2E <b>'), 'nom ekranlanmagan');
    });

    // ---- Mustahkamlik testlari ----
    const origFetch = window.fetch;
    let calls = 0;
    const countFetch = () => { calls = 0; window.fetch = (...a) => { if (String(a[0]).includes('/api/join')) calls++; return origFetch(...a); }; };

    await t('26. Soat farqi (telefon soati 1 soat oldinda): serverga to\'xtovsiz so\'rov yuborilmaydi', async () => {
      const c = await api('create', { title: 'Soat', startAt: Date.now() + 3600e3 });
      localStorage.setItem('name', JSON.stringify('Soat testi'));
      openMeeting(c.code);
      await until(() => waiting, 6000);
      clockSkew = 3600e3; // mijoz vaqt keldi deb o'ylaydi, server esa "kut" deydi
      countFetch(); await sleep(6000); window.fetch = origFetch;
      ok(calls <= 1, `${calls} ta so'rov 6 soniyada`);
      clockSkew = 0; goHome();
    });

    await t('27. Kutish paytida internet uzilsa — qayta urinadi va qo\'shiladi', async () => {
      const c = await api('create', { title: 'Uzilish', startAt: Date.now() });
      let failOnce = true;
      window.fetch = (...a) => { if (failOnce && String(a[0]).includes('/api/join')) { failOnce = false; return Promise.reject(new TypeError('offline')); } return origFetch(...a); };
      waiting = true; ctx = null;
      openMeeting(c.code); waiting = true;
      await until(() => $('#j-error').textContent.includes('Internet'), 5000, 'xato ko\'rsatilmadi');
      await until(() => inMeeting && room?.state === 'connected', 16000, 'qayta urinmadi');
      window.fetch = origFetch; await leave(false);
    });

    await t('28. Video serverga ulanib bo\'lmasa — xabar, cheksiz takrorlanmaydi', async () => {
      const c = await api('create', { title: 'Ulanmaydi', startAt: Date.now() });
      const Orig = LK.Room; // connect har bir obyektda aniqlangan — sinf orqali almashtiramiz
      LK.Room = class extends Orig { constructor(o) { super(o); this.connect = () => Promise.reject(new Error('sinov')); } };
      try {
        openMeeting(c.code);
        await until(() => $('#j-error').textContent.includes('ulanib bo'), 8000, $('#j-error').textContent);
        countFetch(); await sleep(4000); window.fetch = origFetch;
      } finally { LK.Room = Orig; }
      ok(calls === 0, `${calls} marta qayta urindi`); ok(!inMeeting);
    });

    await t('29. Kutilmagan uzilish — avtomatik qayta ulanadi', async () => {
      const c = await api('create', { title: 'Qayta ulanish', startAt: Date.now() });
      openMeeting(c.code);
      await until(() => inMeeting && room?.state === 'connected', 10000);
      const old = room;
      old.emit(LK.RoomEvent.Disconnected, LK.DisconnectReason.UNKNOWN_REASON);
      await until(() => $('#left-text').textContent.includes('qayta ulanmoqda'), 3000);
      await until(() => inMeeting && room && room !== old && room.state === 'connected', 12000, 'qayta ulanmadi');
      old.disconnect().catch(() => {});
      await leave(false);
    });

    await t('30. Kutish paytida bosh sahifaga o\'tilsa — kechikkan javob xatoga olib kelmaydi', async () => {
      const c = await api('create', { title: 'Kech javob', startAt: Date.now() });
      window.fetch = (...a) => String(a[0]).includes('/api/join') ? sleep(1500).then(() => origFetch(...a)) : origFetch(...a);
      openMeeting(c.code); await sleep(200); goHome();
      await sleep(2500); window.fetch = origFetch;
      ok(visible() === 'screen-home' && !inMeeting, `ekran=${visible()} inMeeting=${inMeeting}`);
    });

    for (const b of bots) await b.close();
    goHome();
    const out = `${pass} o'tdi, ${fail} xato\n` + R.join('\n');
    console.log(out);
    return out;
  }
  window.E2E = { run, bot };
})();
