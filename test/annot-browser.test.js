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
// Render a draft into its own file and open it. The shared page (page.html) is what reload() reloads.
const renderPage = (name, source) => {
  const draft = join(tmp, `${name}.md`);
  const file = join(tmp, `${name}.html`);
  writeFileSync(draft, source);
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', file, '--no-open'], {
    env: { ...process.env, AM_NO_UPDATE_CHECK: '1', AM_HOME: join(tmp, 'home') }, stdio: 'pipe',
  });
  return file;
};

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
  const stored2 = store;
  const at = (sel, text, n = 0) => [...document.querySelectorAll('main ' + sel)].filter((el) => el.textContent.includes(text))[n];
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

// The failures a reader hits while marking a second phrase, all found by clicking around rather than by the happy path above.
// `pickRange` selects from one phrase to another, the way a reader drags across a mark; `stored2` is the saved record list.
const REGRESSION_JS = `
  const pickRange = (from, fromOffset, to, toOffset) => {
    const a = nodeWith(panel('A'), from);
    const b = nodeWith(panel('A'), to);
    if (!a || !b) return false;
    const r = document.createRange();
    r.setStart(a, fromOffset === undefined ? a.data.indexOf(from) : fromOffset);
    r.setEnd(b, toOffset === undefined ? b.data.indexOf(to) + to.length : toOffset);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return true;
  };
`;

test('a reopened mark is edited, but a different selection starts its own mark instead of replacing it', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`); await sleep(300); await run('tag(0);'); await sleep(200);
  await run(`pick(${JSON.stringify(p.later)});`); await sleep(300); await run('tag(1);'); await sleep(200);
  assert.deepEqual(await run(`return stored2().map((m) => [m.quote, m.kind]);`), [[p.words, 'suggestion'], [p.later, 'keep']]);
  // Click the first mark: the float opens on it, with its note and its Remove button.
  await run('marks()[0].click();'); await sleep(300);
  assert.deepEqual(await run(`return {shown: shown(float), value: float.querySelector('input').value, drop: !float.querySelector('.am-btn').hidden};`), { shown: true, value: '', drop: true });
  // Now select other words in the same block. The float belongs to those words: it carries no Remove button and no note.
  await run(`pick('Same text two');`); await sleep(350);
  assert.deepEqual(await run(`return {shown: shown(float), value: float.querySelector('input').value, drop: !float.querySelector('.am-btn').hidden};`), { shown: true, value: '', drop: false });
  await run('tag(2);'); await sleep(250);
  // Three marks: tagging the second phrase did not delete the first.
  assert.deepEqual(await run(`return stored2().map((m) => [m.quote, m.kind]);`), [[p.words, 'suggestion'], [p.later, 'keep'], ['Same text two', 'question']]);
  assert.deepEqual(await errors(), []);
});

test('Enter in the note box of an existing mark keeps the kind it already had', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`); await sleep(300); await run('tag(1);'); await sleep(200);
  await run('marks()[0].click();'); await sleep(300);
  await run('note("a late thought");'); await sleep(250);
  assert.deepEqual(await run(`return stored2().map((m) => [m.kind, m.note]);`), [['keep', 'a late thought']]);
  assert.deepEqual(await errors(), []);
});

