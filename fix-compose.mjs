import { readFileSync, writeFileSync } from 'node:fs';

const p = 'src/runtime/compose.js';
let s = readFileSync(p, 'utf8');

const stray = `
// The canvas page script: the .drawio writer first (src/runtime/canvas-drawio.js, a plain module so the format is tested without
// a browser), then the board itself. Both go into one inlined script, which is why the writer cannot be imported at run time.
export function composeCanvas(read) {
  return \`\${unexport(read('canvas-drawio.js'))}\n\${read('canvas-dom.js')}\`;
}
`;
if (!s.includes(stray)) throw new Error('stray block not found');
s = s.replace(stray, '');

const anchor = 'export function composeRuntime(read) {';
if (!s.includes(anchor)) throw new Error('anchor missing');
s = s.replace(anchor, stray.trimStart() + '\n' + anchor);
writeFileSync(p, s);
console.log('ok');
