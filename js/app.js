/* Snake Pad — a friendly snake game for 3–6 year olds.
 *
 * Design notes for anyone changing this:
 *  - The game logic runs on a fixed grid tick (`step`), but rendering
 *    interpolates between ticks so the snake glides instead of teleporting.
 *  - Nothing here may punish a small child for exploring. Any control they
 *    press must do what it says, and the easier age level cannot be lost.
 */

/* ---------------------------------------------------------------- config */

const MODES = {
  little: { label: '3–4', board: 8, tick: 800, selfCollide: false },
  big: { label: '5–6', board: 12, tick: 450, selfCollide: true }
};
const MODE_ORDER = ['little', 'big'];
const MODE_KEY = 'snakePadMode';

const DIR = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const COLORS = {
  board: '#16213e',
  grid: '#1e2c4d',
  head: '#5ddc6b',
  bodyNear: [76, 175, 80],
  bodyFar: [42, 110, 58],
  food: '#ffd23f',
  foodRim: '#fff6cc',
  spark: ['#ffd23f', '#fff6cc', '#ffb703']
};

const MAX_QUEUED_TURNS = 2;   // so a quick double-tap is never swallowed
const MAX_STEPS_PER_FRAME = 4;
const MAX_FRAME_MS = 250;
const BLINK_EVERY_MS = 3800;
const BLINK_MS = 130;
const TONGUE_MS = 320;
const EAT_POP_MS = 260;
const SCORE_ICON_LIMIT = 5;

/* ----------------------------------------------------------------- state */

let canvas, ctx, boardWrap, scoreEl, overlay, overlayEmoji, overlayText, playBtn, modeBtn;
let modeName, mode, boardSize;
let snake, prevSnake, food, dir, turnQueue, score;
let started, dead, paused, outcome;
let cellPx = 0, boardPx = 0;
let acc = 0, lastFrame = 0;
let sparks = [], eatPopAt = -1e9, tongueAt = -1e9, nextBlinkAt = 0, blinkUntil = 0;
let dieTimer;
let reduceMotion = false;

/* ----------------------------------------------------------------- audio */

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}

function tone(f1, f2, dur, vol, type = 'triangle', delay = 0) {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(f1, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(f2, 1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  } catch (_) {}
}

// Each apple is a step up a pentatonic scale, so a good run sounds like a
// tune going somewhere rather than the same blip over and over.
const PENTATONIC = [0, 2, 4, 7, 9];
function sfxEat(n) {
  const semis = PENTATONIC[(n - 1) % PENTATONIC.length] + 12 * Math.floor((n - 1) / PENTATONIC.length);
  const f = 523.25 * Math.pow(2, Math.min(semis, 24) / 12);
  tone(f, f * 1.5, 0.13, 0.22, 'triangle');
}
// Deliberately soft and non-punishing: two gentle notes, not a death buzz.
function sfxDie() {
  tone(392, 370, 0.16, 0.14, 'sine');
  tone(294, 278, 0.28, 0.13, 'sine', 0.14);
}
function sfxWin() {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, f, 0.22, 0.18, 'triangle', i * 0.11));
}
function sfxTurn() { tone(300, 360, 0.04, 0.06); }

/* ------------------------------------------------------------------ mode */

function loadMode() {
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch (_) {}
  setMode(MODES[saved] ? saved : MODE_ORDER[0]);
}

function setMode(name) {
  modeName = name;
  mode = MODES[name];
  boardSize = mode.board;
  try { localStorage.setItem(MODE_KEY, name); } catch (_) {}
  if (modeBtn) {
    modeBtn.textContent = '🧒 ' + mode.label;
    modeBtn.setAttribute('aria-label', 'Age level ' + mode.label + '. Tap to change.');
  }
}

function cycleMode() {
  setMode(MODE_ORDER[(MODE_ORDER.indexOf(modeName) + 1) % MODE_ORDER.length]);
  reset();    // before layout(), so nothing is drawn using the old board's coordinates
  layout();
}

/* ------------------------------------------------------------------ init */

document.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('game');
  ctx = canvas.getContext('2d');
  boardWrap = document.getElementById('boardWrap');
  scoreEl = document.getElementById('score');
  overlay = document.getElementById('overlay');
  overlayEmoji = document.getElementById('overlayEmoji');
  overlayText = document.getElementById('overlayText');
  playBtn = document.getElementById('playBtn');
  modeBtn = document.getElementById('modeBtn');

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduceMotion = mq.matches;
  mq.addEventListener?.('change', e => { reduceMotion = e.matches; if (reduceMotion) sparks = []; });

  loadMode();
  bindControls();
  layout();
  new ResizeObserver(layout).observe(boardWrap);
  window.addEventListener('resize', layout);
  reset();
  requestAnimationFrame(loop);
});

