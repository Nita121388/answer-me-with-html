// A foldable tree node (```tree list fold, src/components/tree.js) is a native <details>, and the browser hides what a closed
// <details> holds from the page — in print too. So a reader who never unfolded a node would lose that part of the tree on paper.
// Printing opens every node, then puts the reader's own folds back, exactly as src/runtime/fold.js does for panels.
// Opening and closing a node itself needs no script: that is the browser's own <details> behaviour.
(() => {
  const folds = [...document.querySelectorAll('.am-tree-fold')];
  if (!folds.length) return;

  // Browsers disagree on which of the `beforeprint` event and the print media query change fires first, or at all, so both are
  // handled; both are idempotent, as in src/runtime/fold.js and src/runtime/layout-dom.js.
  const before = new Map();
  const openAll = () => {
    if (before.size) return;
    for (const fold of folds) {
      before.set(fold, fold.open);
      fold.open = true;
    }
  };
  const restoreAll = () => {
    if (!before.size) return;
    for (const [fold, open] of before) fold.open = open;
    before.clear();
  };
  addEventListener('beforeprint', openAll);
  addEventListener('afterprint', restoreAll);
  const printQuery = matchMedia('print');
  printQuery.addEventListener('change', (e) => (e.matches ? openAll() : restoreAll()));
})();
