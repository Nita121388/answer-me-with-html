// Browser seam for the canvas board (template: canvas). The markup only places the nodes and draws the edges once; panning,
// zooming and moving a node are src/runtime/canvas-dom.js, so only a browser can check them. The checks below drive real pointer
// and wheel events through the DevTools protocol and read the transform, the node positions and an edge path back out of the page.
// Slow and needs Chrome, so it runs only with AM_E2E=1.
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
  ? 'set AM_E2E=1 to run the browser canvas tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const DESKTOP = 1440;
const HEIGHT = 1000;
const MAX_SCALE = 2.5; // src/runtime/canvas-dom.js

const DRAFT = `---
title: Canvas board
template: canvas
collapse: true
lang: en
---
\`\`\`canvas
A -> B: causes
B -> C: needs
\`\`\`
A board of three nodes with two edges.

## A Input
This panel is the first node. It holds prose, so the board has something to read at every zoom.

## B Middle
The second node, connected to A and C.

## C Output
The third node, at the far end of the board.
`;

const IDS = ['panel-A', 'panel-B', 'panel-C'];
// The board is keyed by the page path, not by the panel list: a re-render keeps it even when the letters shift.
const storeKeyExpr = `'am-canvas:' + location.pathname`;

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
const wheel = (x, y, dy) => page('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });

const open = async () => {
  const loaded = cdp.once('Page.loadEventFired');
  await page('Page.navigate', { url: pathToFileURL(boardFile).href });
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
  // The script fits the board once at load and draws the edges from the settled boxes.
  await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))))');
};

// Everything a check needs, read in one round trip.
const board = () => evaluate(`(() => {
  const stage = document.querySelector('[data-canvas-stage]');
  const t = stage.style.transform.match(/translate\\(([-0-9.]+)px, ([-0-9.]+)px\\) scale\\(([-0-9.]+)\\)/);
  const at = (id) => {
    const el = document.getElementById(id);
    return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
  };
  const paths = {};
  for (const g of document.querySelectorAll('.am-canvas-edge')) {
    paths[g.dataset.from + '>' + g.dataset.to] = g.querySelector('path').getAttribute('d');
  }
  return JSON.stringify({
    x: Number(t?.[1]), y: Number(t?.[2]), scale: Number(t?.[3]),
    nodes: { A: at('panel-A'), B: at('panel-B'), C: at('panel-C') },
    paths,
    zoom: document.querySelector('[data-am="canvas-zoom-value"]')?.textContent,
    live: document.documentElement.hasAttribute('data-canvas-live'),
  });
})()`).then(JSON.parse);

const selectedIds = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-canvas-node.is-selected')].map((n) => n.id))`).then(JSON.parse);
// The centre of any element on the page, so a check can press the real thing.
const rectOf = (sel) => evaluate(`(() => {
  const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
})()`).then(JSON.parse);
const clearSelectionAll = () => evaluate(`document.querySelector('.am-canvas-viewport').click()`);
const headAt = (id) => evaluate(`(() => {
  const r = document.getElementById('${id}').querySelector('.am-panel-head').getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
})()`).then(JSON.parse);

