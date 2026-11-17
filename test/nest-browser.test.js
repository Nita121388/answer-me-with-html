// Browser seam for sub-panels ({nest}): a panel that holds panels. What only a browser can show is that the sheet layout leaves
// them alone, that a sub-panel folds without folding its parent, that a reader's saved folds still work, and that print opens
// every fold. Slow and needs Chrome, so it runs only with AM_E2E=1 like test/fold-browser.test.js.
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
  ? 'set AM_E2E=1 to run the browser sub-panel tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const PARENTS = 5;
const CHILDREN = 3;
const LETTER = (i) => String.fromCharCode(65 + i);

// Five panels, each holding three sub-panels; the first sub-panel of each parent starts folded, so a test has both kinds.
const draftOf = () => {
  const panel = (i) => {
    const fold = (k) => (k === 0 ? ' {collapsed}' : k === 1 ? ' {collapse}' : ' {collapse=false}');
    const subs = Array.from({ length: CHILDREN }, (_, k) => `### ${LETTER(i)}${k + 1} Part ${k + 1}${fold(k)}
Body of part ${k + 1} in panel ${LETTER(i)}. It runs a few words so the row has a real height.
`).join('\n');
    return `## ${LETTER(i)} Panel ${i + 1} {nest}
Lead text of panel ${i + 1}.

${subs}
`;
  };
  return `---\ntitle: Sub-panel check\nlang: en\ncollapse: true\ncols: 3\n---\n\n${Array.from({ length: PARENTS }, (_, i) => panel(i)).join('\n')}`;
};

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
// Every test starts on the page with no saved fold: the browser is shared, so a test that leaned on the one before it would pass
// or fail by the order it ran in.
const reset = async (seed) => {
  await evaluate('localStorage.clear()');
  if (seed) await evaluate(`localStorage.setItem('am-fold:' + location.pathname, ${JSON.stringify(JSON.stringify(seed))})`);
  await open();
};
const open = async () => {
  const loaded = cdp.once('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(page).href });
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
  await sleep(300);
};

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-nest-'));
  const draft = join(tmp, 'nest.md');
  const out = join(tmp, 'nest.html');
  writeFileSync(draft, draftOf());
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', out, '--no-open'], {
    env: { ...process.env, AM_NO_UPDATE_CHECK: '1', AM_HOME: join(tmp, 'home') }, stdio: 'pipe',
  });
  page = out;
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = await connect(await devtoolsUrl(chrome));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errors = [];
      addEventListener('error', (e) => window.__errors.push(String(e.message)));
      addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));`,
  });
  await open();
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

test('nest: sub-panels render inside their parent and stay out of the sheet layout', { skip: SKIP, timeout: 60000 }, async () => {
  const shape = JSON.parse(await evaluate(`JSON.stringify({
    // Count by class, not by parent: the sheet layout wraps some panels in .am-col boxes, and a sub-panel is never am-panel.
    panels: document.querySelectorAll('.am-panel').length,
    subs: document.querySelectorAll('.am-subpanel').length,
    subStyle: document.querySelector('.am-subpanel').getAttribute('style'),
    nested: document.querySelector('#panel-A1').closest('.am-panel').id,
    h3: document.querySelector('#panel-A2 .am-panel-head--sub h3')?.textContent,
  })`));
  assert.equal(shape.panels, PARENTS, 'only the top panels are cells of the grid');
  assert.equal(shape.subs, PARENTS * CHILDREN);
  assert.equal(shape.subStyle, null, 'the layout writes no width on a sub-panel');
  assert.equal(shape.nested, 'panel-A', 'a sub-panel lives inside its parent panel');
  assert.equal(shape.h3, 'Part 2');
  assert.deepEqual(await errors(), []);
});

test('nest: a sub-panel folds on its own, without touching the panel that holds it', { skip: SKIP, timeout: 60000 }, async () => {
  await reset();
  // A2 carries {collapse}, so it is a fold that starts open; A1 carries {collapsed} and starts closed.
  await evaluate(`document.querySelector('#panel-A2 .am-fold summary').click()`);
  await sleep(300);
  const after = JSON.parse(await evaluate(`JSON.stringify({
    sub: document.querySelector('#panel-A2 .am-fold').open,
    panel: document.querySelector('#panel-A .am-fold').open,
    sibling: document.querySelector('#panel-A1 .am-fold').open,
    plain: !!document.querySelector('#panel-A3 .am-fold'),
    stored: JSON.parse(localStorage.getItem('am-fold:' + location.pathname) || '{}'),
  })`));
  assert.equal(after.sub, false, 'the sub-panel closed');
  assert.equal(after.panel, true, 'its panel stayed open');
  assert.equal(after.sibling, false, 'a sibling sub-panel keeps its own state');
  assert.equal(after.plain, false, 'a sub-panel that writes {collapse=false} stays a heading');
  // The sub-panel stores under its own ID, and folding it writes nothing about the panel that holds it.
  assert.equal(after.stored['panel-A2'], false);
  assert.equal('panel-A' in after.stored, false, 'folding a sub-panel writes no state for its panel');
  assert.deepEqual(await errors(), []);
});

test('nest: folding the panel hides its sub-panels, and opening it brings their own state back', { skip: SKIP, timeout: 60000 }, async () => {
  await reset();
  await evaluate(`document.querySelector('#panel-A .am-fold summary').click()`);
  await sleep(400);
  const closed = JSON.parse(await evaluate(`JSON.stringify({
    panel: document.querySelector('#panel-A .am-fold').open,
    visible: (() => { const d = document.querySelector('#panel-A .am-fold'); return Math.abs(d.offsetHeight - d.querySelector('summary').offsetHeight) <= 1; })(),
  })`));
  assert.equal(closed.panel, false, 'the panel closed');
  assert.equal(closed.visible, true, 'a closed fold is exactly its head');
  await evaluate(`document.querySelector('#panel-A .am-fold summary').click()`);
  await sleep(400);
  const opened = JSON.parse(await evaluate(`JSON.stringify({
    panel: document.querySelector('#panel-A .am-fold').open,
    sub: document.querySelector('#panel-A2 .am-fold').open,
    first: document.querySelector('#panel-A1 .am-fold').open,
  })`));
  assert.equal(opened.panel, true, 'the panel opened again');
  assert.equal(opened.sub, true, 'the sub-panel kept the state it started with');
  assert.equal(opened.first, false, '{collapsed} still holds for the first sub-panel');
  assert.deepEqual(await errors(), []);
});

test('nest: folds saved before sub-panels existed still open the right panel', { skip: SKIP, timeout: 60000 }, async () => {
  // A page marked by an older version stores "panel-B" (the DOM id), not "B". Those keys must keep working.
  await reset({ 'panel-B': false });
  const state = JSON.parse(await evaluate(`JSON.stringify({
    b: document.querySelector('#panel-B .am-fold').open,
    a: document.querySelector('#panel-A .am-fold').open,
  })`));
  assert.equal(state.b, false, 'the panel the reader closed is closed');
  assert.equal(state.a, true, 'another panel keeps its default');
  await evaluate(`localStorage.removeItem('am-fold:' + location.pathname)`);
  assert.deepEqual(await errors(), []);
});

test('nest: print opens every fold, sub-panels included, and nothing overflows sideways', { skip: SKIP, timeout: 60000 }, async () => {
  await reset();
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(400);
  const printed = JSON.parse(await evaluate(`JSON.stringify({
    allOpen: [...document.querySelectorAll('.am-fold')].every((d) => d.open),
    folds: document.querySelectorAll('.am-fold').length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  })`));
  // A fold per panel, plus the two sub-panels of each panel that fold (the third writes {collapse=false}).
  assert.equal(printed.folds, PARENTS * 3, 'one fold per panel and per foldable sub-panel');
  assert.equal(printed.allOpen, true, 'print shows the whole page');
  assert.equal(printed.overflow, false, 'the sub-panel rail adds no sideways scroll');
  await send('Emulation.setEmulatedMedia', { media: '' });
  await sleep(400);
  assert.deepEqual(await errors(), []);
});

// A sub-panel is a board of its own, so the reader can comment on it instead of on the panel around it: the button sits in its
// head, a press never folds it, the comment names the sub-panel in the reply, and the preview's ✕ drops only that one.
test('nest: every sub-panel takes its own comment, and the reply names the sub-panel', { skip: SKIP, timeout: 60000 }, async () => {
  await reset();
  const counts = JSON.parse(await evaluate(`JSON.stringify({
    buttons: document.querySelectorAll('.am-comment-btn').length,
    boards: document.querySelectorAll('.am-panel, .am-subpanel').length,
    inFold: !!document.querySelector('#panel-A2 .am-fold summary > .am-comment-btn'),
    inPlain: !!document.querySelector('#panel-A3 > header.am-panel-head--sub > .am-comment-btn'),
  })`));
  assert.equal(counts.buttons, counts.boards, 'one button per board, panels and sub-panels alike');
  assert.equal(counts.buttons, PARENTS + PARENTS * CHILDREN);
  assert.equal(counts.inFold, true, 'a folded sub-panel takes the button in the head it folds by');
  assert.equal(counts.inPlain, true, 'a plain sub-panel takes it in its header');

  // A1 starts {collapsed}: pressing its comment button opens the box and leaves the fold closed, so the press is not a fold.
  await evaluate(`document.querySelector('#panel-A1 .am-comment-btn').click()`);
  await sleep(250);
  const opened = JSON.parse(await evaluate(`JSON.stringify({
    box: !document.querySelector('#panel-A1 > .am-comment').hidden,
    fold: document.querySelector('#panel-A1 .am-fold').open,
    focus: document.activeElement.tagName,
  })`));
  assert.equal(opened.box, true, 'the sub-panel comment box opened');
  assert.equal(opened.fold, false, 'the press did not fold the sub-panel open');
  assert.equal(opened.focus, 'TEXTAREA', 'focus went into the box');

  // One comment on the panel and one on the sub-panel: the reply names each by the board the reader wrote it in.
  await evaluate(`const boxA = document.querySelector('#panel-A > .am-comment textarea');
    boxA.value = 'the panel note'; boxA.dispatchEvent(new Event('input', { bubbles: true }));
    const boxA1 = document.querySelector('#panel-A1 > .am-comment textarea');
    boxA1.value = 'split the client'; boxA1.dispatchEvent(new Event('input', { bubbles: true }));`);
  await sleep(300);
  await evaluate(`document.querySelector('[data-am="reply"]').click()`);
  await sleep(350);
  const shown = await evaluate(`document.querySelector('dialog.am-reply textarea').value`);
  assert.ok(shown.includes('- **A · Panel 1**'), `the panel comment names the panel\n${shown}`);
  assert.ok(shown.includes('- **A1 · Part 1**'), `the sub-panel comment names the sub-panel\n${shown}`);

  // Both survive a reload, and the sub-panel's box comes back open with its button lit.
  await open();
  const after = JSON.parse(await evaluate(`JSON.stringify({
    value: document.querySelector('#panel-A1 > .am-comment textarea').value,
    open: !document.querySelector('#panel-A1 > .am-comment').hidden,
    on: document.querySelector('#panel-A1 .am-comment-btn').classList.contains('am-comment-btn--on'),
  })`));
  assert.equal(after.value, 'split the client');
  assert.equal(after.open, true, 'a saved sub-panel comment opens its box again');
  assert.equal(after.on, true);

  // The preview's ✕ drops the sub-panel entry only: its box empties, the panel's box and button stay as they were.
  await evaluate(`document.querySelector('[data-am="reply"]').click()`);
  await sleep(350);
  await evaluate(`document.querySelector('dialog.am-reply .am-rv-entry[data-ref="cA1"] .am-rv-clear').click()`);
  await sleep(350);
  const cleared = JSON.parse(await evaluate(`JSON.stringify({
    sub: document.querySelector('#panel-A1 > .am-comment textarea').value,
    parent: document.querySelector('#panel-A > .am-comment textarea').value,
    parentOn: document.querySelector('#panel-A .am-comment-btn').classList.contains('am-comment-btn--on'),
    subOn: document.querySelector('#panel-A1 .am-comment-btn').classList.contains('am-comment-btn--on'),
    raw: document.querySelector('dialog.am-reply textarea').value,
  })`));
  assert.equal(cleared.sub, '', 'the sub-panel box emptied');
  assert.equal(cleared.parent, 'the panel note', 'the panel box keeps its own comment');
  assert.equal(cleared.parentOn, true, 'the panel button stays lit');
  assert.equal(cleared.subOn, false, 'the sub-panel button goes out');
  assert.equal(cleared.raw.includes('split the client'), false, 'the copied text follows');
  await evaluate(`document.querySelector('dialog.am-reply [data-act="close"]').click()`);
  await sleep(200);
  await evaluate('localStorage.clear()');
  assert.deepEqual(await errors(), []);
});
