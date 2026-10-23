// Moving a panel (sheet pages with `drag: true`). The panel is reordered inside .am-grid; the sheet layout then plans its rows
// from the new reading order, so the width of every panel is still the planner's work and print still falls back to the plain
// CSS grid (src/runtime/layout-dom.js). The order is kept in this browser under one key, built from the panel ids the page
// rendered, so a later `am patch` that adds or removes a panel does not read a stale order.
//
// Two ways to move a panel, both starting at the grip button in the panel head:
//   pointer   pointerdown on a grip, move past 4 px, then pointerup. The panel becomes a fixed ghost that follows the pointer and
//             a dashed slot shows where it will land. Escape cancels.
//   keyboard  the grip is a button: focus it and press the arrow keys. Enter/Space is not used, so the button keeps its own
//             activation behaviour.
//
// No library. The page script is one inlined file with no imports (src/runtime/compose.js) and the page's Content-Security-Policy
// allows no remote content, so a drag library would have to be vendored into the bundle: Sortable's minified build is about 45 KB
// for a grid that is not a flat list, and it owns the DOM that layout-dom rewrites on every pass. Pointer events do this in less
// than a tenth of that and give the keyboard path for free.
(() => {
  const grid = document.querySelector('.am-grid');
  if (!grid) return;
  const grips = [...grid.querySelectorAll('[data-am="grip"]')];
  if (!grips.length) return;

  const panels = () => [...grid.querySelectorAll('.am-panel')];
  const ids = () => panels().map((p) => p.id);
  // The order the page rendered, read once: it is the key an order is stored under. Any other order is the reader's.
  const RENDERED = ids();
  const storeKey = `am-order:${location.pathname}:${RENDERED.join(',')}`;

  const save = (order) => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(order));
    } catch {
      // Storage may be off (a sandboxed `am serve` page, a private window): the order lasts until the page closes.
    }
  };
  const load = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey));
      if (!Array.isArray(saved) || saved.length !== RENDERED.length) return null;
      // Every id exactly once: a stored order from a page that changed under it is dropped, not half applied.
      return RENDERED.every((id) => saved.includes(id)) ? saved : null;
    } catch {
      return null;
    }
  };

  // Put the panels in `order`. The layout adapter stacks two panels into one .am-col box; a box has to be unwrapped first, since
  // the planner unwraps it on its next pass anyway and a panel left inside one would be moved inside the wrong row.
  const apply = (order) => {
    for (const box of grid.querySelectorAll(':scope > .am-col')) box.replaceWith(...box.children);
    for (const id of order) {
      const el = panels().find((p) => p.id === id);
      if (el) grid.append(el);
    }
    // One event for both the reader's move and the restore at load: the adapter plans the order it now finds.
    window.dispatchEvent(new Event('am-replan'));
  };

  const resetOrder = () => {
    try {
      localStorage.removeItem(storeKey);
    } catch {}
    apply(RENDERED);
    window.dispatchEvent(new Event('am-order-reset'));
  };

  // ---- pointer ----
  let moving = null;
  let slot = null;
  let grip = null;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let grabX = 0; // where inside the panel the pointer started
  let grabY = 0;
  let dragging = false;
  let savedStyle = null;

  // The row the pointer is over, and whether the panel lands before the panel under it. With no row under the pointer (above or
  // below the sheet) the panel goes to the start or the end.
  const landingOf = (x, y) => {
    const rest = panels().filter((p) => p !== moving);
    if (!rest.length) return { before: null, at: 'end' };
    const rows = [];
    for (const p of rest) {
      const r = p.getBoundingClientRect();
      const row = rows.find((v) => y >= v.top && y <= v.bottom && r.top === v.top);
      if (row) row.panels.push({ el: p, r });
      else rows.push({ top: r.top, bottom: r.bottom, panels: [{ el: p, r }] });
    }
    const row = rows.find((v) => y >= v.top && y <= v.bottom);
    if (!row) {
      const below = rest.find((p) => p.getBoundingClientRect().top > y);
      return below ? { before: below } : { before: null, at: 'end' };
    }
    const hit = row.panels.find(({ r }) => x < r.left + r.width / 2);
    return hit ? { before: hit.el } : { before: null, at: 'start-of-next-row', row };
  };

  const sizeSlot = (from) => {
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'am-drop-slot';
      slot.setAttribute('aria-hidden', 'true');
    }
    slot.style.width = `${from.width}px`;
    slot.style.height = `${from.height}px`;
    return slot;
  };

  const placeSlot = (x, y) => {
    const from = moving.getBoundingClientRect();
    const el = sizeSlot(from);
    const { before, at } = landingOf(x, y);
    if (before) before.before(el);
    else if (at === 'end') grid.append(el);
    else {
      // Past the last panel of a row: land at the end of that row, before the first panel of the next one.
      const row = panels().filter((p) => p !== moving).find((p) => p.getBoundingClientRect().top > y);
      if (row) row.before(el);
      else grid.append(el);
    }
  };

  const follow = (x, y) => {
    moving.style.left = `${x - grabX}px`;
    moving.style.top = `${y - grabY}px`;
  };

  const startDrag = (event) => {
    const panel = grip.closest('.am-panel');
    const r = panel.getBoundingClientRect();
    savedStyle = panel.getAttribute('style');
    startX = event.clientX;
    startY = event.clientY;
    grabX = event.clientX - r.left;
    grabY = event.clientY - r.top;
    pointerId = event.pointerId;
    dragging = false;
    moving = panel;
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {}
  };

  const begin = (event) => {
    if (dragging) return;
    dragging = true;
    const r = moving.getBoundingClientRect();
    document.documentElement.setAttribute('data-am-dragging', '');
    moving.classList.add('am-panel--moving');
    // The ghost leaves the flow so the pointer can carry it anywhere; the slot keeps the space it left behind.
    moving.style.position = 'fixed';
    moving.style.left = `${r.left}px`;
    moving.style.top = `${r.top}px`;
    moving.style.width = `${r.width}px`;
    moving.style.height = `${r.height}px`;
    moving.style.margin = '0';
    moving.style.zIndex = '20';
    moving.style.pointerEvents = 'none';
    follow(event.clientX, event.clientY);
    placeSlot(event.clientX, event.clientY);
  };

  const moveTo = (event) => {
    if (!moving || event.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
    if (!dragging) begin(event);
    follow(event.clientX, event.clientY);
    placeSlot(event.clientX, event.clientY);
  };

  const finish = (cancel) => {
    if (!moving) return;
    const panel = moving;
    const order = slot
      ? [...grid.querySelectorAll(':scope > .am-panel, :scope > .am-col > .am-panel, .am-drop-slot')]
          .map((el) => (el === slot ? panel : el))
          .map((el) => el.id)
      : ids();
    const didDrag = dragging;
    // The ghost styles come off whether or not the move happened; the planner's own styles are put back as they were.
    if (savedStyle === null) panel.removeAttribute('style');
    else panel.setAttribute('style', savedStyle);
    panel.classList.remove('am-panel--moving');
    slot?.remove();
    slot = null;
    moving = null;
    grip = null;
    pointerId = null;
    dragging = false;
    document.documentElement.removeAttribute('data-am-dragging');
    if (!didDrag || cancel) return;
    apply(order);
    save(order);
  };

  for (const el of grips) {
    el.addEventListener('pointerdown', (e) => {
      // A grip inside a <summary> would otherwise fold the panel on the same press.
      e.preventDefault();
      grip = el;
      startDrag(e);
    });
    el.addEventListener('pointermove', moveTo);
    el.addEventListener('pointerup', () => finish(false));
    el.addEventListener('pointercancel', () => finish(true));
    // The click that follows a pointerup must not reach the summary either.
    el.addEventListener('click', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => {
      const panel = el.closest('.am-panel');
      const step = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
      if (!step) {
        if (e.key === 'Escape') resetOrder();
        return;
      }
      e.preventDefault();
      const list = panels();
      const to = list.indexOf(panel) + step;
      if (to < 0 || to >= list.length) return;
      if (step < 0) list[to].before(panel);
      else list[to].after(panel);
      const order = ids();
      apply(order);
      save(order);
      el.focus();
    });
  }

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && moving) finish(true);
  });

  // The toolbar's reset button (src/render.js adds it to a page with drag) starts hidden, like the text-size buttons.
  const resetBtn = document.querySelector('[data-am="reset-order"]');
  if (resetBtn) {
    resetBtn.hidden = false;
    resetBtn.addEventListener('click', resetOrder);
  }

  const saved = load();
  if (saved) apply(saved);
})();