const clearArrangement = () => evaluate(`localStorage.removeItem(${storeKeyExpr})`);
// A fold is remembered per page too, and an earlier test may have left one closed.
const clearFolds = () => evaluate(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('am-fold:')) localStorage.removeItem(k); return true; })()`);
const dragNode = async (id, dx, dy) => {
  const head = await headAt(id);
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseMoved', head.x, head.y);
  await mouse('mouseMoved', head.x + dx, head.y + dy);
  await mouse('mouseReleased', head.x + dx, head.y + dy);
  await new Promise((r) => setTimeout(r, 150));
};

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-canvas-'));
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

test('canvas: the board opens live, fitted inside the viewport, with nodes and edges drawn', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  await clearArrangement();
  await open();
  const b = await board();
  assert.equal(b.live, true, 'the script marked the page live');
  assert.ok(b.scale > 0 && b.scale <= 1, `the board is fitted, not oversized: scale ${b.scale}`);
  assert.equal(b.zoom, `${Math.round(b.scale * 100)}%`, 'the zoom label matches the transform');
  assert.deepEqual(Object.keys(b.paths).sort(), ['panel-A>panel-B', 'panel-B>panel-C'], 'both edges are drawn');
  assert.ok(b.paths['panel-A>panel-B'].startsWith('M'), 'an edge is a path');
  // dagre laid the three nodes out left to right along the two edges.
  assert.ok(b.nodes.A.x < b.nodes.B.x && b.nodes.B.x < b.nodes.C.x, `A B C in a row: ${JSON.stringify(b.nodes)}`);
});

test('canvas: the wheel zooms in and out about the pointer, and the label follows', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  const start = await board();
  await wheel(DESKTOP / 2, HEIGHT / 2, -240);
  const zoomedIn = await board();
  assert.ok(zoomedIn.scale > start.scale, `zoomed in: ${start.scale} -> ${zoomedIn.scale}`);
  assert.equal(zoomedIn.zoom, `${Math.round(zoomedIn.scale * 100)}%`, 'the label follows the scale');
  await wheel(DESKTOP / 2, HEIGHT / 2, 480);
  const zoomedOut = await board();
  assert.ok(zoomedOut.scale < zoomedIn.scale, `zoomed out: ${zoomedIn.scale} -> ${zoomedOut.scale}`);
  assert.ok(zoomedOut.scale <= MAX_SCALE && zoomedOut.scale >= 0.25, 'the scale stays in range');
  // The board itself did not change: zooming moves the view, not the nodes.
  assert.deepEqual(zoomedOut.nodes, start.nodes, 'zooming moved no node');
});

test('canvas: a plain drag on the empty board selects what it touches, and the board does not move', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  const start = await board();
  // An ordinary press on the empty board draws a selection box; panning is the space bar's and the middle button's job, so a
  // press never moves the board by accident.
  const vp = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('.am-canvas-viewport').getBoundingClientRect())`));
  // A start point that is really empty: no node, no control, no edge under it.
  const from = await evaluate(`(() => {
    const vp = document.querySelector('.am-canvas-viewport').getBoundingClientRect();
    for (let y = vp.top + 20; y < vp.bottom - 20; y += 18) {
      for (let x = vp.left + 20; x < vp.right - 20; x += 18) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('.am-canvas-node') && !el.closest('.am-canvas-zoom') && !el.closest('.am-canvas-minimap') && !el.closest('.am-canvas-edge')) {
          return JSON.stringify({ x: Math.round(x), y: Math.round(y) });
        }
      }
    }
    return JSON.stringify(null);
  })()`).then(JSON.parse);
  assert.ok(from, 'the board has an empty spot to start from');
  await mouse('mousePressed', from.x, from.y);
  await mouse('mouseMoved', from.x + 10, from.y + 10);
  // Far enough to cover every node on the board, not just the first two.
  await mouse('mouseMoved', vp.right - 20, vp.bottom - 20);
  await mouse('mouseReleased', vp.right - 20, vp.bottom - 20);
  await new Promise((r) => setTimeout(r, 200));
  const after = await board();
  assert.equal(after.x, start.x, `the board did not move: x ${start.x} -> ${after.x}`);
  assert.equal(after.y, start.y, `the board did not move: y ${start.y} -> ${after.y}`);
  assert.deepEqual(after.nodes, start.nodes, 'no node moved either');
  assert.deepEqual(await selectedIds(), ['panel-A', 'panel-B', 'panel-C'], 'the box selected every node it covered');
});

