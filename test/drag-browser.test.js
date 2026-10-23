// Browser seam for moving a panel (sheet pages with `drag: true`). The markup only adds a grip button per panel (src/templates/
// panel.js); everything that makes a move — the ghost, the slot, the stored order, the keyboard path — is src/runtime/drag.js, so
// only a browser can check it. The checks below drive real pointer events through the DevTools protocol, the way a reader's
// mouse does, and then read the panel order back out of the page. Slow and needs Chrome, so it runs only with AM_E2E=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, devtoolsUrl, findChrome } from '../src/video/export.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = findChrome();
const SKIP = process.env.AM_E2E !== '1'
  ? 'set AM_E2E=1 to run the browser drag tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const DESKTOP = 1440;
const HEIGHT = 1000;
const LAYOUT_WAIT_MS = 800; // the page waits 150 ms after a move, then plans and applies (RESIZE_DELAY in layout-dom.js)

const filler = (id, n) => `## ${id} Note ${n}\nThis panel is a plain paragraph. It sits in a row with other panels and wraps over a few lines, so the row has a real height. It is here so the layout has something to balance.\n`;

const DRAFT = `---
title: Drag check
cols: 3
lang: en
drag: true
---
${filler('A', 1)}
${filler('B', 2)}
${filler('C', 3)}
${filler('D', 4)}
`;

const PLAIN = `---
title: No drag
cols: 2
lang: en
---
${filler('A', 1)}
${filler('B', 2)}
`;

let tmp;
let chrome;
let cdp;
let session;
const files = {};

const page = (method, params) => cdp.send(method, params, session);
const evaluate = async (expression) => {
  const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page script error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
// One mouse event at the position. `type` is a raw CDP event name; the page listens for the pointer events it maps to.
const mouse = (type, x, y) => page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
const open = async (file) => {
  const loaded = cdp.once('Page.loadEventFired');
  await page('Page.navigate', { url: pathToFileURL(file).href });
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
  await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))))`);
};
const order = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-grid > .am-panel, .am-grid > .am-col > .am-panel')].map((p) => p.id))`).then(JSON.parse);
const KEY = `['panel-A','panel-B','panel-C','panel-D'].join(',')`;
const stored = () => evaluate(`localStorage.getItem('am-order:' + location.pathname + ':' + ${KEY})`).then((v) => JSON.parse(v ?? 'null'));

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-drag-'));
  const render = (src, name) => {
    const draft = join(tmp, `${name}.md`);
    const out = join(tmp, `${name}.html`);
    writeFileSync(draft, src);
    execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', out, '--no-open'], { stdio: 'ignore' });
    files[name] = out;
  };
  render(DRAFT, 'drag');
  render(PLAIN, 'plain');

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', `--window-size=${DESKTOP},${HEIGHT}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = await connect(await devtoolsUrl(chrome));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await page('Page.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: DESKTOP, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
});

after(async () => {
  cdp?.close();
  if (chrome) {
    await new Promise((r) => {
      if (chrome.exitCode !== null) return r();
      const timer = setTimeout(r, 3000);
      chrome.once('exit', () => { clearTimeout(timer); r(); });
      chrome.kill();
    });
  }
  try {
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    // Chrome helper processes can still write to the profile after the main process exits (#74).
    // A leftover temp directory is not a test failure.
    console.warn(`Could not remove ${tmp}: ${e.message}`);
  }
});

// The grip position of one panel, in page coordinates.
const gripAt = (id) => evaluate(`(() => {
  const g = document.getElementById('${id}').querySelector('[data-am="grip"]');
  const r = g.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width });
})()`).then(JSON.parse);
const panelAt = (id) => evaluate(`(() => {
  const r = document.getElementById('${id}').getBoundingClientRect();
  return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
})()`).then(JSON.parse);

test('drag: every panel of a page with drag has a grip, and a page without drag has none', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.drag);
  assert.equal(await evaluate(`document.querySelectorAll('[data-am="grip"]').length`), 4);
  await open(files.plain);
  assert.equal(await evaluate(`document.querySelectorAll('[data-am="grip"]').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('[data-am="reset-order"]').length`), 0);
});

