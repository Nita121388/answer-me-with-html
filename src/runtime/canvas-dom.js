// The canvas board (src/templates/canvas.js): pan, zoom, a node the reader drags anywhere, and edges the reader edits.
//
// The edges live in one array in this file. The draft declares the starting set; from then on the reader adds one from a node's
// port, deletes one with a click and the Delete key, and renames one with a double click. Every change is drawn from that array,
// so the picture and the data cannot drift apart, and the whole board (positions, view, edges) is kept in this browser until the
// reader copies the edges back into the draft with the Copy edges button.
//
// Nothing here changes the rendered file: a page is still a single HTML file, and the arrangement is a reader's own layer on it.
(() => {
  const viewport = document.querySelector('.am-canvas-viewport');
  const stage = document.querySelector('[data-canvas-stage]');
  if (!viewport || !stage) return;
  const nodes = [...stage.querySelectorAll('.am-canvas-node')];
  if (!nodes.length) return;

  const SVG = 'http://www.w3.org/2000/svg';
  const html = document.documentElement;
  // A node is identified by what it says, not by where it sits. The panel id is assigned by position (A, B, C … in draft order),
  // so keying the board by it would throw the reader's arrangement away whenever a panel is inserted above, removed, or the draft
  // is re-rendered with the letters shifted. The key is the title plus the start of the body; two identical panels get an
  // occurrence number, the same way a marked block is keyed (src/runtime/remark-text.js).
  const textKeyOf = (node) => {
    const title = (node.querySelector('.am-panel-head h2')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const body = (node.querySelector('.am-panel-body')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${title}|${body}`;
  };
  const nodeKeys = new Map();
  const occurrences = new Map();
  for (const node of nodes) {
    const base = textKeyOf(node);
    const n = occurrences.get(base) ?? 0;
    occurrences.set(base, n + 1);
    nodeKeys.set(node, n ? `${base}\t${n}` : base);
  }
  const keyOfNode = (node) => nodeKeys.get(node);
  const nodeByKey = new Map([...nodeKeys].map(([node, key]) => [key, node]));
  const RENDERED = [...nodeKeys.values()];
  // The path, not the panel list: a re-render of the same file is the same board, however its panels moved.
  const storeKey = `am-canvas:${location.pathname}`;

  const MIN_SCALE = 0.1;
  // fit() may go below the zoom range: a long board is shown whole first, and the reader zooms in from there.
  const FIT_MIN = 0.05;
  const MAX_SCALE = 2.5;

  let scale = 1;
  let x = 0;
  let y = 0;

  const apply = () => {
    stage.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    const label = document.querySelector('[data-am="canvas-zoom-value"]');
    if (label) label.textContent = `${Math.round(scale * 100)}%`;
  };

  // Zoom about a point in viewport coordinates, so the board does not jump away from the pointer.
  const zoomTo = (next, px, py) => {
    next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    if (Math.abs(next - scale) < 0.0001) return;
    const r = next / scale;
    x = px - (px - x) * r;
    y = py - (py - y) * r;
    scale = next;
    apply();
  };

  // ---- geometry ----
  const boxOf = (node) => ({
    x: parseFloat(node.style.left) || 0,
    y: parseFloat(node.style.top) || 0,
    w: node.offsetWidth,
    h: node.offsetHeight,
  });
  // The same curve the template draws (src/templates/canvas.js edgePath): out of the side that faces the other node.
  const pathFor = (a, b) => {
    const dx = b.x + b.w / 2 - (a.x + a.w / 2);
    const dy = b.y + b.h / 2 - (a.y + a.h / 2);
    const rightward = dx >= 0;
    const x1 = rightward ? a.x + a.w : a.x;
    const x2 = rightward ? b.x : b.x + b.w;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    const bend = Math.max(40, Math.min(140, Math.abs(x2 - x1) * 0.5)) * (rightward ? 1 : -1);
    const lift = Math.abs(dx) < 30 ? Math.sign(dy || 1) * 0 : 0;
    const f = (n) => Math.round(n * 100) / 100;
    return `M${f(x1)},${f(y1)} C${f(x1 + bend)},${f(y1 + lift)} ${f(x2 - bend)},${f(y2 + lift)} ${f(x2)},${f(y2)}`;
  };
  // The midpoint of the curve, near enough for a label: the midpoint of the two anchors.
  const midOf = (a, b) => ({
    x: (a.x + a.w / 2 + b.x + b.w / 2) / 2,
    y: (a.y + a.h / 2 + b.y + b.h / 2) / 2,
  });

  // ---- the edges ----
  const layer = stage.querySelector('.am-canvas-edges');
  const defs = layer.querySelector('defs')?.outerHTML ?? '';
  const markerRef = defs.match(/id="([^"]+)-arrow"/)?.[1];

  // The draft's own edges: the base. The reader's changes are kept as a diff on top of it (added, removed, renamed), so a
  // re-render that re-derives the base does not throw the diff away — and a panel the agent re-worded does not make the
  // draft's edge disappear just because the edge was stored against the old text.
  const declaredEdges = [...layer.querySelectorAll('.am-canvas-edge')].map((g) => ({
    from: g.dataset.from,
    to: g.dataset.to,
    label: g.querySelector('.am-canvas-edge-label')?.textContent ?? '',
  }));
  // A copy, not the same objects: the reader edits these, and the declared set is the baseline a save compares against.
  let edges = declaredEdges.map((e) => ({ ...e }));
  // An edge is named by the two panels' text keys, so its name survives a letter shift.
  const keyOf = (e) => {
    const a = document.getElementById(e.from);
    const b = document.getElementById(e.to);
    if (!a || !b) return `${e.from}>${e.to}`;
    return `${keyOfNode(a)} -> ${keyOfNode(b)}`;
  };
  // The same edge as the draft declared it, so a later save can tell an added edge from a declared one.
  const declaredKey = (e) => {
    const a = document.getElementById(e.from);
    const b = document.getElementById(e.to);
    if (!a || !b) return null;
    return `${keyOfNode(a)} -> ${keyOfNode(b)}`;
  };
  const declaredByKey = new Map();
  for (const e of declaredEdges) {
    const k = declaredKey(e);
    if (k) declaredByKey.set(k, { ...e });
  }

  const el = (name, attrs) => {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  // Draw every edge from `edges`. Cheap enough to redo on any change: a board has tens of edges, not thousands.
  const renderEdges = () => {
    layer.innerHTML = defs;
    for (const e of edges) {
      const a = document.getElementById(e.from);
      const b = document.getElementById(e.to);
      if (!a || !b) continue;
      const d = pathFor(boxOf(a), boxOf(b));
      const g = el('g', { class: 'am-canvas-edge', 'data-from': e.from, 'data-to': e.to, 'data-key': keyOf(e) });
      g.append(el('path', { class: 'am-canvas-edge-hit', d }));
      g.append(el('path', { d, ...(markerRef ? { 'marker-end': `url(#${markerRef}-arrow)` } : {}) }));
      if (e.label) {
        const m = midOf(boxOf(a), boxOf(b));
        const text = el('text', {
          class: 'am-canvas-edge-label', x: m.x, y: m.y,
          'text-anchor': 'middle', 'dominant-baseline': 'central',
        });
        text.textContent = e.label;
        g.append(text);
      }
      layer.append(g);
    }
    // Keep the selection across a rebuild: selected holds the edge key, so the new group is found by it.
    if (selected) select([...layer.querySelectorAll('.am-canvas-edge')].find((x) => x.dataset.key === selected), true);
  };

  // Only the geometry moved: rewrite the paths and the label places without rebuilding the DOM.
  const redrawEdges = () => {
    for (const g of layer.querySelectorAll('.am-canvas-edge')) {
      const a = document.getElementById(g.dataset.from);
      const b = document.getElementById(g.dataset.to);
      if (!a || !b) continue;
      const d = pathFor(boxOf(a), boxOf(b));
      for (const p of g.querySelectorAll('path')) p.setAttribute('d', d);
      const text = g.querySelector('.am-canvas-edge-label');
      if (text) {
        const m = midOf(boxOf(a), boxOf(b));
        text.setAttribute('x', String(Math.round(m.x)));
        text.setAttribute('y', String(Math.round(m.y)));
      }
    }
  };

  // ---- the selection: one node, several, or none ----
  // A marquee (shift and drag on the empty board) and a click both feed this set; every move applies to all of it, so a
  // reader can take a handful of panels and carry them together.
  const selection = new Set();
  const setSelection = (list, additive = false) => {
    if (!additive) for (const n of selection) n.classList.remove('is-selected');
    if (!additive) selection.clear();
    for (const n of list) {
      selection.add(n);
      n.classList.add('is-selected');
    }
  };
  const clearSelection = () => setSelection([]);
  const nudge = (dx, dy) => {
    if (!selection.size) return false;
    for (const n of selection) {
      n.style.left = `${(parseFloat(n.style.left) || 0) + dx}px`;
      n.style.top = `${(parseFloat(n.style.top) || 0) + dy}px`;
    }
    redrawEdges();
    save();
    return true;
  };

  // Stored by text key, so a re-render that keeps a panel keeps its place and its edges even when its letter changed.
  // The nodes are absolute; the edges are a diff against the draft, so the draft stays the place an edge is declared.
  const save = () => {
    const at = {};
    for (const node of nodes) at[keyOfNode(node)] = { x: parseFloat(node.style.left) || 0, y: parseFloat(node.style.top) || 0 };
    const present = new Set(edges.map((e) => declaredKey(e)).filter(Boolean));
    const removed = [...declaredByKey.keys()].filter((k) => !present.has(k));
    const labels = {};
    for (const e of edges) {
      const k = declaredKey(e);
      if (!k) continue;
      const declared = declaredByKey.get(k);
      if (declared && e.label !== declared.label) labels[k] = e.label;
    }
    const added = edges
      .filter((e) => {
        const k = declaredKey(e);
        return k && !declaredByKey.has(k);
      })
      .map((e) => ({ from: keyOfNode(document.getElementById(e.from)), to: keyOfNode(document.getElementById(e.to)), label: e.label }))
      .filter((e) => e.from && e.to);
    try {
      localStorage.setItem(storeKey, JSON.stringify({ v: 3, nodes: at, view: { x, y, scale }, removed, labels, added }));
    } catch {
      // Storage may be off; the board then lasts until the page closes.
    }
  };
  const load = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey));
      if (!saved || saved.v !== 3 || typeof saved !== 'object') return null;
      const at = saved.nodes && typeof saved.nodes === 'object' ? saved.nodes : {};
      // At least one panel of this render must be in the saved board; the rest is matched one by one.
      if (!RENDERED.some((key) => at[key] && Number.isFinite(at[key].x) && Number.isFinite(at[key].y))) return null;

      const gone = new Set(Array.isArray(saved.removed) ? saved.removed : []);
      const labels = saved.labels && typeof saved.labels === 'object' ? saved.labels : {};
      // The draft's edges, minus the ones the reader deleted, with the labels the reader typed.
      edges = declaredEdges
        .filter((e) => !gone.has(declaredKey(e)))
        .map((e) => ({ ...e, label: Object.prototype.hasOwnProperty.call(labels, declaredKey(e)) ? String(labels[declaredKey(e)]) : e.label }));
      // Then the ones the reader drew, for the panels this render still recognises.
      for (const e of Array.isArray(saved.added) ? saved.added : []) {
        const from = nodeByKey.get(e?.from);
        const to = nodeByKey.get(e?.to);
        if (!from || !to || from.id === to.id) continue;
        if (edges.some((x) => x.from === from.id && x.to === to.id)) continue;
        edges.push({ from: from.id, to: to.id, label: typeof e.label === 'string' ? e.label : '' });
      }
      return saved;
    } catch {
      return null;
    }
  };

  // ---- selecting and deleting ----
  let selected = null;
  const select = (g, on) => {
    if (!g) return;
    g.classList.toggle('is-selected', on);
    selected = on ? g.dataset.key : null;
  };
  const removeSelected = () => {
    if (!selected) return false;
    edges = edges.filter((e) => keyOf(e) !== selected);
    selected = null;
    renderEdges();
    save();
    return true;
  };

  // ---- the label editor ----
  let editing = null;
  const closeEditor = () => {
    editing?.remove();
    editing = null;
  };
  const stageToScreen = (px, py) => ({
    x: px * scale + x,
    y: py * scale + y,
  });
  const editLabel = (g) => {
    const a = document.getElementById(g.dataset.from);
    const b = document.getElementById(g.dataset.to);
    if (!a || !b) return;
    closeEditor();
    const m = midOf(boxOf(a), boxOf(b));
    const at = stageToScreen(m.x, m.y);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'am-canvas-label-input';
    input.value = edges.find((e) => keyOf(e) === g.dataset.key)?.label ?? '';
    input.placeholder = 'label';
    input.style.left = `${Math.round(at.x - 60)}px`;
    input.style.top = `${Math.round(at.y - 14)}px`;
    viewport.append(input);
    input.focus();
    input.select();
    editing = input;
    const commit = (keep) => {
      if (!keep) return closeEditor();
      const value = input.value.trim();
      const edge = edges.find((e) => keyOf(e) === g.dataset.key);
      if (edge) edge.label = value;
      closeEditor();
      renderEdges();
      save();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(false);
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  };

  // A press selects an edge, a double click renames it, and the Delete key removes the selected one. The press is handled
  // here with its propagation stopped: the viewport would otherwise take the pointer capture for a pan and the click would
  // never reach the path.
  layer.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.am-canvas-edge');
    if (!g) return;
    e.stopPropagation();
    select(layer.querySelector('.am-canvas-edge.is-selected'), false);
    select(g, true);
  });
  layer.addEventListener('dblclick', (e) => {
    const g = e.target.closest('.am-canvas-edge');
    if (g) editLabel(g);
  });

  // ---- drawing a new edge ----
  let linking = null; // { from, path }
  const linkPath = el('path', { class: 'am-canvas-link' });
  const stagePoint = (e) => {
    const r = viewport.getBoundingClientRect();
    return { x: (e.clientX - r.left - x) / scale, y: (e.clientY - r.top - y) / scale };
  };
  const startLink = (node, e) => {
    const a = boxOf(node);
    linking = { from: node.id, path: linkPath, start: { x: a.x + a.w, y: a.y + 24 } };
    layer.append(linkPath);
    linkPath.setAttribute('d', pathFor({ ...a }, { x: a.x + a.w + 1, y: a.y + 24, w: 1, h: 1 }));
    moveLink(e);
    html.setAttribute('data-am-linking', '');
    html.setAttribute('data-am-canvas-drag', '');
  };
  const moveLink = (e) => {
    if (!linking) return;
    const p = stagePoint(e);
    const a = linking.start;
    const d = `M${a.x},${a.y} C${a.x + 60},${a.y} ${p.x - 60},${p.y} ${p.x},${p.y}`;
    linking.path.setAttribute('d', d);
  };
  const endLink = (e) => {
    if (!linking) return;
    const from = linking.from;
    linking.path.remove();
    linking = null;
    html.removeAttribute('data-am-linking');
    html.removeAttribute('data-am-canvas-drag');
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.am-canvas-node');
    if (!target || target.id === from) return;
    if (edges.some((edge) => edge.from === from && edge.to === target.id)) return;
    edges.push({ from, to: target.id, label: '' });
    renderEdges();
    save();
  };

  for (const node of nodes) {
    const port = node.querySelector('[data-am="canvas-port"]');
    if (port) {
      port.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        port.setPointerCapture?.(e.pointerId);
        startLink(node, e);
      });
      port.addEventListener('pointermove', moveLink);
      port.addEventListener('pointerup', (e) => {
        try {
          port.releasePointerCapture(e.pointerId);
        } catch {}
        endLink(e);
      });
      port.addEventListener('pointercancel', () => {
        linking?.path.remove();
        linking = null;
        html.removeAttribute('data-am-linking');
    html.removeAttribute('data-am-canvas-drag');
      });
    }
  }

  // ---- moving one node ----
  for (const node of nodes) {
    const head = node.querySelector('.am-panel-head');
    if (!head) continue;
    let moving = false;
    let moveId = null;
    let start = null;
    let moved = false;
    let carried = [];
    // On a board with folds the head is a summary as well as the drag handle, so a press that turns into a move would end as a
    // click on that summary and fold the panel the reader just carried. The flag cancels exactly that one click.
    let cancelFoldClick = false;

    head.addEventListener('click', (e) => {
      if (!cancelFoldClick) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('[data-am="canvas-port"]')) return;
      // Keep the press away from the viewport's pan (the head is a summary on a board with folds).
      e.stopPropagation();
      // A press on a node that is already in the selection carries the whole selection; a press on any other node takes the
      // selection to itself, unless shift adds it to what is already selected.
      if (!selection.has(node)) setSelection([node], e.shiftKey);
      moving = true;
      moved = false;
      moveId = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      carried = [...selection].map((n) => ({ n, left: parseFloat(n.style.left) || 0, top: parseFloat(n.style.top) || 0 }));
      node.setAttribute('data-am-node-moving', '');
      html.setAttribute('data-am-canvas-drag', '');
      head.setPointerCapture?.(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!moving || e.pointerId !== moveId) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      moved = true;
      e.preventDefault();
      // The node lives in stage units, the pointer in screen units: undo the pan and the zoom.
      const dx = (e.clientX - start.x) / scale;
      const dy = (e.clientY - start.y) / scale;
      for (const item of carried) {
        item.n.style.left = `${Math.round(item.left + dx)}px`;
        item.n.style.top = `${Math.round(item.top + dy)}px`;
      }
      redrawEdges();
    });
    const endMove = (e) => {
      if (!moving || e.pointerId !== moveId) return;
      moving = false;
      moveId = null;
      node.removeAttribute('data-am-node-moving');
      html.removeAttribute('data-am-canvas-drag');
      try {
        head.releasePointerCapture(e.pointerId);
      } catch {}
      if (moved) {
        // The click that follows this release belongs to the move, not to the fold.
        cancelFoldClick = true;
        setTimeout(() => { cancelFoldClick = false; }, 60);
      }
      save();
    };
    head.addEventListener('pointerup', endMove);
    head.addEventListener('pointercancel', endMove);

    // The keyboard reaches the board too: focus a node's head and the arrow keys move it.
    head.setAttribute('tabindex', '0');
    head.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      // The keyboard moves the whole selection, like the pointer does.
      if (!selection.has(node)) setSelection([node]);
      nudge(dx, dy);
    });
  }

  // A fold makes a node shorter, so the edges that touch it are drawn again.
  for (const fold of stage.querySelectorAll('.am-fold')) fold.addEventListener('toggle', redrawEdges);

  // ---- panning and the marquee ----
  // A plain drag on the empty board pans it; shift and drag draws a box and selects every node it touches, which is how a
  // reader takes several panels at once. A plain click on the empty board clears the selection.
  let panning = false;
  let panId = null;
  let panFrom = null;
  let box = null;
  let boxFrom = null;
  const boxEl = document.createElement('div');
  boxEl.className = 'am-canvas-marquee';
  boxEl.hidden = true;
  viewport.append(boxEl);

  const boxRect = () => box && {
    left: Math.min(box.from.x, box.to.x), top: Math.min(box.from.y, box.to.y),
    right: Math.max(box.from.x, box.to.x), bottom: Math.max(box.from.y, box.to.y),
  };
  const paintBox = () => {
    const r = boxRect();
    if (!r) return boxEl.hidden = true;
    boxEl.hidden = false;
    boxEl.style.left = `${r.left}px`;
    boxEl.style.top = `${r.top}px`;
    boxEl.style.width = `${r.right - r.left}px`;
    boxEl.style.height = `${r.bottom - r.top}px`;
  };
  // Every node whose box overlaps the marquee, in viewport coordinates.
  const withinBox = () => {
    const r = boxRect();
    if (!r) return [];
    return nodes.filter((n) => {
      const b = n.getBoundingClientRect();
      return b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom;
    });
  };

  viewport.addEventListener('pointerdown', (e) => {
    // A press that starts on a node belongs to the node; a press on an edge selects it (the layer's own handler).
    if (e.button !== 0 || panning || box || e.target.closest('.am-canvas-edge')) return;
    if (e.shiftKey) {
      // Shift extends the selection, so the box starts from what is already selected.
      const r = viewport.getBoundingClientRect();
      box = { from: { x: e.clientX - r.left, y: e.clientY - r.top }, to: { x: e.clientX - r.left, y: e.clientY - r.top }, id: e.pointerId };
      boxFrom = [...selection];
      html.setAttribute('data-am-canvas-drag', '');
      viewport.setPointerCapture?.(e.pointerId);
      paintBox();
      return;
    }
    panning = true;
    panId = e.pointerId;
    panFrom = { x: e.clientX - x, y: e.clientY - y };
    html.setAttribute('data-am-panning', '');
    html.setAttribute('data-am-canvas-drag', '');
    viewport.setPointerCapture?.(e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (box && e.pointerId === box.id) {
      const r = viewport.getBoundingClientRect();
      box.to = { x: e.clientX - r.left, y: e.clientY - r.top };
      gestureMoved = true;
      paintBox();
      setSelection([...new Set([...boxFrom, ...withinBox()])]);
      return;
    }
    if (!panning || e.pointerId !== panId) return;
    gestureMoved = true;
    x = e.clientX - panFrom.x;
    y = e.clientY - panFrom.y;
    apply();
  });
  const endBox = () => {
    box = null;
    boxFrom = null;
    boxEl.hidden = true;
    html.removeAttribute('data-am-canvas-drag');
    redrawEdges();
  };
  const endPan = (e) => {
    if (box && (!e || e.pointerId === box.id)) {
      try {
        viewport.releasePointerCapture(box.id);
      } catch {}
      endBox();
      return;
    }
    if (!panning || e.pointerId !== panId) return;
    panning = false;
    panId = null;
    html.removeAttribute('data-am-panning');
    html.removeAttribute('data-am-canvas-drag');
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {}
    save();
  };
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  // The wheel zooms about the pointer. A trackpad pinch arrives as a wheel with ctrlKey, which is the same gesture to us.
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomTo(scale * Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.0015), e.clientX - r.left, e.clientY - r.top);
    save();
  }, { passive: false });

  // ---- the rest ----
  html.setAttribute('data-canvas-live', '');

  // The edges as draft lines, for the Copy edges button: panel-A becomes A, the id the draft names.
  const shortId = (id) => id.replace(/^panel-/, '');
  const edgeLines = () => edges.map((e) => {
    const line = `${shortId(e.from)} -> ${shortId(e.to)}`;
    return e.label ? `${line}: ${e.label}` : line;
  });

  const copyBtn = document.querySelector('[data-am="canvas-copy-edges"]');
  if (copyBtn) {
    copyBtn.hidden = false;
    copyBtn.addEventListener('click', async () => {
      const text = `\`\`\`canvas\n${edgeLines().join('\n')}\n\`\`\``;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      copyBtn.dataset.done = copyBtn.textContent;
      copyBtn.textContent = '✓';
      setTimeout(() => {
        copyBtn.textContent = copyBtn.dataset.done;
        delete copyBtn.dataset.done;
      }, 1400);
    });
  }

  // ---- export as a .drawio file ----
  // drawioXml is a module (src/runtime/canvas-drawio.js), so the format is tested without a browser; the page gets it with the
  // export keyword dropped, in front of this script (src/runtime/compose.js).
  const readNode = (node) => ({
    id: node.id,
    title: (node.querySelector('.am-panel-head h2')?.textContent ?? '').trim(),
    body: (node.querySelector('.am-panel-body')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    x: parseFloat(node.style.left) || 0,
    y: parseFloat(node.style.top) || 0,
    w: node.offsetWidth,
    h: node.offsetHeight,
  });
  const downloadDrawio = () => {
    const title = document.title || 'board';
    const blob = new Blob([drawioXml({ title, nodes: nodes.map(readNode), edges })], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = drawioFileName(title);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const fit = () => {
    const r = viewport.getBoundingClientRect();
    const w = stage.offsetWidth;
    const h = stage.offsetHeight;
    if (!w || !h) return;
    const next = Math.max(FIT_MIN, Math.min(1, Math.min((r.width - 32) / w, (r.height - 32) / h)));
    scale = next;
    x = (r.width - w * next) / 2;
    y = (r.height - h * next) / 2;
    apply();
    save();
  };
  const reset = () => {
    try {
      localStorage.removeItem(storeKey);
    } catch {}
    location.reload();
  };

  document.querySelector('[data-am="canvas-zoom-in"]')?.addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    zoomTo(scale * 1.2, r.width / 2, r.height / 2);
    save();
  });
  document.querySelector('[data-am="canvas-zoom-out"]')?.addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    zoomTo(scale / 1.2, r.width / 2, r.height / 2);
    save();
  });
  document.querySelector('[data-am="canvas-fit"]')?.addEventListener('click', fit);
  document.querySelector('[data-am="canvas-reset"]')?.addEventListener('click', reset);
  document.querySelector('[data-am="canvas-drawio"]')?.addEventListener('click', downloadDrawio);

  // A plain click on the empty board clears the selection; Escape does the same and also drops a selected edge. The click that
  // ends a marquee or a pan must not clear what the gesture just selected, so a gesture that moved leaves a flag behind.
  let gestureMoved = false;
  viewport.addEventListener('click', (e) => {
    const moved = gestureMoved;
    gestureMoved = false;
    if (moved) return;
    if (e.target.closest('.am-canvas-node') || e.target.closest('.am-canvas-edge')) return;
    clearSelection();
    select(layer.querySelector('.am-canvas-edge.is-selected'), false);
  });

  addEventListener('keydown', (e) => {
    if (editing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && removeSelected()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      clearSelection();
      select(layer.querySelector('.am-canvas-edge.is-selected'), false);
    }
  });

  const saved = load();
  if (saved) {
    // Only the panels the saved board still recognises move: a panel it has never seen keeps the place the build gave it.
    for (const [key, at] of Object.entries(saved.nodes ?? {})) {
      const node = nodeByKey.get(key);
      if (!node || !Number.isFinite(at?.x) || !Number.isFinite(at?.y)) continue;
      node.style.left = `${at.x}px`;
      node.style.top = `${at.y}px`;
    }
    if (saved.view && Number.isFinite(saved.view.x) && Number.isFinite(saved.view.y) && Number.isFinite(saved.view.scale)) {
      x = saved.view.x;
      y = saved.view.y;
      scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, saved.view.scale));
      apply();
    }
  } else {
    fit();
  }
  renderEdges();
  // The nodes' heights settle after the fonts arrive; the edges are drawn from the boxes, so they follow.
  document.fonts?.ready.then(renderEdges);
  addEventListener('resize', renderEdges);
})();