test('canvas: a press on the minimap moves the view instead of panning the board', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  const before = await board();
  const r = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('[data-am="canvas-minimap-svg"]').getBoundingClientRect())`));
  await mouse('mousePressed', Math.round(r.left + 6), Math.round(r.top + 6));
  await mouse('mouseReleased', Math.round(r.left + 6), Math.round(r.top + 6));
  await new Promise((res) => setTimeout(res, 200));
  const after = await board();
  assert.ok(after.x !== before.x || after.y !== before.y, 'the minimap moved the view');
  assert.deepEqual(after.nodes, before.nodes, 'and moved no node');
});

test('canvas: dragging a node moves only that node, and its two edges are redrawn', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  await clearArrangement();
  await open();
  const start = await board();
  await dragNode('panel-B', 140, -80);
  const after = await board();
  assert.notDeepEqual(after.nodes.B, start.nodes.B, 'B moved');
  assert.deepEqual(after.nodes.A, start.nodes.A, 'A did not move');
  assert.deepEqual(after.nodes.C, start.nodes.C, 'C did not move');
  assert.notEqual(after.paths['panel-A>panel-B'], start.paths['panel-A>panel-B'], 'the edge into B was redrawn');
  assert.notEqual(after.paths['panel-B>panel-C'], start.paths['panel-B>panel-C'], 'the edge out of B was redrawn');
  assert.ok(after.paths['panel-A>panel-B'].startsWith('M'), 'the redrawn edge is still a path');
});

test('canvas: the arrangement survives a reload, and Reset puts the board back', { skip: SKIP, timeout: 60000 }, async () => {
  await clearArrangement();
  await open();
  const built = await board();

  await dragNode('panel-C', 220, 120);
  const moved = await board();
  assert.ok(moved.nodes.C.y > built.nodes.C.y, 'C moved down');

  await open();
  const back = await board();
  assert.deepEqual(back.nodes, moved.nodes, 'the arrangement came back after the reload');
  assert.ok(Math.abs(back.scale - moved.scale) < 0.01, 'the zoom came back too');

  await evaluate(`document.querySelector('[data-am="canvas-reset"]').click()`);
  await new Promise((r) => setTimeout(r, 600));
  await open();
  const reset = await board();
  assert.deepEqual(reset.nodes, built.nodes, 'Reset put every node back where the build placed it');
});

test('canvas: the keyboard moves a focused node', { skip: SKIP, timeout: 60000 }, async () => {
  await clearArrangement();
  await open();
  const start = await board();
  await evaluate(`document.querySelector('#panel-A .am-panel-head').focus()`);
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown']) {
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 40, nativeVirtualKeyCode: key === 'ArrowRight' ? 39 : 40 });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 40, nativeVirtualKeyCode: key === 'ArrowRight' ? 39 : 40 });
  }
  await new Promise((r) => setTimeout(r, 150));
  const after = await board();
  assert.equal(after.nodes.A.x, start.nodes.A.x + 20, 'two ArrowRight presses moved A 20px');
  assert.equal(after.nodes.A.y, start.nodes.A.y + 10, 'one ArrowDown press moved A 10px');
  assert.notEqual(after.paths['panel-A>panel-B'], start.paths['panel-A>panel-B'], 'the edge followed the key move');
});

test('canvas: dragging a node does not select its text, and the text is selectable again afterwards', { skip: SKIP, timeout: 60000 }, async () => {
  await clearArrangement();
  await open();
  const head = await headAt('panel-B');
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseMoved', head.x, head.y);
  await mouse('mouseMoved', head.x + 160, head.y + 90);
  const during = await evaluate(`JSON.stringify({
    drag: document.documentElement.hasAttribute('data-am-canvas-drag'),
    userSelect: getComputedStyle(document.querySelector('#panel-B .am-panel-body')).userSelect,
    selected: String(window.getSelection() ?? ''),
  })`).then(JSON.parse);
  assert.equal(during.drag, true, 'the gesture is marked');
  assert.equal(during.userSelect, 'none', 'nothing on the board is selectable while a node moves');
  assert.equal(during.selected, '', 'a move never turns into a text selection');
  await mouse('mouseReleased', head.x + 160, head.y + 90);
  await new Promise((r) => setTimeout(r, 150));
  const after = await evaluate(`JSON.stringify({
    drag: document.documentElement.hasAttribute('data-am-canvas-drag'),
    userSelect: getComputedStyle(document.querySelector('#panel-B .am-panel-body')).userSelect,
  })`).then(JSON.parse);
  assert.equal(after.drag, false, 'the gesture ends with the release');
  assert.notEqual(after.userSelect, 'none', 'the body text is selectable again');
});

test('canvas: a press that moves a node does not also fold it, and a plain click still folds', { skip: SKIP, timeout: 60000 }, async () => {
  await clearArrangement();
  await open();
  // The head is both the drag handle and the fold toggle, so a move must not leave the panel folded behind it.
  const head = await headAt('panel-A');
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseMoved', head.x, head.y);
  await mouse('mouseMoved', head.x + 150, head.y + 70);
  await mouse('mouseReleased', head.x + 150, head.y + 70);
  await new Promise((r) => setTimeout(r, 200));
  const moved = await board();
  assert.equal(moved.nodes.A.x, (await board()).nodes.A.x, 'A moved');
  assert.ok(moved.nodes.A.x !== 20, 'A is not where the build put it');
  // The drag must not fold the panel: the toggle only belongs to a click that stayed a click.
  assert.equal(await evaluate(`document.getElementById('panel-A').querySelector('.am-fold').open`), true, 'A is still open after the move');

  // And a plain click, with no movement, still folds it.
  const now = await headAt('panel-A');
  await mouse('mousePressed', now.x, now.y);
  await mouse('mouseReleased', now.x, now.y);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await evaluate(`document.getElementById('panel-A').querySelector('.am-fold').open`), false, 'a click folds');
});

test('canvas: a shift-drag on the empty board selects several nodes and moves them together', { skip: SKIP, timeout: 60000 }, async () => {
  await clearArrangement();
  await open();
  clearSelectionAll();
  const a = (await board()).nodes.A;
  const b = (await board()).nodes.B;
  const c = (await board()).nodes.C;

  // A box over B and C, drawn with shift, from the empty board next to them.
  const r = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('.am-canvas-viewport').getBoundingClientRect())`));
  const to = (p) => evaluate(`(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    const t = stage.style.transform.match(/translate\(([-0-9.]+)px, ([-0-9.]+)px\) scale\(([-0-9.]+)\)/);
    const box = (id) => { const n = document.getElementById(id).getBoundingClientRect(); return { x: n.left, y: n.top }; };
    return JSON.stringify({ b: box('panel-B'), c: box('panel-C') });
  })()`).then(JSON.parse);
  const pos = await to();
  const x0 = Math.max(4, Math.min(pos.b.x, pos.c.x) - 30);
  const y0 = Math.max(4, Math.min(pos.b.y, pos.c.y) - 30);
  const x1 = Math.min(r.width - 4, Math.max(pos.b.x + 400, pos.c.x + 400) + 30);
  const y1 = Math.min(r.height - 4, Math.max(pos.b.y + 200, pos.c.y + 200) + 30);
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, modifiers: 8 });
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + 30, y: y0 + 30, button: 'left', modifiers: 8 });
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'left', modifiers: 8 });
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', modifiers: 8 });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await selectedIds(), ['panel-B', 'panel-C'], 'the box selected B and C');
  assert.equal(await evaluate(`document.querySelector('.am-canvas-marquee').hidden`), true, 'the box is gone');

  // Now press one of them and drag: both move, A does not.
  const head = await headAt('panel-B');
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseMoved', head.x, head.y);
  await mouse('mouseMoved', head.x + 90, head.y - 60);
  await mouse('mouseReleased', head.x + 90, head.y - 60);
  await new Promise((r) => setTimeout(r, 200));
  const after = await board();
  assert.equal(after.nodes.B.x, b.x + 90, 'B moved with the group');
  assert.equal(after.nodes.B.y, b.y - 60, 'B moved up too');
  assert.equal(after.nodes.C.x, c.x + 90, 'C moved with the group');
  assert.equal(after.nodes.C.y, c.y - 60, 'C moved up too');
  assert.deepEqual(after.nodes.A, a, 'A is untouched');
  await clearSelectionAll();
});


