// The canvas template without a browser: the edges it reads from the draft, the placement dagre computes, and the fact that a
// canvas page carries the canvas script and its stylesheet while a sheet page does not. The runtime itself (pan, zoom, moving a
// node) is in test/canvas-browser.test.js with AM_E2E=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCanvasEdges, placePanels, CanvasEdgeError } from '../src/templates/canvas.js';
import { renderDoc } from '../src/render.js';

const P = (id, x, y) => ({ id, attrs: x === undefined ? {} : { x, y }, html: 'x' });

test('canvas edges: A -> B and A -> B: label parse; comments and blank lines are ignored', () => {
  assert.deepEqual(parseCanvasEdges('// a note\n\nA -> B\nB -> C: 依赖'), [
    { from: { id: 'A' }, to: { id: 'B' }, label: '' },
    { from: { id: 'B' }, to: { id: 'C' }, label: '依赖' },
  ]);
});

test('canvas edges: a quoted title names a panel without its letter, so an inserted panel cannot move the edge', () => {
  assert.deepEqual(parseCanvasEdges('"输入" -> "中间": 依据'), [
    { from: { title: '输入' }, to: { title: '中间' }, label: '依据' },
  ]);
});

test('canvas edges: a line that is not an edge names its line and the expected form', () => {
  assert.throws(() => parseCanvasEdges('A -> B\nA B C', 4), (e) => e instanceof CanvasEdgeError && e.line === 5 && /A -> B/.test(e.message));
  assert.throws(() => parseCanvasEdges('a -> b', 1), (e) => e instanceof CanvasEdgeError);
});

test('canvas placement: panels with x and y keep their coordinates', () => {
  const { boxes } = placePanels([P('A', 10, 20), P('B', 500, 90)], []);
  assert.deepEqual(boxes.get('A'), { x: 10, y: 20, w: 340, h: 90 });
  assert.deepEqual(boxes.get('B'), { x: 500, y: 90, w: 340, h: 90 });
});

test('canvas placement: free panels are laid out left to right along the edges', () => {
  const { boxes, width, height } = placePanels([P('A'), P('B'), P('C')], [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
  ]);
  assert.ok(boxes.get('A').x < boxes.get('B').x, `A left of B: ${JSON.stringify([boxes.get('A'), boxes.get('B')])}`);
  assert.ok(boxes.get('B').x < boxes.get('C').x, 'B left of C');
  // A board never starts at a negative coordinate, and its box covers every node.
  assert.ok(Math.min(...[...boxes.values()].map((b) => b.x)) >= 0);
  assert.ok(width >= Math.max(...[...boxes.values()].map((b) => b.x + b.w)));
  assert.ok(height >= Math.max(...[...boxes.values()].map((b) => b.y + b.h)));
});

test('canvas placement: a panel no edge reaches still gets a place', () => {
  const { boxes } = placePanels([P('A'), P('B'), P('Z')], [{ from: 'A', to: 'B' }]);
  assert.ok(boxes.has('Z') && Number.isFinite(boxes.get('Z').x), 'Z was placed');
});

test('canvas: a canvas page renders the stage, the edges and the zoom controls', () => {
  const { html } = renderDoc(['---', 'title: Board', 'template: canvas', 'lang: en', '---', '```canvas', 'A -> B: causes', 'B -> C', '```', 'Lead.', '', '## A One', 'Text.', '', '## B Two', 'Text.', '', '## C Three', 'Text.'].join('\n'));
  assert.match(html, /<main class="am-canvas" data-canvas>/);
  const markup = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*<\/script>/g, '');
  assert.equal((markup.match(/class="am-canvas-node /g) || []).length, 3, 'one node per panel');
  assert.equal((markup.match(/class="am-canvas-edge"/g) || []).length, 2);
  assert.equal((markup.match(/am-canvas-edge-label/g) || []).length, 1, 'only the edge with a label carries one');
  assert.match(html, /data-am="canvas-zoom-in"/);
  assert.match(html, /data-am="canvas-reset"/);
  // The canvas fence is consumed by the template and not rendered as a code block (it is in #am-source, as always).
  assert.doesNotMatch(markup, /class="am-codeblock/);
  assert.match(html, /<h1>Board<\/h1>/);
  assert.match(html, /Lead\./);
});

test('canvas: the page carries the canvas stylesheet and the canvas script, and a sheet page does not', () => {
  const canvas = renderDoc(['---', 'template: canvas', '---', '```canvas', 'A -> B', '```', '## A One', 'x', '', '## B Two', 'x'].join('\n')).html;
  const sheet = renderDoc('---\n---\n## A One\nx').html;
  assert.match(canvas, /\.am-canvas-viewport/);
  assert.match(canvas, /\.am-canvas-edges/);
  assert.match(canvas, /am-canvas:/);
  assert.doesNotMatch(sheet, /\.am-canvas-viewport/);
  assert.doesNotMatch(sheet, /am-canvas:/);
});

test('canvas: a canvas page without a canvas fence fails with a line of its own', () => {
  assert.throws(() => renderDoc('---\ntemplate: canvas\n---\n## A One\nx'), /a canvas page needs its edges/);
});

test('canvas: an edge that names a panel the page does not have is reported, not silently drawn', () => {
  const { html } = renderDoc(['---', 'template: canvas', '---', '```canvas', 'A -> B', 'A -> Z', '```', '## A One', 'x', '', '## B Two', 'x'].join('\n'));
  assert.equal((html.match(/class="am-canvas-edge"/g) || []).length, 1, 'only the edge between two real panels is drawn');
  assert.match(html, /A -&gt; Z/, 'the dropped edge is named on the page');
});

test('canvas: the page script parses, since the CSP pins a hash of its exact text', () => {
  const { html } = renderDoc(['---', 'template: canvas', '---', '```canvas', 'A -> B', '```', '## A One', 'x', '', '## B Two', 'x'].join('\n'));
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  assert.doesNotThrow(() => new Function(script));
});
