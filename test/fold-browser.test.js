// Browser seam for foldable panels: the markup is a native <details> (src/templates/panel.js), so this file checks the three
// things only a browser can show — that a reader's click folds and unfolds a panel and the sheet plans its rows again, that the
// choice comes back after a reload, that printing opens every panel, and that a page with folding switched off renders exactly
// as before. Slow and needs Chrome, so it runs only with AM_E2E=1.
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
  ? 'set AM_E2E=1 to run the browser fold tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

const DESKTOP = 1440;
const LAYOUT_WAIT_MS = 1000; // a fold plans the sheet in the same task now; the wait covers fonts and the last paint

const DRAFT = `---
title: Fold check
cols: 3
lang: en
collapse: true
---
Lead text.

## A First panel
This panel is a plain paragraph. It is long enough to wrap over a few lines so the row has a real height to plan.

## B Second panel {collapsed}
This panel starts folded. A reader opens it by clicking its head, and the sheet plans its rows again.

## C Third panel
A third panel keeps the row full, so the layout has something to balance when one panel changes height.
`;

const PLAIN = `---
title: No folds
cols: 2
lang: en
---
## A One
Text.

## B Two
Text.
`;

// Tall enough to scroll: folding a panel above the reader used to throw the page back to the top (#361).
const LONG = (() => {
  const panels = Array.from({ length: 12 }, (_, i) => {
    const body = Array.from({ length: 8 }, (_, k) => `Paragraph ${k + 1} of panel ${String.fromCharCode(65 + i)}: middleware notes long enough to wrap onto a second line here.`).join('\n\n');
    return `## ${String.fromCharCode(65 + i)} Panel ${i + 1}\n${body}\n`;
  }).join('\n');
  return `---
title: Long fold
cols: 3
lang: en
collapse: true
---
${panels}`;
})();

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
  // The sheet plans its rows right after load; a fold test that measured before it would compare two different layouts.
  await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))`);
};
// Every panel's id, open state and height: one read for all the checks below.
const state = () => evaluate(`JSON.stringify([...document.querySelectorAll('.am-panel')].map((p) => ({
  id: p.id,
  fold: !!p.querySelector('.am-fold'),
  open: p.querySelector('.am-fold')?.open ?? null,
  // Chrome hides a closed details' content with content-visibility, so the body still reports a layout box; the details' own
  // height is what shows it: a closed fold is exactly its summary.
  body: (() => {
    const d = p.querySelector('.am-fold');
    if (!d) return true;
    return d.offsetHeight > (d.querySelector('summary')?.offsetHeight ?? 0) + 1;
  })(),
  h: Math.round(p.getBoundingClientRect().height),
})))`).then(JSON.parse);

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-fold-'));
  const render = (src, name) => {
    const draft = join(tmp, `${name}.md`);
    const out = join(tmp, `${name}.html`);
    writeFileSync(draft, src);
    execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', out, '--no-open'], { stdio: 'ignore', env: { ...process.env, AM_HOME: join(tmp, 'home'), AM_NO_UPDATE_CHECK: '1' } });
    files[name] = out;
  };
  render(DRAFT, 'fold');
  render(PLAIN, 'plain');
  render(LONG, 'long');

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', `--window-size=${DESKTOP},900`, 'about:blank',
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

test('fold: page-level collapse makes every panel a fold, and {collapsed} starts one closed', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  const panels = await state();
  assert.deepEqual(panels.map((p) => p.id), ['panel-A', 'panel-B', 'panel-C']);
  assert.deepEqual(panels.map((p) => p.fold), [true, true, true], 'every panel is a fold');
  assert.deepEqual(panels.map((p) => p.open), [true, false, true], 'B starts folded, A and C start open');
  // The sheet stretches every panel of a row to the row's height, so the panel box does not get shorter; the body is what goes away.
  assert.deepEqual(panels.map((p) => p.body), [true, false, true], 'only the folded panel hides its body');
});

test('fold: a click on the head folds and unfolds, and the sheet plans its rows again', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  // Count the layout passes the page makes: a fold changes a row's height, so the sheet must plan again.
  const watch = `window.__amLayouts = 0; document.addEventListener('am-layout', () => { window.__amLayouts++; }); true`;
  await evaluate(watch);

  await evaluate(`document.querySelector('#panel-A > .am-fold > summary').click()`);
  await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
  const folded = await state();
  assert.equal(folded.find((p) => p.id === 'panel-A').open, false, 'A is folded after the click');
  assert.equal(folded.find((p) => p.id === 'panel-A').body, false, 'the folded body is hidden');
  assert.ok(await evaluate('window.__amLayouts') > 0, 'the sheet planned its rows again after the fold');

  await evaluate(watch);
  await evaluate(`document.querySelector('#panel-A > .am-fold > summary').click()`);
  await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
  const reopened = await state();
  assert.equal(reopened.find((p) => p.id === 'panel-A').open, true, 'A is open again');
  assert.equal(reopened.find((p) => p.id === 'panel-A').body, true, 'the body is back');
  assert.ok(await evaluate('window.__amLayouts') > 0, 'the sheet planned again after the unfold');
  // The sheet is still the justified layout, not the plain CSS grid: the fold did not knock the planner out.
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.am-grid')).display`), 'flex');
});

