// Browser seam for text marks (src/runtime/remark.js, the second granularity of remark mode): the reader picks words inside one
// block, one click tags them, and the words keep their mark across a reload and reach the reply. It catches what the pure tests
// cannot: a runtime that throws on load, a float that covers the words it is about, a mark whose paint changes the text the next
// mark is measured against. Needs Chrome, so it runs only with AM_E2E=1 like test/remark-browser.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, devtoolsUrl, findChrome } from '../src/video/export.js';
import en from '../src/languages/en.js';
import zh from '../src/languages/zh.js';


const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = findChrome();
const SKIP = process.env.AM_E2E !== '1'
  ? 'set AM_E2E=1 to run the browser text mark tests'
  : !CHROME ? 'no Chrome found (set AM_CHROME)' : typeof WebSocket === 'undefined' ? 'needs Node 22 (built-in WebSocket)' : false;

// `words` is the phrase a test picks, `later` a second phrase in the same paragraph, `other` a phrase in panel B.
const PAGES = {
  en: {
    tag: 'en', lang: en,
    first: 'Redis keeps sessions and follows the cache order closely.',
    words: 'keeps sessions', later: 'follows the cache', other: 'ships on the third day',
    row: ['Redis', 'cache'],
  },
  zh: {
    tag: 'zh', lang: zh,
    first: 'Redis 会保留会话，并在每次请求时跟随缓存的读取顺序。',
    words: '保留会话', later: '跟随缓存', other: '第三天进行',
    row: ['Redis', '缓存'],
  },
};

const draftOf = (p) => `---
title: Text mark check
lang: ${p.tag}
---
## A The cache
${p.first}

- Same text one
- Same text two

| a | b |
|---|---|
| ${p.row.join(' | ')} |

## B Release
It ${p.other}.
`;

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
const load = async (url) => {
  const loaded = cdp.once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
};
const reload = async () => {
  const loaded = cdp.once('Page.loadEventFired');
  await send('Page.reload');
  await loaded;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'am-annot-'));
  const draft = join(tmp, 'page.md');
  const file = join(tmp, 'page.html');
  writeFileSync(draft, draftOf(PAGES.en));
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', file, '--no-open'], {
    env: { ...process.env, AM_NO_UPDATE_CHECK: '1', AM_HOME: join(tmp, 'home') }, stdio: 'pipe',
  });
  page = pathToFileURL(file).href;
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = await connect(await devtoolsUrl(chrome));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errors = [];
      addEventListener('error', (e) => window.__errors.push(String(e.message)));
      addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));`,
  });
  await load(page);
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

// Page helpers as source text for Runtime.evaluate: `pick` selects a phrase the way a reader drags over it, `store` reads what the
// page saved, and `float` is the one thing that appears on a pick.
const PAGE_JS = `
  const float = document.querySelector('.am-annot-float');
  const btn = document.querySelector('[data-am="remark"]');
  const shown = (el) => !!el && !el.hidden;
  const panel = (letter) => document.querySelector('#panel-' + letter);
  const nodeWith = (root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) if (node.data.includes(text)) return node;
    return null;
  };
  const pick = (text, letter = 'A') => {
    const node = nodeWith(panel(letter), text);
    if (!node) return false;
    const i = node.data.indexOf(text);
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + text.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  };
  const pickAcross = (a, b) => {
    const from = nodeWith(panel('A'), a);
    const to = nodeWith(panel('B'), b);
    const range = document.createRange();
    range.setStart(from, 0);
    range.setEnd(to, 2);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const store = () => JSON.parse(localStorage.getItem('am-remark:' + location.pathname) || '[]');
  const kinds = () => [...document.querySelectorAll('.am-annot-float .am-remark-kind')];
  const tag = (i) => kinds()[i].click();
  const note = (text) => {
    const box = float.querySelector('input');
    box.value = text;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const marks = () => [...document.querySelectorAll('mark.am-annot')];
  const numbers = () => [...document.querySelectorAll('sup.am-annot-n')].map((s) => s.textContent);
`;

const run = async (body) => evaluate(`(() => { ${PAGE_JS} ${body} })()`);
const mode = async (on) => {
  const is = await evaluate(`document.querySelector('[data-am="remark"]').getAttribute('aria-pressed')`);
  if ((is === 'true') !== on) await evaluate(`document.querySelector('[data-am="remark"]').click()`);
};
// Every test starts on a page with no mark and the mode on: the browser is shared, so a test that leaned on the one before it
// would pass or fail by the order it ran in.
const reset = async () => {
  await reload();
  await evaluate(`localStorage.clear()`);
  await reload();
  await mode(true);
};

test('a pick shows the float, and one click tags the words', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  assert.equal(await run(`return pick(${JSON.stringify(p.words)});`), true);
  await sleep(300);
  assert.equal(await run('return shown(float);'), true);
  // The kinds carry the number a reader can press, as the block popover does.
  assert.deepEqual(await run('return kinds().map((b) => b.dataset.n);'), ['1', '2', '3', '4']);
  await run('tag(3);');
  await sleep(200);
  assert.equal(await run('return shown(float);'), false);
  assert.equal(await run('return marks().length;'), 1);
  assert.equal(await run('return numbers().join();'), '1');
  assert.deepEqual(await run('return store().map((m) => [m.quote, m.kind, m.note]);'), [[p.words, 'concern', '']]);
  // The number the page paints must not join the page text: the block key and every later offset depend on that text.
  assert.equal(await run(`return document.querySelector('#panel-A p').textContent.includes('1');`), true);
  assert.deepEqual(await errors(), []);
});

test('a note with Enter saves too, and gets the next number', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`);
  await sleep(300);
  await run('tag(3);');
  await sleep(200);
  await run(`pick(${JSON.stringify(p.later)});`);
  await sleep(300);
  assert.equal(await run('return shown(float);'), true);
  await run('note("check the numbers");');
  await sleep(250);
  assert.equal(await run('return marks().length;'), 2);
  assert.equal(await run('return numbers().join();'), '1,2');
  assert.deepEqual(await run('return store().map((m) => m.note);'), ['', 'check the numbers']);
  assert.deepEqual(await errors(), []);
});

