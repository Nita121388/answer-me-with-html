// Browser seam for foldable tree nodes: the markup is a native <details> (src/components/tree.js), so this file checks the three
// things only a browser can show — that a click on a node opens and closes it with no script of ours, that a closed node keeps its
// own row height, and that printing opens every node, since a closed <details> hides its content from the page (src/runtime/tree-fold.js).
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
  ? 'set AM_E2E=1 to run the browser tree fold tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const FOLD = `---
title: Tree fold check
lang: en
---
## A Closed by default
\`\`\`tree list fold
src/
  components/ | renders the page
    tree.js
    flow.js
  runtime/
    fold.js
\`\`\`

## B Open by default
\`\`\`tree list fold open
docs/
  reference.md
  changes/
    old.md
\`\`\`
`;

const DEEP = `---
title: Deep tree fold
lang: en
---
## A Five levels
\`\`\`tree list fold open
app/
  api/ | interface
    v1/
      http/ | transport
        handler.js
        router.js
      grpc/
        server.js
  data/
    sqlite/
      index.db
\`\`\`
`;

const PLAIN = `---
title: No tree fold
lang: en
---
## A A plain tree
\`\`\`tree list
src/
  components/
    tree.js
\`\`\`
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
const open = async (file) => {
  const loaded = cdp.once('Page.loadEventFired');
  await page('Page.navigate', { url: pathToFileURL(file).href });
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 200));
};
// Every foldable node: open state, and whether any of its lines is on the screen. Chrome hides what a closed <details>
// holds with content-visibility, so a hidden line still reports a layout box and a height; checkVisibility is what shows it.
const state = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-tree-fold')].map((d) => ({
  label: d.querySelector('summary .am-tree-label')?.textContent.trim() ?? '',
  open: d.open,
  shown: [...d.querySelectorAll('li')].some((li) => li.checkVisibility()),
})))`).then(JSON.parse);

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-treefold-'));
  const render = (src, name) => {
    const draft = join(tmp, `${name}.md`);
    const out = join(tmp, `${name}.html`);
    writeFileSync(draft, src);
    execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', out, '--no-open'], { stdio: 'ignore', env: { ...process.env, AM_HOME: join(tmp, 'home'), AM_NO_UPDATE_CHECK: '1' } });
    files[name] = out;
  };
  render(FOLD, 'fold');
  render(DEEP, 'deep');
  render(PLAIN, 'plain');

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = await connect(await devtoolsUrl(chrome));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await page('Page.enable');
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

test('tree fold: fold starts closed and fold open starts open, with the note on the folding line', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  const nodes = await state();
  // components/ and runtime/ fold in panel A; changes/ folds in panel B (the root of a list is a box, not a node).
  assert.deepEqual(nodes.map((n) => n.label), ['components/', 'runtime/', 'changes/']);
  assert.deepEqual(nodes.map((n) => n.open), [false, false, true], 'only fold open starts unfolded');
  assert.deepEqual(nodes.map((n) => n.shown), [false, false, true], 'a closed node shows none of its lines');
  assert.match(await evaluate(`document.querySelector('.am-tree-fold summary').textContent`), /renders the page/, 'the note stays on the folding line');
});

test('tree fold: a click opens and closes a node, with no page script of ours', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  assert.equal(await evaluate(`document.querySelector('.am-tree-fold .am-tree-fold, .am-tree-fold') instanceof HTMLDetailsElement`), true, 'the node is a native details');
  await evaluate(`document.querySelector('.am-tree-fold > summary').click()`);
  await new Promise((r) => setTimeout(r, 200));
  let nodes = await state();
  assert.equal(nodes[0].open, true, 'the node opened on a click');
  assert.equal(nodes[0].shown, true, 'its lines came on the screen');
  await evaluate(`document.querySelector('.am-tree-fold > summary').click()`);
  await new Promise((r) => setTimeout(r, 200));
  nodes = await state();
  assert.equal(nodes[0].open, false, 'the node closed on the second click');
  assert.equal(nodes[0].shown, false, 'the lines left the screen again');
});