function bindControls() {
  const pad = { upBtn: 'up', downBtn: 'down', leftBtn: 'left', rightBtn: 'right' };
  Object.keys(pad).forEach(id => {
    document.getElementById(id).addEventListener('pointerdown', e => {
      e.preventDefault();
      ensureAudio();
      goDir(pad[id]);
    });
  });

  document.addEventListener('keydown', e => {
    const m = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
    if (m[e.key]) { e.preventDefault(); ensureAudio(); goDir(m[e.key]); return; }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); ensureAudio(); overlayAction(); }
  });

  // Listen on the wrapper, not the canvas: the overlay sits on top of the
  // canvas and would otherwise swallow every tap-to-start / tap-to-retry.
  boardWrap.addEventListener('pointerdown', e => {
    e.preventDefault();
    ensureAudio();
    overlayAction();
  });

  modeBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    ensureAudio();
    cycleMode();
  });

  // A tablet put down mid-game should wait for the child, not play on alone.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && started && !dead) {
      paused = true;
      showOverlay('paused');
    }
  });
}

/* --------------------------------------------------------------- gameplay */

function playing() { return started && !dead && !paused; }

function lastQueuedDir() {
  return turnQueue.length ? turnQueue[turnQueue.length - 1] : dir;
}

function goDir(d) {
  if (dead) { reset(); startGame(); return; }
  if (paused) { paused = false; hideOverlay(); return; }

  if (!started) {
    // The snake lies flat facing `dir`, so the opposite direction would drive
    // the head straight into its own neck. Flip the body instead, so the very
    // first button a child presses always does what it says.
    if (d === OPPOSITE[dir]) snake.reverse();
    dir = d;
    prevSnake = snake.map(s => ({ x: s.x, y: s.y }));
    startGame();
    return;
  }

  const ref = lastQueuedDir();
  if (d !== ref && d !== OPPOSITE[ref] && turnQueue.length < MAX_QUEUED_TURNS) {
    turnQueue.push(d);
    sfxTurn();
  }
}

function startGame() {
  started = true;
  paused = false;
  dead = false;
  acc = 0;
  hideOverlay();
}

function reset() {
  const mid = Math.floor(boardSize / 2);
  snake = [{ x: mid, y: mid }, { x: mid - 1, y: mid }, { x: mid - 2, y: mid }];
  prevSnake = snake.map(s => ({ x: s.x, y: s.y }));
  dir = 'right';
  turnQueue = [];
  score = 0;
  started = false;
  dead = false;
  paused = false;
  outcome = null;
  acc = 0;
  sparks = [];
  clearTimeout(dieTimer);
  renderScore();
  placeFood();
  showOverlay('start');
}

// Returns false when the snake has filled the board and there is nowhere left
// to put food.
function placeFood() {
  const free = [];
  for (let x = 0; x < boardSize; x++) {
    for (let y = 0; y < boardSize; y++) {
      if (!snake.some(s => s.x === x && s.y === y)) free.push({ x, y });
    }
  }
  if (!free.length) return false;
  food = free[Math.floor(Math.random() * free.length)];
  return true;
}

function step() {
  if (turnQueue.length) dir = turnQueue.shift();
  prevSnake = snake.map(s => ({ x: s.x, y: s.y }));

  const head = { x: snake[0].x + DIR[dir].x, y: snake[0].y + DIR[dir].y };
  if (head.x < 0) head.x = boardSize - 1;
  if (head.x >= boardSize) head.x = 0;
  if (head.y < 0) head.y = boardSize - 1;
  if (head.y >= boardSize) head.y = 0;

  const hitSelf = snake.some(s => s.x === head.x && s.y === head.y);
  if (hitSelf && mode.selfCollide) {
    snake.unshift(head);   // show the collision frame before the overlay
    die();
    return;
  }

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score++;
    renderScore();
    sfxEat(score);
    burst(food.x, food.y);
    eatPopAt = performance.now();
    tongueAt = performance.now();
    if (!placeFood()) { win(); return; }
  } else {
    snake.pop();
  }
}

function die() {
  dead = true;
  outcome = 'dead';
  sfxDie();
  showOverlay('dead');
  dieTimer = setTimeout(() => { if (dead) reset(); }, 4000);
}

function win() {
  dead = true;
  outcome = 'win';
  sfxWin();
  showOverlay('win');
  dieTimer = setTimeout(() => { if (dead) reset(); }, 5000);
}

/* ---------------------------------------------------------------- overlay */

const OVERLAY_STATES = {
  start: { emoji: '', btn: '▶', replay: false, text: 'Tap to play!' },
  paused: { emoji: '⏸️', btn: '▶', replay: false, text: 'Paused' },
  dead: { emoji: '🐍', btn: '↻', replay: true, text: 'Oops! Try again' },
  win: { emoji: '🎉', btn: '↻', replay: true, text: 'You filled the board!' }
};

