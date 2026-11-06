// Browser seam for the reading width: the toolbar list, the draft's `width:`, and the print fallback. What only a browser can show
// is the width a page really lays out at, the choice a reader keeps across a reload, and that paper still gets the reading measure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, devtoolsUrl, findChrome } from '../src/video/export.js';
import en from '../src/languages/en.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = findChrome();
const SKIP = process.env.AM_E2E !== '1'
  ? 'set AM_E2E=1 to run the browser width tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const BODY = '## A One\nText.\n\n## B Two\nMore text.\n';
const pages = {
  standard: `---\ntitle: Standard\ntemplate: doc\n---\n\n${BODY}`,
  wide: `---\ntitle: Wide\ntemplate: doc\nwidth: wide\n---\n\n${BODY}`,
  full: `---\ntitle: Full\ntemplate: doc\nwidth: full\n---\n\n${BODY}`,
  pixels: `---\ntitle: Pixels\ntemplate: doc\nwidth: 1400\n---\n\n${BODY}`,
  sheet: `---\ntitle: Sheet\ntemplate: sheet\nwidth: wide\ncols: 2\n---\n\n${BODY}`,
};

let tmp;
let chrome;
let cdp;
let session;

const send = (method, params) => cdp.send(method, params, session);
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page script error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const errors = () => evaluate('window.__errors');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async (file) => {
  const loaded = cdp.once('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(file).href });
  await loaded;
  await sleep(300);
};
// The width the page really lays out at, and what the preset says it should be.
const width = () => evaluate(`Math.round(document.querySelector('.am-doc, .am-sheet').getBoundingClientRect().width)`);
const attr = () => evaluate(`document.documentElement.getAttribute('data-measure')`);

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-width-'));
  for (const [name, source] of Object.entries(pages)) {
    const draft = join(tmp, `${name}.md`);
    writeFileSync(draft, source);
    execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', join(tmp, `${name}.html`), '--no-open'], {
      env: { ...process.env, AM_NO_UPDATE_CHECK: '1', AM_HOME: join(tmp, 'home') }, stdio: 'pipe',
    });
  }
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1600,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = await connect(await devtoolsUrl(chrome));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errors = [];
      addEventListener('error', (e) => window.__errors.push(String(e.message)));
      addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));`,
  });
});

after(async () => {
  cdp?.close();
  if (chrome && chrome.exitCode === null) {
    await new Promise((r) => {
      const timer = setTimeout(r, 3000);
      chrome.once('exit', () => { clearTimeout(timer); r(); });
      chrome.kill();
    });
  }
  try {
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    console.warn(`Could not remove ${tmp}: ${e.message}`);
  }
});

test('width: a draft that says nothing keeps the reading measure', { skip: SKIP, timeout: 60000 }, async () => {
  await open(join(tmp, 'standard.html'));
  assert.equal(await attr(), null, 'no attribute on a page that never asks');
  assert.equal(await width(), 916, 'the doc reading measure');
  assert.equal(await evaluate(`document.querySelector('select[data-am="measure"]').value`), 'standard');
  assert.deepEqual(await errors(), []);
});

test('width: the draft can ask for wide, for full, or for a number of pixels', { skip: SKIP, timeout: 60000 }, async () => {
  await open(join(tmp, 'wide.html'));
  assert.equal(await attr(), 'wide');
  assert.equal(await width(), 1200, 'a doc page widens to 1200, not to the sheet board');
  await open(join(tmp, 'full.html'));
  assert.equal(await attr(), 'full');
  assert.equal(await width(), await evaluate('Math.round(innerWidth)') - 56, 'full is the window, less the gutters');
  await open(join(tmp, 'pixels.html'));
  assert.equal(await attr(), null, 'a pixel width is the variable, not a preset');
  assert.equal(await width(), 1400);
  assert.deepEqual(await errors(), []);
});

test('width: the toolbar list widens the page and remembers the choice per page', { skip: SKIP, timeout: 60000 }, async () => {
  await open(join(tmp, 'standard.html'));
  const before = await width();
  await evaluate(`(() => { const s = document.querySelector('select[data-am="measure"]'); s.value = 'full'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(200);
  const after = await width();
  assert.ok(after > before + 200, `the page grew from ${before} to ${after}`);
  assert.equal(await attr(), 'full');
  assert.equal(await evaluate(`localStorage.getItem('am-measure:' + location.pathname)`), 'full');
  // A reload keeps it, and another page is untouched.
  await open(join(tmp, 'standard.html'));
  assert.equal(await attr(), 'full', 'the reader choice survived the reload');
  assert.equal(await evaluate(`document.querySelector('select[data-am="measure"]').value`), 'full');
  await open(join(tmp, 'wide.html'));
  assert.equal(await attr(), 'wide', 'another page keeps its own width');
  // Back to standard clears the attribute, so the page is as it was rendered.
  await open(join(tmp, 'standard.html'));
  await evaluate(`(() => { const s = document.querySelector('select[data-am="measure"]'); s.value = 'standard'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(150);
  assert.equal(await attr(), null);
  assert.equal(await width(), 916);
  assert.deepEqual(await errors(), []);
});

test('width: a sheet page follows the same presets, and its board widens', { skip: SKIP, timeout: 60000 }, async () => {
  await open(join(tmp, 'sheet.html'));
  assert.equal(await attr(), 'wide');
  // The board is 1680 wide on a wide enough window; here the window is 1600, so the measure is what to check, and the page
  // fills the window rather than sitting at the 1680 default it never reaches anyway.
  assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--am-measure').trim()`), '1680px');
  assert.ok(await width() >= 1500, 'the board is as wide as the window allows');
  assert.deepEqual(await errors(), []);
});

test('width: paper keeps the reading measure whatever the reader chose', { skip: SKIP, timeout: 60000 }, async () => {
  await open(join(tmp, 'standard.html'));
  await evaluate(`(() => { const s = document.querySelector('select[data-am="measure"]'); s.value = 'full'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(200);
  const screen = await width();
  assert.ok(screen > 916);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(300);
  assert.equal(await width(), 916, 'A4 gets the reading measure, not the window');
  await send('Emulation.setEmulatedMedia', { media: '' });
  await sleep(300);
  assert.equal(await width(), screen, 'and the screen choice comes back');
  assert.deepEqual(await errors(), []);
});