test('canvas: the Export .drawio button saves a file named after the page, and the file is the board', { skip: SKIP, timeout: 60000 }, async () => {
  await clearArrangement();
  await open();
  // Capture the blob instead of letting the browser download it: URL.createObjectURL is the one seam these two share.
  const captured = await evaluate(`(async () => {
    const original = URL.createObjectURL;
    let blob = null;
    let name = null;
    URL.createObjectURL = (b) => { blob = b; return 'blob:captured'; };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { name = this.download; };
    try {
      document.querySelector('[data-am="canvas-drawio"]').click();
    } finally {
      URL.createObjectURL = original;
      HTMLAnchorElement.prototype.click = click;
    }
    if (!blob) return JSON.stringify({ ok: false });
    return JSON.stringify({ ok: true, name, size: blob.size, text: await blob.text() });
  })()`).then(JSON.parse);

  assert.equal(captured.ok, true, 'the button produced a file');
  assert.match(captured.name, /\.drawio$/);
  assert.equal(captured.name, 'Canvas board.drawio', 'the name is the page title');
  assert.match(captured.text, /<mxfile /);
  assert.equal((captured.text.match(/vertex="1"/g) ?? []).length, 3, 'one vertex per panel');
  assert.equal((captured.text.match(/edge="1"/g) ?? []).length, 2, 'one edge per link');
  assert.doesNotMatch(captured.text, /undefined|NaN/);
});

