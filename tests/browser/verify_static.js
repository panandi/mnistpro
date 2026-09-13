// Verify the GitHub Pages build the way a visitor meets it: over http, no
// backend. Exercises the easy tier, the instructions, the hint, and plays the
// FIRST easy puzzle — the one a new player actually lands on — to prove it is
// winnable. Grading is checked in both directions.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8123';
// Resolved from this file, so the suite runs from any checkout.
const DOCS = path.join(__dirname, '..', '..', 'docs');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const TRAIN = path.join(__dirname, '..', '..', 'backend', 'data', 'arc1', 'training');
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

async function paint(page, grid) {
  await page.$eval('#out-rows', (e, v) => { e.value = v; }, String(grid.length));
  await page.$eval('#out-cols', (e, v) => { e.value = v; }, String(grid[0].length));
  await page.click('#btn-resize');
  // Resize keeps existing cells, and the loop below never paints colour 0,
  // so start from a blank grid or leftovers survive into the next answer.
  await page.click('#btn-clear');
  for (let colour = 1; colour < 10; colour += 1) {
    const cells = [];
    for (let r = 0; r < grid.length; r += 1) {
      for (let c = 0; c < grid[0].length; c += 1) if (grid[r][c] === colour) cells.push([r, c]);
    }
    if (!cells.length) continue;
    await page.click(`#palette .swatch.c${colour}`);
    for (const [r, c] of cells) await page.click(`#editor-grid .cell[data-r="${r}"][data-c="${c}"]`);
  }
}

