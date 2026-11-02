// The text maths of a text annotation (src/runtime/annot-text.js): offsets in a block's page text, the per-segment slices a
// highlight wraps, and the three ways a stored range finds its place in a block that was rendered again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexSegments, joinSegments, offsetAt, sliceAt, quoteAt, relocate } from '../src/runtime/annot-text.js';

// Segments as src/runtime/remark.js walkText produces them: one per text node, the space that starts a line or a cell leading
// the segment it belongs to, a formula already read as its TeX, and the block's note chip left out.
const INDEX = indexSegments([
  { id: 'date', text: '2026 ' },
  { id: 'title', text: 'Ship it' },
  { id: 'math', text: ' $x^2$ ' },
  { id: 'tail', text: 'today' },
]);
const TEXT = '2026 Ship it $x^2$ today';

test('indexSegments: the offsets run on from segment to segment', () => {
  assert.deepEqual(INDEX.map((s) => [s.id, s.start, s.end]), [
    ['date', 0, 5],
    ['title', 5, 12],
    // $x^2$ is five characters, so the formula segment does not add its own length alone: the spaces around it are the ones
    // that stand where a line begins, and they belong to the segments the reader sees.
    ['math', 12, 19],
    ['tail', 19, 24],
  ]);
});

test('joinSegments: the joined text is the block text blockText reads', () => {
  assert.equal(joinSegments(INDEX), TEXT);
  assert.equal(joinSegments(INDEX).length, INDEX.at(-1).end);
});

test('offsetAt: a position inside a segment becomes an offset in the block', () => {
  assert.equal(offsetAt(INDEX, 'title', 0), 5);
  assert.equal(offsetAt(INDEX, 'title', 4), 9);
  assert.equal(offsetAt(INDEX, 'title', 7), 12);
  // A count past the end of the segment, or before its start, is held to the segment.
  assert.equal(offsetAt(INDEX, 'title', 99), 12);
  assert.equal(offsetAt(INDEX, 'title', -3), 5);
  // A node the block no longer has gives no answer rather than a wrong one.
  assert.equal(offsetAt(INDEX, 'gone', 0), null);
});

test('sliceAt: a range becomes one slice per segment it covers', () => {
  assert.deepEqual(sliceAt(INDEX, 7, 10), [{ id: 'title', from: 2, to: 5 }]);
  assert.deepEqual(sliceAt(INDEX, 3, 8), [
    { id: 'date', from: 3, to: 5 },
    { id: 'title', from: 0, to: 3 },
  ]);
  // The start and the end of the block, both segments touched and none empty.
  assert.deepEqual(sliceAt(INDEX, 0, 24).map((p) => p.id), ['date', 'title', 'math', 'tail']);
  // A range that covers nothing, and a range the caller wrote backwards, which reads the same way.
  assert.deepEqual(sliceAt(INDEX, 7, 7), []);
  assert.deepEqual(sliceAt(INDEX, 10, 7), [{ id: 'title', from: 2, to: 5 }]);
  // A range past the end stops at the end.
  assert.deepEqual(sliceAt(INDEX, 19, 999), [{ id: 'tail', from: 0, to: 5 }]);
});

test('quoteAt: the picked text, whitespace collapsed and cut with an ellipsis', () => {
  assert.equal(quoteAt(TEXT, 5, 12), 'Ship it');
  assert.equal(quoteAt(TEXT, 0, 12), '2026 Ship it');
  assert.equal(quoteAt('a   b\n c', 0, 9), 'a b c');
  assert.equal(quoteAt('abcdefghij', 0, 10, 4), 'abcd…');
  // A mark that was written past the end of a shorter text gives what there is, not an error.
  assert.equal(quoteAt('abc', 1, 99), 'bc');
});

test('relocate: the stored offsets still hold the stored text', () => {
  assert.deepEqual(relocate(TEXT, { start: 5, end: 12, quote: 'Ship it' }), [5, 12]);
  // The same text twice: the stored offsets are the only thing that says which one, so they win when they hold.
  assert.deepEqual(relocate('cd and cd', { start: 7, end: 9, quote: 'cd' }), [7, 9]);
});

test('relocate: a block that grew text before the mark is found again by its ring', () => {
  // "2026 " became "2026-01 ", so every offset after it moved by three.
  const text = '2026-01 Ship it $x^2$ today';
  const mark = { start: 8, end: 15, quote: 'Ship it', prefix: '2026 ', suffix: ' $x' };
  assert.deepEqual(relocate(text, mark), [8, 15]);
  assert.equal(text.slice(8, 15), 'Ship it');
});

test('relocate: the ring no longer holds but the text is still unique', () => {
  const text = '2026-01 Ship it $y^2$ today';
  const mark = { start: 8, end: 15, quote: 'Ship it', prefix: '2026 ', suffix: ' $x' };
  assert.deepEqual(relocate(text, mark), [8, 15]);
});

test('relocate: a ring or a text that occurs twice gives no answer', () => {
  const twice = 'Ship it here, Ship it there';
  // The stored offsets no longer hold the text (the mark was made in a block that has since been edited), so only the text
  // itself can answer, and it occurs twice.
  assert.equal(relocate(twice, { start: 0, end: 8, quote: 'Ship it' }), null);
  // A ring that fits both places is just as ambiguous.
  assert.equal(relocate(twice, { start: 0, end: 8, quote: 'Ship it', prefix: '', suffix: '' }), null);
  // While stored offsets that still hold the text are the one answer that is right, even with the text twice on the block.
  assert.deepEqual(relocate(twice, { start: 0, end: 7, quote: 'Ship it' }), [0, 7]);
});

test('relocate: a text the block no longer holds gives no answer', () => {
  assert.equal(relocate(TEXT, { start: 5, end: 12, quote: 'Ship them' }), null);
  assert.equal(relocate(TEXT, { start: 5, end: 12, quote: '' }), null);
  assert.equal(relocate('', { start: 0, end: 1, quote: 'a' }), null);
});

test('relocate: a mark with no stored offsets still finds a unique text', () => {
  assert.deepEqual(relocate(TEXT, { quote: '$x^2$' }), [13, 18]);
});