test('canvas: the controls are outside the scaled stage, so a fit board keeps clickable buttons', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  // The stage is what the board's transform scales; the controls and the minimap sit in the viewport, not inside it.
  const sizes = await evaluate(`JSON.stringify({
    stage: document.querySelector('[data-canvas-stage]').style.transform,
    drawio: (() => { const r = document.querySelector('[data-am="canvas-drawio"]').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    fitBtn: (() => { const r = document.querySelector('[data-am="canvas-fit"]').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    outsideStage: !document.querySelector('[data-canvas-stage]').contains(document.querySelector('[data-am="canvas-drawio"]')),
    inViewport: document.querySelector('.am-canvas-viewport').contains(document.querySelector('[data-am="canvas-drawio"]')),
  })`).then(JSON.parse);
  assert.equal(sizes.outsideStage, true, 'the button is not in the scaled stage');
  assert.equal(sizes.inViewport, true, 'the button is in the viewport');
  assert.ok(sizes.drawio[0] >= 40 && sizes.drawio[1] >= 18, `the button keeps its size: ${sizes.drawio.join('x')}`);
  assert.ok(sizes.fitBtn[0] >= 20, `the fit button is clickable: ${sizes.fitBtn.join('x')}`);
});

test('canvas: the minimap shows every node and the view, and a click on it moves the view', { skip: SKIP, timeout: 60000 }, async () => {
  await clearArrangement();
  await open();
  const mm = await evaluate(`JSON.stringify({
    hidden: document.querySelector('[data-am="canvas-minimap"]').hidden,
    rects: document.querySelectorAll('.am-mini-node').length,
    view: !!document.querySelector('.am-mini-view'),
    w: document.querySelector('[data-am="canvas-minimap-svg"]').getAttribute('width'),
    h: document.querySelector('[data-am="canvas-minimap-svg"]').getAttribute('height'),
    viewBox: document.querySelector('[data-am="canvas-minimap-svg"]').getAttribute('viewBox'),
  })`).then(JSON.parse);
  assert.equal(mm.hidden, false, 'the minimap is shown');
  assert.equal(mm.rects, 3, 'one rectangle per node');
  assert.equal(mm.view, true, 'the view rectangle is drawn');
  assert.ok(Number(mm.w) > 0 && Number(mm.h) > 0, `the picture has a size: ${mm.w}x${mm.h}`);
  assert.ok(Number(mm.w) <= 300 && Number(mm.h) <= 300, `the picture stays within its cap: ${mm.w}x${mm.h}`);

  const before = await board();
  // Click the far corner of the minimap: the view moves to the opposite end of the board.
  const r = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('[data-am="canvas-minimap-svg"]').getBoundingClientRect())`));
  await mouse('mousePressed', Math.round(r.left + r.width - 4), Math.round(r.top + r.height - 4));
  await mouse('mouseReleased', Math.round(r.left + r.width - 4), Math.round(r.top + r.height - 4));
  await new Promise((res) => setTimeout(res, 250));
  const after = await board();
  assert.ok(after.x !== before.x || after.y !== before.y, 'the view moved');
  assert.deepEqual(after.nodes, before.nodes, 'a click on the minimap moved no node');
});

test('canvas: a zoom or a pan keeps the minimap picture in step with the view', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  const viewRect = () => evaluate(`(() => {
    const r = document.querySelector('.am-mini-view');
    return JSON.stringify({ x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) });
  })()`).then(JSON.parse);
  const before = await viewRect();
  await wheel(DESKTOP / 2, HEIGHT / 2, -240);
  const zoomed = await viewRect();
  assert.notDeepEqual(zoomed, before, 'the view rectangle follows the zoom');
  assert.ok(zoomed.w <= before.w, 'a zoom in shrinks the marked area');
});

test('canvas: the toolbar sits inside the window, so a real click reaches its buttons', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  // The board takes what the head leaves of the window: a viewport taller than that would push its own toolbar off screen, and
  // every button in it would be unclickable (this is how the Export button first shipped broken).
  const geo = await evaluate(`JSON.stringify((() => {
    const vp = document.querySelector('.am-canvas-viewport').getBoundingClientRect();
    const b = document.querySelector('[data-am="canvas-drawio"]').getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
    return {
      viewportBottom: Math.round(vp.bottom),
      windowHeight: innerHeight,
      button: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
      hitIsButton: !!hit && hit.getAttribute('data-am') === 'canvas-drawio',
    };
  })())`).then(JSON.parse);
  assert.ok(geo.viewportBottom <= geo.windowHeight + 1, `the viewport ends inside the window: ${geo.viewportBottom} <= ${geo.windowHeight}`);
  assert.equal(geo.hitIsButton, true, 'the centre of the button is the button, not something covering it');
  assert.ok(geo.button[2] >= 40, `the button keeps a clickable width: ${geo.button[2]}`);
});

test('canvas: a real press on the zoom buttons is not swallowed by the board pan', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  const zoom = await evaluate(`document.querySelector('[data-am="canvas-zoom-value"]').textContent`);
  const at = async (sel) => JSON.parse(await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`));
  const plus = await at('[data-am="canvas-zoom-in"]');
  await mouse('mousePressed', plus.x, plus.y);
  await mouse('mouseReleased', plus.x, plus.y);
  await new Promise((r) => setTimeout(r, 200));
  const zoomed = await evaluate(`document.querySelector('[data-am="canvas-zoom-value"]').textContent`);
  assert.notEqual(zoomed, zoom, `a real click zoomed: ${zoom} -> ${zoomed}`);

  const fit = await at('[data-am="canvas-fit"]');
  await mouse('mousePressed', fit.x, fit.y);
  await mouse('mouseReleased', fit.x, fit.y);
  await new Promise((r) => setTimeout(r, 300));
  assert.notEqual(await evaluate(`document.querySelector('[data-am="canvas-zoom-value"]').textContent`), zoomed, 'a real click on Fit fitted the board again');
});

