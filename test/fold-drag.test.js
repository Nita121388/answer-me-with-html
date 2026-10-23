// The fold and the drag, as far as they can be checked without a browser: the draft attributes that turn them on, the markup
// they add, and the fact that a page that asks for neither renders exactly as it did before. What only a browser can show (the
// ghost, the slot, the stored order, print) is in test/fold-browser.test.js and test/drag-browser.test.js with AM_E2E=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttrs } from '../src/parse.js';
import { renderDoc } from '../src/render.js';

// The markup of the page without its stylesheet and its script: a rule such as `.am-grip` must not count as a grip.
const markupOf = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*<\/script>/g, '');

// The section tag of each panel, so a check names the panel it is about.
const sections = (html) => [...html.matchAll(/<section class="am-panel[^"]*" id="panel-[\w-]+"/g)].map((m) => m[0]);

test('fold: a bare collapse attribute is true, and =false turns it off', () => {
  assert.deepEqual(parseAttrs('collapse'), { collapse: true });
  assert.deepEqual(parseAttrs('collapse collapsed'), { collapse: true, collapsed: true });
  assert.deepEqual(parseAttrs('collapse=false'), { collapse: false });
  assert.deepEqual(parseAttrs('collapse=off'), { collapse: false });
  assert.deepEqual(parseAttrs('collapse=no'), { collapse: false });
  assert.deepEqual(parseAttrs('collapse=true'), { collapse: true });
  assert.deepEqual(parseAttrs('collapsed=0'), { collapsed: false });
});

test('fold: drag is a page boolean, read the same way', () => {
  assert.equal(parseAttrs('drag').drag, true);
  assert.equal(parseAttrs('drag=false').drag, false);
});

test('fold: a page with collapse: true folds every panel, and {collapse=false} keeps one open', () => {
  const { html } = renderDoc('---\ncols: 2\ncollapse: true\n---\n## A One\ntext\n\n## B Two {collapse=false}\ntext');
  assert.match(sections(html)[0], /am-panel--fold/);
  const second = sections(html)[1];
  assert.doesNotMatch(second, /am-panel--fold/);
  assert.doesNotMatch(second, /am-fold/);
});

test('fold: one panel folds on its own without the page setting', () => {
  const { html } = renderDoc('---\ncols: 2\n---\n## A One\ntext\n\n## B Two {collapse}\ntext');
  assert.doesNotMatch(sections(html)[0], /am-panel--fold/);
  assert.match(sections(html)[1], /am-panel--fold/);
});

test('fold: {collapsed} starts the panel closed; every other fold starts open', () => {
  const { html } = renderDoc('---\ncols: 3\ncollapse: true\n---\n## A One\ntext\n\n## B Two {collapsed}\ntext\n\n## C Three\ntext');
  const details = [...html.matchAll(/<details class="am-fold"([^>]*)>/g)].map((m) => m[1].trim());
  assert.deepEqual(details, ['open', '', 'open']);
});

test('fold: the head becomes the summary, and a bare panel never folds (nothing to click)', () => {
  const { html } = renderDoc('---\ncollapse: true\n---\n## A One\ntext\n\n## B {bare}\ntext');
  const markup = markupOf(html);
  assert.match(markup, /<details class="am-fold" open><summary class="am-panel-head"><span class="am-panel-id">A<\/span>/);
  assert.doesNotMatch(sections(html)[1], /am-panel--fold/);
  assert.match(markup, /<section class="[^"]*am-panel--bare" id="panel-B"[^>]*>\n<div class="am-panel-body">/);
});

test('fold: collapse and drag are page settings, not meta row entries', () => {
  const { html } = renderDoc('---\ncollapse: true\ndrag: true\nsource: x.md\n---\n## A One\ntext');
  const metaRow = html.match(/<div class="am-head-meta">[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(metaRow, /source/);
  assert.doesNotMatch(metaRow, /collapse|drag/);
});

test('drag: a page with drag gets a grip in every panel head, named after the panel', () => {
  const { html } = renderDoc('---\ndrag: true\n---\n## A One\ntext\n\n## B Two\ntext');
  const grips = [...markupOf(html).matchAll(/<button class="am-grip" type="button" data-am="grip" aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(grips, ['Move panel A', 'Move panel B']);
});

test('drag: the grip is inside the summary of a folded panel, so the head is still one click target', () => {
  const { html } = renderDoc('---\ndrag: true\ncollapse: true\n---\n## A One\ntext');
  assert.match(markupOf(html), /<summary class="am-panel-head"><button class="am-grip"[^>]*><\/button><span class="am-panel-id">A<\/span>/);
});

test('drag: a bare panel gets no grip, and a page without drag gets neither grip nor reset button', () => {
  assert.doesNotMatch(markupOf(renderDoc('---\ndrag: true\n---\n## A {bare}\ntext').html), /am-grip/);
  const plain = renderDoc('---\n---\n## A One\ntext').html;
  assert.doesNotMatch(markupOf(plain), /am-grip/);
  assert.doesNotMatch(markupOf(plain), /data-am="reset-order"/);
  assert.match(markupOf(renderDoc('---\ndrag: true\n---\n## A One\ntext').html), /data-am="reset-order"/);
});

test('fold and drag: the page script carries the fold and the drag runtime, and still parses', () => {
  const { html } = renderDoc('---\ndrag: true\ncollapse: true\n---\n## A One\ntext');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  assert.match(script, /am-fold:/);
  assert.match(script, /am-order:/);
  // The CSP pins a hash of exactly this text, so a script that does not parse is a page that renders nothing.
  assert.doesNotThrow(() => new Function(script));
});

test('fold and drag: the stylesheet carries the fold and the grip rules', () => {
  const { html } = renderDoc('---\ndrag: true\ncollapse: true\n---\n## A One\ntext');
  assert.match(html, /\.am-fold > \.am-panel-head::after/);
  assert.match(html, /\.am-fold\[open\] > \.am-panel-head::after/);
  assert.match(html, /@media print \{\s*\.am-fold > \.am-panel-head::after \{ display: none; \}/);
  assert.match(html, /\.am-grip/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});
