// Smoke tests for the interactions a child actually performs first, plus the
// behaviour that keeps the game fair for them.
// Run: npm test   (requires `npm install` for the playwright devDependency)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'file://' + resolve(ROOT, 'index.html');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined
});

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
  const page = await ctx.newPage();
  await page.goto(APP);
  await page.waitForFunction(() => typeof snake !== 'undefined' && snake.length > 0 && cellPx > 0);
  page.on('pageerror', err => check('no page errors', false, String(err)));
  return page;
}

const overlayHidden = page =>
  page.locator('#overlay').evaluate(el => el.classList.contains('hidden'));

/* -- Every control must start the game, never end it ---------------------- */
// The snake spawns facing right, so `left` used to walk the head into its own
// neck on the very first press.
for (const [id, name] of [['leftBtn', 'left'], ['rightBtn', 'right'], ['upBtn', 'up'], ['downBtn', 'down']]) {
  const page = await open();
  await page.locator('#' + id).dispatchEvent('pointerdown');
  await page.waitForTimeout(120);
  const state = await page.evaluate(() => ({ dead, dir, started }));
  check(`first press "${name}" does not kill the snake`, !state.dead);
  check(`first press "${name}" starts the game`, state.started && await overlayHidden(page));
  check(`first press "${name}" travels ${name}`, state.dir === name, `dir=${state.dir}`);
  await page.close();
}

/* -- Tap-to-start must work through the overlay --------------------------- */
{
  const page = await open();
  const box = await page.locator('#game').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(120);
  check('tapping the board starts the game', await overlayHidden(page));
  await page.close();
}
{
  const page = await open();
  await page.locator('#playBtn').dispatchEvent('pointerdown');
  await page.waitForTimeout(120);
  check('the play button starts the game', await overlayHidden(page));
  await page.close();
}

/* -- Retina ---------------------------------------------------------------*/
{
  const page = await open({ deviceScaleFactor: 3 });
  const info = await page.evaluate(() => {
    const c = document.getElementById('game');
    return { dpr: devicePixelRatio, backing: c.width, css: Math.round(c.getBoundingClientRect().width) };
  });
  check('canvas is scaled for retina', info.backing === info.css * info.dpr,
    `dpr ${info.dpr}, backing ${info.backing}px, css ${info.css}px`);
  await page.close();
}

/* -- Age levels ------------------------------------------------------------*/
{
  const page = await open();
  const read = () => page.evaluate(() => ({ mode: modeName, board: boardSize, tick: mode.tick, selfCollide: mode.selfCollide }));

  const little = await read();
  check('defaults to the easiest level', little.mode === 'little' && little.board === 8 && little.selfCollide === false, JSON.stringify(little));

  await page.locator('#modeBtn').dispatchEvent('pointerdown');
  await page.waitForTimeout(80);
  const big = await read();
  check('toggle switches to the 5–6 level', big.mode === 'big' && big.board === 12 && big.tick < little.tick && big.selfCollide === true, JSON.stringify(big));

  await page.reload();
  await page.waitForFunction(() => typeof modeName !== 'undefined');
  check('level choice persists across reload', await page.evaluate(() => modeName) === 'big');
  await page.close();
}

/* -- The easy level cannot be lost ---------------------------------------- */
{
  const page = await open();
  const r = await page.evaluate(() => {
    snake = [{ x: 4, y: 4 }, { x: 4, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 4 }, { x: 3, y: 5 }];
    prevSnake = snake.map(s => ({ ...s }));
    dir = 'left'; turnQueue = []; started = true; dead = false;
    step(); step();
    return { dead, outcome };
  });
  check('easy level: snake passes through itself', !r.dead, JSON.stringify(r));
  await page.close();
}

/* -- The harder level still ends on a self-collision, showing the frame ---- */
{
  const page = await open();
  const r = await page.evaluate(() => {
    setMode('big');
    reset();
    snake = [{ x: 4, y: 4 }, { x: 4, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 4 }, { x: 3, y: 5 }];
    prevSnake = snake.map(s => ({ ...s }));
    dir = 'left'; turnQueue = []; started = true; dead = false;
    const before = snake.length;
    step();
    return { dead, outcome, grew: snake.length > before, text: document.getElementById('overlayText').textContent };
  });
  check('hard level: self-collision ends the game', r.dead && r.outcome === 'dead', JSON.stringify(r));
  check('the collision frame is drawn before the overlay', r.grew);
  check('death copy is gentle', /try again/i.test(r.text), r.text);
  await page.close();
}