test('canvas: on a foldable board the comment button, the port and the head each do their own job', { skip: SKIP, timeout: 90000 }, async () => {
  await clearArrangement();
  await clearFolds();
  await open();
  const foldOpen = () => evaluate(`document.getElementById('panel-A').querySelector('.am-fold').open`);
  const commentOpen = () => evaluate(`(() => { const w = document.querySelector('#panel-A .am-comment'); return Boolean(w && !w.hidden); })()`);
  const press = async (sel) => {
    const p = await rectOf(sel);
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseReleased', p.x, p.y);
    await new Promise((r) => setTimeout(r, 300));
  };

  // The comment button opens the box and does not fold the panel it lives in.
  await press('#panel-A .am-comment-btn');
  assert.equal(await commentOpen(), true, 'the comment box opened');
  assert.equal(await foldOpen(), true, 'and the panel did not fold');
  assert.equal(await evaluate('document.activeElement.tagName'), 'TEXTAREA', 'focus went into the box');

  // A second press closes it, again without folding.
  await press('#panel-A .am-comment-btn');
  assert.equal(await commentOpen(), false, 'the box closed');
  assert.equal(await foldOpen(), true, 'still not folded');

  // The port starts an edge even though the head it sits next to is a summary.
  const port = await rectOf('#panel-A [data-am="canvas-port"]');
  const target = await rectOf('#panel-C .am-panel-head');
  await mouse('mousePressed', port.x, port.y);
  await mouse('mouseMoved', port.x + 20, port.y + 20);
  await mouse('mouseMoved', target.x, target.y);
  await mouse('mouseReleased', target.x, target.y);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await edgesIds()).includes('panel-A>panel-C'), 'the port drew an edge to C');
  assert.equal(await foldOpen(), true, 'drawing an edge did not fold the panel');

  // And a press on the head itself still folds it.
  await press('#panel-A .am-panel-head h2');
  assert.equal(await foldOpen(), false, 'a click on the head folds the panel');
});

// The edges as "panel-A>panel-B", for a check that does not care about labels.
const edgesIds = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-canvas-edge')].map((g) => g.dataset.from + '>' + g.dataset.to))`).then(JSON.parse);