test('drag: a pointer move puts the panel where it is dropped, and the sheet plans the new order', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.drag);
  const from = await gripAt('panel-A');
  const target = await panelAt('panel-C');
  await mouse('mousePressed', from.x, from.y);
  // Two moves: the first starts the drag, the second carries the ghost over C.
  await mouse('mouseMoved', from.x + 6, from.y + 6);
  await mouse('mouseMoved', target.x + target.w / 2, target.y + target.h / 2);
  const ghosting = await evaluate(`JSON.stringify({
    attr: document.documentElement.hasAttribute('data-am-dragging'),
    ghost: !!document.querySelector('.am-panel--moving'),
    slot: !!document.querySelector('.am-drop-slot'),
  })`).then(JSON.parse);
  assert.deepEqual(ghosting, { attr: true, ghost: true, slot: true }, 'the drag shows a ghost and a slot');
  await mouse('mouseReleased', target.x + target.w / 2, target.y + target.h / 2);
  await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
  const after = await order();
  assert.equal(after.indexOf('panel-A'), 2, `A moved to C's place; order is ${after.join(' ')}`);
  assert.equal(await evaluate(`document.documentElement.hasAttribute('data-am-dragging')`), false, 'no drag left behind');
  // The stored order is what the reader now sees, and the toolbar button that can undo it is visible.
  assert.ok(await stored(), 'the order is stored');
  assert.equal(await evaluate(`document.querySelector('[data-am="reset-order"]').hidden`), false);
});

test('drag: the order survives a reload, and the reset button puts the page back', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.drag);
  await evaluate(`localStorage.setItem('am-order:' + location.pathname + ':' + ['panel-A','panel-B','panel-C','panel-D'].join(','), JSON.stringify(['panel-B','panel-A','panel-C','panel-D']))`);
  await open(files.drag);
  assert.deepEqual(await order(), ['panel-B', 'panel-A', 'panel-C', 'panel-D'], 'the stored order came back');
  await evaluate(`document.querySelector('[data-am="reset-order"]').click()`);
  await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
  assert.deepEqual(await order(), ['panel-A', 'panel-B', 'panel-C', 'panel-D'], 'the reset put the page back');
  assert.equal(await stored(), null, 'the stored order is gone');
});

test('drag: Escape during a move cancels it and nothing is stored', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.drag);
  await evaluate(`localStorage.removeItem('am-order:' + location.pathname + ':' + ['panel-A','panel-B','panel-C','panel-D'].join(','))`);
  await open(files.drag);
  const from = await gripAt('panel-A');
  const target = await panelAt('panel-D');
  await mouse('mousePressed', from.x, from.y);
  await mouse('mouseMoved', from.x + 6, from.y + 6);
  await mouse('mouseMoved', target.x + target.w / 2, target.y + target.h / 2);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
  assert.deepEqual(await order(), ['panel-A', 'panel-B', 'panel-C', 'panel-D'], 'the order is unchanged');
  assert.equal(await evaluate(`document.querySelector('.am-drop-slot') !== null`), false, 'no slot left behind');
  assert.equal(await stored(), null, 'nothing stored');
});

test('drag: the keyboard moves a panel too, and the width is still the planner work', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.drag);
  const focus = () => evaluate(`document.getElementById('panel-A').querySelector('[data-am="grip"]').focus()`);
  await focus();
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
  await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
  const after = await order();
  assert.deepEqual(after, ['panel-B', 'panel-A', 'panel-C', 'panel-D'], `A moved down: ${after.join(' ')}`);
  assert.ok(await stored(), 'the keyboard move is stored as well');
  // A moved panel keeps the width the planner gives it: no inline width left over from the drag (the layout adapter sets the
  // widths itself, so a width is fine; what matters is that the drag's own style never survives it).
  assert.equal(await evaluate(`document.getElementById('panel-A').style.position`), '', 'no drag style left behind');
  assert.equal(await evaluate(`document.getElementById('panel-A').style.zIndex`), '', 'no ghost z-index left behind');
  assert.equal(await evaluate(`document.getElementById('panel-A').classList.contains('am-panel--moving')`), false, 'not marked as moving');
  // And the sheet really did plan: the grid is the justified flexbox, not the plain CSS grid.
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.am-grid')).display`), 'flex');
});
