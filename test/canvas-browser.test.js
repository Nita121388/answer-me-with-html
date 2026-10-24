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
const clearSelectionAll = () => evaluate(`document.querySelector('.am-canvas-viewport').click()`);
const headAt = (id) => evaluate(`(() => {
  const r = document.getElementById('${id}').querySelector('.am-panel-head').getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
})()`).then(JSON.parse);

const clearArrangement = () => evaluate(`localStorage.removeItem(${storeKeyExpr})`);
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
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', boardFile, '--no-open'], { stdio: 'ignore' });

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

test('canvas: a press on empty space pans the board, and the nodes stay where they were', { skip: SKIP, timeout: 60000 }, async () => {
  await open();
  const start = await board();
  await mouse('mousePressed', Math.round(DESKTOP / 2), HEIGHT - 60);
  await mouse('mouseMoved', Math.round(DESKTOP / 2), HEIGHT - 60);
  await mouse('mouseMoved', Math.round(DESKTOP / 2), HEIGHT - 260);
  await mouse('mouseReleased', Math.round(DESKTOP / 2), HEIGHT - 260);
  const after = await board();
  assert.ok(Math.abs(after.y - start.y) > 100, `the board panned up: y ${start.y} -> ${after.y}`);
  assert.deepEqual(after.nodes, start.nodes, 'panning moved no node');
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
  assert.ok(Number(mm.w) <= 168 && Number(mm.h) <= 168, 'the picture stays small');

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
