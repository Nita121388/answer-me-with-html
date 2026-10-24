// The .drawio writer as a plain module: no browser needed to check the format, which is the point of keeping it out of the page
// script (src/runtime/canvas-drawio.js). The button that uses it is checked in test/canvas-browser.test.js with AM_E2E=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawioXml, drawioLabel, drawioFileName } from '../src/runtime/canvas-drawio.js';

const node = (id, over = {}) => ({ id, title: id.toUpperCase(), body: 'body of ' + id, x: 10, y: 20, w: 300, h: 120, ...over });

test('drawio: the file is an mxfile with one vertex per node and one edge per link', () => {
  const xml = drawioXml({
    title: 'Board',
    nodes: [node('a'), node('b', { x: 400 })],
    edges: [{ from: 'a', to: 'b', label: 'causes' }],
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<mxfile host="answer-me-with-html" type="device">/);
  assert.match(xml, /<diagram name="Board">/);
  assert.equal((xml.match(/vertex="1"/g) ?? []).length, 2);
  assert.equal((xml.match(/edge="1"/g) ?? []).length, 1);
  // The ids are stable and referenced by the edge.
  assert.match(xml, /<mxCell id="n1"[^>]*vertex="1"/);
  assert.match(xml, /<mxCell id="n2"[^>]*vertex="1"/);
  assert.match(xml, /source="n1" target="n2"/);
  assert.match(xml, /value="causes"/);
  // The label is HTML inside an XML attribute: the tags are escaped once for XML and draw.io undoes that layer.
  assert.ok(xml.includes(String.raw`value="&lt;b&gt;A&lt;/b&gt;&lt;br&gt;body of a"`), xml);
});

test('drawio: a node keeps its geometry, rounded to whole pixels', () => {
  const xml = drawioXml({ nodes: [node('a', { x: 12.4, y: 30.6, w: 300.2, h: 120.8 })] });
  assert.match(xml, /<mxGeometry x="12" y="31" width="300" height="121" as="geometry"\/>/);
});

test('drawio: the label is the title in bold, then the body, escaped for an HTML label', () => {
  const label = drawioLabel({ title: 'A <b> & "quoted"', body: 'x < y & z' });
  // drawioLabel returns HTML with its text escaped; drawioXml escapes the whole thing for the attribute.
  assert.equal(label, '<b>A &lt;b&gt; &amp; &quot;quoted&quot;</b><br>x &lt; y &amp; z');
});

test('drawio: a long body is cut, and a panel with no body is just its title', () => {
  const long = drawioLabel({ title: 'T', body: 'x'.repeat(400) });
  assert.ok(long.length < 400, 'the body was cut');
  assert.match(long, /…$/);
  assert.equal(drawioLabel({ title: 'Only' }), '<b>Only</b>');
  assert.equal(drawioLabel({ body: 'no title' }), 'no title');
});

test('drawio: an edge to a node that is not on the board is skipped, and so is a self link', () => {
  const xml = drawioXml({
    nodes: [node('a'), node('b')],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'gone' },
      { from: 'a', to: 'a' },
    ],
  });
  assert.equal((xml.match(/edge="1"/g) ?? []).length, 1);
});

test('drawio: the download name comes from the page title, with the characters a file system refuses removed', () => {
  assert.equal(drawioFileName('K09 · Windows 消息机制与"泵消息"'), 'K09 · Windows 消息机制与-泵消息-.drawio');
  assert.equal(drawioFileName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i.drawio');
  assert.equal(drawioFileName(''), 'board.drawio');
  assert.equal(drawioFileName(undefined), 'board.drawio');
});

test('drawio: an empty board is still a valid file', () => {
  const xml = drawioXml({});
  assert.match(xml, /<mxfile /);
  assert.equal((xml.match(/vertex="1"/g) ?? []).length, 0);
  assert.doesNotMatch(xml, /undefined|NaN/);
});