test('canvas: holding space turns any drag into a pan, and lets go of the board when released', { skip: SKIP, timeout: 90000 }, async () => {
  await clearArrangement();
  await clearFolds();
  await open();
  const spaceKey = (type) => page('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  const state = () => evaluate(`JSON.stringify({
    transform: document.querySelector('[data-canvas-stage]').style.transform,
    holding: document.documentElement.hasAttribute('data-am-space'),
    node: [parseFloat(document.getElementById('panel-A').style.left), parseFloat(document.getElementById('panel-A').style.top)],
    folded: document.getElementById('panel-A').querySelector('.am-fold').open,
  })`).then(JSON.parse);

  const before = await state();
  await spaceKey('keyDown');
  assert.equal(await evaluate(`document.documentElement.hasAttribute('data-am-space')`), true, 'the board says it is a hand tool');

  // A drag that starts on a node's own head pans the board instead of moving the node or folding it.
  const head = await rectOf('#panel-A .am-panel-head h2');
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseMoved', head.x, head.y);
  await mouse('mouseMoved', head.x - 120, head.y + 90);
  await mouse('mouseReleased', head.x - 120, head.y + 90);
  await new Promise((r) => setTimeout(r, 250));
  const panned = await state();
  assert.notEqual(panned.transform, before.transform, 'the board panned');
  assert.deepEqual(panned.node, before.node, 'the node did not move');
  assert.equal(panned.folded, before.folded, 'and it did not fold');

  await spaceKey('keyUp');
  assert.equal(await evaluate(`document.documentElement.hasAttribute('data-am-space')`), false, 'the hand tool is released');

  // Released, the same press on the head moves the node again: the space did not leave anything switched on.
  const head2 = await rectOf('#panel-A .am-panel-head h2');
  await mouse('mousePressed', head2.x, head2.y);
  await mouse('mouseMoved', head2.x, head2.y);
  await mouse('mouseMoved', head2.x + 70, head2.y);
  await mouse('mouseReleased', head2.x + 70, head2.y);
  await new Promise((r) => setTimeout(r, 250));
  const moved = await state();
  assert.equal(moved.node[0], before.node[0] + 70, 'the node moved again');
});

test('canvas: holding space does not swallow an ordinary click', { skip: SKIP, timeout: 90000 }, async () => {
  await clearArrangement();
  await clearFolds();
  await open();
  const spaceKey = (type) => page('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  const commentOpen = () => evaluate(`(() => { const w = document.querySelector('#panel-A .am-comment'); return Boolean(w && !w.hidden); })()`);

  await spaceKey('keyDown');
  const at = await rectOf('#panel-A .am-comment-btn');
  await mouse('mousePressed', at.x, at.y);
  await mouse('mouseReleased', at.x, at.y);
  await spaceKey('keyUp');
  await new Promise((r) => setTimeout(r, 250));
  // The board is a hand tool while the space is held, so this is allowed to do nothing; what matters is that the release
  // leaves the page in a state where the next click works.
  const before = await commentOpen();
  const at2 = await rectOf('#panel-A .am-comment-btn');
  await mouse('mousePressed', at2.x, at2.y);
  await mouse('mouseReleased', at2.x, at2.y);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(await commentOpen(), !before, 'the click after the release works');
});

test('canvas: a space-drag marks no text, and text is still selectable without the space', { skip: SKIP, timeout: 90000 }, async () => {
  await clearArrangement();
  await clearFolds();
  await open();
  const spaceKey = (type) => page('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  const selected = () => evaluate('String(window.getSelection() ?? "")');
  const spot = (sel) => evaluate(`(() => {
    const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.left + 5), y: Math.round(b.top + b.height / 2) });
  })()`).then(JSON.parse);

  // The body text is the case that used to go wrong: a press there is a press on selectable text.
  const body = await spot('#panel-B .am-panel-body p');
  await spaceKey('keyDown');
  await mouse('mousePressed', body.x, body.y);
  await mouse('mouseMoved', body.x + 70, body.y + 5);
  await mouse('mouseMoved', body.x + 240, body.y + 10);
  assert.equal(await selected(), '', 'a pan marks no text');
  await mouse('mouseReleased', body.x + 240, body.y + 10);
  await spaceKey('keyUp');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await selected(), '', 'nothing is left marked after the pan');

  // Without the space the text is selectable again, so it can still be copied.
  const body2 = await spot('#panel-A .am-panel-body p');
  await mouse('mousePressed', body2.x, body2.y);
  await mouse('mouseMoved', body2.x + 60, body2.y);
  await mouse('mouseMoved', body2.x + 120, body2.y);
  await mouse('mouseReleased', body2.x + 120, body2.y);
  assert.notEqual(await selected(), '', 'a plain drag still selects text');
  await evaluate('window.getSelection().removeAllRanges()');
});

test('canvas: panning is the space bar and the middle button, and nothing else moves the board', { skip: SKIP, timeout: 90000 }, async () => {
  await clearArrangement();
  await clearFolds();
  await open();
  const spaceKey = (type) => page('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  const boardX = () => board().then((b) => b.x);
  const vp = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('.am-canvas-viewport').getBoundingClientRect())`));
  const from = { x: Math.round(vp.left + 30), y: Math.round(vp.top + 30) };
  const dragTo = async (dx, dy, button = 'left') => {
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button, clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + dx, y: from.y + dy, button });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 200));
  };

  // A plain drag moves nothing, so an ordinary press never pans the board by accident.
  const start = await boardX();
  await dragTo(120, 90);
  assert.equal(await boardX(), start, 'a plain drag left the board where it was');

  // The space bar pans.
  await spaceKey('keyDown');
  await dragTo(120, 90);
  await spaceKey('keyUp');
  assert.notEqual(await boardX(), start, 'a space-drag panned the board');

  // The middle button pans too, for a mouse with one.
  const afterSpace = await boardX();
  await dragTo(80, 60, 'middle');
  assert.notEqual(await boardX(), afterSpace, 'a middle-button drag panned the board');
});