function showOverlay(kind) {
  const s = OVERLAY_STATES[kind];
  overlayEmoji.textContent = s.emoji;
  playBtn.textContent = s.btn;
  playBtn.classList.toggle('replay', s.replay);
  playBtn.setAttribute('aria-label', s.replay ? 'Play again' : 'Play');
  overlayText.textContent = s.text;
  overlay.classList.remove('hidden');
}

function hideOverlay() { overlay.classList.add('hidden'); }

function overlayAction() {
  if (dead) { reset(); startGame(); return; }
  if (paused) { paused = false; hideOverlay(); return; }
  if (!started) startGame();
}

function renderScore() {
  scoreEl.textContent = score === 0 ? '0'
    : score <= SCORE_ICON_LIMIT ? '⭐'.repeat(score)
    : '⭐×' + score;
  scoreEl.setAttribute('aria-label', score + (score === 1 ? ' star' : ' stars'));
}

/* ----------------------------------------------------------------- layout */

function layout() {
  if (!boardWrap) return;
  const w = boardWrap.clientWidth;
  const h = boardWrap.clientHeight;
  if (!w || !h) return;

  cellPx = Math.max(8, Math.floor(Math.min(w, h) / boardSize));
  boardPx = cellPx * boardSize;

  // Back the canvas with real device pixels so it is not upscaled on retina
  // screens, then keep drawing in CSS pixels via the transform.
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = boardPx + 'px';
  canvas.style.height = boardPx + 'px';
  canvas.width = Math.round(boardPx * dpr);
  canvas.height = Math.round(boardPx * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (snake) render(1, performance.now());
}

/* ------------------------------------------------------------------- loop */

function loop(now) {
  requestAnimationFrame(loop);

  if (!lastFrame) lastFrame = now;
  let dt = now - lastFrame;
  lastFrame = now;
  if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;   // returned from a hidden tab

  if (playing()) {
    acc += dt;
    let guard = 0;
    while (acc >= mode.tick && playing() && guard++ < MAX_STEPS_PER_FRAME) {
      acc -= mode.tick;
      step();
    }
    if (!playing()) acc = 0;
  }

  updateSparks(dt);
  if (now >= nextBlinkAt) { blinkUntil = now + BLINK_MS; nextBlinkAt = now + BLINK_EVERY_MS + Math.random() * 2200; }

  // Reduced motion: snap cell to cell instead of gliding.
  const alpha = reduceMotion || !playing() ? 1 : Math.min(acc / mode.tick, 1);
  render(alpha, now);
}

/* ---------------------------------------------------------------- effects */

function burst(gx, gy) {
  if (reduceMotion) return;
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12 + Math.random() * 0.5;
    const sp = 0.055 + Math.random() * 0.075;   // cells per ms
    sparks.push({
      x: gx + 0.5, y: gy + 0.5,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 1, color: COLORS.spark[i % COLORS.spark.length]
    });
  }
}

function updateSparks(dt) {
  const f = dt / 1000;
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.x += p.vx * f;
    p.y += p.vy * f;
    p.vx *= 0.92;
    p.vy *= 0.92;
    p.life -= dt / 520;
    if (p.life <= 0) sparks.splice(i, 1);
  }
}

/* -------------------------------------------------------------- rendering */

function lerp(a, b, t) { return a + (b - a) * t; }

// Interpolated grid position of segment `i`, plus the mirrored copy it needs
// when it is mid-way through wrapping around an edge.
function segmentPositions(i, alpha) {
  const cur = snake[i];
  const prev = prevSnake[i] || cur;

  let px = prev.x, py = prev.y, cx = cur.x, cy = cur.y;
  let wrapX = 0, wrapY = 0;

  if (cx - px > 1) { cx -= boardSize; wrapX = boardSize; }
  else if (px - cx > 1) { cx += boardSize; wrapX = -boardSize; }
  if (cy - py > 1) { cy -= boardSize; wrapY = boardSize; }
  else if (py - cy > 1) { cy += boardSize; wrapY = -boardSize; }

  const x = lerp(px, cx, alpha);
  const y = lerp(py, cy, alpha);
  const out = [{ x, y }];
  if (wrapX || wrapY) out.push({ x: x + wrapX, y: y + wrapY });
  return out;
}

