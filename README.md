# 🐍 Snake Pad

A friendly snake game for 3–6 year olds. Installable, works offline, no
dependencies, no network calls, no analytics, no ads.

Open `index.html`, or serve the folder over HTTP to get the installable PWA
behaviour:

```sh
python3 -m http.server 8000    # then visit http://localhost:8000
```

## Age levels

The 🧒 button in the header switches level; the choice is saved and the app
opens on the easier one by default.

| | Board | Seconds per move | Can you lose? |
| --- | --- | --- | --- |
| **3–4** | 8 × 8 | 0.8 | No — the snake passes through itself |
| **5–6** | 12 × 12 | 0.45 | Yes — running into yourself ends the round |

Walls never kill in either level; the snake wraps around to the other side.
Filling the whole board is a win.

## Design rules

These are deliberate. Please keep them if you change the game:

- **Every control does what it says.** No input may end the round on the first
  press — the snake's body is flipped instead of refusing the direction.
- **The 3–4 level cannot be lost.** A preschooler cannot reason about
  self-collision, so it is not a rule at that level.
- **Failure is gentle.** Soft two-note sound, "Oops! Try again", one tap to
  restart, and an automatic restart after a few seconds if nobody taps.
- **Nothing is conveyed by colour alone.** The food is a *star* and the snake
  is *round*, so the two never depend on telling red from green.
- **Targets are big.** The d-pad scales with the viewport and stays at least
  ~70 px per button on the smallest supported phone.
- **Text is never the only instruction.** Non-readers get a large ▶ button.
- **It waits for the child.** Hiding the tab pauses the game instead of playing
  on without them.

## Layout

Portrait stacks header / board / d-pad. Landscape puts the board and d-pad side
by side — stacking them collapses the board to a few dozen pixels on a phone
held sideways, which is how a lot of children hold a tablet.

The board is sized from a `ResizeObserver` on its wrapper rather than from
hardcoded viewport arithmetic, and the canvas is backed by real device pixels so
it is sharp on retina screens.

## Tests

```sh
npm install
npm test
```

`tests/smoke.mjs` drives the real page in headless Chromium and covers the
things a child hits first — every first press, tap-to-start, the age levels,
pausing, the win and lose states, and that the layout fits on five device
shapes. Set `CHROMIUM_PATH` to use a browser you already have instead of
Playwright's download.

## Files

```
index.html          markup
css/style.css       layout, d-pad, overlay, landscape rules
js/app.js           the whole game: state, loop, rendering, audio
sw.js               offline cache (stale-while-revalidate)
manifest.json       PWA install metadata
icons/              app icons — icon-*.png are generated from the SVGs
tests/smoke.mjs     browser smoke tests
```

The game logic runs on a fixed grid tick, but rendering interpolates between
ticks so the snake glides rather than teleporting from cell to cell.
