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

  for (const fold of folds) {
    fold.addEventListener('toggle', () => {
      if (restoring) return;
      const id = panelId(fold);
      if (!id) return;
      state[id] = fold.open;
      save(state);
      replan();
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