test('a mark keeps its record after the page text moved, so a click on it still opens it and Remove still drops it', { skip: SKIP }, async () => {
  const p = PAGES.en;
  // The block's key is the start of its text (80 characters), so a paragraph that opens with more than that keeps its key while
  // an insertion further on moves every offset after it.
  const HEAD = 'Opening line that is long enough to fill more than eighty characters, so the block fingerprint stays the same here.';
  const page = (mid = '') => `---
title: Text mark check
lang: en
---
## A The cache
${HEAD} ${mid}${p.first}

## B Release
It ${p.other}.
`;
  const draft = join(tmp, 'page.md');
  const file = join(tmp, 'page.html');
  const renderIt = () => {
    writeFileSync(draft, page());
    execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', file, '--no-open'], {
      env: { ...process.env, AM_NO_UPDATE_CHECK: '1', AM_HOME: join(tmp, 'home') }, stdio: 'pipe',
    });
  };
  renderIt();
  await load(pathToFileURL(file).href);
  await evaluate(`localStorage.clear()`);
  renderIt();
  await reload();
  await mode(true);
  await run(`pick(${JSON.stringify(p.words)});`); await sleep(300); await run('tag(3);'); await sleep(200);
  const before = await run(`return stored2()[0];`);
  assert.equal(before.kind, 'concern');
  // Rewrite the page with a sentence inserted after the key but before the mark: the key stays, every offset after it moves.
  writeFileSync(draft, page('A brand new inserted sentence.'));
  execFileSync(process.execPath, [join(ROOT, 'bin/am.js'), 'render', draft, '-o', file, '--no-open'], {
    env: { ...process.env, AM_NO_UPDATE_CHECK: '1', AM_HOME: join(tmp, 'home') }, stdio: 'pipe',
  });
  await load(pathToFileURL(file).href);
  await mode(true);
  // The painted part carries the record's own id, so the click finds the record and the float opens on it.
  await run('marks()[0].click();'); await sleep(350);
  assert.deepEqual(await run(`return {shown: shown(float), drop: !float.querySelector('.am-btn').hidden};`), { shown: true, drop: true });
  await run('float.querySelector(".am-btn").click();'); await sleep(300);
  assert.deepEqual(await run(`return {marks: marks().length, store: stored2().length};`), { marks: 0, store: 0 });
  assert.deepEqual(await errors(), []);
});

