// The board as a .drawio file (draw.io / diagrams.net). A plain ES module for tests: src/runtime/compose.js puts it in front of
// canvas-dom.js with its `export` keyword dropped, so the page calls `drawioXml` with no import.
//
// A .drawio file is an mxGraphModel in XML, which is the whole reason this needs no library: a panel becomes a rounded vertex
// whose HTML label holds the title and the start of its body, and a link becomes an edge between the two ids.
//
// nodes: [{ id, title, body, x, y, w, h }]   edges: [{ from, to, label }]
// `from` and `to` are the node ids. An edge whose two ends are not both in `nodes` is skipped.

const xmlText = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// draw.io renders an HTML label, so the title is bold and the body follows on its own lines. The text is escaped for HTML here;
// the whole label is escaped again for the XML attribute that carries it (drawioXml), and draw.io undoes the XML layer. That
// double pass is what lets a label hold markup of its own and still show a panel body verbatim.
const BODY_LIMIT = 220;
export function drawioLabel({ title = '', body = '' }, limit = BODY_LIMIT) {
  const text = String(body).replace(/\s+/g, ' ').trim();
  const short = text.length > limit ? `${text.slice(0, limit)}…` : text;
  const parts = [];
  if (title) parts.push(`<b>${xmlText(title)}</b>`);
  if (short) parts.push(xmlText(short));
  return parts.join('<br>');
}

// The cell style a panel gets: a rounded box, HTML label, text at the top left with room to breathe.
const NODE_STYLE = 'rounded=1;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacing=8;fontSize=12;';
const EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;';

export function drawioXml({ title = 'Board', nodes = [], edges = [] }, { bodyLimit = BODY_LIMIT } = {}) {
  const cellOf = new Map();
  nodes.forEach((node, i) => cellOf.set(node.id, `n${i + 1}`));

  const vertices = nodes.map((node) => {
    const id = cellOf.get(node.id);
    const label = drawioLabel(node, bodyLimit);
    const x = Math.round(Number(node.x) || 0);
    const y = Math.round(Number(node.y) || 0);
    const w = Math.max(1, Math.round(Number(node.w) || 0));
    const h = Math.max(1, Math.round(Number(node.h) || 0));
    return `<mxCell id="${id}" value="${xmlText(label)}" style="${NODE_STYLE}" vertex="1" parent="1">`
      + `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
  });

  const links = edges
    .filter((edge) => cellOf.has(edge.from) && cellOf.has(edge.to) && edge.from !== edge.to)
    .map((edge, i) => `<mxCell id="e${i + 1}" value="${xmlText(edge.label ?? '')}" style="${EDGE_STYLE}" edge="1" parent="1"`
      + ` source="${cellOf.get(edge.from)}" target="${cellOf.get(edge.to)}">`
      + '<mxGeometry relative="1" as="geometry"/></mxCell>');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mxfile host="answer-me-with-html" type="device">',
    `  <diagram name="${xmlText(title)}">`,
    '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" page="1" math="0" shadow="0">',
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    ...[...vertices, ...links].map((cell) => `        ${cell}`),
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ].join('\n');
}

// The file name a download uses: the page title, with the characters a file system refuses taken out.
export function drawioFileName(title = 'board') {
  const clean = String(title).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${clean || 'board'}.drawio`;
}
