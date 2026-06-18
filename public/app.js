const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const keys = {};
const particles = [];
const peerConnections = new Map();
const remoteAudio = new Map();
const playerMotion = new Map();

let socket = null;
let myId = null;
let snapshot = null;
let token = localStorage.getItem('bd_token');
let catalog = { jobs: [], vehicles: [] };
let reconnectAttempt = 0;
let camera = { x: 0, y: 0 };
let previousWallet = { cash: 0, bettabukz: 0 };
let editorMode = false;
let localVoiceStream = null;
let audioContext = null;
let lastLeaderboardAt = 0;

function resize() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}
addEventListener('resize', resize);
resize();

function ensureAudio() {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function playTone(kind = 'click') {
  try {
    const ac = ensureAudio();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const now = ac.currentTime;
    osc.type = kind === 'coin' ? 'triangle' : 'square';
    osc.frequency.setValueAtTime(kind === 'coin' ? 880 : 320, now);
    osc.frequency.exponentialRampToValueAtTime(kind === 'coin' ? 1320 : 220, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === 'coin' ? 0.12 : 0.05, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  } catch {
    /* WebAudio may be unavailable in older embedded browsers. */
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('button,a')) playTone('click');
});

async function loadContent() {
  try {
    const res = await fetch('/api/content');
    const data = await res.json();
    catalog = data.catalog || catalog;
    renderStaticPanels();
  } catch {
    renderStaticPanels();
  }
}
loadContent();

async function authCall(path) {
  const body = { username: username.value, password: password.value, name: charname.value, gender: gender.value };
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw Error(data.error);
  localStorage.setItem('bd_token', data.token);
  token = data.token;
  connect();
}

login.onclick = () => authCall('/api/login').catch((error) => (authMsg.textContent = error.message));
register.onclick = () => authCall('/api/register').catch((error) => (authMsg.textContent = error.message));

function connect(attempt = 0) {
  auth.style.display = 'none';
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}?token=${token}`);
  socket.onopen = () => {
    reconnectAttempt = 0;
    connectionStatus.textContent = 'Connection: online';
    toast('Connected to server.');
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') {
      snapshot = message.payload;
      myId = snapshot.selfId;
      hudRender();
      maybeRefreshLeaderboard();
      syncVoicePeers();
    }
    if (message.type === 'system') toast(message.payload);
    if (message.type === 'chat') log(message.payload);
    if (message.type === 'reward') handleReward(message.payload);
    if (message.type === 'voice:signal') handleVoiceSignal(message.payload);
  };
  socket.onclose = () => {
    connectionStatus.textContent = 'Connection: disconnected';
    toast('Connection lost. Reconnecting...');
    setTimeout(() => connect(Math.min(attempt + 1, 6)), Math.min(5000, 1000 + attempt * 1000));
  };
  socket.onerror = () => {
    connectionStatus.textContent = 'Connection: error';
  };
}

function send(message) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(message));
  else toast('Waiting for connection...');
}
window.send = send;
if (token) connect();

function toast(text) {
  toastEl().textContent = text;
  log(`SYSTEM: ${text}`);
  setTimeout(() => {
    if (toastEl().textContent === text) toastEl().textContent = '';
  }, 5000);
}

function toastEl() {
  return document.getElementById('toast');
}

function log(text) {
  chatLog.innerHTML += `<div>${String(text).replace(/[<>]/g, '')}</div>`;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderStaticPanels() {
  const left = document.querySelector('aside.panel');
  const right = document.querySelectorAll('aside.panel')[1];
  if (left && !document.getElementById('rpControls')) {
    left.insertAdjacentHTML('beforeend', `
      <div id="rpControls" class="rp-section">
        <h3>Jobs</h3>
        <div id="jobButtons" class="stack"></div>
        <button class="btn action" id="completeJobBtn">Complete Job</button>
      </div>
      <div class="rp-section">
        <h3>Dealership</h3>
        <select id="vehicleSelect" class="input"></select>
        <button class="btn action" id="buyVehicleBtn">Buy Vehicle</button>
      </div>
      <div id="adminPanel" class="rp-section hidden">
        <h3>Admin</h3>
        <input id="adminAmount" class="input" type="number" value="1000">
        <button class="btn warn" id="adminGiveCash">Give Self Cash</button>
        <button class="btn warn" id="adminSpawnVehicle">Spawn Vehicle</button>
      </div>
    `);
    completeJobBtn.onclick = () => send({ type: 'job:complete' });
    buyVehicleBtn.onclick = () => send({ type: 'dealership:buy', itemId: vehicleSelect.value });
    adminGiveCash.onclick = () => send({ type: 'admin:giveCash', targetId: myId, amount: adminAmount.value });
    adminSpawnVehicle.onclick = () => send({ type: 'admin:spawnVehicle', vehicleType: 'admin_cruiser' });
  }
  if (right && !document.getElementById('leaderboard')) {
    right.insertAdjacentHTML('afterbegin', `
      <div class="rp-section">
        <h3>Leaderboard</h3>
        <ol id="leaderboard" class="leaderboard"></ol>
      </div>
    `);
  }
  renderJobButtons();
  renderVehicleOptions();
}

function renderJobButtons() {
  const box = document.getElementById('jobButtons');
  if (!box) return;
  const jobs = catalog.jobs?.length ? catalog.jobs : [
    { id: 'taxi', name: 'Taxi' },
    { id: 'police', name: 'Police' },
    { id: 'delivery', name: 'Delivery' }
  ];
  box.innerHTML = jobs.map((job) => `<button class="btn subtle" data-job="${job.id}">${job.name}</button>`).join('');
  box.querySelectorAll('button').forEach((button) => {
    button.onclick = () => send({ type: 'job:start', jobId: button.dataset.job });
  });
}

function renderVehicleOptions() {
  const select = document.getElementById('vehicleSelect');
  if (!select) return;
  const vehicles = (catalog.vehicles || []).slice(0, 18);
  select.innerHTML = vehicles.map((vehicle) => {
    const price = vehicle.bettabukzPrice > 0 ? `${vehicle.bettabukzPrice} BBZ` : `$${Number(vehicle.price || 0).toLocaleString()}`;
    return `<option value="${vehicle.id}">${vehicle.name} - ${price}</option>`;
  }).join('');
}

async function maybeRefreshLeaderboard(force = false) {
  if (!force && Date.now() - lastLeaderboardAt < 10000) return;
  lastLeaderboardAt = Date.now();
  try {
    const res = await fetch('/api/leaderboard');
    const rows = await res.json();
    const box = document.getElementById('leaderboard');
    if (!box) return;
    box.innerHTML = rows.map((row) => `<li><span>${row.name}</span><b>Lv ${row.level}</b><em>$${Number(row.cash).toLocaleString()}</em></li>`).join('');
  } catch {
    /* The multiplayer canvas still runs if the API is restarting. */
  }
}

function nearestZone(p) {
  return snapshot?.world?.zones?.reduce((best, zone) => {
    const d = Math.hypot(p.x - zone.x, p.y - zone.y);
    return !best || d < best.d ? { zone, d } : best;
  }, null);
}

function hudRender() {
  const p = snapshot?.players?.[myId];
  if (!p) return;
  const xpBase = (p.level - 1) * 500;
  const xpNext = p.level * 500;
  const xpProgress = Math.max(0, Math.min(1, (p.xp - xpBase) / (xpNext - xpBase)));
  const nearest = nearestZone(p);
  const nearbyPlayers = Object.values(snapshot.players).filter((other) => other.id !== myId && Math.hypot(other.x - p.x, other.y - p.y) < 320).length;
  const mission = p.missions || { progress: 0, target: 3 };

  if (p.bettabukz > previousWallet.bettabukz && previousWallet.bettabukz !== 0) spawnBbzParticles(canvas.width / 2, canvas.height / 2, p.bettabukz - previousWallet.bettabukz);
  const walletChanged = p.cash !== previousWallet.cash || p.bettabukz !== previousWallet.bettabukz;
  previousWallet = { cash: p.cash, bettabukz: p.bettabukz };

  hud.classList.toggle('wallet-pop', walletChanged);
  setTimeout(() => hud.classList.remove('wallet-pop'), 260);
  hud.innerHTML = `
    <b>${p.name}</b><br>
    Cash: $${Math.floor(p.cash).toLocaleString()}<br>
    <span class="bbz">BettaBukz: ${p.bettabukz || 0} BBZ</span><br>
    Member: ${p.member_tier}<br>
    Role: ${p.permission || 'player'}<br>
    Level: ${p.level} XP: ${p.xp}/${xpNext}<br>
    <progress value="${xpProgress}" max="1" class="w-full"></progress><br>
    Mission: ${mission.progress || 0}/${mission.target || 3} activities<br>
    Job: ${p.job?.active ? p.job.jobName : 'Available'}<br>
    Daily Streak: ${p.daily_streak || 0}<br>
    BBZ Today: ${p.bbzEarnedToday || 0}<br>
    Nearest: ${nearest?.zone.name || 'Unknown'} (${Math.round(nearest?.d || 0)}m)<br>
    Nearby Players: ${nearbyPlayers}<br>
    Garage: ${(p.garage || []).length}<br>
    Editor: ${editorMode ? 'ON' : 'OFF'}<br>
    <span class="badge">${p.appearance?.hairstyle || 'streetwear'}</span>`;

  document.getElementById('adminPanel')?.classList.toggle('hidden', !['admin', 'moderator'].includes(p.permission));
}

function handleReward(reward) {
  if (reward.bbz > 0) {
    playTone('coin');
    spawnBbzParticles(canvas.width / 2, canvas.height * 0.35, reward.bbz);
  }
}

function spawnBbzParticles(x, y, amount = 10) {
  const count = Math.min(32, 10 + Math.floor(amount / 3));
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 4;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1,
      life: 1,
      size: 3 + Math.random() * 4
    });
  }
}

addEventListener('keydown', (event) => {
  if (document.activeElement === chat) return;
  const key = event.key.toLowerCase();
  if (key === 'w' || event.key === 'ArrowUp') keys.up = true;
  if (key === 's' || event.key === 'ArrowDown') keys.down = true;
  if (key === 'a' || event.key === 'ArrowLeft') keys.left = true;
  if (key === 'd' || event.key === 'ArrowRight') keys.right = true;
  if (key === 'e') send({ type: 'interact' });
  if (key === 'f') send({ type: 'vehicle' });
  if (key === 'r') send({ type: 'race:start' });
  if (key === 'm') toggleEditor();
  if (key === 'v') toggleVoice();
  if (key === 't') {
    event.preventDefault();
    chat.focus();
  }
});

addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'w' || event.key === 'ArrowUp') keys.up = false;
  if (key === 's' || event.key === 'ArrowDown') keys.down = false;
  if (key === 'a' || event.key === 'ArrowLeft') keys.left = false;
  if (key === 'd' || event.key === 'ArrowRight') keys.right = false;
});

chat.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && chat.value.trim()) {
    send({ type: 'chat', text: chat.value });
    chat.value = '';
    chat.blur();
  }
});

canvas.addEventListener('click', (event) => {
  if (!editorMode || !snapshot?.players?.[myId]) return;
  const rect = canvas.getBoundingClientRect();
  const me = snapshot.players[myId];
  const worldX = camera.x + event.clientX - rect.left;
  const worldY = camera.y + event.clientY - rect.top;
  send({ type: 'map:zone:add', x: worldX, y: worldY, name: 'Player Zone', zoneType: 'custom', radius: 95 });
  spawnBbzParticles(event.clientX - rect.left, event.clientY - rect.top, 3);
});

function toggleEditor() {
  editorMode = !editorMode;
  canvas.classList.toggle('editing', editorMode);
  toast(`Map editor ${editorMode ? 'enabled' : 'disabled'}.`);
}

setInterval(() => send({ type: 'input', ...keys, ...(window.__bdGamepadInput || {}), ...(window.__bdTouchInput || {}) }), 50);

function screen(x, y) {
  return { x: x - camera.x, y: y - camera.y };
}

function drawPlayer(p, me) {
  const s = screen(p.x, p.y);
  const last = playerMotion.get(p.id) || { x: p.x, y: p.y };
  const moving = p.vehicleId || Math.hypot(p.x - last.x, p.y - last.y) > 0.8;
  playerMotion.set(p.id, { x: p.x, y: p.y });
  const frame = moving ? Math.floor(performance.now() / 160) % 2 : 0;
  const sprite = moving ? 'player_walk' : 'player_idle';
  if (!BettaDayzSprites.draw(ctx, sprite, s.x, s.y)) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = p.id === myId ? '#38bdf8' : '#c084fc';
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = frame ? '#facc15' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-7, 11);
    ctx.lineTo(frame ? -11 : -5, 19);
    ctx.moveTo(7, 11);
    ctx.lineTo(frame ? 5 : 11, 19);
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = 'white';
  ctx.fillText(p.name, s.x, s.y - 18);
}

function drawMinimap(me) {
  const mm = document.getElementById('minimap');
  const m = mm.getContext('2d');
  m.clearRect(0, 0, mm.width, mm.height);
  m.fillStyle = 'rgba(2,6,23,.9)';
  m.fillRect(0, 0, mm.width, mm.height);
  const sx = (x) => (x / 2200) * mm.width;
  const sy = (y) => (y / 1500) * mm.height;
  for (const zone of snapshot.world.zones) {
    m.fillStyle = zone.type === 'dealership' ? '#facc15' : zone.type === 'race' ? '#d946ef' : '#22c55e';
    m.fillRect(sx(zone.x) - 2, sy(zone.y) - 2, 4, 4);
  }
  for (const p of Object.values(snapshot.players)) {
    m.fillStyle = p.id === myId ? '#84cc16' : '#38bdf8';
    m.beginPath();
    m.arc(sx(p.x), sy(p.y), p.id === myId ? 4 : 2.5, 0, Math.PI * 2);
    m.fill();
  }
}

function drawParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.05;
    p.life *= 0.95;
    ctx.globalAlpha = p.life;
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    if (p.life < 0.05) particles.splice(i, 1);
  }
  ctx.globalAlpha = 1;
}

function draw() {
  requestAnimationFrame(draw);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!snapshot) return;
  const me = snapshot.players[myId];
  if (!me) return;

  camera.x += (me.x - canvas.width / 2 - camera.x) * 0.12;
  camera.y += (me.y - canvas.height / 2 - camera.y) * 0.12;
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const gridSize = 80;
  ctx.strokeStyle = 'rgba(34,211,238,.08)';
  ctx.lineWidth = 1;
  for (let x = -camera.x % gridSize; x < canvas.width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = -camera.y % gridSize; y < canvas.height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  drawMinimap(me);
  for (const zone of snapshot.world.zones) {
    const s = screen(zone.x, zone.y);
    ctx.strokeStyle = zone.type === 'race' ? '#d946ef' : zone.type === 'luxury' || zone.type === 'dealership' ? '#facc15' : '#3b82f6';
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(s.x, s.y, zone.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(zone.name, s.x, s.y);
  }
  for (const v of snapshot.world.vehicles) {
    const s = screen(v.x, v.y);
    if (!BettaDayzSprites.draw(ctx, v.type === 'lowrider' ? 'vehicle_lowrider' : 'vehicle_exotic', s.x, s.y)) {
      ctx.fillStyle = v.color;
      ctx.fillRect(s.x - 12, s.y - 7, 24, 14);
    }
  }
  for (const npc of snapshot.world.npcs) {
    const s = screen(npc.x, npc.y);
    BettaDayzSprites.draw(ctx, npc.role === 'rival' ? 'npc_rival' : 'npc_civilian', s.x, s.y) || ctx.fillRect(s.x - 5, s.y - 5, 10, 10);
  }
  for (const p of Object.values(snapshot.players)) drawPlayer(p, me);
  if (editorMode) {
    ctx.fillStyle = 'rgba(250,204,21,.9)';
    ctx.fillText('EDITOR MODE: click map to place a zone', canvas.width / 2, 28);
  }
  drawParticles();
}
draw();

async function toggleVoice() {
  if (localVoiceStream) {
    localVoiceStream.getTracks().forEach((track) => track.stop());
    localVoiceStream = null;
    for (const pc of peerConnections.values()) pc.close();
    peerConnections.clear();
    toast('Voice chat disabled.');
    return;
  }
  try {
    localVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    toast('Voice chat enabled. Nearby players can connect.');
    syncVoicePeers(true);
  } catch {
    toast('Microphone permission was not granted.');
  }
}

function nearbyVoiceIds() {
  const me = snapshot?.players?.[myId];
  if (!me) return [];
  return Object.values(snapshot.players)
    .filter((p) => p.id !== myId && Math.hypot(p.x - me.x, p.y - me.y) < 300)
    .map((p) => p.id);
}

async function syncVoicePeers(forceOffer = false) {
  if (!localVoiceStream || !snapshot) return;
  const nearby = new Set(nearbyVoiceIds());
  for (const id of nearby) if (forceOffer || !peerConnections.has(id)) createVoicePeer(id, true);
  for (const [id, pc] of peerConnections) {
    if (!nearby.has(id)) {
      pc.close();
      peerConnections.delete(id);
    }
  }
}

async function createVoicePeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peerConnections.set(id, pc);
  localVoiceStream.getTracks().forEach((track) => pc.addTrack(track, localVoiceStream));
  pc.onicecandidate = (event) => {
    if (event.candidate) send({ type: 'voice:signal', to: id, signal: { candidate: event.candidate } });
  };
  pc.ontrack = (event) => {
    let audio = remoteAudio.get(id);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      remoteAudio.set(id, audio);
    }
    audio.srcObject = event.streams[0];
  };
  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'voice:signal', to: id, signal: { description: pc.localDescription } });
  }
  return pc;
}

async function handleVoiceSignal({ from, signal }) {
  if (!localVoiceStream) return;
  if (!nearbyVoiceIds().includes(from)) return;
  const pc = peerConnections.get(from) || await createVoicePeer(from, false);
  if (signal.description) {
    await pc.setRemoteDescription(signal.description);
    if (signal.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'voice:signal', to: from, signal: { description: pc.localDescription } });
    }
  }
  if (signal.candidate) await pc.addIceCandidate(signal.candidate).catch(() => {});
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