test('fold: the reader choice survives a reload', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  await evaluate(`document.querySelector('#panel-C > .am-fold > summary').click()`);
  await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
  assert.equal((await state()).find((p) => p.id === 'panel-C').open, false);
  await open(files.fold);
  assert.equal((await state()).find((p) => p.id === 'panel-C').open, false, 'C was still folded after the reload');
  // Clean up the stored choice so no other test sees it.
  await evaluate(`localStorage.removeItem('am-fold:' + location.pathname)`);
});

test('fold: printing opens every panel and the reader layout comes back afterwards', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.fold);
  await evaluate(`localStorage.removeItem('am-fold:' + location.pathname)`);
  await open(files.fold);
  // Emulate print media: that is what beforeprint/afterprint fire for in a headless browser.
  await page('Emulation.setEmulatedMedia', { media: 'print' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await state()).map((p) => p.open), [true, true, true], 'every panel prints open');
  await page('Emulation.setEmulatedMedia', { media: '' });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual((await state()).map((p) => p.open), [true, false, true], 'the reader layout came back');
});

test('fold: a page without collapse renders no details and adds nothing to storage', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.plain);
  const panels = await state();
  assert.deepEqual(panels.map((p) => p.fold), [false, false]);
  // Only this page's own key matters: other pages tested in this browser share the file:// origin's storage.
  const own = await evaluate(`localStorage.getItem('am-fold:' + location.pathname)`);
  assert.equal(own, null, 'no fold key written for a page with no folds');
});

test('fold: folding a panel above the reader keeps the page where it is', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.long);
  // Scroll into the middle of the page, so the first panel is above the window.
  await evaluate('window.scrollTo(0, 900)');
  await new Promise((r) => setTimeout(r, 300));
  const before = JSON.parse(await evaluate(`JSON.stringify((() => {
    const panels = [...document.querySelectorAll('.am-panel')];
    const folded = 'panel-A';
    const ref = panels.find((p) => p.id !== folded && p.getBoundingClientRect().bottom > 8);
    return { folded, ref: ref.id, refTop: ref.getBoundingClientRect().top, scrollY: scrollY, headTop: document.querySelector('#panel-A summary').getBoundingClientRect().top };
  })())`));
  assert.ok(before.headTop < 0, 'the folded head starts above the window');
  await evaluate(`document.querySelector('#panel-A summary').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const after = JSON.parse(await evaluate(`JSON.stringify((() => {
    const ref = document.getElementById(${JSON.stringify(before.ref)});
    return { refTop: ref.getBoundingClientRect().top, scrollY: scrollY };
  })())`));
  // The panel the reader is looking at holds its place on the screen, and the page does not go back to the top.
  assert.ok(Math.abs(after.refTop - before.refTop) <= 2, `the reading place moved ${(after.refTop - before.refTop).toFixed(1)}px`);
  assert.ok(after.scrollY > 0, 'the page stayed scrolled');
});

test('fold: folding the panel the reader is looking at keeps its head under the pointer', { skip: SKIP, timeout: 60000 }, async () => {
  await open(files.long);
  await evaluate('window.scrollTo(0, 1400)');
  await new Promise((r) => setTimeout(r, 300));
  const before = JSON.parse(await evaluate(`JSON.stringify((() => {
    const heads = [...document.querySelectorAll('.am-fold summary')];
    const head = heads.find((h) => h.getBoundingClientRect().top > 0) ?? heads[0];
    return { id: head.closest('.am-panel').id, top: head.getBoundingClientRect().top, scrollY: scrollY };
  })())`));
  await evaluate(`document.getElementById(${JSON.stringify(before.id)}).querySelector('summary').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const after = JSON.parse(await evaluate(`JSON.stringify((() => {
    const head = document.getElementById(${JSON.stringify(before.id)}).querySelector('summary');
    return { top: head.getBoundingClientRect().top, scrollY: scrollY };
  })())`));
  // A head the reader can see stays where it is, the way a <details> folds anywhere else on the web.
  assert.ok(Math.abs(after.top - before.top) <= 2, `the head moved ${(after.top - before.top).toFixed(1)}px`);
});
