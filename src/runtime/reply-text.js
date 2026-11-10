// The reply a reader copies from the page: one Markdown text with the decisions, the panel comments and the block remarks.
// A plain ES module for tests; the page gets it with its `export` keyword dropped (src/runtime/compose.js).
// decisions: [{ panel, question, picked: [label], suggested: [label], touched }]; comments: [{ panel, id, title, text }];
// remarks: [{ panel, quote, kind, note }], where quote is the start of the marked block and kind is a key of ui.kinds.
// Comment and remark text is quoted line by line, so text the reader typed cannot pass as part of the structure.
// rtl: the page reads right to left, so the arrow before each answer points left, the way the text runs.

// The reply as lines, each with the Markdown it becomes and, for a comment or a remark, a ref that names the entry it came from.
// The reply sheet (src/runtime/reply.js) draws these lines and puts a Clear button on a line that has a ref, so the reader can drop
// one comment or one mark from the preview. replyText joins the same lines, so the copied text and the drawn sheet cannot disagree.
// A comment's ref is `c<panel id>`; a remark's ref is `r<its index in remarks>`.
export function replyLines({ title, decisions, comments, remarks = [], ui, rtl = false }) {
  const arrow = rtl ? '←' : '→';
  const lines = [{ text: `# Re: ${title}` }];
  const push = (text, ref) => lines.push(ref ? { text, ref } : { text });
  if (decisions.length) {
    push('');
    push(`## ${ui.decisions}`);
    decisions.forEach((d, i) => {
      const answer = d.picked.length ? d.picked.map((l) => `**${l}**`).join(', ') : '**—**';
      // Every option starts unselected, so an ask the reader never clicked has no answer: the reply names the suggestion
      // instead of passing it off as the reader's choice.
      const same = d.picked.length === d.suggested.length && d.picked.every((l) => d.suggested.includes(l));
      const suggested = d.suggested.join(', ') || '—';
      const why = !d.touched ? `${ui.untouched}: ${suggested}` : same ? ui.confirmed : `${ui.was}: ${suggested}`;
      push(`${i + 1}. [${d.panel}] ${d.question}`);
      push(`   ${arrow} ${answer} _(${why})_`);
    });
  }
  const written = comments.filter((c) => c.text.trim());
  const quoted = (text) => (text.trim() ? text.trim().split('\n').map((l) => `  > ${l}`) : []);
  if (written.length) {
    push('');
    push(`## ${ui.comments}`);
    for (const c of written) {
      push(`- **${c.panel} · ${c.title}**`, `c${c.id}`);
      for (const line of quoted(c.text)) push(line);
    }
  }
  if (remarks.length) {
    push('');
    push(`## ${ui.remarks}`);
    remarks.forEach((r, i) => {
      // A mark on a block names its tag; a mark on words has no tag unless the reader picked one, so it is a quote.
      const kind = r.kind ? (ui.kinds?.[r.kind] ?? r.kind) : r.words ? ui.words : '';
      const label = [r.panel, kind].filter(Boolean).join(' · ');
      push(`- **${label}** "${r.quote}"`, `r${i}`);
      for (const line of quoted(r.note)) push(line);
    });
  }
  if (written.length || remarks.some((r) => r.note.trim())) {
    push('');
    push(`_${ui.typed}_`);
  }
  return lines;
}

// The lines as the Markdown the reader copies. The one join, so the sheet that draws the lines and the text Copy copies cannot drift.
export function replyLinesText(lines) {
  return lines.length ? `${lines.map((line) => line.text).join('\n')}\n` : '';
}

export function replyText(args) {
  return replyLinesText(replyLines(args));
}
