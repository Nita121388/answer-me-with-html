// The canvas board (src/templates/canvas.js): pan, zoom, and a node that the reader drags anywhere.
//
// The edges are drawn here as well as in the markup: the build draws them once from the layout it computed, and every move of a
// node redraws the ones that touch it. A redraw is one path attribute, so the whole board keeps up with the pointer.
//
// The arrangement lives in this browser under one key, built from the node ids the page rendered, so a page whose panels changed
// keeps its own layout instead of reading a stale one.
(() => {
  const viewport = document.querySelector('.am-canvas-viewport');
  const stage = document.querySelector('[data-canvas-stage]');
  if (!viewport || !stage) return;
  const nodes = [...stage.querySelectorAll('.am-canvas-node')];
  if (!nodes.length) return;

  const html = document.documentElement;
  const ids = () => nodes.map((n) => n.id);
  const RENDERED = ids().map((id) => id);
  const storeKey = `am-canvas:${location.pathname}:${RENDERED.join(',')}`;

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 2.5;

  let scale = 1;
  let x = 0;
  let y = 0;

  const apply = () => {
    stage.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    const zoomLabel = document.querySelector('[data-am="canvas-zoom-value"]');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
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

  // ---- the arrangement ----
  const positions = () => {
    const out = {};
    for (const n of nodes) out[n.id] = { x: parseFloat(n.style.left) || 0, y: parseFloat(n.style.top) || 0 };
    return out;
  };
  const saveArrangement = () => {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ nodes: positions(), view: { x, y, scale } }));
    } catch {
      // Storage may be off; the arrangement then lasts until the page closes.
    }
  };
  const loadArrangement = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey));
      if (!saved || typeof saved !== 'object') return null;
      const my = RENDERED;
      const at = saved.nodes && typeof saved.nodes === 'object' ? saved.nodes : {};
      if (!my.every((id) => at[id] && Number.isFinite(at[id].x) && Number.isFinite(at[id].y))) return null;
      return saved;
    } catch {
      return null;
    }
  };

  // ---- edges ----
  const edgeGroups = [...stage.querySelectorAll('.am-canvas-edge')];
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
  const drawEdges = () => {
    for (const g of edgeGroups) {
      const a = document.getElementById(g.dataset.from);
      const b = document.getElementById(g.dataset.to);
      if (!a || !b) continue;
      const path = g.querySelector('path');
      const label = g.querySelector('.am-canvas-edge-label');
      path.setAttribute('d', pathFor(boxOf(a), boxOf(b)));
      if (label) {
        const ba = boxOf(a);
        const bb = boxOf(b);
        label.setAttribute('x', String(Math.round((ba.x + ba.w + bb.x) / 2)));
        label.setAttribute('y', String(Math.round((ba.y + ba.h / 2 + bb.y + bb.h / 2) / 2)));
      }
    }
  };

  // ---- panning ----
  let panning = false;
  let panId = null;
  let panFrom = null;
  viewport.addEventListener('pointerdown', (e) => {
    // A press that starts on a node belongs to the node; the node handler stops it there.
    if (e.button !== 0 || panning) return;
    panning = true;
    panId = e.pointerId;
    panFrom = { x: e.clientX - x, y: e.clientY - y };
    html.setAttribute('data-am-panning', '');
    viewport.setPointerCapture?.(e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panId) return;
    x = e.clientX - panFrom.x;
    y = e.clientY - panFrom.y;
    apply();
  });
  const endPan = (e) => {
    if (!panning || e.pointerId !== panId) return;
    panning = false;
    panId = null;
    html.removeAttribute('data-am-panning');
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {}
    saveArrangement();
  };
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  // The wheel zooms about the pointer. A trackpad pinch arrives as a wheel with ctrlKey, which is the same gesture to us.
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomTo(scale * Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.0015), e.clientX - r.left, e.clientY - r.top);
    saveArrangement();
  }, { passive: false });

  // ---- moving one node ----
  for (const node of nodes) {
    const head = node.querySelector('.am-panel-head');
    if (!head) continue;
    let moving = false;
    let moveId = null;
    let grab = null;
    let start = null;

    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Keep the press away from the viewport's pan and from a fold toggle (the head is a summary on a canvas with folds).
      e.stopPropagation();
      moving = true;
      moveId = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      grab = { dx: e.clientX - left * scale - x, dy: e.clientY - top * scale - y };
      node.setAttribute('data-am-node-moving', '');
      head.setPointerCapture?.(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!moving || e.pointerId !== moveId) return;
      e.preventDefault();
      // The node lives in stage units, the pointer in screen units: undo the pan and the zoom.
      node.style.left = `${Math.round((e.clientX - grab.dx - x) / scale)}px`;
      node.style.top = `${Math.round((e.clientY - grab.dy - y) / scale)}px`;
      drawEdges();
    });
    const endMove = (e) => {
      if (!moving || e.pointerId !== moveId) return;
      moving = false;
      moveId = null;
      node.removeAttribute('data-am-node-moving');
      try {
        head.releasePointerCapture(e.pointerId);
      } catch {}
      saveArrangement();
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
      node.style.left = `${(parseFloat(node.style.left) || 0) + dx}px`;
      node.style.top = `${(parseFloat(node.style.top) || 0) + dy}px`;
      drawEdges();
      saveArrangement();
    });
  }

  // ---- the rest ----
  html.setAttribute('data-canvas-live', '');

  const fit = () => {
    const r = viewport.getBoundingClientRect();
    const w = stage.offsetWidth;
    const h = stage.offsetHeight;
    if (!w || !h) return;
    const next = Math.max(MIN_SCALE, Math.min(1, Math.min((r.width - 32) / w, (r.height - 32) / h)));
    scale = next;
    x = (r.width - w * next) / 2;
    y = (r.height - h * next) / 2;
    apply();
    saveArrangement();
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
    saveArrangement();
  });
  document.querySelector('[data-am="canvas-zoom-out"]')?.addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    zoomTo(scale / 1.2, r.width / 2, r.height / 2);
    saveArrangement();
  });
  document.querySelector('[data-am="canvas-fit"]')?.addEventListener('click', fit);
  document.querySelector('[data-am="canvas-reset"]')?.addEventListener('click', reset);

  const saved = loadArrangement();
  if (saved) {
    for (const n of nodes) {
      const at = saved.nodes[n.id];
      if (!at) continue;
      n.style.left = `${at.x}px`;
      n.style.top = `${at.y}px`;
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
  drawEdges();
  // The nodes' heights settle after the fonts arrive; the edges are drawn from the boxes, so they follow.
  document.fonts?.ready.then(drawEdges);
  addEventListener('resize', drawEdges);
})();
