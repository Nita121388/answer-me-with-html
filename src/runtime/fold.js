// Folded panels. The markup needs no script to open and close (a native <details>, src/templates/panel.js); this file adds
// the four things the markup cannot do alone: it keeps the reader's choice in this browser, it tells the sheet layout to
// plan again (a folded panel is one head high, so every row height changes), it opens every panel for printing, and it gives
// the toolbar one button that folds every panel or opens every panel at once.
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
  // The nearest board holds its own state: a sub-panel folds under its own ID ("panel-A1") and never touches the panel that
  // holds it. The ID keeps its "panel-" prefix, exactly as it was stored before sub-panels existed, so a reader's saved folds
  // still open the panels they closed.
  const panelId = (fold) => fold.closest('.am-panel, .am-subpanel')?.id ?? '';

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

  // `restoring` keeps the programmatic open/close above, the print expansion below and the fold-all button out of the stored
  // state: those are not the reader's own clicks.
  let restoring = false;
  // What each fold showed once the reader's saved state was in place. A browser also fires `toggle` for a <details> that starts
  // open, and the restore above fires one more; neither is a choice. Only a state that differs from this one is stored, so the
  // record holds the panels the reader touched and nothing else.
  const shown = new Map(folds.map((fold) => [fold, fold.open]));

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

  // ── Fold all / open all ──────────────────────────────────
  // One toolbar button that reads the page: while any panel is open it folds them all, and once every panel is folded it opens
  // them all. The panels the author wrote as {collapsed} are included: the reader asked for the whole page at once.
  const allBtn = document.querySelector('[data-am="fold-all"]');
  const labels = allBtn ? JSON.parse(allBtn.dataset.ui) : null;
  // The button says what the next click will do, so a page of folded panels offers "Open all" and a page of open panels "Fold all".
  const syncAll = () => {
    if (!allBtn) return;
    const anyOpen = folds.some((fold) => fold.open);
    allBtn.textContent = anyOpen ? labels.collapse : labels.expand;
    allBtn.setAttribute('aria-label', allBtn.textContent);
    allBtn.title = allBtn.textContent;
  };

  // Set one fold's state as the reader's own choice, so the toggle that follows stores it.
  const applyChoice = (fold, open) => {
    if (fold.open === open) return false;
    shown.set(fold, open);
    fold.open = open;
    return true;
  };

  for (const fold of folds) {
    fold.addEventListener('toggle', () => {
      // A programmatic change (the restore above, printing, the fold-all button) is not a choice: it updates what the page shows
      // but leaves the stored state alone. `restoring` covers the synchronous part; the `shown` map covers a toggle event that
      // arrives after the flag is already back down, which is what a browser does for a <details> changed in the same task.
      if (restoring) {
        shown.set(fold, fold.open);
        return;
      }
      if (shown.get(fold) === fold.open) return;
      shown.set(fold, fold.open);
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
      syncAll();
    });
  }

  if (allBtn) {
    allBtn.hidden = false;
    syncAll();
    allBtn.addEventListener('click', () => {
      const open = !folds.some((fold) => fold.open);
      // The page keeps the place of the first panel below the window: folding twelve panels one by one would otherwise throw the
      // reader to the top twelve times.
      const anchor = anchorOf(null);
      restoring = true;
      let changed = false;
      for (const fold of folds) if (applyChoice(fold, open)) changed = true;
      restoring = false;
      // Every fold is now the reader's choice, so the next reload shows the page the same way.
      for (const fold of folds) {
        const id = panelId(fold);
        if (id) state[id] = fold.open;
      }
      save(state);
      syncAll();
      if (!changed) return;
      replan();
      holdPlace(anchor);
    });
  }

  // Printing never shows a closed panel's body: open them all, then put the reader's own layout back.
  // Browsers disagree on which of the `beforeprint` event and the print media query change fires first, or at all, so both are
  // handled; both are idempotent (src/runtime/layout-dom.js does the same for the sheet layout).
  const printOpen = new Map();
  const openAll = () => {
    if (printOpen.size) return;
    for (const fold of folds) {
      printOpen.set(fold, fold.open);
      fold.open = true;
      shown.set(fold, true);
    }
  };
  const restoreAll = () => {
    if (!printOpen.size) return;
    for (const fold of folds) {
      if (!printOpen.has(fold)) continue;
      const open = printOpen.get(fold);
      fold.open = open;
      shown.set(fold, open);
    }
    printOpen.clear();
    replan();
  };
  addEventListener('beforeprint', openAll);
  addEventListener('afterprint', restoreAll);
  const printQuery = matchMedia('print');
  printQuery.addEventListener('change', (e) => (e.matches ? openAll() : restoreAll()));
})();