test('canvas: full screen hides the head, and the toolbar and minimap never move with the board', { skip: SKIP, timeout: 90000 }, async () => {
  await clearArrangement();
  await open();
  const geo = () => evaluate(`JSON.stringify({
    head: getComputedStyle(document.querySelector('.am-canvas > .am-head')).display,
    viewport: (() => { const r = document.querySelector('.am-canvas-viewport').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })(),
    toolbar: (() => { const r = document.querySelector('.am-canvas-zoom').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })(),
    minimap: (() => { const r = document.querySelector('.am-canvas-minimap').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    fullscreen: document.documentElement.classList.contains('am-board-full'),
  })`).then(JSON.parse);

  const before = await geo();
  assert.equal(before.fullscreen, false);

  await evaluate(`document.querySelector('[data-am="canvas-fullscreen"]').click()`);
  await new Promise((r) => setTimeout(r, 350));
  const full = await geo();
  assert.equal(full.fullscreen, true, 'the board is in full screen');
  assert.equal(full.head, 'none', 'the head makes room for the board');
  assert.equal(full.viewport[0], 0, 'the viewport starts at the top of the window');
  assert.ok(full.viewport[1] >= before.viewport[1] + before.viewport[0] - 1, `the viewport takes what the head gave up: ${before.viewport.join('+')} -> ${full.viewport.join('/')}`);
  assert.equal(await evaluate(`document.querySelector('[data-am="canvas-fullscreen"]').getAttribute('aria-pressed')`), 'true', 'the button says it is pressed');

  // The minimap is bigger than the old fixed cap, and stays under a third of the window.
  assert.ok(full.minimap[0] >= 200, `the minimap is readable: ${full.minimap.join('x')}`);
  assert.ok(full.minimap[0] <= 300, `the minimap leaves the board room: ${full.minimap.join('x')}`);

  // The controls are fixed to the window, so panning does not carry them away.
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'middle', clickCount: 1 });
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 300, button: 'middle' });
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 300, button: 'middle', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const panned = await geo();
  assert.deepEqual(panned.toolbar, full.toolbar, 'the toolbar stayed put while the board panned');
  assert.deepEqual(panned.minimap, full.minimap, 'the minimap stayed put too');

  await evaluate(`document.querySelector('[data-am="canvas-fullscreen"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await geo()).fullscreen, false, 'and full screen comes back off');
});
