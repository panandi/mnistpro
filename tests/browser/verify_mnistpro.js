// Verify the MNIST-PRO page against the upstream benchmark, not against itself.
//
// The headline check: episode 0 starts at [130,130], and the published golden
// manifest records that two "up" moves take it to [130,98] then [130,66]. If
// this port reproduces that, the movement semantics are faithful.
//
// It also reads real pixels back off the canvas and compares them to the
// shipped bitmap, so the masking is verified rather than eyeballed.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8123';
// Resolved from this file, so the suite runs from any checkout.
const DOCS = path.join(__dirname, '..', '..', 'docs');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    // Windows
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  const hit = candidates.find((c) => c && fs.existsSync(c));
  if (!hit) {
    throw new Error('no Chrome, Chromium or Edge found. Set CHROME_PATH to a browser binary.');
  }
  return hit;
}

let fails = 0;
const t = (label, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${got}${ok ? '' : ` (expected ${want})`}`);
  if (!ok) fails += 1;
};

const windowOf = (page) => page.$eval('#human-window', (e) => e.textContent.trim());

(async () => {
  const index = JSON.parse(fs.readFileSync(path.join(DOCS, 'data/mnistpro/index.json'), 'utf8'));
  const ep0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'data/mnistpro/episodes/ep000.json'), 'utf8'));
  console.log(`ep000: label ${ep0.label}, start [${ep0.start}], `
    + `${ep0.width}x${ep0.height}, box ${ep0.box_size}, step ${ep0.step_size}\n`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1500 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.accept());

  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(
    () => document.querySelectorAll('#episode-select option[value]:not([value=""])').length > 0,
    { timeout: 15000 });

  t('episodes listed', await page.$$eval('#episode-select option', (o) => o.length), index.episodes.length);
  t('step budget shown', await page.$eval('#steps-left', (e) => e.textContent), index.max_steps);
  t('how-to steps', await page.$$eval('.howto .steps li', (l) => l.length), 4);
  t('how-to is collapsed by default', await page.$eval('.howto', (e) => e.open), false);
  await page.click('.howto > summary');
  await sleep(150);
  t('how-to opens when clicked', await page.$eval('.howto', (e) => e.open), true);
  await page.click('.howto > summary');
  await sleep(150);
  t('how-to closes again', await page.$eval('.howto', (e) => e.open), false);
  t('memory defaults to one window', await page.$eval('#view-select', (e) => e.value), 'single');

  // The default model must be readable without opening the opponent menu.
  const modelRow = await page.$eval('#ai-model', (e) => e.textContent.trim());
  const pill = await page.$eval('#mode-pill', (e) => e.textContent.trim());
  t('model named while solo', /gemini-3\.8-flash/.test(modelRow), true);
  t('paid default is not labelled free', /free/.test(modelRow), false);
  t('header pill names the model', /gemini-3\.8-flash/.test(pill), true);
  console.log(`      model row: "${modelRow}"  pill: "${pill}"`);
  // Assert what actually renders. An explicit display rule beats [hidden], so an
  // element can report hidden === true and still be plainly on screen - which is
  // exactly the bug the old attribute check sailed past.
  const shown = (sel) => page.$eval(sel, (e) =>
    !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  t('solo hides the model menu', await shown('#model-field'), false);
  t('solo hides the key row', await shown('#keyrow'), false);
  await page.select('#opponent-select', 'key');
  await sleep(150);
  t('model menu appears with an AI opponent', await shown('#model-field'), true);
  t('key row appears with an AI opponent', await shown('#keyrow'), true);
  t('pill switches to vs AI', /vs AI/.test(await page.$eval('#mode-pill', (e) => e.textContent)), true);
  await page.select('#opponent-select', 'solo');
  await sleep(150);
  t('solo hides them again', await shown('#keyrow'), false);

  await page.select('#episode-select', 'ep000');
  await page.select('#opponent-select', 'solo');
  await page.click('#btn-start');
  await page.waitForFunction(() => document.getElementById('human-veil').hidden, { timeout: 10000 });

  t('start window matches the generator', await windowOf(page), ep0.start.join(', '));
  // veil.hidden was always true; the veil was painted anyway because
  // .canvas-veil sets display:grid. Assert what is drawn.
  t('human veil is gone once the round starts', await shown('#human-veil'), false);

  // deterministic_start centres the window on a stroke pixel, so at the start it
  // must show both ink and background. After clamping into a corner it legitimately
  // shows only background, which is why this is checked here and not later.
  const atStart = await page.evaluate((box, sx, sy) => {
    const c = document.getElementById('board-human');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const vals = new Set();
    for (let y = 4; y < box - 4; y += 1) {
      for (let x = 4; x < box - 4; x += 1) vals.add(d[((y + sy) * c.width + (x + sx)) * 4]);
    }
    return Array.from(vals).sort((a, b) => a - b);
  }, ep0.box_size, ep0.start[0], ep0.start[1]);
  t('start window shows ink and background', JSON.stringify(atStart), '[0,255]');

  // --- the golden-manifest trajectory -------------------------------------
  await page.click('#dp-up');
  t('after one up  (golden [130,98])', await windowOf(page), '130, 98');
  await page.click('#dp-up');
  t('after two ups (golden [130,66])', await windowOf(page), '130, 66');
  t('sensing steps counted', await page.$eval('#human-steps', (e) => e.textContent), 2);
  t('steps left decremented', await page.$eval('#steps-left', (e) => e.textContent), index.max_steps - 2);

  // --- clamping ------------------------------------------------------------
  for (let i = 0; i < 6; i += 1) await page.click('#dp-up');
  t('clamps at the top edge', (await windowOf(page)).split(',')[1].trim(), '0');
  for (let i = 0; i < 10; i += 1) await page.click('#dp-left');
  t('clamps at the left edge', (await windowOf(page)).split(',')[0].trim(), '0');

  // --- the canvas really shows what the bitmap says ------------------------
  const probe = await page.evaluate((box) => {
    const c = document.getElementById('board-human');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const at = (x, y) => d[(y * c.width + x) * 4];
    let grey = 0;
    for (let i = 0; i < c.width * c.height; i += 1) if (d[i * 4] === 128) grey += 1;
    const inside = [];
    for (let y = 4; y < box - 4; y += 1) {
      for (let x = 4; x < box - 4; x += 1) inside.push(at(x, y));
    }
    return {
      greyFraction: grey / (c.width * c.height),
      outsideIsGrey: at(200, 200) === 128,
      insideValues: Array.from(new Set(inside)).sort((a, b) => a - b),
    };
  }, ep0.box_size);
  t('outside the window is masked grey', probe.outsideIsGrey, true);
  t('window holds only pure black or white',
    probe.insideValues.every((v) => v === 0 || v === 255), true);
  console.log(`      grey covers ${(probe.greyFraction * 100).toFixed(1)}% `
    + `(one 64px window on 224px = ${(100 - 100 * 64 * 64 / (224 * 224)).toFixed(1)}% expected)`);

  // Compare the visible window against the shipped bitmap, pixel for pixel.
  const bits = Buffer.from(ep0.bits, 'base64');
  const strokeAt = (x, y) => {
    const i = y * ep0.width + x;
    return (bits[i >> 3] >> (7 - (i & 7))) & 1;
  };
  const mismatches = await page.evaluate((box) => {
    const c = document.getElementById('board-human');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const out = [];
    for (let y = 0; y < box; y += 1) {
      for (let x = 0; x < box; x += 1) out.push(d[(y * c.width + x) * 4]);
    }
    return out;
  }, ep0.box_size);
  let bad = 0;
  for (let y = 0; y < ep0.box_size; y += 1) {
    for (let x = 0; x < ep0.box_size; x += 1) {
      const shown = mismatches[y * ep0.box_size + x];
      const want = strokeAt(x, y) ? 0 : 255;
      // The cyan outline legitimately overwrites the outer 2px ring.
      if (x < 3 || y < 3 || x >= ep0.box_size - 3 || y >= ep0.box_size - 3) continue;
      if (shown !== want) bad += 1;
    }
  }
  t('window pixels match the shipped bitmap', bad, 0);

  // --- trail mode reveals more --------------------------------------------
  const greyBefore = probe.greyFraction;
  await page.select('#view-select', 'trail');
  await sleep(200);
  const greyAfter = await page.evaluate(() => {
    const c = document.getElementById('board-human');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let g = 0;
    for (let i = 0; i < c.width * c.height; i += 1) if (d[i * 4] === 128) g += 1;
    return g / (c.width * c.height);
  });
  t('trail reveals more than one window', greyAfter < greyBefore, true);
  console.log(`      grey ${(greyBefore * 100).toFixed(1)}% -> ${(greyAfter * 100).toFixed(1)}%`);
  await page.screenshot({ path: path.join(SHOTS, 'mnistpro-trail.png'), fullPage: true });

  // --- one-shot answer -----------------------------------------------------
  await page.click(`#guess-buttons button[data-digit="${ep0.label}"]`);
  await page.waitForSelector('#scoreboard:not([hidden])', { timeout: 10000 });
  t('correct answer wins', await page.$eval('#race-result', (e) => e.textContent), 'YOU WON');
  t('answer recorded', await page.$eval('#result-human .r-answer', (e) => e.textContent), ep0.label);
  t('locked after answering', await page.$eval('#guess-buttons button', (e) => e.disabled), true);
  t('d-pad locked too', await page.$eval('#dp-up', (e) => e.disabled), true);
  console.log('      verdict:', await page.$eval('#verdict-reason', (e) => e.textContent));

  // --- a wrong answer must lose -------------------------------------------
  await page.click('#btn-start');
  await page.waitForFunction(() => document.getElementById('human-veil').hidden, { timeout: 10000 });
  const wrong = (Number(ep0.label) + 1) % 10;
  await page.click(`#guess-buttons button[data-digit="${wrong}"]`);
  await page.waitForSelector('#scoreboard:not([hidden])', { timeout: 10000 });
  t('wrong answer loses', await page.$eval('#race-result', (e) => e.textContent), 'NO WINNER');

  console.log('\nERRORS:', errors.length ? errors.slice(0, 10) : 'none');
  console.log(fails === 0 && errors.length === 0 ? '\nALL CHECKS PASSED' : `\n${fails} check(s) failed`);
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAILED:', e.message); process.exit(1); });