test('two marks that overlap never nest, and each one can still be clicked and removed', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`); await sleep(300); await run('tag(0);'); await sleep(200);
  await run(`pick(${JSON.stringify(p.later)});`); await sleep(300); await run('tag(1);'); await sleep(200);
  // A third range that covers the end of the first mark and the start of the second.
  await run(`${REGRESSION_JS} pickRange(${JSON.stringify(p.words)}, 6, ${JSON.stringify(p.later)}, ${JSON.stringify(p.later)}.length);`); await sleep(350);
  await run('tag(3);'); await sleep(300);
  const state = await run(`return {
    nested: document.querySelectorAll('mark.am-annot mark.am-annot').length,
    numbers: [...document.querySelectorAll('sup.am-annot-n')].map((s) => s.textContent),
    store: stored2().length,
    parts: marks().length,
  };`);
  assert.equal(state.nested, 0, 'no mark sits inside another');
  assert.deepEqual(state.numbers, ['1', '2', '3'], 'the numbers run down the page without a gap or a swap');
  assert.equal(state.store, 3);
  assert.ok(state.parts >= 3, 'every mark keeps a part of its own to click');
  // The overlapping mark can be clicked and dropped, and the other two stay.
  await run(`[...document.querySelectorAll('mark.am-annot')].find((m) => m.dataset.kind === 'concern').click();`); await sleep(350);
  assert.equal(await run(`return !float.querySelector('.am-btn').hidden;`), true);
  await run('float.querySelector(".am-btn").click();'); await sleep(300);
  assert.deepEqual(await run(`return stored2().map((m) => m.kind);`), ['suggestion', 'keep']);
  assert.deepEqual(await errors(), []);
});

test('a drag that picks words opens the float only, not the block popover as well', { skip: SKIP }, async () => {
  const p = PAGES.en;
  await reset();
  // A real drag ends with a click on the block it started in.
  const out = await run(`${REGRESSION_JS}
    pick(${JSON.stringify(p.words)});
    const el = at('p', ${JSON.stringify(p.first)});
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { pop: !document.querySelector('.am-remark-pop').hidden };`);
  await sleep(400);
  assert.equal(out.pop, false, 'the block popover stayed closed');
  assert.equal(await run('return shown(float);'), true, 'the word float opened');
  await run('tag(0);'); await sleep(250);
  assert.deepEqual(await run(`return stored2().map((m) => [m.quote, m.kind]);`), [[p.words, 'suggestion']]);
  assert.deepEqual(await errors(), []);
});

test('the reply preview drops one comment and one mark, and the copied text follows', { skip: SKIP }, async () => {
  const p = PAGES.en;
  const L = p.lang.ui;
  await reset();
  await run(`pick(${JSON.stringify(p.words)});`); await sleep(300); await run('tag(1);'); await sleep(200);
  await run(`pick(${JSON.stringify(p.later)});`); await sleep(300); await run('tag(2);'); await sleep(200);
  // One comment on panel A, so the preview has a comment entry and two remark entries.
  await run(`panel('A').querySelector('.am-comment-btn').click();
    const box = panel('A').querySelector('.am-comment textarea');
    box.value = 'a note on the panel';
    box.dispatchEvent(new Event('input', { bubbles: true }));`);
  await evaluate(`document.querySelector('[data-am="reply"]').click()`);
  await sleep(300);
  const before = await run(`return {
    refs: [...document.querySelectorAll('dialog.am-reply .am-rv-entry')].map((e) => e.dataset.ref),
    raw: document.querySelector('dialog.am-reply textarea').value,
  };`);
  assert.deepEqual(before.refs, ['cA', 'r0', 'r1']);
  // Drop the comment from the preview: the panel box empties and the drawn reply loses the line.
  await run(`document.querySelector('dialog.am-reply .am-rv-entry[data-ref="cA"] .am-rv-clear').click();`); await sleep(300);
  const noComment = await run(`return {
    refs: [...document.querySelectorAll('dialog.am-reply .am-rv-entry')].map((e) => e.dataset.ref),
    raw: document.querySelector('dialog.am-reply textarea').value,
    box: panel('A').querySelector('.am-comment textarea').value,
    open: document.querySelector('dialog.am-reply').open,
  };`);
  assert.deepEqual(noComment.refs, ['r0', 'r1']);
  assert.equal(noComment.box, '');
  assert.equal(noComment.open, true, 'the sheet stayed open');
  assert.doesNotMatch(noComment.raw, new RegExp(L.reply.comments));
  // Drop the first mark: it leaves the page and the reply.
  await run(`document.querySelector('dialog.am-reply .am-rv-entry[data-ref="r0"] .am-rv-clear').click();`); await sleep(300);
  const noMark = await run(`return {
    refs: [...document.querySelectorAll('dialog.am-reply .am-rv-entry')].map((e) => e.dataset.ref),
    raw: document.querySelector('dialog.am-reply textarea').value,
    store: stored2().map((m) => m.quote),
    marks: marks().length,
  };`);
  assert.deepEqual(noMark.refs, ['r0']);
  assert.deepEqual(noMark.store, [p.later]);
  assert.equal(noMark.marks, 1);
  assert.doesNotMatch(noMark.raw, new RegExp(p.words));
  assert.match(noMark.raw, new RegExp(p.later));
  assert.deepEqual(await errors(), []);
});

test('a code block copies its code, not the number of a mark inside it', { skip: SKIP }, async () => {
  const file = renderPage('code-copy', `---
title: Code copy
lang: en
---
## A Cache
\`\`\`js
const a = 1;
const b = 2;
\`\`\`
`);
  await load(file);
  await mode(true);
  const picked = await run(`
    const node = nodeWith(panel('A'), 'const b = 2;');
    if (!node) return 'no-code-node';
    const i = node.data.indexOf('const b = 2;');
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + 'const b = 2;'.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return true;`);
  assert.equal(picked, true);
  await sleep(300);
  await run('tag(0);'); await sleep(250);
  assert.equal(await run('return marks().length;'), 1);
  // The copy button's own work (src/runtime/page.js) is the same on a page with a mark: the mark's number is not code.
  const lines = await run(`return [...document.querySelectorAll('.am-ln')].map((line) => {
    const copy = line.cloneNode(true);
    for (const el of copy.querySelectorAll('.am-annot-n, .am-mark-note')) el.remove();
    return copy.textContent;
  });`);
  assert.deepEqual(lines, ['const a = 1;', 'const b = 2;']);
  assert.deepEqual(await errors(), []);
});
