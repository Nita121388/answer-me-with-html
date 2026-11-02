// Text maths for a text annotation (src/runtime/annot.js): where a range sits in a block's page text, and how a stored range
// finds its place again after the page is rendered afresh.
// A plain ES module for tests; the page gets it with its `export` keyword dropped (src/runtime/compose.js).
//
// A block's page text is the text the reader sees (src/runtime/remark.js reads it with one traversal): a formula reads as the
// TeX the draft wrote, a word joiner of a right-to-left page is not part of it, and a space stands where a line, a cell or a
// timeline part begins. Every offset here is a position in that same string, never a position in textContent.

// segments: [{ id, text }] in page order; id is opaque (a Text node in the page, a plain string in a test).
// Returns the same list with the start and end offset of each segment in the joined text.
export function indexSegments(segments) {
  let at = 0;
  return segments.map((s) => {
    const entry = { id: s.id, text: String(s.text ?? ''), start: at, end: at + String(s.text ?? '').length };
    at = entry.end;
    return entry;
  });
}

// The joined text of an index. A page quote and a mark's stored text come from here, so a test can hold both to one string.
export function joinSegments(index) {
  return index.map((s) => s.text).join('');
}

// The offset in the joined text of a position inside one segment: the segment's start plus the number of characters that come
// before it in that segment (the caller counts them, because only it knows how much of the raw node text is page text).
export function offsetAt(index, id, charsBefore = 0) {
  const seg = index.find((s) => s.id === id);
  if (!seg) return null;
  return seg.start + Math.max(0, Math.min(seg.text.length, charsBefore));
}

// The parts of [start, end) as per-segment slices: [{ id, from, to }], from and to being positions inside that segment's text.
// A part with nothing in it is left out, so the caller wraps only the segments the range really covers.
export function sliceAt(index, start, end) {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(0, Math.max(start, end));
  const parts = [];
  for (const seg of index) {
    const a = Math.max(from, seg.start) - seg.start;
    const b = Math.min(to, seg.end) - seg.start;
    if (b > a) parts.push({ id: seg.id, from: a, to: b });
  }
  return parts;
}

// What the reply quotes of a mark: the text the reader picked, whitespace collapsed, cut with an ellipsis when it is long.
export function quoteAt(text, start, end, max = 120) {
  const picked = squeeze(String(text).slice(start, end));
  return picked.length > max ? `${picked.slice(0, max).trimEnd()}…` : picked;
}

const squeeze = (text) => String(text).replace(/\s+/g, ' ').trim();

// A mark's place in a block's text again, or null when the block no longer holds it.
// Three tries, each one only accepting an answer it cannot get wrong:
//   1  the stored offsets still hold the stored text
//   2  the ring (some text before, the text, some text after) occurs exactly once
//   3  the text itself occurs exactly once
// A ring or a text that occurs twice or not at all gives no answer: a wrong highlight is worse than a mark the page shows as
// not found, because the reply still carries its text for the agent to judge.
export function relocate(text, mark) {
  const s = String(text ?? '');
  const start = Number(mark?.start);
  const end = Number(mark?.end);
  const quote = String(mark?.quote ?? '');
  if (!quote) return null;
  if (Number.isInteger(start) && Number.isInteger(end) && end > start && s.slice(start, end) === quote) return [start, end];
  const ring = `${mark?.prefix ?? ''}${quote}${mark?.suffix ?? ''}`;
  const place = (needle, lead) => {
    if (!needle) return null;
    const at = s.indexOf(needle);
    if (at < 0 || s.indexOf(needle, at + 1) >= 0) return null;
    return [at + lead, at + lead + quote.length];
  };
  return place(ring, String(mark?.prefix ?? '').length) ?? place(quote, 0);
}
