// Folded panels. The markup needs no script to open and close (a native <details>, src/templates/panel.js); this file adds
// the three things the markup cannot do alone: it keeps the reader's choice in this browser, it tells the sheet layout to
// plan again (a folded panel is one head high, so every row height changes), and it opens every panel for printing.
//
// The stored value is an object of panel id to open state, holding only the panels the reader touched, so a panel the author
// later writes as {collapsed} still starts folded. A panel that is gone from the page stays stored (it may come back with
// `am patch`); it is simply never read. Storage may be off (a sandboxed `am serve` page, a private window): the fold then
// works for this tab and the choice is not remembered, like the text size button.
(() => {
  const folds = [...document.querySelectorAll('.am-fold')];
  if (!folds.length) return;

  const storeKey = `am-fold:${location.pathname}`;
  // A page with no folds never writes this key, so an ordinary page adds nothing to storage.
  const panelId = (fold) => fold.closest('.am-panel')?.id ?? '';

  const load = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
      const kept = {};
      for (const [key, open] of Object.entries(saved)) {
        if (typeof key === 'string' && typeof open === 'boolean') kept[key] = open;
      }
      return kept;
    } catch {
      return {};
    }
  };
  const save = (state) => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(state));
    } catch {
      // Storage may be off; the choice then lasts until the page closes.
    }
  };

  const state = load();

  // Restore before anything measures the page: the sheet layout plans its rows from panel heights and runs at load.
  for (const fold of folds) {
    const id = panelId(fold);
    if (id && id in state) fold.open = state[id];
  }

  // `restoring` keeps the programmatic open/close above and the print expansion below out of the stored state: those are not
  // the reader's choices.
  let restoring = false;

  const replan = () => window.dispatchEvent(new Event('am-replan'));

  // The reader's place on the page. A fold changes the height of its row and of every row after it, so the sheet is planned
  // again; without this the page would jump to another place, or to the top, when that happens (#361).
  // A head on the screen is the one the reader just clicked: the fold happens where they look, and the page keeps that head in
  // place. A head above the screen belongs to a panel they already read: then the first panel below it holds its place, so the
  // text they are reading does not move.
  const anchorOf = (panel) => {
    for (const el of document.querySelectorAll('.am-panel')) {
      if (el === panel) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 8) return { el, top: rect.top };
    }
    return null;
  };
  // Put the anchor panel back where it was on the screen. The offset is read from the page as it stands now, so it also works
  // when the browser already moved the scroll position while the sheet was rebuilt.
  const holdPlace = (anchor) => {
    if (!anchor || !anchor.el.isConnected) return;
    const moved = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
  };
  // A click that folds a panel records the place first: the toggle event comes after the height has already changed.
  let foldAnchor = null;

  // A fold can make the head a <summary>, and a click on a <summary> folds the panel unless the click lands on an interactive
  // element. The comment button is such an element, but its icon is an <svg>, and the browser decides from the element that was
  // actually hit: an icon that swallows the pointer would fold the panel instead of opening the comment. So the icon is painted
  // but never hit, and the button under it is.
  for (const fold of folds) {
    fold.addEventListener('click', (e) => {
      const control = e.target.closest?.('button, a, input, textarea, select, label');
      if (control && fold.querySelector('summary')?.contains(control)) {
        e.preventDefault();
        return;
      }
      if (!control) {
        const panel = fold.closest('.am-panel');
        const head = fold.querySelector('summary')?.getBoundingClientRect();
        // A head the reader can see is the one they just clicked: hold that panel's own top, so the head stays under the pointer
        // and the content below it moves up the way a fold does anywhere else. A head above the window belongs to a panel they
        // already read: hold the first panel below it instead, so the text they are reading does not move.
        foldAnchor = head && head.top >= -4
          ? (panel ? { el: panel, top: panel.getBoundingClientRect().top } : null)
          : anchorOf(panel);
      }
    }, true);
  }

  for (const fold of folds) {
    fold.addEventListener('toggle', () => {
      if (restoring) return;
      const id = panelId(fold);
      if (!id) return;
      state[id] = fold.open;
      save(state);
      const anchor = foldAnchor;
      foldAnchor = null;
      replan();
      holdPlace(anchor);
      // Planning rebuilds the grid, so the head loses the focus it had; give it back without letting the browser scroll to it.
      const summary = fold.querySelector('summary');
      if (summary && !summary.contains(document.activeElement)) summary.focus({ preventScroll: true });
    });
  }

  // Printing never shows a closed panel's body: open them all, then put the reader's own layout back.
  // Browsers disagree on which of the `beforeprint` event and the print media query change fires first, or at all, so both are
  // handled; both are idempotent (src/runtime/layout-dom.js does the same for the sheet layout).
  const printOpen = new Map();
  const openAll = () => {
    if (printOpen.size) return;
    restoring = true;
    for (const fold of folds) {
      printOpen.set(fold, fold.open);
      fold.open = true;
    }
    restoring = false;
  };
  const restoreAll = () => {
    if (!printOpen.size) return;
    restoring = true;
    for (const fold of folds) {
      if (printOpen.has(fold)) fold.open = printOpen.get(fold);
    }
    printOpen.clear();
    restoring = false;
    replan();
  };
  addEventListener('beforeprint', openAll);
  addEventListener('afterprint', restoreAll);
  const printQuery = matchMedia('print');
  printQuery.addEventListener('change', (e) => (e.matches ? openAll() : restoreAll()));
})();
