// Browser seam for enlarging a picture: a figure's image opens in the same viewer the diagrams use, so a screenshot of a UI can
// be read at 1:1. Only a browser can show the clone, the pan and zoom, the focus that comes back, and that a diagram still opens
// the way it did. Slow and needs Chrome, so it runs only with AM_E2E=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, devtoolsUrl, findChrome } from '../src/video/export.js';
import en from '../src/languages/en.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = findChrome();
const SKIP = process.env.AM_E2E !== '1'
  ? 'set AM_E2E=1 to run the browser picture tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

// A PNG of a solid colour, so the test carries its own picture and needs no fixture: 300 x 200, 8-bit RGB.
function png(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, (_, x) => [40 + (x % 200), 120, 190]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let tmp;
let chrome;
let cdp;
let session;
let page;

const send = (method, params) => cdp.send(method, params, session);
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page script error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const errors = () => evaluate('window.__errors');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The Windows virtual-key code is a number; the key and code stay names, which is what the page reads.
const VK = { Escape: 27, Enter: 13, ' ': 32 };
const key = (name, code = name) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: VK[name] ?? 0 });
const box = async () => JSON.parse(await evaluate(`JSON.stringify({
  open: !document.querySelector('.am-lightbox').hasAttribute('hidden'),
  children: document.querySelector('.am-lightbox-canvas').children.length,
  tag: document.querySelector('.am-lightbox-canvas')?.firstElementChild?.tagName?.toLowerCase() ?? null,
  title: document.querySelector('.am-lightbox-title-text').textContent,
  label: document.querySelector('.am-lightbox').getAttribute('aria-label'),
  overflow: document.body.style.overflow,
  focused: document.activeElement?.localName ?? null,
})`));

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-picture-'));
  const picture = join(tmp, 'shot.png');
  writeFileSync(picture, png(300, 200));
  const draft = join(tmp, 'page.md');
  const out = join(tmp, 'page.html');
  writeFileSync(draft, `---\ntitle: Picture check\nlang: en\n---\n\n## A With a picture\n\n![A screenshot of the settings screen](${picture})\n\n\`\`\`flow\nA -> B\n\`\`\`\n`);
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', out, '--no-open'], {
    env: { ...process.env, AM_NO_UPDATE_CHECK: '1', AM_HOME: join(tmp, 'home') }, stdio: 'pipe',
  });
  page = out;
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = await connect(await devtoolsUrl(chrome));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errors = [];
      addEventListener('error', (e) => window.__errors.push(String(e.message)));
      addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));`,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(page).href });
  await loaded;
  await sleep(400);
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

test('picture: a figure image is a button that opens the viewer at its own pixel size', { skip: SKIP, timeout: 60000 }, async () => {
  // The viewer arrives with the page whenever it holds a picture, even with no diagram to open.
  assert.equal(await evaluate(`!!document.querySelector('.am-lightbox')`), true);
  assert.deepEqual(await evaluate(`(() => { const i = document.querySelector('.am-figure img'); return [i.tabIndex, i.getAttribute('role'), i.getAttribute('aria-label')]; })()`), [0, 'button', en.ui.expandImage]);
  await evaluate(`document.querySelector('.am-figure img').click()`);
  await sleep(250);
  const state = await box();
  assert.equal(state.open, true);
  assert.equal(state.tag, 'img', 'the clone is the picture, not its figure');
  assert.equal(state.children, 1);
  assert.equal(state.title, 'A screenshot of the settings screen', 'the caption names the viewer');
  assert.equal(state.label, en.ui.image, 'the dialog says it holds a picture');
  assert.equal(state.overflow, 'hidden', 'the page behind does not scroll');
  // The clone keeps the picture's own size, so zooming in reaches 1:1 instead of the width the page gave it.
  assert.deepEqual(await evaluate(`(() => { const c = document.querySelector('.am-lightbox-canvas img'); return [c.style.width, c.style.height]; })()`), ['300px', '200px']);
  assert.deepEqual(await errors(), []);
});

test('picture: the wheel zooms it, Escape closes it and the focus comes back', { skip: SKIP, timeout: 60000 }, async () => {
  const before = await evaluate(`getComputedStyle(document.querySelector('.am-lightbox-canvas')).transform`);
  await evaluate(`document.querySelector('.am-lightbox-stage').dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 600, clientY: 400, bubbles: true, cancelable: true }))`);
  await sleep(150);
  const after = await evaluate(`getComputedStyle(document.querySelector('.am-lightbox-canvas')).transform`);
  assert.notEqual(after, before, 'the wheel changes the scale');
  await key('Escape');
  await sleep(200);
  const state = await box();
  assert.equal(state.open, false);
  assert.equal(state.children, 0, 'the clone is dropped, so a big picture is not kept in memory');
  assert.equal(state.overflow, '');
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.am-figure img')`), true, 'the focus returns to the picture');
  assert.deepEqual(await errors(), []);
});

test('picture: Enter opens it, and a click on the backdrop closes it', { skip: SKIP, timeout: 60000 }, async () => {
  await evaluate(`document.querySelector('.am-figure img').focus()`);
  await key('Enter');
  await sleep(250);
  assert.equal((await box()).open, true, 'the keyboard opens the viewer too');
  await evaluate(`document.querySelector('.am-lightbox-backdrop').click()`);
  await sleep(200);
  assert.equal((await box()).open, false);
  assert.deepEqual(await errors(), []);
});

test('picture: a diagram still opens in the same viewer, and the dialog names it as a diagram', { skip: SKIP, timeout: 60000 }, async () => {
  await evaluate(`document.querySelector('.am-diagram-expand').click()`);
  await sleep(300);
  const state = await box();
  assert.equal(state.open, true);
  assert.equal(state.tag, 'svg', 'a diagram is cloned as its svg');
  assert.equal(state.label, en.ui.diagram);
  await key('Escape');
  await sleep(200);
  assert.equal((await box()).open, false);
  assert.deepEqual(await errors(), []);
});
