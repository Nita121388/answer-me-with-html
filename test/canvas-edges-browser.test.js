// Browser seam for editing the board's edges: adding one from a node's port, deleting one with the keyboard, renaming one, and
// the Copy edges button that turns the reader's board back into draft lines. All of it is src/runtime/canvas-dom.js, so only a
// browser can check it. Slow and needs Chrome, so it runs only with AM_E2E=1.
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
  ? 'set AM_E2E=1 to run the browser canvas edge tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const DESKTOP = 1440;
const HEIGHT = 1000;
const IDS = ['panel-A', 'panel-B', 'panel-C'];
const STORE = `'am-canvas:' + location.pathname + ':' + ${JSON.stringify(IDS.join(','))}`;

const DRAFT = `---
title: Edge editing
template: canvas
lang: en
---
\`\`\`canvas
A -> B: causes
\`\`\`
Three nodes, one edge at first.

## A Input
The first node.

## B Middle
The second node.

## C Output
The third node, not connected to anything yet.
`;

let tmp;
let chrome;
let cdp;
let session;
let boardFile;

const page = (method, params) => cdp.send(method, params, session);
const evaluate = async (expression) => {
  const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page script error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const mouse = (type, x, y) => page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
const open = async () => {
  const loaded = cdp.once('Page.loadEventFired');
  await page('Page.navigate', { url: pathToFileURL(boardFile).href });
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
  await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))))');
};
// The edges as "from>to: label", in drawing order.
const edges = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-canvas-edge')].map((g) =>
  g.dataset.from + '>' + g.dataset.to + (g.querySelector('.am-canvas-edge-label')?.textContent ? ':' + g.querySelector('.am-canvas-edge-label').textContent : '')))`).then(JSON.parse);
const fresh = async () => {
  await open();
  await evaluate('localStorage.clear()');
  await open();
};
const rectOf = (sel) => evaluate(`(() => {
  const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), l: r.left, t: r.top, w: r.width, h: r.height });
})()`).then(JSON.parse);

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-canvas-edit-'));
  const draft = join(tmp, 'draft.md');
  boardFile = join(tmp, 'board.html');
  writeFileSync(draft, DRAFT);
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', boardFile, '--no-open'], { stdio: 'ignore', env: { ...process.env, AM_HOME: join(tmp, 'home'), AM_NO_UPDATE_CHECK: '1' } });

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
    console.warn(`Could not remove ${tmp}: ${e.message}`);
  }
});

test('canvas edges: the board starts with the draft edge, and every node carries a port', { skip: SKIP, timeout: 60000 }, async () => {
  await fresh();
  assert.deepEqual(await edges(), ['panel-A>panel-B:causes']);
  assert.equal(await evaluate(`document.querySelectorAll('[data-am="canvas-port"]').length`), 3);
  assert.equal(await evaluate(`document.querySelector('[data-am="canvas-copy-edges"]').hidden`), false, 'the copy button shows on a live board');
});

test('canvas edges: dragging from a port to another node adds an edge', { skip: SKIP, timeout: 60000 }, async () => {
  await fresh();
  const port = await rectOf('#panel-A [data-am="canvas-port"]');
  const target = await rectOf('#panel-C .am-panel-head');
  await mouse('mousePressed', port.x, port.y);
  await mouse('mouseMoved', port.x + 20, port.y + 20);
  await mouse('mouseMoved', target.x, target.y);
  const linking = await evaluate(`JSON.stringify({
    attr: document.documentElement.hasAttribute('data-am-linking'),
    line: !!document.querySelector('.am-canvas-link'),
  })`).then(JSON.parse);
  assert.deepEqual(linking, { attr: true, line: true }, 'a dashed line follows the pointer');
  await mouse('mouseReleased', target.x, target.y);
  await new Promise((r) => setTimeout(r, 150));
  const after = await edges();
  assert.ok(after.includes('panel-A>panel-C'), `A -> C was added: ${after.join(' | ')}`);
  assert.equal(await evaluate(`document.documentElement.hasAttribute('data-am-linking')`), false, 'no linking state left');
  assert.equal(await evaluate(`document.querySelectorAll('.am-canvas-link').length`), 0, 'the dashed line is gone');
});

test('canvas edges: a new edge survives a reload, and a duplicate is not added twice', { skip: SKIP, timeout: 60000 }, async () => {
  await fresh();
  const port = await rectOf('#panel-A [data-am="canvas-port"]');
  const target = await rectOf('#panel-C .am-panel-head');
  for (let i = 0; i < 2; i++) {
    await mouse('mousePressed', port.x, port.y);
    await mouse('mouseMoved', port.x + 20, port.y + 20);
    await mouse('mouseMoved', target.x, target.y);
    await mouse('mouseReleased', target.x, target.y);
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.equal((await edges()).filter((e) => e.startsWith('panel-A>panel-C')).length, 1, 'the same edge is not added twice');
  await open();
  assert.ok((await edges()).includes('panel-A>panel-C'), 'the added edge came back after the reload');
});

test('canvas edges: a click selects an edge and Delete removes it', { skip: SKIP, timeout: 60000 }, async () => {
  await fresh();
  const mid = await rectOf('.am-canvas-edge:first-of-type .am-canvas-edge-hit');
  await mouse('mousePressed', mid.x, mid.y);
  await mouse('mouseReleased', mid.x, mid.y);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await evaluate(`document.querySelectorAll('.am-canvas-edge.is-selected').length`), 1, 'the edge is selected');
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await edges(), [], 'the edge is gone');
  await open();
  assert.deepEqual(await edges(), [], 'and it stays gone after a reload');
});

test('canvas edges: a double click renames an edge, and the new label survives a reload', { skip: SKIP, timeout: 60000 }, async () => {
  await fresh();
  const mid = await rectOf('.am-canvas-edge:first-of-type .am-canvas-edge-hit');
  await mouse('mousePressed', mid.x, mid.y);
  await mouse('mouseReleased', mid.x, mid.y);
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 2 });
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', clickCount: 2 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(await evaluate(`!!document.querySelector('.am-canvas-label-input')`), true, 'the label editor opened');
  await evaluate(`(() => {
    const input = document.querySelector('.am-canvas-label-input');
    input.value = 'drives';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await edges(), ['panel-A>panel-B:drives']);
  await open();
  assert.deepEqual(await edges(), ['panel-A>panel-B:drives'], 'the label came back after the reload');
});

test('canvas edges: Copy edges yields the draft fence with panel ids shortened', { skip: SKIP, timeout: 60000 }, async () => {
  await fresh();
  // Read what the button would copy without needing a clipboard permission: the same lines the fence uses.
  const text = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('.am-canvas-edge')].map((g) => {
      const label = g.querySelector('.am-canvas-edge-label')?.textContent;
      const line = g.dataset.from.replace(/^panel-/, '') + ' -> ' + g.dataset.to.replace(/^panel-/, '');
      return label ? line + ': ' + label : line;
    });
    return ['\`\`\`canvas', ...lines, '\`\`\`'].join('\\n');
  })()`);
  assert.equal(text, '```canvas\nA -> B: causes\n```');
});