test('tree fold: folding a parent takes the whole subtree with it', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  const closed = await evaluate(`document.querySelectorAll('.am-tree-fold')[0].querySelectorAll('li').length`);
  assert.ok(closed >= 2, 'the closed node still holds its lines in the markup');
  const visible = await evaluate(`(() => {
    const node = document.querySelectorAll('.am-tree-fold')[0];
    return [...node.querySelectorAll('li')].filter((li) => li.checkVisibility()).length;
  })()`);
  assert.equal(visible, 0, 'a closed node shows none of its lines');
});

test('tree fold: every level folds on its own, however deep it sits', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.deep);
  // document order: api/, v1/, http/, grpc/, data/, sqlite/ — the third level closes by itself.
  const labels = await evaluate(`JSON.stringify([...document.querySelectorAll('.am-tree-fold')].map((d) => d.querySelector('summary .am-tree-label').textContent.trim()))`).then(JSON.parse);
  assert.deepEqual(labels, ['api/', 'v1/', 'http/', 'grpc/', 'data/', 'sqlite/']);
  assert.ok(await evaluate(`document.querySelectorAll('.am-tree-fold')[2].querySelectorAll('li').length`) === 2, 'the third level holds its two files');
  await evaluate(`document.querySelectorAll('.am-tree-fold')[2].open = false`);
  await new Promise((r) => setTimeout(r, 200));
  const after = JSON.parse(await evaluate(`JSON.stringify((() => {
    const all = [...document.querySelectorAll('.am-tree-fold')];
    return {
      closed: all[2].open,
      itsLines: [...all[2].querySelectorAll('li')].filter((li) => li.checkVisibility()).length,
      sibling: all[3].open,
      siblingLines: [...all[3].querySelectorAll('li')].filter((li) => li.checkVisibility()).length,
    };
  })())`));
  assert.equal(after.closed, false, 'the third level closed');
  assert.equal(after.itsLines, 0, 'only its own lines left the screen');
  assert.equal(after.sibling, true, 'its sibling stayed open');
  assert.equal(after.siblingLines, 1, 'the sibling kept its own line');
});

test('tree fold: printing opens every node and the reader layout comes back afterwards', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  // Emulate print media: that is what beforeprint/afterprint fire for in a headless browser (src/runtime/tree-fold.js).
  await page('Emulation.setEmulatedMedia', { media: 'print' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await state()).map((n) => n.open), [true, true, true], 'every node prints open');
  await page('Emulation.setEmulatedMedia', { media: '' });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual((await state()).map((n) => n.open), [false, false, true], 'the reader layout came back');
});

test('tree fold: a reader marks the row of a node that folds, and the click does not fold it', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  await evaluate(`document.querySelector('[data-am="remark"]').click()`);
  const openBefore = await evaluate(`document.querySelector('.am-tree-fold').open`);
  await evaluate(`document.querySelector('.am-tree-fold > summary .am-tree-label').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(await evaluate(`document.querySelector('.am-tree-fold').open`), openBefore, 'the marking click left the fold as it was');
  const typed = await evaluate(`(() => {
    const inp = [...document.querySelectorAll('input')].find((i) => i.offsetParent !== null && !i.closest('.am-toolbar'));
    if (!inp) return false;
    inp.value = 'why is this its own node?';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(typed, true, 'the note input opened on the row');
  await evaluate(`document.body.click()`);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(await evaluate(`!!document.querySelector('.am-tree-fold > summary .am-mark-note')`), true, 'the note shows on the folding line');
  // A click on the note with the mode off opens it and leaves the fold alone.
  await evaluate(`document.querySelector('[data-am="remark"]').click()`);
  await evaluate(`document.querySelector('.am-tree-fold > summary .am-mark-note').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(await evaluate(`document.querySelector('.am-tree-fold').open`), openBefore, 'a click on the note did not fold the row');
  await evaluate(`document.querySelector('[data-am="reply"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const reply = await evaluate(`document.querySelector('.am-reply-raw textarea')?.value ?? ''`);
  assert.match(reply, /"components\/ renders the page"/, 'the reply names the row the reader marked');
  assert.match(reply, /> why is this its own node\?/, 'and carries the question');
});

test('tree fold: a tree without fold renders no details at all', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.plain);
  assert.equal(await evaluate(`document.querySelectorAll('.am-tree-fold').length`), 0, 'no foldable node without the argument');
  assert.ok(await evaluate(`document.querySelectorAll('.am-tree-list li').length`) >= 2, 'the plain list markup is still there');
});
