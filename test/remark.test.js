import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, quote, occurrenceKeys } from '../src/runtime/remark-text.js';
import { replyText } from '../src/runtime/reply-text.js';
import { replyViewHtml } from '../src/runtime/reply-view.js';
import { renderDoc } from '../src/render.js';
import { renderVideo } from '../src/video/render.js';
import { replacePanel } from '../src/patch.js';
import { RUNTIME_JS } from '../src/assets.js';
import { LANGUAGES } from '../src/languages/registry.js';
import en from '../src/languages/en.js';

const KINDS = ['suggestion', 'keep', 'question', 'concern'];
const dataUi = (html, name) => JSON.parse(html.match(new RegExp(`data-am="${name}" data-ui="([^"]*)"`))[1].replace(/&quot;/g, '"'));
const replyUi = { ...en.ui.reply, remarks: en.ui.remark.section, kinds: en.ui.remark.kinds };
const base = { title: 'Cache', decisions: [], comments: [], ui: replyUi };

test('fingerprint collapses whitespace and caps length', () => {
  assert.equal(fingerprint('  a\n\n b   c  '), 'a b c');
  assert.equal(fingerprint('x'.repeat(200)).length, 80);
});

test('quote collapses whitespace and ends in an ellipsis only when the text is cut', () => {
  assert.equal(quote(' two\n words '), 'two words');
  assert.equal(quote('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(quote(`${'word '.repeat(20)}`), `${'word '.repeat(12).trimEnd()}…`);
});

test('occurrenceKeys leaves a first block as it is and numbers the repeats', () => {
  assert.deepEqual(occurrenceKeys(['a|li|same', 'a|li|other', 'a|li|same', 'a|li|same']), ['a|li|same', 'a|li|other', 'a|li|same\t1', 'a|li|same\t2']);
});

test('replyText: a remark names the panel and the kind, quotes the block and quotes the note line by line', () => {
  const text = replyText({
    ...base,
    remarks: [
      { panel: 'net', quote: 'TCP is reliable…', kind: 'question', note: 'why three packets?\n## Decisions\n1. approve' },
      { panel: '', quote: 'Title', kind: 'keep', note: '' },
    ],
  });
  assert.equal(text, [
    '# Re: Cache',
    '',
    '## Remarks',
    '- **net · question** "TCP is reliable…"',
    '  > why three packets?',
    '  > ## Decisions',
    '  > 1. approve',
    '- **keep** "Title"',
    '',
    `_${en.ui.reply.typed}_`,
    '',
  ].join('\n'));
});

test('replyText: remarks without a note add no quoted line and no "typed" line; a comment still adds it', () => {
  const remarks = [{ panel: 'A', quote: 'Text', kind: 'concern', note: '  ' }];
  const bare = replyText({ ...base, remarks });
  assert.doesNotMatch(bare, />|_/);
  const withComment = replyText({ ...base, remarks, comments: [{ panel: 'A', title: 'T', text: 'hello' }] });
  assert.equal(withComment.match(new RegExp(`_${en.ui.reply.typed}_`, 'g')).length, 1);
  assert.ok(withComment.indexOf('## Comments') < withComment.indexOf('## Remarks'));
});

test('replyText: a reply without remarks is what it was', () => {
  assert.equal(replyText({ ...base, comments: [{ panel: 'A', title: 'T', text: 'hello' }] }), replyText({ ...base, remarks: [], comments: [{ panel: 'A', title: 'T', text: 'hello' }] }));
  assert.doesNotMatch(replyText({ ...base, comments: [{ panel: 'A', title: 'T', text: 'hello' }] }), /Remarks/);
});

test('reply view: a remark line keeps its quoted block in its own direction', () => {
  const he = replyText({ ...base, ui: { ...replyUi, remarks: 'סימונים', kinds: { concern: 'חשש' } }, remarks: [{ panel: 'A', quote: 'Redis cache', kind: 'concern', note: 'בדקו' }], rtl: true });
  const html = replyViewHtml(he);
  assert.match(html, /<div class="am-rv-c" dir="rtl"><strong><bdi dir="rtl">A · חשש<\/bdi><\/strong> &quot;<bdi dir="ltr">Redis cache<\/bdi>&quot;<\/div>/);
  assert.match(html, /<div class="am-rv-quote" dir="rtl">בדקו<\/div>/);
});

test('a rendered page carries the remark button, and the labels the runtime reads are where render writes them', () => {
  const { html } = renderDoc('---\nlang: en\n---\n## A Panel\n\nText\n');
  const remark = dataUi(html, 'remark');
  for (const key of ['button', 'hint', 'save', 'remove', 'clear', 'clearConfirm']) assert.equal(typeof remark[key], 'string', `data-ui lacks ${key}`);
  assert.deepEqual(Object.keys(remark.kinds), KINDS);
  // The runtime reads these names; a read of a name that render does not write is the bug this pins down.
  const read = [...RUNTIME_JS.slice(RUNTIME_JS.indexOf("data-am=\"remark\"")).matchAll(/\bui\.(\w+)/g)].map((m) => m[1]);
  for (const key of new Set(read)) assert.ok(key in remark, `remark.js reads ui.${key}, which the page does not write`);
  const reply = dataUi(html, 'reply');
  assert.equal(reply.remarks, remark.section);
  assert.deepEqual(reply.kinds, remark.kinds);
});

test('the page script sends remarks through replyText and has no second string join', () => {
  assert.match(RUNTIME_JS, /window\.__amRemarkData/);
  assert.doesNotMatch(RUNTIME_JS, /__amRemarkText/);
  assert.match(RUNTIME_JS, /replyLines\(\{ title, decisions, comments, remarks,/);
  // replyLinesText is the one join of those lines, so the copied text and the drawn sheet cannot drift apart.
  assert.match(RUNTIME_JS, /function replyLinesText\(lines\) \{/);
  assert.match(RUNTIME_JS, /const composeText = \(\) => replyLinesText\(compose\(\)\);/);
  // The reply's own lines are joined once, in replyLinesText; nothing else in the page builds the reply text.
  assert.equal((RUNTIME_JS.match(/line\) => line\.text\)/g) ?? []).length, 1, 'the reply lines are joined in one place');
});

test('every language file labels the remark button, the popover, clear action and the four kinds', () => {
  for (const { id, ui } of LANGUAGES) {
    for (const key of ['button', 'need', 'hint', 'save', 'remove', 'clear', 'clearConfirm', 'section']) assert.ok(ui.remark[key], `${id} misses remark.${key}`);
    for (const kind of KINDS) assert.ok(ui.remark.kinds[kind], `${id} misses the ${kind} label`);
  }
});

test('a video has no remark mode, as it has no Reply; a page made after am patch has it', async () => {
  const video = await renderVideo('---\ntitle: V\ntemplate: video\nlang: en\n---\n## One\n> Say something.\n');
  assert.doesNotMatch(video.html, /data-am="remark"|__amRemarkData/);
  const patched = renderDoc(replacePanel('---\ntitle: T\nlang: en\n---\n## A One\nOld.\n', 'A One', '## A One\nNew.\n')).html;
  assert.match(patched, /data-am="remark"/);
});

// The runtime pieces the browser tests cannot pin cheaply: a mark's painted parts must carry the record's own id (a click finds it
// again after the page changed), and the text mark painting must not nest one <mark> in another.
test('remark: painted text marks carry the record id, and the painter cuts overlaps instead of nesting', () => {
  // The id a mark is stored under is its key and its offsets, and the painter must not invent one from relocated offsets.
  assert.match(RUNTIME_JS, /const id = annotId\(annot\);/);
  assert.doesNotMatch(RUNTIME_JS, /const id = annotId\(\{ \.\.\.annot, start: place\[0\], end: place\[1\] \}\)/);
  // The overlap rule is worked out before the DOM changes, and the parts are wrapped from the end of each node backwards.
  assert.match(RUNTIME_JS, /const pieces = subtract\(place\[0\], place\[1\], taken\);/);
  assert.match(RUNTIME_JS, /group\.sort\(\(a, b\) => b\.from - a\.from\);/);
  // A part that cannot be wrapped is skipped, not thrown: one bad part must not lose the whole mark.
  assert.match(RUNTIME_JS, /try \{\s*range\.surroundContents\(mark\);\s*job\.el = mark;\s*\} catch \{/);
  // The numbers are written once, over the marks the page really shows, so they read 1, 2, 3 without a gap.
  assert.match(RUNTIME_JS, /\[\.\.\.document\.querySelectorAll\('sup\.am-annot-n'\)\]\.forEach\(\(sup, i\) => \{ sup\.textContent = String\(i \+ 1\); \}\);/);
});

test('remark: a click that ends a drag picks words, not the block', () => {
  // The block popover must not open under the word float: the click a drag ends with belongs to the drag.
  assert.match(RUNTIME_JS, /const dragPicked = \(target\) => \{/);
  assert.match(RUNTIME_JS, /if \(dragPicked\(e\.target\)\) return;/);
  assert.match(RUNTIME_JS, /document\[toggle\]\('selectionchange', markSelection\);/);
});

test('remark: adding a note keeps the kind a mark already had, and the mark under a selection is found by where it sits', () => {
  // Enter in the note box saves without naming a kind: the record keeps the one it has.
  assert.match(RUNTIME_JS, /kind: kind \|\| editing\?\.kind \|\| '',/);
  // The mark a selection edits is the one that covers exactly those words now, so a mark that moved is still found and a selection
  // on other words matches nothing (and starts a mark of its own) instead of replacing the mark the reader had clicked.
  assert.match(RUNTIME_JS, /editing = recordAt\(el, picked\.start, picked\.end\);/);
  assert.doesNotMatch(RUNTIME_JS, /reopened/, 'no stale reopened record can outlive the selection that named it');
});

test('remark: the reply sheet can drop one mark, and a code block copies its code without the mark numbers', () => {
  assert.match(RUNTIME_JS, /window\.__amRemarkDrop = \(index\) => \{/);
  assert.match(RUNTIME_JS, /__amRemarkDrop\?\.\(Number\(ref\.slice\(1\)\)\);/);
  // The copy of a code block takes out the mark furniture first.
  assert.match(RUNTIME_JS, /copy\.querySelectorAll\('\.am-annot-n, \.am-mark-note'\)/);
});