const check = (label, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${got}${ok ? '' : ` (expected ${want})`}`);
  return ok;
};

(async () => {
  const index = JSON.parse(fs.readFileSync(path.join(DOCS, 'data/index.json'), 'utf8'));
  const easy = index.filter((t) => t.tier === 'easy');
  const first = easy[0];
  const answer = JSON.parse(fs.readFileSync(path.join(TRAIN, `${first.id}.json`), 'utf8')).test[0].output;
  console.log(`first easy puzzle: ${first.id} — "${first.hint}" — answer ${answer.length}x${answer[0].length}\n`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1600 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.accept());

  let fails = 0;
  const t = (label, got, want) => { if (!check(label, got, want)) fails += 1; };

  await page.goto(BASE + '/arc.html', { waitUntil: 'networkidle2' });
  await page.waitForFunction(
    () => document.querySelectorAll('#task-select option[value]:not([value=""])').length > 0,
    { timeout: 15000 });

  // --- instructions ---
  t('how-to-play steps shown', await page.$$eval('.howto .steps li', (l) => l.length), 4);
  t('how-to is collapsed by default', await page.$eval('.howto', (e) => e.open), false);
  await page.click('.howto > summary');
  await sleep(150);
  t('how-to opens when clicked', await page.$eval('.howto', (e) => e.open), true);
  await page.click('.howto > summary');
  await sleep(150);
  t('how-to closes again', await page.$eval('.howto', (e) => e.open), false);
  t('guide link present', await page.$$eval('.howto-foot a', (a) => a.length), 1);

  // The model must be named without opening the opponent menu here too.
  const arcModel = await page.$eval('#ai-model', (e) => e.textContent.trim());
  const arcPill = await page.$eval('#mode-pill', (e) => e.textContent.trim());
  t('ARC names the model while solo', /gemini-3\.8-flash/.test(arcModel), true);
  t('ARC pill names the model', /gemini-3\.8-flash/.test(arcPill), true);
  t('ARC solo hides the key row', await page.$eval('#keyrow', (e) =>
    !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)), false);
  console.log(`      model row: "${arcModel}"  pill: "${arcPill}"`);

  // --- difficulty tier ---
  t('difficulty defaults to easy', await page.$eval('#tier-select', (e) => e.value), 'easy');
  t('easy puzzle count', await page.$$eval('#task-select option', (o) => o.length), easy.length);
  t('first puzzle is the easiest', await page.$eval('#task-select', (e) => e.value), first.id);
  console.log('      rules line:', await page.$eval('#attempts-display', (e) => e.textContent));

  await page.select('#tier-select', 'all');
  await sleep(200);
  t('everything tier count', await page.$$eval('#task-select option', (o) => o.length), index.length);
  await page.select('#tier-select', 'easy');
  await sleep(200);
  t('back to easy', await page.$$eval('#task-select option', (o) => o.length), easy.length);

  // --- start the first easy puzzle ---
  t('hint hidden before start', await page.$eval('#btn-hint', (e) => e.hidden), true);
  await page.select('#opponent-select', 'solo');
  await page.click('#btn-start');
  await page.waitForSelector('#examples .pair', { timeout: 15000 });

  t('examples drawn', await page.$$eval('#examples .pair', (p) => p.length), first.train);
  t('hint button offered', await page.$eval('#btn-hint', (e) => e.hidden), false);
  t('hint text still hidden', await page.$eval('#hint-text', (e) => e.hidden), true);
  await page.click('#btn-hint');
  await sleep(150);
  t('hint revealed on click', await page.$eval('#hint-text', (e) => e.hidden), false);
  console.log('      hint says:', await page.$eval('#hint-text', (e) => e.textContent));

  // The editor must open at the ANSWER's shape, not the test input's.
  t('editor rows match answer', await page.$eval('#out-rows', (e) => e.value), String(answer.length));
  t('editor cols match answer', await page.$eval('#out-cols', (e) => e.value), String(answer[0].length));
  t('answer size labelled', await page.$eval('#answer-size', (e) => e.textContent.trim()),
    `Answer is ${answer.length} × ${answer[0].length}`);

  // --- grading, both directions ---
  const wrong = answer.map((r) => r.slice());
  wrong[0][0] = (wrong[0][0] + 1) % 10;
  await paint(page, wrong);
  await page.click('#btn-submit');
  await sleep(400);
  const wrongMsg = await page.$eval('#human-result', (e) => e.textContent.trim());
  t('wrong answer rejected', /Not quite/.test(wrongMsg), true);
  console.log('      ->', wrongMsg);

  await paint(page, answer);
  await page.click('#btn-submit');
  await page.waitForSelector('#scoreboard:not([hidden])', { timeout: 15000 });
  await sleep(400);
  t('right answer accepted', await page.$eval('#human-result', (e) => e.textContent.trim()), 'Correct — solved!');
  t('scoreboard says solved', await page.$eval('#race-result', (e) => e.textContent), 'SOLVED');
  console.log('      time:', await page.$eval('#result-human .r-time', (e) => e.textContent));
  t('editor locked after finish', await page.$eval('#btn-submit', (e) => e.disabled), true);
  await page.screenshot({ path: path.join(SHOTS, 'pages-easy-mode.png'), fullPage: true });

  // --- regression: the puzzle from the bug report, 1x5 in and 20x20 out ---
  await page.goto(BASE + '/arc.html', { waitUntil: 'networkidle2' });
  await page.waitForFunction(
    () => document.querySelectorAll('#task-select option[value]:not([value=""])').length > 0,
    { timeout: 15000 });
  await page.select('#tier-select', 'all');
  await sleep(300);
  const label = await page.$$eval('#task-select option', (opts) =>
    (opts.find((o) => o.value === 'feca6190') || {}).textContent || 'NOT FOUND');
  t('feca6190 advertises its answer size', /answer 20×20/.test(label), true);
  console.log('      dropdown says:', label);
  await page.select('#task-select', 'feca6190');
  await page.select('#opponent-select', 'solo');
  await page.click('#btn-start');
  await page.waitForSelector('#examples .pair', { timeout: 15000 });
  t('feca6190 opens 20 rows', await page.$eval('#out-rows', (e) => e.value), '20');
  t('feca6190 opens 20 cols', await page.$eval('#out-cols', (e) => e.value), '20');
  t('feca6190 draws 400 cells', await page.$$eval('#editor-grid .cell', (c) => c.length), 400);
  console.log('      toolbar says:', await page.$eval('#answer-size', (e) => e.textContent));
  await page.screenshot({ path: path.join(SHOTS, 'pages-answer-size.png'), fullPage: true });

  // --- the guide still loads ---
  await page.goto(BASE + '/guide.html', { waitUntil: 'networkidle2' });
  t('guide loads', await page.title(), 'ARC Race');

  console.log('\nERRORS:', errors.length ? errors.slice(0, 10) : 'none');
  console.log(fails === 0 && errors.length === 0 ? '\nALL CHECKS PASSED' : `\n${fails} check(s) failed`);
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAILED:', e.message); process.exit(1); });
