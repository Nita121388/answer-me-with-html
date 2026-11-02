// Heading and fence-line attributes (key=value pairs and bare flags). Kept apart from parse.js so the components can use it
// without a cycle: parse.js reads the component registry.

const NUMERIC_KEYS = new Set(['cols', 'span']);
// Panel attributes. collapse makes a panel a fold; collapsed starts it folded. They are booleans when written bare,
// so `{collapse}` and `{collapse=true}` are the same thing.
const FOLD_ATTRS = new Set(['collapse', 'collapsed']);
// Page-level booleans: `drag: true` makes the panels movable on the page (src/runtime/drag.js).
const BOOL_KEYS = new Set([...FOLD_ATTRS, 'drag']);
// A bare attribute is `true`. For a fold attribute, "false" / "off" / "0" / "no" turn it off, so a page can fold every panel
// in the frontmatter and still keep one panel open with {collapse=false}.
const OFF = new Set(['false', 'off', '0', 'no']);
const ATTR_TOKEN = /([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g;

export function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(ATTR_TOKEN)) {
    attrs[m[1]] = m[2] === undefined ? true : coerce(m[1], unquote(m[2]));
  }
  return attrs;
}

export function unquote(v) {
  const s = v.trim();
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

export function coerce(key, value) {
  if (NUMERIC_KEYS.has(key) && /^\d+$/.test(value)) return Number(value);
  if (BOOL_KEYS.has(key)) return value === true || !OFF.has(String(value).trim().toLowerCase());
  return value;
}
