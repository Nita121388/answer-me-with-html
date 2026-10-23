import { readFileSync, writeFileSync } from 'node:fs';

let p = 'src/render.js';
let s = readFileSync(p, 'utf8');
const anchors = [
  [
    'chart: hasChart(body), update: Boolean(update), closeAfter, theme: meta.theme, scale })',
    "chart: hasChart(body), canvas: meta.template === 'canvas', update: Boolean(update), closeAfter, theme: meta.theme, scale })",
    'pageCss flags',
  ],
  [
    "const script = `\\n${RUNTIME_JS}${hasDelta(body) ? DELTA_JS : ''}",
    "const script = `\\n${RUNTIME_JS}${meta.template === 'canvas' ? CANVAS_JS : ''}${hasDelta(body) ? DELTA_JS : ''}",
    'script',
  ],
  [
    "import { VERSION, RUNTIME_JS, DELTA_JS, UPDATE_JS, CLOSE_AFTER_JS } from './assets.js';",
    "import { VERSION, RUNTIME_JS, DELTA_JS, UPDATE_JS, CLOSE_AFTER_JS, CANVAS_JS } from './assets.js';",
    'import',
  ],
];
for (const [old, next, name] of anchors) {
  if (!s.includes(old)) throw new Error(`anchor ${name} missing`);
  s = s.replace(old, next);
}
writeFileSync(p, s);

p = 'src/runtime/compose.js';
s = readFileSync(p, 'utf8');
const oldCompose = "${read('drag.js')}\\n";
if (!s.includes(oldCompose)) throw new Error('anchor compose missing');
s = s.replace(oldCompose, "${read('drag.js')}\\n${read('canvas-dom.js')}\\n");
writeFileSync(p, s);

console.log('written');
