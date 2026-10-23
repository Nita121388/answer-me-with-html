import { renderDoc } from './src/render.js';

const draft = [
  '---',
  'title: Board',
  'template: canvas',
  '---',
  '```canvas',
  'A -> B: 影响',
  'B -> C',
  '```',
  '## A 开始',
  '文字一。',
  '',
  '## B 中间',
  '文字二。',
  '',
  '## C 结束',
  '文字三。',
].join('\n');

const { html } = renderDoc(draft);
console.log('nodes:', (html.match(/am-canvas-node/g) || []).length);
console.log('edges:', (html.match(/class="am-canvas-edge"/g) || []).length);
console.log('labels:', (html.match(/am-canvas-edge-label/g) || []).length);
console.log('boxes:', (html.match(/data-box="[^"]+"/g) || []).join(' | '));
console.log('stage:', html.match(/data-canvas-stage style="[^"]*"/)?.[0]);
console.log('canvas fence not rendered as code:', !html.includes('am-codeblock') || !html.includes('A -&gt; B'));
console.log('head:', /<h1>Board<\/h1>/.test(html));