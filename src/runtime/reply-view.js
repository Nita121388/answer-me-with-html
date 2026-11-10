// The reply as the reader sees it in the Reply sheet (src/runtime/reply.js): the Markdown that Copy copies, drawn as headings, bold answers
// and quoted comments instead of raw "# Re: ...", "1. [E] ..." and "- **A · ...**" lines. Each line gets its own direction, so a
// Hebrew reader sees Latin answers and paths in place; a line with no right-to-left letter reads left to right, as on any other page.
// The raw Markdown stays in the sheet under a fold, so the copied text does not change.
// A plain ES module for tests; the page gets it with its `export` keyword dropped and rtl-letter.js in front of it in place of the
// import (src/runtime/compose.js).
import { RTL_LETTER } from './rtl-letter.js';

const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// A line with a right-to-left letter reads right to left; a line without one (an English comment, a path) reads left to right.
const dirOf = (s) => (RTL_LETTER.test(s) ? 'rtl' : 'ltr');

// The only inline Markdown src/runtime/reply-text.js writes: **answer**, _(note)_ and the "quote" of a remark. Each piece is isolated in its own direction,
// so a Latin answer inside a Hebrew line keeps its place, and "A · title" still starts with the panel letter.
const piece = (tag, text) => `<${tag}><bdi dir="${dirOf(text)}">${text}</bdi></${tag}>`;
function inline(s) {
  return escHtml(s)
    .replace(/\*\*(.+?)\*\*/g, (_, t) => piece('strong', t))
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, (_, pre, t) => pre + piece('em', t))
    // The quoted start of a marked block ("- **A · concern** "text""): isolated, so Latin text in a Hebrew line keeps its place.
    .replace(/&quot;(.+)&quot;$/, (_, t) => `&quot;<bdi dir="${dirOf(t)}">${t}</bdi>&quot;`);
}

// One line of the reply as HTML. `ref` is the entry the line came from (a comment or a remark); the sheet puts a Clear button on
// the line that has one. The markup of the line itself does not change, so a test can read both forms.
export function replyLineHtml(line, ref = '') {
  const dir = dirOf(line);
  let m;
  if (!line.trim()) return '<div class="am-rv-gap"></div>';
  if ((m = line.match(/^(#{1,2}) (.*)$/))) return `<div class="am-rv-h${m[1].length}" dir="${dir}">${inline(m[2])}</div>`;
  if ((m = line.match(/^(\d+)\. \[([^\]]*)\] (.*)$/))) {
    return `<div class="am-rv-q" dir="${dir}"><bdi>${m[1]}.</bdi> <bdi class="am-rv-tag">${escHtml(m[2])}</bdi> ${inline(m[3])}</div>`;
  }
  if ((m = line.match(/^ {3}([←→]) (.*)$/))) return `<div class="am-rv-a" dir="${dir}">${m[1]} ${inline(m[2])}</div>`;
  if ((m = line.match(/^- (.*)$/))) return `<div class="am-rv-c" dir="${dir}">${inline(m[1])}</div>`;
  // A comment line is shown exactly as the reader typed it.
  if ((m = line.match(/^ {2}> ?(.*)$/))) return `<div class="am-rv-quote" dir="${dirOf(m[1])}">${escHtml(m[1]) || '&nbsp;'}</div>`;
  return `<div dir="${dir}">${inline(line)}</div>`;
}

// The reply text (src/runtime/reply-text.js) as HTML, one block per line.
export function replyViewHtml(text) {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => replyLineHtml(line))
    .join('');
}

// The reply as lines (replyLines in src/runtime/reply-text.js) drawn in the sheet. A line that names a comment or a mark is wrapped
// with a Clear button, so the reader can drop that one entry from the preview; `label` is the button's accessible name.
export function replyLinesHtml(lines, label) {
  return lines
    .map(({ text, ref }) => (ref ? `<div class="am-rv-entry" data-ref="${escHtml(ref)}">${replyLineHtml(text)}<button type="button" class="am-rv-clear" title="${escHtml(label)}" aria-label="${escHtml(label)}">✕</button></div>` : replyLineHtml(text)))
    .join('');
}
