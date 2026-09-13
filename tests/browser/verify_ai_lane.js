// Drive the AI lane with a stubbed fetch, so its behaviour is testable without
// an API key and without spending anything.
//
// The case that matters: a reply that lands *after* the round has ended. That
// produced "Out of steps" together with "Wrong - it answered null" from a model
// that had in fact answered correctly - two states that cannot both be true.
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${got}${ok ? '' : `  (expected ${want})`}`);
  if (!ok) fails += 1;
};

/** Install the stub before any page script runs. */
async function stubModel(page, replies) {
  await page.evaluateOnNewDocument((scripted) => {
    window.__aiCalls = 0;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('openrouter.ai')) return realFetch(input, init);
      const i = window.__aiCalls++;
      const step = scripted[Math.min(i, scripted.length - 1)];
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      return new Response(
        JSON.stringify({ choices: [{
          message: { content: step.content },
          finish_reason: step.finishReason || 'stop',
        }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, replies);
}

const move = (dir) => JSON.stringify({ thought: `going ${dir}`, action: 'move', direction: dir });
const answer = (v, delayMs) => ({
  content: JSON.stringify({ thought: "It's a " + v + '.', action: 'answer', value: v }),
  delayMs,
});

async function openRound(page, replies) {
  await stubModel(page, replies);
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.setItem('arc-race-openrouter-key', 'test-key-not-real'));
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(
    () => document.querySelectorAll('#episode-select option[value]:not([value=""])').length > 0,
    { timeout: 15000 });
  await page.select('#episode-select', 'ep000');
  await page.select('#opponent-select', 'key');
  await page.click('#btn-start');
  await page.waitForFunction(() => document.getElementById('human-veil').hidden, { timeout: 10000 });
}

const read = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const drawn = (page, sel) => page.$eval(sel, (e) =>
  !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length));
const logText = (page) => page.$$eval('#log li', (ls) => ls.map((l) => l.textContent).join(' | '));

(async () => {
  const ep0 = JSON.parse(fs.readFileSync(path.join(DOCS, 'data/mnistpro/episodes/ep000.json'), 'utf8'));
  const right = ep0.label;
  const wrong = String((Number(right) + 1) % 10);
  console.log(`ep000 label is ${right}\n`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];

  // ---------- 1. the model answers correctly ----------
  let page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  console.log('--- 1. two moves then a correct answer ---');
  await openRound(page, [
    { content: move('up') }, { content: move('left') }, answer(right),
  ]);
  await page.waitForFunction(
    () => /Answered|Solved/.test(document.getElementById('ai-state').textContent),
    { timeout: 20000 });
  await sleep(300);
  // renderLane shows 'Solved' for a correct answer, not the raw reason.
  t('AI state', await read(page, '#ai-state'), 'Solved');
  t('AI veil lifts while it plays', await drawn(page, '#ai-veil'), false);
  t('human veil lifts too', await drawn(page, '#human-veil'), false);
  t('AI result is correct', /^Correct/.test(await read(page, '#ai-result')), true);
  t('AI sensing steps', await read(page, '#ai-steps'), 2);
  console.log('      result:', await read(page, '#ai-result'));
  await page.close();

  // ---------- 2. a wrong answer must name the digit, never null ----------
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  console.log('\n--- 2. a wrong answer ---');
  await openRound(page, [{ content: move('up') }, answer(wrong)]);
  await page.waitForFunction(
    () => document.getElementById('ai-result').textContent.trim().length > 0,
    { timeout: 20000 });
  await sleep(300);
  const wrongMsg = await read(page, '#ai-result');
  t('wrong answer reported', /^Wrong/.test(wrongMsg), true);
  t('wrong answer names the digit', wrongMsg.includes(wrong), true);
  t('never reports null', /null/.test(wrongMsg), false);
  console.log('      result:', wrongMsg);
  await page.close();

  // ---------- 3. the regression: a reply landing after STOP ----------
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  console.log('\n--- 3. STOP pressed while a correct answer is in flight ---');
  await openRound(page, [answer(right, 5000)]);   // reply takes 5s
  await sleep(900);
  await page.click('#btn-stop');                   // stop mid-request
  await page.waitForSelector('#scoreboard:not([hidden])', { timeout: 10000 });
  t('lane says stopped, not out of steps', await read(page, '#ai-state'), 'Stopped');
  await sleep(6000);                               // let the late reply land
  const lateMsg = await read(page, '#ai-result');
  t('no verdict from a discarded reply', lateMsg, '');
  t('never claims a null answer', /null/.test(lateMsg), false);
  t('still says stopped afterwards', await read(page, '#ai-state'), 'Stopped');
  t('the discard is logged', /discarded/.test(await logText(page)), true);
  console.log('      result line:', JSON.stringify(lateMsg));
  console.log('      scoreboard :', await read(page, '#race-result'));
  await page.close();

  // ---------- 4. replies that mean the right thing but are formatted badly ----
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  console.log('--- 4. sloppy but unmistakable replies ---');
  const NL = String.fromCharCode(10);
  const fenced = '```json' + NL
    + JSON.stringify({ thought: 'tracing', action: 'Move', direction: 'Right.' }) + NL
    + '```';
  const echoesExample = 'I could do {"action": "move", "direction": "up"} as the prompt shows, '
    + 'but I will instead: '
    + JSON.stringify({ thought: 'following the curve', action: 'move', direction: 'down' });
  await openRound(page, [
    { content: fenced },
    { content: echoesExample },
    { content: JSON.stringify({ thought: 'a loop', action: 'answer', value: "It's a " + right }) },
  ]);
  await page.waitForFunction(
    () => /Solved|Invalid|Out of/.test(document.getElementById('ai-state').textContent),
    { timeout: 25000 });
  await sleep(300);
  // From [130,130]: "Right." then "down" can only land here if both were honoured.
  t('capitalised + punctuated direction honoured', await read(page, '#ai-window'), '160, 160');
  t('example-echoing reply still parsed', await read(page, '#ai-steps'), 2);
  t('answer read out of a sentence', await read(page, '#ai-state'), 'Solved');
  t('no unrecognised-action error', await read(page, '#ai-error'), '');
  console.log('      result:', await read(page, '#ai-result'));
  await page.close();

  // A reply that ran out of budget mid-string: no closing brace, no action.
  const cutOff = '```json {"thought": "the stroke curves around and I am still describing';

  // ---------- 5. truncated once, then fine ----------
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  console.log('--- 5. a truncated reply, then a good one ---');
  await openRound(page, [
    { content: cutOff, finishReason: 'length' },
    { content: JSON.stringify({ thought: 'enough looking', action: 'move', direction: 'up' }) },
    { content: JSON.stringify({ thought: 'a closed loop', action: 'answer', value: right }) },
  ]);
  await page.waitForFunction(
    () => /Solved|Invalid|Out of/.test(document.getElementById('ai-state').textContent),
    { timeout: 30000 });
  await sleep(300);
  t('retry after truncation rescues the round', await read(page, '#ai-state'), 'Solved');
  t('no bogus malformed-reply error', /no usable action/.test(await read(page, '#ai-error')), false);
  console.log('      result:', await read(page, '#ai-result'));
  await page.close();

  // ---------- 6. truncated every time: say which failure it was ----------
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  console.log('--- 6. every reply truncated ---');
  await openRound(page, [{ content: cutOff, finishReason: 'length' }]);
  await page.waitForFunction(
    () => document.getElementById('ai-error').textContent.trim().length > 0,
    { timeout: 40000 });
  await sleep(200);
  const cutMsg = await read(page, '#ai-error');
  t('truncation is named as a budget problem', /token budget/.test(cutMsg), true);
  t('not mislabelled as malformed', /no usable action/.test(cutMsg), false);
  t('the reply itself is shown', /the stroke curves around/.test(cutMsg), true);
  console.log('      error line:', cutMsg.slice(0, 130));
  await page.close();

  console.log('\nERRORS:', errors.length ? errors.slice(0, 8) : 'none');
  console.log(fails === 0 && errors.length === 0 ? '\nALL CHECKS PASSED' : `\n${fails} check(s) failed`);
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAILED:', e.message); process.exit(1); });
