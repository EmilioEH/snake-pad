// Smoke tests for the interactions a child actually performs first.
// Run: npm test   (requires `npm install` for the playwright devDependency)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const APP = 'file://' + resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined
});

async function open(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...opts });
  await page.goto(APP);
  await page.waitForFunction(() => document.getElementById('overlayText')?.textContent?.length > 0);
  return page;
}

const overlayHidden = page =>
  page.locator('#overlay').evaluate(el => el.classList.contains('hidden'));

// Every d-pad button must start the game, never end it. The snake spawns facing
// right, so `left` used to walk the head into its own neck on the first press.
for (const [id, name] of [['leftBtn', 'left'], ['rightBtn', 'right'], ['upBtn', 'up'], ['downBtn', 'down']]) {
  const page = await open();
  await page.locator('#' + id).dispatchEvent('pointerdown');
  await page.waitForTimeout(150);
  const text = await page.locator('#overlayText').textContent();
  check(`first press "${name}" does not kill the snake`, !text.includes('Oops'), text.includes('Oops') ? 'died instantly' : '');
  check(`first press "${name}" starts the game`, await overlayHidden(page));
  await page.close();
}

// The overlay covers the canvas, so tap-to-start has to work through it.
{
  const page = await open();
  const box = await page.locator('#game').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  check('tapping the board starts the game', await overlayHidden(page));
  await page.close();
}

// Canvas must be backed by real device pixels, not upscaled.
{
  const page = await open({ deviceScaleFactor: 3 });
  const info = await page.evaluate(() => {
    const c = document.getElementById('game');
    return { dpr: devicePixelRatio, backing: c.width, css: Math.round(c.getBoundingClientRect().width) };
  });
  check('canvas is scaled for retina', info.backing === info.css * info.dpr, `dpr ${info.dpr}, backing ${info.backing}px, css ${info.css}px`);
  await page.close();
}

// Age toggle: switches board size + speed, and survives a reload.
{
  const page = await open();
  const read = () => page.evaluate(() => ({ mode: modeName, board: boardSize, tick: mode.tick, selfCollide: mode.selfCollide }));

  const little = await read();
  check('defaults to the easiest mode', little.mode === 'little' && little.board === 8 && little.selfCollide === false, JSON.stringify(little));

  await page.locator('#modeBtn').dispatchEvent('pointerdown');
  await page.waitForTimeout(100);
  const big = await read();
  check('toggle switches to the 5–6 mode', big.mode === 'big' && big.board === 12 && big.tick < little.tick && big.selfCollide === true, JSON.stringify(big));

  await page.reload();
  await page.waitForFunction(() => document.getElementById('overlayText')?.textContent?.length > 0);
  const persisted = await page.evaluate(() => modeName);
  check('mode choice persists across reload', persisted === 'big', `got ${persisted}`);
  await page.close();
}

// In the little mode the snake passes through itself instead of dying.
{
  const page = await open();
  await page.evaluate(() => {
    started = true;
    hideOverlay();
    snake = [{ x: 4, y: 4 }, { x: 4, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 4 }, { x: 3, y: 5 }];
    dir = nextDir = 'left';
    tick();
  });
  await page.waitForTimeout(300);
  const text = await page.locator('#overlayText').textContent();
  check('little mode: snake passes through itself', !text.includes('Oops'), text);
  await page.close();
}

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
