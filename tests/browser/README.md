# Browser tests

Three end-to-end suites that drive the real pages in a real browser. They exist
because the interesting bugs in this project were not the ones unit tests catch:
every one of them passed its assertions while the screen was wrong.

## Running them

```bash
cd tests/browser
npm install          # puppeteer-core only; it drives a browser you already have
node run.js          # serves docs/ on a free port and runs all three suites
```

`run.js` exits non-zero if any suite fails, so it works as a CI gate.

To run a single suite, or to point one at the live site instead of a local
server:

```bash
node verify_mnistpro.js
BASE=https://panandi.github.io/mnistpro node verify_ai_lane.js
```

Chrome, Chromium or Edge is found automatically on Windows, macOS and Linux.
Set `CHROME_PATH` to override. Screenshots are written to `screenshots/`, which
is ignored by git.

## What each suite covers

| Suite | Covers |
| --- | --- |
| `verify_mnistpro.js` | Episode list, the collapsed how-to, the model name shown while solo, the golden-manifest trajectory, edge clamping, canvas pixels against the shipped bitmap, trail mode, the one-shot answer |
| `verify_static.js` | ARC Race: the measured easy tier, hints, answer-size labelling, grading in both directions, the guide |
| `verify_ai_lane.js` | The AI opponent, driven by a **stubbed `fetch`** — no API key and no spending |

## Why the AI suite stubs the network

`verify_ai_lane.js` replaces `window.fetch` before the page loads and returns
scripted replies. That makes the opponent's behaviour deterministic and free,
and it lets the suite reproduce failures that are otherwise a matter of luck:

- a reply arriving **after** the round was stopped
- a reply whose JSON is **cut off** by the token budget
- a reply that says `"Move"` / `"Right."` instead of `"move"` / `"right"`
- a reply that restates the prompt's example object before the real one

## What these caught

Each of these shipped, passed every assertion at the time, and was found by
looking at a screenshot:

1. A correct answer reported as `Wrong — it answered null`
2. A lane stuck showing `Playing` after the round ended
3. `hidden` set on elements that stayed on screen, because an explicit CSS
   `display` beats the `[hidden]` attribute — including the veils sitting on top
   of live canvases
4. Sensible model actions rejected over capitalisation and punctuation
5. A reply truncated by the token budget, scored as malformed
6. The how-to panel, which the "four steps exist" assertion passed whether or
   not it was collapsed

The lesson runs through all six: **assert what renders, not what was set.**
Checking `element.hidden === true` passes happily while the element is visible.
