// canvas: an infinite board of panels with connections between them. Every panel is a node at an absolute position on a stage the
// reader pans and zooms; the edges come from a `canvas` fence in the intro of the draft and are drawn as SVG curves on a layer
// under the nodes.
//
// Positions are computed here, in Node, so a canvas opens the same way everywhere and can be printed as static markup:
//   - a panel with {x= y=} keeps those coordinates (a reader or an author who wants a fixed arrangement);
//   - every other panel is placed by dagre, the layout engine flow and er already use, from the edge graph;
//   - a panel no edge reaches still gets a place (its own column, so it is not lost under another node).
// The reader's own arrangement lives in the page (src/runtime/canvas-dom.js) and never changes this file.
import dagre from '@dagrejs/dagre';
import { esc } from '../svg/text.js';
import { headHtml, panelHtml } from './panel.js';
import { arrowDefs, f } from '../svg/shapes.js';

// Node width: wide enough for a sentence of prose or a small diagram, narrow enough that four columns fit a laptop screen.
const NODE_W = 340;
const NODE_W_MAX = 900;
const NODE_MIN_H = 90;
// How tall a panel most likely is, before a browser measures it: a title bar plus a line per ~55 characters of text. Only the
// first spread of the board depends on it; a reader who drags a node owns the position from then on.
const estimateHeight = (panel) => {
  const text = String(panel.html ?? '').replace(/<[^>]+>/g, ' ');
  return Math.max(NODE_MIN_H, 46 + Math.ceil(text.trim().length / 55) * 22);
};

// One edge per line: "A -> B" or "A -> B: label". A panel is named by its id (A, B, C …) or, in quotes, by its title.
// An id is a letter, and letters are assigned by position, so inserting a panel above re-letters the ones below it and every
// edge written by letter then points somewhere else. A quoted title does not move, which is what a board that outlives its
// draft wants.
const EDGE_END = /^("(?:[^"\\]|\\.)*"|[A-Z][0-9]{0,2})$/;
const EDGE_LINE = /^(\S.*?)\s*->\s*(\S.*?)\s*(?::\s*(.*))?$/;

