import { esc } from '../svg/text.js';
import { hasRtl } from '../bidi.js';

// `hints.span` is the span the author wrote; it becomes data-span for the layout script. The inline grid styles come from `panel.attrs`
// (which may include spans added by the server) and are only the fallback without JavaScript. `rows` is not a hint for the layout
// script: it only shapes the plain grid.
// A fold is a native <details>: the panel opens and closes with no script, works from the keyboard alone, and prints open.
// `folds` is the page-level setting (`folds: true` in the frontmatter); a panel opts out with {collapse=false}.
// The comment button (added by src/runtime/reply.js) hangs on the <section>, outside the details, so a click on it never folds.
export function panelHtml(panel, { cols = 3, grid = true, hints = {}, folds = false, drag = false, moveLabel = 'Move panel' } = {}) {
  const { attrs } = panel;
  const span = Math.min(Number(attrs.span) || 1, cols);
  const rows = Number(attrs.rows) || 1;
  const layout = [
    grid && span > 1 ? `grid-column: span ${span}` : '',
    grid && rows > 1 ? `grid-row: span ${rows}` : '',
  ].filter(Boolean).join('; ');
  const style = layout ? ` style="${layout}"` : '';
  const hinted = Math.floor(Number(hints.span));
  const data = grid && hinted >= 1 ? ` data-span="${Math.min(hinted, cols)}"` : '';
  const fold = folds ? attrs.collapse !== false : attrs.collapse === true;
  const cls = `${span > 1 ? ' am-span-wide' : ''}${attrs.bare ? ' am-panel--bare' : ''}${fold && !attrs.bare ? ' am-panel--fold' : ''}`;
  const meta = attrs.meta ? `<span class="am-panel-meta">${esc(attrs.meta)}</span>` : '';
  // The grip is a button so the keyboard reaches it; src/runtime/drag.js moves the panel from it. It sits inside <summary>
  // on a folded panel, so its click must not fold the panel: drag.js calls preventDefault() on pointerdown and click.
  const grip = drag && !attrs.bare
    ? `<button class="am-grip" type="button" data-am="grip" aria-label="${esc(`${moveLabel} ${panel.id}`)}" title="${esc(moveLabel)}"></button>`
    : '';
  const head = attrs.bare
    ? ''
    : `${grip}<span class="am-panel-id">${esc(panel.id)}</span><h2>${esc(panel.title)}</h2>${meta}`;
  // A bare panel has no title bar at all, so it cannot fold: there is nothing to click.
  const isFold = fold && !attrs.bare;
  const body = `<div class="am-panel-body">${panel.html}${subPanels(panel, folds)}</div>`;
  const inner = isFold
    ? `<details class="am-fold"${attrs.collapsed === true ? '' : ' open'}><summary class="am-panel-head">${head}</summary>
${body}</details>
`
    : `${attrs.bare ? '' : `<header class="am-panel-head">${head}</header>
`}${body}
`;
  return `<section class="am-panel${cls}" id="panel-${esc(panel.id)}"${style}${data}>
${inner}</section>`;
}

// A sub-panel is a panel inside a panel ({nest} in the draft): it shares the head, the body and the fold, and differs in three
// ways. Its class is am-subpanel, not am-panel, so the sheet layout never plans it as a cell of the grid; its head is an h3 under
// the parent's h2; and it never takes a grip or a grid span, because it has no row of its own to sit in.
// A sub-panel folds only when the draft says so: the page-level `collapse` belongs to the panels the reader skims first.
function subPanels(panel, folds = false) {
  const children = panel.children ?? [];
  if (!children.length) return '';
  return `\n${children.map((child) => {
    const attrs = child.attrs ?? {};
    // A sub-panel folds when its page folds; a draft that leaves its page open can still fold one part with {collapse}. Either
    // way {collapse=false} keeps that part open, so one long stretch of text can stay whole inside a folded page.
    const fold = (folds || attrs.collapse === true || attrs.collapsed === true) && attrs.collapse !== false;
    const head = `<span class="am-panel-id">${esc(child.id)}</span><h3>${esc(child.title)}</h3>`;
    const body = `<div class="am-panel-body">${child.html}</div>`;
    const inner = fold
      ? `<details class="am-fold am-fold--sub"${attrs.collapsed === true ? '' : ' open'}><summary class="am-panel-head am-panel-head--sub">${head}</summary>
${body}</details>`
      : `<header class="am-panel-head am-panel-head--sub">${head}</header>
${body}`;
    return `<section class="am-subpanel" id="panel-${esc(child.id)}" data-am-parent="${esc(panel.id)}">
${inner}</section>`;
  }).join('\n')}`;
}

const RESERVED = new Set(['template', 'theme', 'style', 'mode', 'cols', 'title', 'subtitle', 'lang', 'collapse', 'drag', 'outline', 'nest', 'width']);

// language: the page language. Its metaKeys name common keys in the page language (author in Hebrew). On a right-to-left page the value
// sits in its own <bdi>, so a key and a value of different directions do not run together ("date7.10.2026").
export function headHtml(meta, introHtml, language = {}) {
  const extras = Object.entries(meta).filter(([k, v]) => !RESERVED.has(k) && v !== '');
  const names = language.metaKeys ?? {};
  // A value with a Hebrew letter reads right to left even when it opens with an English word ("d8df1b0 (4 קומיטים מעל main)"); a plain
  // <bdi> would take its direction from that first word and show the Hebrew sentence in left-to-right order.
  const value = (v) => (language.dir === 'rtl' ? `<bdi${hasRtl(v) ? ' dir="rtl"' : ''}>${esc(v)}</bdi>` : esc(v));
  const metaRow = extras.length
    ? `<div class="am-head-meta">${extras.map(([k, v]) => `<span><b>${esc(names[k.toLowerCase()] ?? k)}</b>${value(v)}</span>`).join('')}</div>`
    : '';
  const sub = meta.subtitle ? `<p class="am-sub">${esc(meta.subtitle)}</p>` : '';
  const intro = introHtml ? `<div class="am-intro am-md">${introHtml}</div>` : '';
  return `<header class="am-head"><h1>${esc(meta.title || 'Untitled')}</h1>${sub}${metaRow}${intro}</header>`;
}
