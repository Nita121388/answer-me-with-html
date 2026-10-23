import { esc } from '../svg/text.js';
import { hasRtl } from '../bidi.js';

// `hints.span` is the span the author wrote; it becomes data-span for the layout script. The inline grid styles come from `panel.attrs`
// (which may include spans added by the server) and are only the fallback without JavaScript. `rows` is not a hint for the layout
// script: it only shapes the plain grid.
// A fold is a native <details>: the panel opens and closes with no script, works from the keyboard alone, and prints open.
// `folds` is the page-level setting (`folds: true` in the frontmatter); a panel opts out with {collapse=false}.
// The comment button (added by src/runtime/reply.js) hangs on the <section>, outside the details, so a click on it never folds.
export function panelHtml(panel, { cols = 3, grid = true, hints = {}, folds = false } = {}) {
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
  const head = attrs.bare
    ? ''
    : `<span class="am-panel-id">${esc(panel.id)}</span><h2>${esc(panel.title)}</h2>${meta}`;
  // A bare panel has no title bar at all, so it cannot fold: there is nothing to click.
  const isFold = fold && !attrs.bare;
  const body = `<div class="am-panel-body">${panel.html}</div>`;
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

const RESERVED = new Set(['template', 'theme', 'style', 'mode', 'cols', 'title', 'subtitle', 'lang', 'collapse']);

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