// "Text" becomes { title: 'Text' }; A becomes { id: 'A' }.
const refOf = (raw) => (raw.startsWith('"') && raw.endsWith('"')
  ? { title: raw.slice(1, -1).replace(/\\(["\\])/g, '$1') }
  : { id: raw });

export function parseCanvasEdges(text, line = 1) {
  const edges = [];
  String(text)
    .split('\n')
    .forEach((raw, i) => {
      const s = raw.trim();
      if (!s || s.startsWith('//')) return;
      const m = s.match(EDGE_LINE);
      if (!m || !EDGE_END.test(m[1].trim()) || !EDGE_END.test(m[2].trim())) {
        throw new CanvasEdgeError(`"${s}" is not an edge; write "A -> B", "A -> B: label" or use quoted titles`, line + i);
      }
      edges.push({ from: refOf(m[1].trim()), to: refOf(m[2].trim()), label: (m[3] ?? '').trim() });
    });
  return edges;
}

export class CanvasEdgeError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'CanvasEdgeError';
    this.line = line;
  }
}

// A curve from the right edge of `from` to the left edge of `to`, bending horizontally. Anchors are chosen by the relative
// position, so an edge that runs back up the board still leaves and enters on the side that faces the other node.
function edgePath(from, to) {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const rightward = dx >= 0;
  const x1 = rightward ? from.x + from.w : from.x;
  const x2 = rightward ? to.x : to.x + to.w;
  const y1 = from.y + from.h / 2;
  const y2 = to.y + to.h / 2;
  // The curve leaves horizontally, so both control points sit at the same height as their anchor.
  const bend = Math.max(40, Math.min(140, Math.abs(x2 - x1) * 0.5)) * (rightward ? 1 : -1);
  // A near-vertical edge would otherwise run straight through both nodes; the horizontal bend keeps it outside them.
  const lift = Math.abs(dx) < 30 ? Math.sign(dy || 1) * 0 : 0;
  return `M${f(x1)},${f(y1)} C${f(x1 + bend)},${f(y1 + lift)} ${f(x2 - bend)},${f(y2 + lift)} ${f(x2)},${f(y2)}`;
}

// Lay the panels out. `placed` returns, for each panel, its box in stage coordinates.
// {w=520} widens a node: a table or a diagram needs the room, and a board of prose does not.
const widthOf = (panel) => {
  const w = Number(panel.attrs?.w);
  return Number.isFinite(w) && w >= 240 ? Math.min(w, NODE_W_MAX) : NODE_W;
};

const DIRECTIONS = new Set(['LR', 'RL', 'TB', 'BT']);

export function placePanels(panels, edges, direction = 'LR') {
  const rankdir = DIRECTIONS.has(String(direction).toUpperCase()) ? String(direction).toUpperCase() : 'LR';
  const byId = new Map(panels.map((p) => [p.id, p]));
  // A panel with both coordinates keeps them; the rest go through dagre.
  const fixed = new Set(panels.filter((p) => Number.isFinite(p.attrs?.x) && Number.isFinite(p.attrs?.y)).map((p) => p.id));
  const free = panels.filter((p) => !fixed.has(p.id));
  const boxes = new Map();
  for (const id of fixed) {
    const p = byId.get(id);
    boxes.set(id, { x: Number(p.attrs.x), y: Number(p.attrs.y), w: widthOf(p), h: estimateHeight(p) });
  }
  if (free.length) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir, nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const p of free) g.setNode(p.id, { width: widthOf(p), height: estimateHeight(p) });
    // Only edges between two free panels shape the spread: a fixed panel already has its place.
    const freeIds = new Set(free.map((p) => p.id));
    for (const e of edges) {
      if (!freeIds.has(e.from) || !freeIds.has(e.to)) continue;
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      g.setEdge(e.from, e.to, {}, `${e.from}->${e.to}`);
    }
    // A panel no edge reaches is not in dagre's graph; give it a node of its own so it still gets a place.
    for (const p of free) if (g.node(p.id) === undefined) g.setNode(p.id, { width: widthOf(p), height: estimateHeight(p) });
    dagre.layout(g);
    for (const p of free) {
      const n = g.node(p.id);
      if (!n) continue;
      const w = widthOf(p);
      boxes.set(p.id, { x: n.x - w / 2, y: n.y - (n.height ?? NODE_MIN_H) / 2, w, h: n.height ?? NODE_MIN_H });
    }
  }
  // A negative coordinate would be clipped by the stage, so the board is moved into view; coordinates an author wrote keep
  // their value when they are already positive.
  const shiftX = Math.min(0, ...(boxes.size ? [...boxes.values()].map((box) => box.x) : [0]));
  const shiftY = Math.min(0, ...(boxes.size ? [...boxes.values()].map((box) => box.y) : [0]));
  for (const box of boxes.values()) {
    box.x -= shiftX;
    box.y -= shiftY;
  }
  const width = Math.max(...[...boxes.values()].map((b) => b.x + b.w)) + 20;
  const height = Math.max(...[...boxes.values()].map((b) => b.y + b.h)) + 20;
  return { boxes, width, height };
}

