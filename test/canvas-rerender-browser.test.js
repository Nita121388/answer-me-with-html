// The board is the reader's, and a re-render must not take it away. This file is about that promise: the draft is edited and
// rendered again over the same file, and the arrangement the reader made has to survive — even when the edit inserts a panel
// above the others and every panel id shifts by one letter.
//
// It runs the CLI between loads, so it needs Chrome and the repo, and only runs with AM_E2E=1.
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
  ? 'set AM_E2E=1 to run the browser canvas re-render tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const DESKTOP = 1440;
const HEIGHT = 1000;

const board = (extraPanel = '', extraEdge = '') => `---
title: Re-render
template: canvas
lang: en
---
\`\`\`canvas
"Input" -> "Middle": causes
${extraEdge}\`\`\`
A board that outlives its draft.

${extraPanel}## Input
This panel is the first node, and its text is long enough that the body is more than a title.

## Middle
The second node, also with a body long enough to identify it.

## Output
The third node. Only its text changes between the two renders.
`;

let tmp;
let chrome;
let cdp;
let session;
let draftPath;
let boardFile;

const page = (method, params) => cdp.send(method, params, session);
const evaluate = async (expression) => {
  const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page script error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const mouse = (type, x, y) => page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
const render = (source) => {
  writeFileSync(draftPath, source);
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draftPath, '-o', boardFile, '--no-open'], { stdio: 'ignore' });
};
const open = async () => {
  const loaded = cdp.once('Page.loadEventFired');
  await page('Page.navigate', { url: pathToFileURL(boardFile).href });
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
  await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))))');
};
// Every node as "title@x,y", by heading text, so a check does not depend on the letter a panel was given.
const nodes = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-canvas-node')].map((n) => ({
  title: n.querySelector('.am-panel-head h2')?.textContent ?? '',
  x: parseFloat(n.style.left),
  y: parseFloat(n.style.top),
})))`).then(JSON.parse);
const edges = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-canvas-edge')].map((g) =>
  g.dataset.from.replace(/^panel-/, '') + '>' + g.dataset.to.replace(/^panel-/, '')))`).then(JSON.parse);
const headAt = (title) => evaluate(`(() => {
  const node = [...document.querySelectorAll('.am-canvas-node')].find((n) => n.querySelector('.am-panel-head h2')?.textContent === ${JSON.stringify(title)});
  const r = node.querySelector('.am-panel-head').getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
})()`).then(JSON.parse);

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-canvas-rerender-'));
  draftPath = join(tmp, 'draft.md');
  boardFile = join(tmp, 'board.html');
  render(board());

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

test('re-render: changing one panel keeps every other panel where the reader put it', { skip: SKIP, timeout: 90000 }, async () => {
  await open();
  await evaluate('localStorage.clear()');
  render(board());
  await open();

  // Move B away from where the build placed it.
  const head = await headAt('Middle');
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseMoved', head.x, head.y);
  await mouse('mouseMoved', head.x + 180, head.y + 160);
  await mouse('mouseReleased', head.x + 180, head.y + 160);
  await new Promise((r) => setTimeout(r, 200));
  const moved = (await nodes()).find((n) => n.title === 'Middle');
  const a = (await nodes()).find((n) => n.title === 'Input');
  const c = (await nodes()).find((n) => n.title === 'Output');

  // "The agent edits something else": the text of C changes, nothing else does.
  render(board('', '').replace('Only its text changes between the two renders.', 'Only its text changes between the two renders, and now it changed.'));
  await open();

  const after = await nodes();
  assert.deepEqual(after.find((n) => n.title === 'Middle'), moved, 'B kept the place the reader gave it');
  assert.deepEqual(after.find((n) => n.title === 'Input'), a, 'A kept its place');

  // C is the panel the agent edited, so its key changed and the build's placement is what shows. Read that placement from a
  // load with the saved board cleared: it is the same page, so the two must agree exactly.
  await evaluate('localStorage.clear()');
  await open();
  const pristine = await nodes();
  assert.deepEqual(after.find((n) => n.title === 'Output'), pristine.find((n) => n.title === 'Output'), 'C sits where the build puts an edited panel');
  // The declared edge is still there, and it still joins the same two panels even though C moved in the list.
  assert.deepEqual(await edges(), ['A>B']);
});

test('re-render: inserting a panel above shifts every letter, and the board still holds', { skip: SKIP, timeout: 90000 }, async () => {
  await evaluate('localStorage.clear()');
  render(board());
  await open();

  const head = await headAt('Output');
  await mouse('mousePressed', head.x, head.y);
  await mouse('mouseMoved', head.x + 60, head.y + 220);
  await mouse('mouseReleased', head.x + 60, head.y + 220);
  await new Promise((r) => setTimeout(r, 200));
  const before = await nodes();
  const keptOutput = before.find((n) => n.title === 'Output');
  const keptInput = before.find((n) => n.title === 'Input');

  // A new panel first in the draft: every existing panel's id moves down one letter (A becomes B, and so on).
  render(board('## Intro\nA new panel inserted above everything else.\n\n', ''));
  await open();

  const after = await nodes();
  assert.equal(after.length, 4, 'the new panel is on the board');
  assert.deepEqual(after.find((n) => n.title === 'Output'), keptOutput, 'Output stayed where the reader put it, whatever its letter is now');
  assert.deepEqual(after.find((n) => n.title === 'Input'), keptInput, 'Input stayed too');
  // The new panel has never been seen, so the build's placement stands for it.
  assert.ok(after.find((n) => n.title === 'Intro'), 'the new panel is placed by the build');
  // The draft names its edge by title, so it still joins the same two panels even though their letters moved: the panels are
  // now B and C, and the edge follows them rather than the letters A and B.
  assert.deepEqual(await edges(), ['B>C'], 'the title-named edge still joins Input and Middle');
});

test('re-render: an edge the reader drew is kept across a re-render', { skip: SKIP, timeout: 90000 }, async () => {
  await evaluate('localStorage.clear()');
  render(board());
  await open();

  // Draw A -> C from the port, then let the draft be re-rendered.
  const port = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.am-canvas-node')].find((n) => n.querySelector('.am-panel-head h2')?.textContent === 'Input');
    const r = node.querySelector('[data-am="canvas-port"]').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`).then(JSON.parse);
  const target = await headAt('Output');
  await mouse('mousePressed', port.x, port.y);
  await mouse('mouseMoved', port.x + 20, port.y + 20);
  await mouse('mouseMoved', target.x, target.y);
  await mouse('mouseReleased', target.x, target.y);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok((await edges()).includes('A>C'), 'the reader drew A -> C');

  render(board('', '').replace('The second node, also with a body long enough to identify it.', 'The second node, reworded by the agent.'));
  await open();
  assert.deepEqual((await edges()).sort(), ['A>B', 'A>C'], 'both edges are on the board after the re-render');
});