function render(alpha, now) {
  if (!ctx || !boardPx) return;
  const s = cellPx;

  ctx.fillStyle = COLORS.board;
  ctx.fillRect(0, 0, boardPx, boardPx);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < boardSize; i++) {
    const p = Math.round(i * s) + 0.5;   // crisp hairlines
    ctx.moveTo(p, 0); ctx.lineTo(p, boardPx);
    ctx.moveTo(0, p); ctx.lineTo(boardPx, p);
  }
  ctx.stroke();

  drawFood(now, s);

  // Tail first so the head sits on top.
  const headPop = reduceMotion ? 1 : 1 + 0.3 * Math.max(0, 1 - (now - eatPopAt) / EAT_POP_MS);
  for (let i = snake.length - 1; i >= 0; i--) {
    const t = i / Math.max(snake.length - 1, 1);
    const c = COLORS.bodyNear.map((v, k) => Math.round(lerp(v, COLORS.bodyFar[k], t)));
    const fill = i === 0 ? COLORS.head : `rgb(${c[0]},${c[1]},${c[2]})`;
    const r = s * 0.42 * (i === 0 ? headPop : 1);
    for (const p of segmentPositions(i, alpha)) {
      drawSegment(p.x * s + s / 2, p.y * s + s / 2, r, fill, i === 0, now, s);
    }
  }

  drawSparks(s);
}

function drawFood(now, s) {
  const pulse = reduceMotion ? 1 : 1 + 0.08 * Math.sin(now / 260);
  const cx = food.x * s + s / 2;
  const cy = food.y * s + s / 2;
  const r = s * 0.40 * pulse;

  // A star, not another circle: shape distinguishes the food from the snake
  // even for a child who cannot separate the red and green by colour.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = 'rgba(255,210,63,.55)';
  ctx.shadowBlur = s * 0.35;
  starPath(ctx, r, r * 0.46, 5, -Math.PI / 2);
  ctx.fillStyle = COLORS.food;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, s * 0.05);
  ctx.strokeStyle = COLORS.foodRim;
  ctx.stroke();
  ctx.restore();
}

function starPath(c, outer, inner, points, rot) {
  c.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = rot + (Math.PI * i) / points;
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
  }
  c.closePath();
}

function drawSegment(cx, cy, r, fill, isHead, now, s) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx - r * 0.22, cy - r * 0.22, r * 0.26, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fill();

  if (isHead) drawFace(cx, cy, r, now, s);
}

function drawFace(cx, cy, r, now, s) {
  const facing = lastQueuedDir();
  const d = DIR[facing];
  const perp = { x: -d.y, y: d.x };
  const eyeOut = r * 0.44;   // sideways spread
  const eyeFwd = r * 0.16;   // toward the nose
  const blinking = now < blinkUntil;

  const eyes = [-1, 1].map(sign => ({
    x: cx + d.x * eyeFwd + perp.x * eyeOut * sign,
    y: cy + d.y * eyeFwd + perp.y * eyeOut * sign
  }));

  // Tongue flick, forward from the nose.
  if (now - tongueAt < TONGUE_MS) {
    const reach = r * (1.05 + 0.35 * Math.sin(((now - tongueAt) / TONGUE_MS) * Math.PI));
    ctx.strokeStyle = '#ff5d73';
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.lineCap = 'round';
    const forkAt = reach * 0.72;
    ctx.beginPath();
    ctx.moveTo(cx + d.x * r * 0.6, cy + d.y * r * 0.6);
    ctx.lineTo(cx + d.x * forkAt, cy + d.y * forkAt);
    // Fork forward into a Y, not sideways into a T.
    [1, -1].forEach(sign => {
      ctx.moveTo(cx + d.x * forkAt, cy + d.y * forkAt);
      ctx.lineTo(cx + d.x * reach + perp.x * r * 0.26 * sign, cy + d.y * reach + perp.y * r * 0.26 * sign);
    });
    ctx.stroke();
  }

  const eyeR = Math.max(1.6, r * 0.30);
  if (blinking) {
    ctx.strokeStyle = '#12331b';
    ctx.lineWidth = Math.max(1.5, r * 0.13);
    ctx.lineCap = 'round';
    eyes.forEach(e => {
      ctx.beginPath();
      ctx.moveTo(e.x - perp.x * eyeR - d.x * 0, e.y - perp.y * eyeR);
      ctx.lineTo(e.x + perp.x * eyeR, e.y + perp.y * eyeR);
      ctx.stroke();
    });
    return;
  }

  eyes.forEach(e => {
    ctx.beginPath();
    ctx.arc(e.x, e.y, eyeR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(e.x + d.x * eyeR * 0.34, e.y + d.y * eyeR * 0.34, eyeR * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = '#12331b';
    ctx.fill();
    // Catchlight, so the eyes look alive rather than printed on.
    if (s >= 26) {
      ctx.beginPath();
      ctx.arc(e.x - perp.x * eyeR * 0.3 - d.x * eyeR * 0.3, e.y - perp.y * eyeR * 0.3 - d.y * eyeR * 0.3, eyeR * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fill();
    }
  });
}

function drawSparks(s) {
  sparks.forEach(p => {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.beginPath();
    ctx.arc(p.x * s, p.y * s, Math.max(1, s * 0.09 * p.life), 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}
