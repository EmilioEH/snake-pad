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

let canvas, ctx, scoreEl, overlay, overlayText, modeBtn;
let snake, food, dir, nextDir, score, dead, started, cellPx, boardPx;
let tickTimer, dieTimer;
let modeName, mode, boardSize;

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function ensureAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep(f1, f2, dur, vol) {
  if (!audioCtx) return;
  try {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.connect(g);
    g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(f1, audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(f2, audioCtx.currentTime + dur);
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.start();
    o.stop(audioCtx.currentTime + dur + 0.05);
  } catch (_) {}
}

function sfxEat() { beep(500, 1000, 0.1, 0.2); }
function sfxDie() { beep(400, 80, 0.35, 0.25); }
function sfxTurn() { beep(300, 360, 0.04, 0.08); }
function sfxWin() { beep(600, 1400, 0.5, 0.2); }

function randInt(max) { return Math.floor(Math.random() * max); }

function loadMode() {
  let saved;
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
  const next = MODE_ORDER[(MODE_ORDER.indexOf(modeName) + 1) % MODE_ORDER.length];
  setMode(next);
  resize();
  reset();
}

document.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('game');
  ctx = canvas.getContext('2d');
  scoreEl = document.getElementById('score');
  overlay = document.getElementById('overlay');
  overlayText = document.getElementById('overlayText');
  modeBtn = document.getElementById('modeBtn');

  loadMode();
  bindControls();
  resize();
  window.addEventListener('resize', resize);
  reset();
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
    if (m[e.key]) { e.preventDefault(); ensureAudio(); goDir(m[e.key]); }
  });

  // Listen on the wrapper, not the canvas: the overlay sits on top of the
  // canvas and would otherwise swallow every tap-to-start / tap-to-retry.
  document.getElementById('boardWrap').addEventListener('pointerdown', e => {
    e.preventDefault();
    ensureAudio();
    if (dead) { reset(); return; }
    if (!started) { started = true; hideOverlay(); tick(); }
  });

  modeBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    ensureAudio();
    cycleMode();
  });
}

function goDir(d) {
  if (dead) { reset(); return; }
  if (!started) {
    // First press: the snake lies flat facing `dir`, so the opposite direction
    // would drive the head straight into its own neck. Flip the body instead so
    // the very first button a child presses always does what it says.
    if (d === OPPOSITE[dir]) snake.reverse();
    nextDir = d;
    dir = d;
    started = true;
    hideOverlay();
    tick();
    return;
  }
  if (d !== OPPOSITE[dir] && d !== dir) {
    nextDir = d;
    sfxTurn();
    draw();
  }
}

function reset() {
  const mid = Math.floor(boardSize / 2);
  snake = [{ x: mid, y: mid }, { x: mid - 1, y: mid }, { x: mid - 2, y: mid }];
  dir = 'right';
  nextDir = 'right';
  score = 0;
  dead = false;
  started = false;
  scoreEl.textContent = '0';
  clearTimeout(tickTimer);
  clearTimeout(dieTimer);
  placeFood();
  showOverlay('Tap or press arrows to start!');
  draw();
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
  food = free[randInt(free.length)];
  return true;
}

function tick() {
  if (dead || !started) return;
  dir = nextDir;

  const head = { x: snake[0].x + DIR[dir].x, y: snake[0].y + DIR[dir].y };

  if (head.x < 0) head.x = boardSize - 1;
  if (head.x >= boardSize) head.x = 0;
  if (head.y < 0) head.y = boardSize - 1;
  if (head.y >= boardSize) head.y = 0;

  const hitSelf = snake.some(s => s.x === head.x && s.y === head.y);
  if (hitSelf && mode.selfCollide) {
    snake.unshift(head);
    draw();
    die();
    return;
  }

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score++;
    scoreEl.textContent = score;
    sfxEat();
    if (!placeFood()) { draw(); win(); return; }
  } else {
    snake.pop();
  }

  draw();
  tickTimer = setTimeout(tick, mode.tick);
}

function die() {
  dead = true;
  clearTimeout(tickTimer);
  sfxDie();
  showOverlay('🐍 Oops!\nTap to try again!');
  dieTimer = setTimeout(() => { if (dead) reset(); }, 3000);
}

function win() {
  dead = true;
  clearTimeout(tickTimer);
  sfxWin();
  showOverlay('🎉 You filled the board!\nTap to play again!');
  dieTimer = setTimeout(() => { if (dead) reset(); }, 4000);
}

function showOverlay(msg) {
  overlayText.textContent = msg;
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

function resize() {
  const maxW = window.innerWidth - 16;
  const maxH = window.innerHeight - 270;
  const size = Math.min(maxW, maxH, 420);
  cellPx = Math.max(10, Math.floor(size / boardSize));
  boardPx = cellPx * boardSize;

  // Back the canvas with real device pixels so it is not upscaled on retina
  // screens, then draw in CSS pixels via the transform.
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = boardPx + 'px';
  canvas.style.height = boardPx + 'px';
  canvas.width = Math.round(boardPx * dpr);
  canvas.height = Math.round(boardPx * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (snake) draw();
}

function draw() {
  const s = cellPx;
  const w = boardPx;
  const h = boardPx;

  ctx.fillStyle = '#16213e';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#1a2744';
  ctx.lineWidth = 1;
  for (let i = 1; i < boardSize; i++) {
    ctx.beginPath();
    ctx.moveTo(i * s, 0);
    ctx.lineTo(i * s, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * s);
    ctx.lineTo(w, i * s);
    ctx.stroke();
  }

  // Food
  const fx = food.x * s + s / 2;
  const fy = food.y * s + s / 2;
  const fr = s * 0.4;

  ctx.beginPath();
  ctx.arc(fx + 1, fy + 1, fr, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(fx, fy, fr, 0, Math.PI * 2);
  ctx.fillStyle = '#e63946';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(fx - fr * 0.3, fy - fr * 0.3, fr * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fill();

  // Snake body (draw tail first so head is on top)
  for (let i = snake.length - 1; i >= 0; i--) {
    const seg = snake[i];
    const cx = seg.x * s + s / 2;
    const cy = seg.y * s + s / 2;
    const t = i / Math.max(snake.length - 1, 1);
    const g = Math.round(170 - t * 40);
    const col = i === 0 ? '#4caf50' : `rgb(76,${g},60)`;
    const r = s * 0.4;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx - r * 0.2, cy - r * 0.2, r * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();

    if (i === 0) {
      const eyeR = r * 0.25;
      const off = r * 0.4;
      let x1, y1, x2, y2;
      switch (nextDir) {
        case 'up':  x1 = cx - off; y1 = cy - off; x2 = cx + off; y2 = cy - off; break;
        case 'down': x1 = cx - off; y1 = cy + off; x2 = cx + off; y2 = cy + off; break;
        case 'left': x1 = cx - off; y1 = cy - off; x2 = cx - off; y2 = cy + off; break;
        case 'right': x1 = cx + off; y1 = cy - off; x2 = cx + off; y2 = cy + off; break;
      }

      ctx.beginPath();
      ctx.arc(x1, y1, eyeR * 1.3, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x2, y2, eyeR * 1.3, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x1, y1, eyeR * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = '#111';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x2, y2, eyeR * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
