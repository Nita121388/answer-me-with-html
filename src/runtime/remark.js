// Remark mode: the reader turns it on, clicks a block, tags it (suggestion, keep, question, concern) and may add a note.
// A mark shows as a bar and a note chip inside the block, lives in localStorage like panel comments, and the Reply button carries it
// back to the agent: reply.js calls window.__amRemarkData, and replyText (reply-text.js) writes the Remarks section.
(() => {
  const btn = document.querySelector('[data-am="remark"]');
  if (!btn) return;
  const ui = JSON.parse(btn.dataset.ui);
  const KINDS = ['suggestion', 'keep', 'question', 'concern'];
  const storeKey = `am-remark:${location.pathname}`;
  // A page served by `am serve` has no localStorage and the phone may discard its tab; it keeps the marks on the server, in the
  // same record as the answers (reply.js), so a re-opened page finds them again.
  const serve = (() => {
    const { amSave: save, amState: state } = document.body?.dataset ?? {};
    if (!save) return null;
    try {
      return { save, restored: state ? JSON.parse(state) : null };
    } catch {
      return { save, restored: null };
    }
  })();
  let saveTimer = null;
  let pendingPatch = null;
  const sendSave = (patch) => {
    fetch(serve.save, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch), keepalive: true })
      .catch(() => {});
  };
  const saveSoon = (patch) => {
    clearTimeout(saveTimer);
    pendingPatch = patch;
    saveTimer = setTimeout(() => {
      pendingPatch = null;
      sendSave(patch);
    }, 400);
  };
  // A hidden or closing page sends the change it still holds, before the timer can run.
  const flushSave = () => {
    if (!pendingPatch) return;
    clearTimeout(saveTimer);
    sendSave(pendingPatch);
    pendingPatch = null;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
  window.addEventListener('pagehide', flushSave);
  // The one definition of a block a reader can mark: the content under <main>. The page and panel titles are left out, because the
  // reply reads them as text; a panel has its Comment button.
  // A $$ block on its own is a div; a $$ formula inside a sentence is a span of its paragraph.
  const BLOCK = 'main :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,dd,dt,figure,div.am-math-block):not(.am-head *, .am-panel-head *, .am-toc *)';
  // A click on these does what it always did.
  const LIVE = '.am-remark-pop, .am-annot-float, .am-toolbar, a, button, input, textarea, select, label';
  const blockAt = (target) => (target.closest(LIVE) ? null : target.closest(BLOCK));

  const WJ = new RegExp(String.fromCharCode(0x2060), 'g'); // word joiners of a right-to-left page (src/bidi.js); not part of the draft's text
  // A narrow horizontal timeline shows its date and title inline (src/themes/base.css). They stay parts of their own, so a block key
  // does not change with the width of the window (#194).
  const OWN_BOX = '.am-timeline--h .am-tl-when, .am-timeline--h .am-tl-title';
  const inlineBox = new WeakMap();
  const isInline = (el) => {
    if (!inlineBox.has(el)) inlineBox.set(el, !el.matches(OWN_BOX) && getComputedStyle(el).display.startsWith('inline'));
    return inlineBox.get(el);
  };
  // The page text of a block, text node by text node: the one traversal that blockText joins and that the text annotations
  // (src/runtime/annot.js) index. Lead is the space that stands where a line, a cell or a timeline part begins.
  const walkText = (el, visit) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // The note chip of a block mark and the number of a text mark are the reader's furniture, not the draft's words: neither is
      // part of the page text, or painting a mark would change the text the next mark is measured against.
      if (node.parentElement.closest('.am-mark-note, .am-annot-n')) continue;
      let box = formulaOf(node) ?? node.parentElement;
      while (box !== el && isInline(box)) box = box.parentElement;
      const lead = last && box !== last ? ' ' : '';
      last = box;
      visit(node, lead, nodeText(node).replace(WJ, ''));
    }
  };
  const blockText = (el) => {
    let text = '';
    walkText(el, (node, lead, piece) => { text += lead + piece; });
    return text;
  };

  const panelOf = (el) => el.closest('.am-panel')?.id.replace(/^panel-/, '') ?? '';
  // Block keys, in page order. Built when first needed: a page nobody marked pays nothing.
  let keys = null;
  const keyMap = () => {
    if (!keys) {
      const blocks = [...document.querySelectorAll(BLOCK)];
      const ids = occurrenceKeys(blocks.map((el) => `${panelOf(el)}|${el.localName}|${fingerprint(blockText(el))}`));
      keys = new Map(blocks.map((el, i) => [el, ids[i]]));
    }
    return keys;
  };

  // A stored record with start and end is a text mark (the words inside one block); one without is a block mark, which is what
  // every page marked before text marks existed holds.
  const isAnnot = (m) => Number.isInteger(m?.start) && Number.isInteger(m?.end) && typeof m?.quote === 'string';
  const annotId = (a) => `${a.key}\u0001${a.start}-${a.end}`;
  const usable = (m) => typeof m?.key === 'string' && (isAnnot(m) || KINDS.includes(m.kind));
  const load = () => {
    const restored = serve?.restored?.remark;
    if (Array.isArray(restored)) return restored.filter(usable);
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey));
      return Array.isArray(saved) ? saved.filter(usable) : [];
    } catch {
      return [];
    }
  };
  const storedMarks = load();
  // A mark whose block is gone from the page stays stored (it may return with `am patch`); it is neither painted nor sent.
  const marks = new Map(storedMarks.filter((m) => !isAnnot(m)).map((m) => [m.key, { key: m.key, kind: m.kind, note: String(m.note ?? '') }]));
  // A text mark names the words inside a block. It is kept in the same place as a block mark, so one Clear all and one serve
  // record carry both, and a page marked before text marks existed still reads.
  const annots = new Map(storedMarks.filter(isAnnot).map((m) => [annotId(m), {
    key: m.key,
    start: m.start,
    end: m.end,
    quote: String(m.quote),
    prefix: String(m.prefix ?? ''),
    suffix: String(m.suffix ?? ''),
    kind: String(m.kind ?? ''),
    note: String(m.note ?? ''),
  }]));
  // Kind and note of a popover closed without Save, by block key, until the page reloads (see open below).
  const drafts = new Map();
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'am-btn am-btn--remark-clear';
  clearBtn.textContent = ui.clear;
  // Clear all drops saved marks and drafts, so it shows while either exists.
  const toClear = () => marks.size + drafts.size + annots.size;
  const showClear = () => { clearBtn.hidden = toClear() === 0; };
  btn.insertAdjacentElement('afterend', clearBtn);
  let clearTimer = null;
  let clearArmed = false;
  const resetClear = () => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    clearTimer = null;
    clearArmed = false;
    clearBtn.classList.remove('is-armed');
    clearBtn.textContent = ui.clear;
    showClear();
  };
  const armClear = () => {
    clearArmed = true;
    clearBtn.classList.add('is-armed');
    clearBtn.textContent = ui.clearConfirm.replace('{n}', toClear());
    clearTimer = setTimeout(resetClear, 4000);
  };
  clearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      armClear();
      return;
    }
    for (const el of document.querySelectorAll('.am-mark')) unpaint(el);
    marks.clear();
    // Text marks go with the block marks: one Clear all empties the page.
    unpaintAnnots();
    annots.clear();
    // A draft is a remark the reader has not saved yet; Clear all drops it too, so no block reopens with an old kind.
    drafts.clear();
    try {
      localStorage.removeItem(storeKey);
    } catch {
      // Storage may be off (private window, a sandboxed page); the in-memory marks still clear.
    }
    if (serve) saveSoon({ remark: [] });
    resetClear();
    document.dispatchEvent(new Event('am-remark-change'));
  });
  const allMarks = () => [...marks.values(), ...annots.values()];
  const save = () => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(allMarks()));
    } catch {
      // Storage may be off (private window, a sandboxed page); marks then last until the page closes.
    }
    if (serve) saveSoon({ remark: allMarks() });
    // The reply bar (reply.js) shows the number of marks.
    document.dispatchEvent(new Event('am-remark-change'));
    showClear();
  };

  const chip = (el, mark) => {
    const note = document.createElement(el.localName === 'table' ? 'caption' : 'span');
    note.className = 'am-mark-note';
    const kind = document.createElement('b');
    kind.textContent = ui.kinds[mark.kind];
    note.append(kind, mark.note ? ` ${mark.note}` : '');
    return note;
  };
  const clearChip = (el) => el.querySelector(':scope > .am-mark-note')?.remove();
  const paint = (el, mark) => {
    clearChip(el);
    el.classList.add('am-mark');
    el.dataset.kind = mark.kind;
    // Inside the block, so a list item stays a child of its list. A table takes it as its caption; a list item with a sub-list shows
    // it under its own text, before the sub-list.
    const sub = el.querySelector(':scope > ul, :scope > ol');
    if (el.localName === 'table') el.prepend(chip(el, mark));
    else if (sub) sub.before(chip(el, mark));
    else el.append(chip(el, mark));
  };
  const unpaint = (el) => {
    clearChip(el);
    el.classList.remove('am-mark');
    delete el.dataset.kind;
  };
  showClear();
  if (marks.size) for (const [el, key] of keyMap()) if (marks.has(key)) paint(el, marks.get(key));

  // ---- Text marks: the reader picks words and tags them, instead of tagging the whole block ----
  // A text mark keeps its place in the block's page text (the maths live in src/runtime/annot-text.js): the block is named by
  // its key and the words by their offsets, so a render pays them back, and a block that changed finds them again by the text.

  const WJ_CHAR = String.fromCharCode(0x2060);
  // Where each character of the page text sits in the node's own text, plus the end: a word joiner is not page text, so offset
  // n of the page text is not offset n of the node.
  const rawOffsets = (data) => {
    const map = [];
    for (let i = 0; i < data.length; i += 1) if (data[i] !== WJ_CHAR) map.push(i);
    map.push(data.length);
    return map;
  };
  // The offset inside a node's own text for a position in its page text, which starts after the space that opens a line.
  const rawPos = (node, at, leadLen) => {
    const map = rawOffsets(node.data);
    return map[Math.min(map.length - 1, Math.max(0, at - leadLen))];
  };
  // The segments of a block, each with the length of the space that starts it: annot-text counts that space, so the caller does too.
  const segmentsOf = (el) => {
    const segments = [];
    walkText(el, (node, lead, piece) => segments.push({ id: node, text: lead + piece, lead: lead.length }));
    return segments;
  };
  const annotIndex = (el) => {
    const segments = segmentsOf(el);
    return {
      index: indexSegments(segments.map((s) => ({ id: s.id, text: s.text }))),
      lead: new Map(segments.map((s) => [s.id, s.lead])),
      text: segments.map((s) => s.text).join(''),
    };
  };
  // Where a range sits in the block's page text. A formula reads as its TeX, which is not a copy of its MathML characters, so it
  // is one unit: a range that touches it takes all of it, or none.
  const offsetsOf = (el, range) => {
    const { index, lead } = annotIndex(el);
    const edge = (node, offset, start) => {
      if (node.nodeType === 3) return [node, offset];
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      if (start) {
        const first = walker.nextNode();
        return first ? [first, 0] : null;
      }
      let last = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n;
      return last ? [last, last.data.length] : null;
    };
    const pos = (at, start) => {
      if (!at) return null;
      const [node, offset] = at;
      const seg = index.find((s) => s.id === node);
      if (!seg) return null;
      const leadLen = lead.get(node) ?? 0;
      const len = seg.text.length - leadLen;
      const before = formulaOf(node) ? (offset > 0 ? len : 0) : rawOffsets(node.data.slice(0, offset)).length - 1;
      return seg.start + leadLen + Math.min(len, Math.max(0, before));
    };
    const from = pos(edge(range.startContainer, range.startOffset, true), true);
    const to = pos(edge(range.endContainer, range.endOffset, false), false);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return null;
    return [from, to];
  };

  // Paint one text mark: wrap each part of the range in a <mark>, tag the formula it covers, and number the last part. It answers
  // false when the block no longer holds the words, so the caller can leave the mark stored and unshown.
  const paintAnnot = (el, annot, n) => {
    const { index, lead, text } = annotIndex(el);
    const place = relocate(text, annot);
    if (!place) return false;
    const parts = sliceAt(index, place[0], place[1]);
    if (!parts.length) return false;
    const id = annotId({ ...annot, start: place[0], end: place[1] });
    const tagged = [];
    for (const part of parts) {
      const node = part.id;
      const math = formulaOf(node);
      if (math) {
        if (!math.classList.contains('am-annot')) {
          math.classList.add('am-annot');
          math.dataset.amAnnot = id;
          if (annot.kind) math.dataset.kind = annot.kind;
          tagged.push(math);
        }
        continue;
      }
      const leadLen = lead.get(node) ?? 0;
      const from = rawPos(node, part.from, leadLen);
      const to = rawPos(node, part.to, leadLen);
      if (to <= from) continue;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const mark = document.createElement('mark');
      mark.className = 'am-annot';
      mark.dataset.amAnnot = id;
      if (annot.kind) mark.dataset.kind = annot.kind;
      range.surroundContents(mark);
      tagged.push(mark);
    }
    if (!tagged.length) return false;
    const sup = document.createElement('sup');
    sup.className = 'am-annot-n';
    sup.dataset.amAnnot = id;
    if (annot.kind) sup.dataset.kind = annot.kind;
    sup.textContent = String(n);
    sup.title = annot.note || ui.kinds[annot.kind] || ui.button;
    tagged.at(-1).after(sup);
    return true;
  };
  const unpaintAnnots = () => {
    for (const sup of document.querySelectorAll('sup[data-am-annot]')) sup.remove();
    for (const mark of document.querySelectorAll('mark.am-annot[data-am-annot]')) mark.replaceWith(...mark.childNodes);
    for (const math of document.querySelectorAll('[data-am-annot]:not(sup):not(mark)')) {
      math.classList.remove('am-annot');
      delete math.dataset.amAnnot;
    }
  };
  // The block element of every key on the page, in page order: a stored mark names its block by key, and this finds it again.
  const indexByKey = () => {
    const byKey = new Map();
    for (const [el, key] of keyMap()) if (!byKey.has(key)) byKey.set(key, el);
    return byKey;
  };
  // The range of a part of a block's page text, so a click on marked words selects them again. A formula has no character
  // positions, so a range that only covers one has no DOM range to give.
  const rangeOf = (el, place) => {
    const { index, lead } = annotIndex(el);
    const real = sliceAt(index, place[0], place[1]).filter((p) => !formulaOf(p.id));
    if (!real.length) return null;
    const first = real[0];
    const last = real.at(-1);
    const range = document.createRange();
    range.setStart(first.id, rawPos(first.id, first.from, lead.get(first.id) ?? 0));
    range.setEnd(last.id, rawPos(last.id, last.to, lead.get(last.id) ?? 0));
    return range;
  };

  // Page order: the blocks as the page lists them, and inside a block the words in reading order, so the numbers read 1, 2, 3.
  const paintAllAnnots = () => {
    unpaintAnnots();
    if (!annots.size) return;
    const byKey = indexByKey();
    const order = new Map([...byKey.keys()].map((key, i) => [key, i]));
    const listed = [...annots.values()].filter((a) => byKey.has(a.key)).sort((p, q) => (order.get(p.key) - order.get(q.key)) || p.start - q.start);
    let n = 0;
    for (const annot of listed) if (paintAnnot(byKey.get(annot.key), annot, n + 1)) n += 1;
  };

  // The float: one click on a kind tags the words at once, so the reader never opens a box and submits it for each place. The box
  // takes a note, and Enter saves it; a note without a kind is a mark too. Escape puts the page back as it was.
  let picked = null;
  let editing = null;
  // A record the reader reopened by a click on its words. It carries the words' place at the time of the click, which may not be
  // the offsets the record was saved with, so the float edits the record itself rather than looking it up by offsets.
  let reopened = null;
  const float = document.createElement('div');
  float.className = 'am-annot-float';
  float.hidden = true;
  float.setAttribute('role', 'dialog');
  float.setAttribute('aria-label', ui.button);
  const noteIn = document.createElement('input');
  noteIn.type = 'text';
  noteIn.placeholder = ui.hint;
  noteIn.setAttribute('aria-label', ui.hint);
  const dropBtn = document.createElement('button');
  dropBtn.type = 'button';
  dropBtn.className = 'am-btn';
  dropBtn.textContent = ui.remove;
  dropBtn.hidden = true;
  const hideFloat = () => {
    if (float.hidden) return;
    float.hidden = true;
    picked = null;
    editing = null;
    reopened = null;
    noteIn.value = '';
    dropBtn.hidden = true;
    showClear();
  };
  const placeFloat = (rect) => {
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const w = float.offsetWidth;
    const h = float.offsetHeight;
    let x = rtl ? rect.right - w : rect.left;
    // Below the words first: a float above them covers the line the reader just read.
    let y = rect.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 8);
    x = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    float.style.left = `${window.scrollX + x}px`;
    float.style.top = `${window.scrollY + y}px`;
  };
  const showFloat = () => {
    if (btn.getAttribute('aria-pressed') !== 'true') return hideFloat();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return hideFloat();
    const range = selection.getRangeAt(0);
    const blockOf = (node) => blockAt(node.nodeType === 3 ? node.parentElement : node);
    const el = blockOf(range.startContainer);
    if (!el || el !== blockOf(range.endContainer)) return hideFloat();
    const offsets = offsetsOf(el, range);
    if (!offsets) return hideFloat();
    // The words as the block reads them, verbatim: relocate compares them with the same text after a render.
    const words = blockText(el).slice(offsets[0], offsets[1]);
    if (!words.trim()) return hideFloat();
    picked = { el, start: offsets[0], end: offsets[1] };
    const key = keyMap().get(el);
    editing = reopened?.key === key ? reopened : (annots.get(annotId({ key, start: picked.start, end: picked.end })) ?? [...annots.values()].find((a) => a.key === key && a.quote === words) ?? null);
    noteIn.value = editing?.note ?? '';
    dropBtn.hidden = !editing;
    float.hidden = false;
    placeFloat(range.getBoundingClientRect());
  };
  const saveAnnot = (kind) => {
    if (!picked) return;
    const key = keyMap().get(picked.el);
    if (typeof key !== 'string') return hideFloat();
    const text = blockText(picked.el);
    const words = text.slice(picked.start, picked.end);
    if (!words.trim()) return hideFloat();
    const record = {
      key,
      start: picked.start,
      end: picked.end,
      quote: words,
      prefix: text.slice(Math.max(0, picked.start - 32), picked.start),
      suffix: text.slice(picked.end, picked.end + 32),
      kind: kind || '',
      note: noteIn.value.trim(),
    };
    if (editing) annots.delete(annotId(editing));
    annots.set(annotId(record), record);
    hideFloat();
    save();
    paintAllAnnots();
    window.getSelection()?.removeAllRanges();
  };
  const dropAnnot = () => {
    if (!editing) return;
    annots.delete(annotId(editing));
    hideFloat();
    save();
    paintAllAnnots();
    window.getSelection()?.removeAllRanges();
  };
  const kindPick = KINDS.map((k, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'am-remark-kind';
    b.dataset.kind = k;
    // The number a reader can press to tag the words without the pointer, as the block popover shows it.
    b.dataset.n = String(i + 1);
    b.textContent = ui.kinds[k];
    b.addEventListener('click', () => saveAnnot(k));
    return b;
  });
  dropBtn.addEventListener('click', () => dropAnnot());
  float.append(...kindPick, dropBtn, noteIn);
  document.body.append(float);
  // A press inside the float keeps the selection; only the box takes the focus, so a note can be typed.
  float.addEventListener('pointerdown', (e) => { if (e.target !== noteIn) e.preventDefault(); });
  float.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideFloat();
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (e.target === noteIn) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        saveAnnot('');
      }
      return;
    }
    if (/^[1-4]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      saveAnnot(KINDS[Number(e.key) - 1]);
    }
  });
  // A click on marked words selects them again and opens the float on that mark, so a note can be changed or dropped without
  // picking the words a second time. Marked words win over the block click.
  const openWords = (e) => {
    const part = e.target.closest?.('[data-am-annot]');
    if (!part) return;
    const record = annots.get(part.dataset.amAnnot);
    const el = record && indexByKey().get(record.key);
    if (!record || !el) return;
    const place = relocate(blockText(el), record);
    const range = place && rangeOf(el, place);
    if (!range) return;
    e.preventDefault();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    reopened = record;
    showFloat();
  };
  // A pick on the words opens the float; typing a note keeps it open, and any other change of the selection reads again.
  let readTimer = null;
  const readSelection = () => {
    if (!float.hidden && float.contains(document.activeElement)) return;
    clearTimeout(readTimer);
    readTimer = setTimeout(showFloat, 120);
  };
  paintAllAnnots();

  // The popover edits one block. Save stays off until a kind is picked, and a hint says so. 1–4 pick a kind from the keyboard and
  // move to the note; Ctrl / Cmd + Enter saves. A popover closed without Save keeps its kind and note as a draft for that block until the page reloads.
  const pop = document.createElement('div');
  pop.className = 'am-remark-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', ui.button);
  document.body.append(pop);
  let opener = null;
  let anchor = null;
  let keepDraft = null;
  const close = (restoreFocus) => {
    if (pop.hidden) return;
    keepDraft?.();
    keepDraft = null;
    pop.hidden = true;
    if (restoreFocus) (opener?.isConnected && opener !== document.body ? opener : btn).focus();
  };
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const x = rtl ? rect.right - pop.offsetWidth : rect.left;
    // Under the block; a block taller than the window gets the popover at the bottom of the window instead.
    const y = Math.min(rect.bottom + 6, window.innerHeight - pop.offsetHeight - 8);
    pop.style.left = `${window.scrollX + Math.min(Math.max(8, x), window.innerWidth - pop.offsetWidth - 8)}px`;
    pop.style.top = `${window.scrollY + Math.max(8, y)}px`;
  };
  const make = (tag, props) => Object.assign(document.createElement(tag), props);
  const open = (el) => {
    const key = keyMap().get(el);
    const mark = marks.get(key);
    const draft = drafts.get(key);
    let kind = draft?.kind ?? mark?.kind ?? '';
    opener = document.activeElement;
    anchor = el;

    const note = make('textarea', { rows: 2, placeholder: ui.hint, value: draft?.note ?? mark?.note ?? '' });
    note.setAttribute('aria-label', ui.hint);
    const keep = make('button', { type: 'button', className: 'am-btn', textContent: ui.save, disabled: !kind });
    const need = make('span', { className: 'am-remark-need', textContent: ui.need, hidden: Boolean(kind) });
    keepDraft = () => {
      if (kind || note.value.trim()) drafts.set(key, { kind, note: note.value });
      else drafts.delete(key);
      showClear();
    };
    const done = () => { drafts.delete(key); keepDraft = null; showClear(); };
    keep.addEventListener('click', () => {
      done();
      const saved = { key, kind, note: note.value.trim() };
      marks.set(key, saved);
      save();
      paint(el, saved);
      close(true);
    });
    const actions = make('div', { className: 'am-remark-actions' });
    actions.append(keep);
    if (mark) {
      const drop = make('button', { type: 'button', className: 'am-btn', textContent: ui.remove });
      drop.addEventListener('click', () => {
        done();
        marks.delete(key);
        save();
        unpaint(el);
        close(true);
      });
      actions.append(drop);
    }
    const choose = (k) => {
      kind = k;
      for (const other of kindBtns) other.setAttribute('aria-pressed', String(other.dataset.kind === k));
      keep.disabled = false;
      need.hidden = true;
    };
    const kindBtns = KINDS.map((k, i) => {
      const kb = make('button', { type: 'button', className: 'am-remark-kind', textContent: ui.kinds[k] });
      kb.dataset.kind = k;
      kb.dataset.n = i + 1;
      kb.setAttribute('aria-pressed', String(k === kind));
      kb.addEventListener('click', () => choose(k));
      return kb;
    });
    // Ctrl / Cmd + Enter presses Save (nothing while Save waits for a kind). A digit types into the note, so it picks a kind
    // only while the focus is outside the note.
    pop.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        if (!keep.disabled) keep.click();
        return;
      }
      if (e.target === note || e.ctrlKey || e.metaKey || e.altKey || !/^[1-4]$/.test(e.key)) return;
      e.preventDefault();
      choose(KINDS[Number(e.key) - 1]);
      note.focus();
    };
    actions.append(need);
    pop.replaceChildren(make('div', { className: 'am-remark-kinds' }), note, actions);
    pop.firstChild.append(...kindBtns);
    pop.hidden = false;
    place();
    (kindBtns.find((b) => b.dataset.kind === kind) ?? kindBtns[0]).focus({ preventScroll: true });
  };

  // Picking works only while remark mode is on. A click on a marked block edits its mark, on a plain block starts one.
  // The block under the pointer gets an outline: the same blockAt decides what is outlined and what a click picks.
  let hover = null;
  const track = (e) => {
    const el = e.type === 'mouseout' && e.relatedTarget === null ? null : blockAt(e.target);
    if (el === hover) return;
    hover?.classList.remove('am-remark-hover');
    hover = el;
    hover?.classList.add('am-remark-hover');
  };
  const pick = (e) => {
    // A pick on the words is the float's: the block popover waits until the range is gone.
    if (!float.hidden) return;
    if (e.target.closest?.('[data-am-annot]')) return;
    const el = blockAt(e.target);
    if (el) open(el);
  };
  // The keyboard picks too: while the mode is on, every block takes focus with Tab, and Enter or Space opens its popover. A block
  // that already had a tabindex keeps it; only the ones the mode added lose it again.
  const pickKey = (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.ctrlKey || e.metaKey || e.altKey || !e.target.hasAttribute?.('data-am-pick')) return;
    e.preventDefault();
    open(e.target);
  };
  const focusable = (on) => {
    if (!on && !keys) return; // the mode starts off: a page nobody marked builds no block keys
    for (const el of keyMap().keys()) {
      if (on && !el.hasAttribute('tabindex')) {
        el.tabIndex = 0;
        el.setAttribute('data-am-pick', '');
      } else if (!on && el.hasAttribute('data-am-pick')) {
        el.removeAttribute('tabindex');
        el.removeAttribute('data-am-pick');
      }
    }
  };
  const setMode = (on) => {
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
    const toggle = on ? 'addEventListener' : 'removeEventListener';
    document.body[toggle]('click', pick);
    document.body[toggle]('mouseover', track);
    document.body[toggle]('mouseout', track);
    document.body[toggle]('keydown', pickKey);
    // A change of the selection reads while the mode is on: the float is the only thing that appears.
    document[toggle]('selectionchange', readSelection);
    document[toggle]('click', openWords, true);
    focusable(on);
    if (!on) {
      track({ type: 'mouseout', relatedTarget: null });
      hideFloat();
      close(false);
    }
  };
  btn.addEventListener('click', () => setMode(btn.getAttribute('aria-pressed') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close(true);
  });
  // A click outside the popover closes it; the same click may then start another mark.
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target)) close(false);
  }, true);
  // The float is placed against the words, so a scroll or a new width could leave it lying about a line it no longer covers. It
  // goes instead, unless the reader is typing a note: a note under the pointer is worth more than a float in the right place.
  const typing = () => float.contains(document.activeElement) && document.activeElement === noteIn;
  window.addEventListener('scroll', () => { if (!float.hidden && !typing()) hideFloat(); }, { passive: true });
  window.addEventListener('resize', () => { if (!float.hidden && !typing()) hideFloat(); });
  setMode(false);

  // What the Reply button reads: the marked blocks and the marked words that are on the page, in page order.
  window.__amRemarkData = () => {
    if (!marks.size && !annots.size) return [];
    const live = [];
    for (const [el, key] of keyMap()) {
      const mark = marks.get(key);
      if (mark) live.push({ panel: panelOf(el), quote: quote(blockText(el)), kind: mark.kind, note: mark.note });
      // The marked words of this block, in reading order, after the block itself: a mark on the whole block is the outer range.
      const own = [...annots.values()].filter((a) => a.key === key).sort((p, q) => p.start - q.start);
      for (const a of own) live.push({ panel: panelOf(el), quote: quoteAt(a.quote, 0, a.quote.length), kind: a.kind, note: a.note, words: true });
    }
    return live;
  };
})();