/* -- Filling the board wins rather than wedging the food placement -------- */
{
  const page = await open();
  const r = await page.evaluate(() => {
    const cells = [];
    for (let y = 0; y < boardSize; y++) for (let x = 0; x < boardSize; x++) cells.push({ x, y });
    snake = [{ x: 1, y: 0 }, ...cells.filter(c => !(c.x === 0 && c.y === 0) && !(c.x === 1 && c.y === 0))];
    prevSnake = snake.map(s => ({ ...s }));
    food = { x: 0, y: 0 };
    dir = 'left'; turnQueue = []; started = true; dead = false;
    step();
    return { outcome, len: snake.length, cells: boardSize * boardSize, text: document.getElementById('overlayText').textContent };
  });
  check('filling the board is a win', r.outcome === 'win' && /filled the board/i.test(r.text), JSON.stringify(r));
  await page.close();
}

/* -- Rapid turns are queued, not swallowed -------------------------------- */
{
  const page = await open();
  const r = await page.evaluate(() => {
    started = true; dead = false; paused = false; dir = 'right'; turnQueue = [];
    goDir('up');
    goDir('left');      // illegal straight after 'up'? no — legal, queued
    return { queue: turnQueue.slice() };
  });
  check('a quick second turn is queued', r.queue.length === 2 && r.queue[0] === 'up' && r.queue[1] === 'left', JSON.stringify(r));
  await page.close();
}

/* -- A reversal is still refused ------------------------------------------ */
{
  const page = await open();
  const r = await page.evaluate(() => {
    started = true; dead = false; paused = false; dir = 'right'; turnQueue = [];
    goDir('left');
    return turnQueue.slice();
  });
  check('reversing into itself is refused', r.length === 0, JSON.stringify(r));
  await page.close();
}

/* -- The game pauses when the tablet is put down -------------------------- */
{
  const page = await open();
  await page.locator('#upBtn').dispatchEvent('pointerdown');
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(80);
  const r = await page.evaluate(() => ({ paused, text: document.getElementById('overlayText').textContent }));
  check('hiding the tab pauses the game', r.paused && /paused/i.test(r.text), JSON.stringify(r));

  const head = await page.evaluate(() => ({ ...snake[0] }));
  await page.waitForTimeout(1000);
  const head2 = await page.evaluate(() => ({ ...snake[0] }));
  check('a paused game does not keep moving', head.x === head2.x && head.y === head2.y);

  await page.locator('#playBtn').dispatchEvent('pointerdown');
  await page.waitForTimeout(80);
  check('tapping play resumes', await page.evaluate(() => !paused));
  await page.close();
}

/* -- Layout holds up on the shapes a kid's tablet actually takes ----------- */
for (const vp of [
  { width: 390, height: 844, name: 'phone portrait' },
  { width: 844, height: 390, name: 'phone landscape' },
  { width: 768, height: 1024, name: 'tablet portrait' },
  { width: 1024, height: 768, name: 'tablet landscape' },
  { width: 320, height: 568, name: 'small phone' }
]) {
  const page = await open({ viewport: { width: vp.width, height: vp.height } });
  const r = await page.evaluate(() => {
    const g = document.getElementById('game').getBoundingClientRect();
    const d = document.getElementById('dpad').getBoundingClientRect();
    const btn = document.getElementById('upBtn').getBoundingClientRect();
    return {
      board: Math.round(g.width),
      btn: Math.round(Math.min(btn.width, btn.height)),
      fits: d.bottom <= innerHeight + 1 && d.right <= innerWidth + 1 && g.bottom <= innerHeight + 1 && g.top >= -1,
      overlapsBoard: !(d.left >= g.right || d.right <= g.left || d.top >= g.bottom || d.bottom <= g.top)
    };
  });
  check(`${vp.name}: everything fits on screen`, r.fits, JSON.stringify(r));
  check(`${vp.name}: board is usable (${r.board}px)`, r.board >= 200);
  check(`${vp.name}: d-pad targets are big (${r.btn}px)`, r.btn >= 60);
  check(`${vp.name}: d-pad does not cover the board`, !r.overlapsBoard);
  await page.close();
}

/* -- No horizontal page scroll -------------------------------------------- */
{
  const page = await open();
  const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check('page does not scroll sideways', !over);
  await page.close();
}

/* -- PWA install metadata -------------------------------------------------- */
{
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
  const png = manifest.icons.filter(i => i.type === 'image/png');
  check('manifest ships PNG icons for install', png.some(i => i.sizes === '192x192') && png.some(i => i.sizes === '512x512'),
    png.map(i => i.sizes).join(', '));
  check('manifest ships a maskable icon', manifest.icons.some(i => i.purpose === 'maskable'));
  check('manifest paths are relative (sub-path hosting)', manifest.start_url.startsWith('.') && manifest.scope.startsWith('.'));

  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  check('apple-touch-icon is a PNG (iOS ignores SVG)', /apple-touch-icon[^>]*\.png/.test(html));

  const sw = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');
  check('service worker uses relative asset paths', !/'\/[a-z]/.test(sw) && sw.includes("'./index.html'"));
}

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