test('a selection across two blocks shows no float', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pickAcross(${JSON.stringify(p.words)}, ${JSON.stringify(p.other)});`);
  await sleep(300);
  assert.equal(await run('return shown(float);'), false);
  assert.deepEqual(await run('return store();'), []);
  assert.deepEqual(await errors(), []);
});

test('a click on the marked words opens the float on that mark, and Remove renumbers the rest', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`);
  await sleep(300);
  await run('tag(3);');
  await sleep(200);
  await run(`pick(${JSON.stringify(p.later)});`);
  await sleep(300);
  await run('note("check the numbers");');
  await sleep(250);
  // The first mark is the one without a note; a click on its words selects them again.
  await run('marks()[0].click();');
  await sleep(300);
  assert.equal(await run('return shown(float);'), true);
  assert.equal(await run('return !float.querySelector(".am-btn").hidden;'), true);
  assert.equal(await run('return float.querySelector("input").value;'), '');
  // The second mark carries its note back.
  await run('marks()[1].click();');
  await sleep(300);
  assert.equal(await run('return float.querySelector("input").value;'), 'check the numbers');
  await run('float.querySelector(".am-btn").click();');
  await sleep(250);
  assert.equal(await run('return marks().length;'), 1);
  assert.equal(await run('return numbers().join();'), '1');
  assert.deepEqual(await run('return store().map((m) => m.quote);'), [p.words]);
  assert.deepEqual(await errors(), []);
});

test('a reload paints the same marks, and the reply carries the words', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`);
  await sleep(300);
  await run('tag(3);');
  await sleep(200);
  await run(`pick(${JSON.stringify(p.later)});`);
  await sleep(300);
  await run('note("check the numbers");');
  await sleep(250);
  await reload();
  assert.equal(await run('return marks().length;'), 2);
  assert.equal(await run('return numbers().join();'), '1,2');
  const reply = await evaluate(`(() => { document.querySelector('[data-am="reply"]').click(); return document.querySelector('dialog.am-reply textarea').value; })()`);
  const section = reply.slice(reply.indexOf(`## ${p.lang.ui.remark.section}`));
  assert.equal(section, [
    `## ${p.lang.ui.remark.section}`,
    `- **A · ${p.lang.ui.remark.kinds.concern}** "${p.words}"`,
    `- **A · ${p.lang.ui.remark.words}** "${p.later}"`,
    '  > check the numbers',
    '',
    `_${p.lang.ui.reply.typed}_`,
    '',
  ].join('\n'));
  assert.deepEqual(await errors(), []);
});

test('with the mode off a selection shows nothing, and the marks stay painted', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`);
  await sleep(300);
  await run('tag(0);');
  await sleep(200);
  await mode(false);
  await run(`pick(${JSON.stringify(p.later)});`);
  await sleep(300);
  assert.equal(await run('return shown(float);'), false);
  assert.equal(await run('return marks().length;'), 1);
  assert.deepEqual(await errors(), []);
});

test('Clear all drops the text marks with the block marks', { skip: SKIP }, async () => {
  await reset();
  await run('pick("Same text one");');
  await sleep(300);
  await run('tag(0);');
  await sleep(200);
  await run(`pick(${JSON.stringify(PAGES.en.later)});`);
  await sleep(300);
  await run('tag(1);');
  await sleep(200);
  assert.equal(await run('return marks().length;'), 2);
  await evaluate(`document.querySelector('.am-btn--remark-clear').click()`);
  await sleep(50);
  await evaluate(`document.querySelector('.am-btn--remark-clear').click()`);
  await sleep(200);
  assert.equal(await run('return marks().length;'), 0);
  assert.deepEqual(await run('return store();'), []);
  assert.deepEqual(await errors(), []);
});