// The canvas body: a stage holding one SVG layer of edges and one absolutely positioned node per panel.
export function canvas({ meta, introHtml, panels, ui, language, edges = [] }) {
  const known = new Set(panels.map((p) => p.id));
  // An edge end is an id or a quoted title, which is the stable way to name a panel: a title does not move when the draft grows.
  const idOf = (ref) => {
    if (!ref) return null;
    if (ref.id) return known.has(ref.id) ? ref.id : null;
    const match = panels.filter((p) => p.title === ref.title);
    return match.length === 1 ? match[0].id : null;
  };
  const resolved = edges.map((e) => ({ from: idOf(e.from), to: idOf(e.to), raw: e, label: e.label }));
  const kept = resolved.filter((e) => e.from && e.to);
  const dropped = resolved.filter((e) => !e.from || !e.to).map((e) => ({
    from: e.raw.from.title ?? e.raw.from.id,
    to: e.raw.to.title ?? e.raw.to.id,
  }));
  // direction: LR (left to right, the default) | TB (top to bottom, better for a long chain of panels).
  const { boxes, width, height } = placePanels(panels, kept, meta.dir ?? meta.direction);
  const uid = `c${Math.abs(hash(meta.title ?? '') % 100000)}`;
  // The labels of the board's own controls, one entry per language file (ui.canvas).
  const c = ui?.canvas ?? {};

  const nodes = panels
    .map((p) => {
      const b = boxes.get(p.id) ?? { x: 0, y: 0, w: NODE_W, h: NODE_MIN_H };
      const html = panelHtml(p, { cols: 1, grid: false, folds: meta.collapse === true, drag: false, moveLabel: ui?.move });
      // The port starts a new edge (src/runtime/canvas-dom.js): press it and drop on another panel.
      const port = `<button class="am-canvas-port" type="button" data-am="canvas-port" aria-label="${esc(c.linkFrom ?? 'Link from this panel')}"></button>`;
      return html.replace(
        /^<section class="am-panel/,
        `<section data-box="${f(b.x)} ${f(b.y)}" class="am-canvas-node am-panel`,
      ).replace(/>\n/, ` style="left:${f(b.x)}px;top:${f(b.y)}px;width:${f(b.w)}px">\n${port}`);
    })
    .join('\n');

  const paths = kept
    .map((e) => {
      const a = boxes.get(e.from);
      const b = boxes.get(e.to);
      if (!a || !b) return '';
      const label = e.label
        ? `<text class="am-canvas-edge-label" x="${f((a.x + a.w + b.x) / 2)}" y="${f((a.y + a.h / 2 + b.y + b.h / 2) / 2)}" text-anchor="middle" dominant-baseline="central">${esc(e.label)}</text>`
        : '';
      return `<g class="am-canvas-edge" data-from="panel-${esc(e.from)}" data-to="panel-${esc(e.to)}"><path d="${edgePath(a, b)}" marker-end="url(#${uid}-arrow)"/>${label}</g>`;
    })
    .join('\n');

  // The zoom and edge controls sit in the corner of the viewport. A board can be edited: the port on each node starts an edge,
  // a click selects one, and deviating from the draft is written into this browser until it is copied back (src/runtime/canvas-dom.js).
  const zoomOut = c.zoomOut ?? 'Zoom out';
  const zoomIn = c.zoomIn ?? 'Zoom in';
  const fit = c.fit ?? 'Fit';
  const reset = c.reset ?? 'Reset';
  const copyEdges = c.copyEdges ?? 'Copy edges';
  const drawio = c.drawio ?? 'Export .drawio';
  // The controls live in the viewport, not in the stage: the stage is what the board's transform scales, so a button inside
  // it would be 15px wide at a 16% fit and no one could click it. They are placed once here, before the script moves anything.
  const controls = `<div class="am-canvas-zoom">`
    + `<button class="am-btn" type="button" data-am="canvas-zoom-out" aria-label="${esc(zoomOut)}">−</button>`
    + `<span class="am-btn" data-am="canvas-zoom-value">100%</span>`
    + `<button class="am-btn" type="button" data-am="canvas-zoom-in" aria-label="${esc(zoomIn)}">+</button>`
    + `<button class="am-btn" type="button" data-am="canvas-fit">${esc(fit)}</button>`
    + `<button class="am-btn" type="button" data-am="canvas-copy-edges" hidden>${esc(copyEdges)}</button>`
    + `<button class="am-btn" type="button" data-am="canvas-drawio">${esc(drawio)}</button>`
    + `<button class="am-btn" type="button" data-am="canvas-reset">${esc(reset)}</button>`
    + `</div>`;
  // The minimap: a small picture of the whole board with the part in view marked, so a reader on a board wider than the screen
  // knows where they are and can jump anywhere. The script fills it in (src/runtime/canvas-dom.js).
  const minimap = `<div class="am-canvas-minimap" data-am="canvas-minimap" role="presentation" hidden><svg data-am="canvas-minimap-svg" aria-hidden="true"></svg></div>`;
  return `<main class="am-canvas" data-canvas>
${headHtml(meta, introHtml, language)}
<div class="am-canvas-viewport">
${controls}
${minimap}
<div class="am-canvas-stage" data-canvas-stage style="width:${Math.ceil(width)}px;height:${Math.ceil(height)}px">
<svg class="am-canvas-edges" width="${Math.ceil(width)}" height="${Math.ceil(height)}" aria-hidden="true">${arrowDefs(uid)}
${paths}
</svg>
<div class="am-canvas-nodes">
${nodes}
</div>
</div>
</div>
${dropped.length ? `<p class="am-canvas-dropped">${esc(dropped.map((e) => `${e.from} -> ${e.to}`).join(', '))}</p>` : ''}
</main>`;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return h;
}
