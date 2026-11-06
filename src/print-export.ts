import { parseMarkdown, type MarkdownNode } from './markdown';
import { renderNode, type Host } from './editor';
import { tokenizeGithub } from './github-highlighting';
import { printGeometry, type PrintOptions } from '../shared/print';
import regular from '../assets/fonts/SourceCodePro-Regular.woff2?inline';
import bold from '../assets/fonts/SourceCodePro-Bold.woff2?inline';
import italic from '../assets/fonts/SourceCodePro-It.woff2?inline';
import DOMPurify from 'dompurify';
import katex from 'katex';

export async function printHTML(source: string, title: string, host: Host, options: PrintOptions): Promise<string> {
  const article = document.createElement('article'); article.className = options.layout === 'portrait' ? 'single' : 'columns';
  const render = async (node: MarkdownNode): Promise<Node> => {
    if (node.type === 'html') {
      const raw = document.createElement('div'); raw.className = 'print-raw'; raw.innerHTML = DOMPurify.sanitize(node.value ?? '', { ADD_TAGS: ['mjx-container'] });
      for (const math of raw.querySelectorAll('mjx-container')) {
        const latex = math.querySelector('img[title]')?.getAttribute('title');
        if (latex) { const replacement = document.createElement('span'); replacement.innerHTML = katex.renderToString(latex, { throwOnError: false, trust: false, strict: 'ignore' }); math.replaceWith(replacement); }
      }
      for (const element of raw.querySelectorAll<HTMLElement>('[style]')) {
        if (element.closest('svg')) continue;
        const align = element.style.textAlign; element.removeAttribute('style'); if (/^(left|right|center)$/.test(align)) element.style.textAlign = align;
      }
      for (const details of raw.querySelectorAll('details')) details.open = true;
      for (const pre of raw.querySelectorAll('pre')) { const language = /language-([\w+#-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ?? ''; pre.replaceWith(await render({ type: 'code', value: pre.textContent ?? '', lang: language })); }
      for (const image of raw.querySelectorAll('img[src]')) image.setAttribute('src', host.media(image.getAttribute('src')!));
      return raw;
    }
    if (node.type === 'code') {
      if (node.lang?.toLowerCase() === 'mermaid') {
        try { const { default: mermaid } = await import('mermaid'); mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: options.color === 'mono' ? 'neutral' : 'default', htmlLabels: false }); const result = await mermaid.render(`print-${crypto.randomUUID()}`, node.value ?? ''); const diagram = document.createElement('div'); diagram.className = 'print-diagram'; diagram.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } }); return diagram; } catch { /* Incomplete diagrams remain readable code. */ }
      }
      const value = node.value ?? '', pre = document.createElement('pre'); pre.className = `print-code ${options.lineNumbers ? 'numbered' : ''}`;
      const tokens = await tokenizeGithub(value, node.lang ?? '', options.color === 'mono' ? 'moye-print-mono' : 'github-light');
      const lines = value.split('\n'); const body = document.createElement('code');
      const rows = lines.map((text, index) => {
        const line = document.createElement('span'); line.className = 'print-code-line'; line.dataset.line = String(index + 1);
        let indent = 0; for (const character of /^\s*/.exec(text)![0]) indent += character === '\t' ? 4 - indent % 4 : 1;
        line.style.setProperty('--indent', `${Math.min(24, indent + 2)}ch`);
        for (const token of tokens?.[index] ?? [{ content: text, color: '#111111', fontStyle: 0 }]) {
          const span = document.createElement('span'); span.textContent = token.content; span.style.color = token.color ?? '#111111';
          if ((token.fontStyle ?? 0) & 1) span.style.fontStyle = 'italic'; if ((token.fontStyle ?? 0) & 2) span.style.fontWeight = '700'; line.append(span);
        }
        return line;
      });
      // Keep the heading with at least two source lines at a new page/column.
      if (rows.length > 2) { const lead = document.createElement('span'); lead.className = 'print-code-lead'; lead.append(...rows.splice(0, 2)); body.append(lead); }
      body.append(...rows); pre.append(body); return pre;
    }
    if (node.type === 'table') {
      const table = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
      for (const [index, row] of (node.children ?? []).entries()) {
        const tr = document.createElement('tr');
        for (const [column, cell] of (row.children ?? []).entries()) { const element = document.createElement(index ? 'td' : 'th'); element.style.textAlign = node.align?.[column] ?? ''; for (const child of cell.children ?? []) element.append(renderNode(child, host)); tr.append(element); }
        (index ? body : head).append(tr);
      }
      table.append(head, body); return table;
    }
    if (node.type === 'thematicBreak') return document.createElement('hr');
    const containers: Record<string, string> = { heading: `h${node.depth ?? 1}`, list: node.ordered ? 'ol' : 'ul', listItem: 'li', blockquote: 'blockquote', footnoteDefinition: 'aside' };
    if (containers[node.type]) {
      const element = document.createElement(containers[node.type]); if (node.type === 'list' && node.ordered) (element as HTMLOListElement).start = node.start ?? 1;
      if (node.type === 'listItem' && typeof node.checked === 'boolean') element.append(document.createTextNode(node.checked ? '☑ ' : '☐ '));
      for (const child of node.children ?? []) element.append(await render(child)); return element;
    }
    return renderNode(node, host);
  };
  for (const node of parseMarkdown(source).children ?? []) if (node.type !== 'yaml' && node.type !== 'definition') article.append(await render(node));
  for (const table of article.querySelectorAll('table:not(:has(thead))')) { const first = table.querySelector('tr'); if (first?.querySelector('th')) { const head = document.createElement('thead'); head.append(first); table.prepend(head); } }
  const safeTitle = document.createElement('title'); safeTitle.textContent = title;
  const geometry = printGeometry(options.layout), font = options.codeFontPt, maxHeight = geometry.heightMm - geometry.topMm - geometry.bottomMm;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: replica-media:; font-src data:; style-src 'unsafe-inline'; script-src 'none'">${safeTitle.outerHTML}<style>
@font-face{font-family:'Source Code Pro';font-weight:400;src:url('${regular}') format('woff2')}
@font-face{font-family:'Source Code Pro';font-weight:700;src:url('${bold}') format('woff2')}
@font-face{font-family:'Source Code Pro';font-weight:400;font-style:italic;src:url('${italic}') format('woff2')}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111}body{font:${font + .5}pt/1.45 'Microsoft YaHei','微软雅黑','Segoe UI',sans-serif;overflow-wrap:anywhere}
article{width:100%;min-width:0}.columns{column-count:2;column-gap:8mm;column-fill:auto}
h1,h2,h3,h4,h5,h6{font-weight:700;line-height:1.25;margin:1em 0 .5em;break-after:avoid;page-break-after:avoid}h1{font-size:${font + 8}pt}h2{font-size:${font + 4}pt}h3{font-size:${font + 2}pt}h4,h5,h6{font-size:${font + 1}pt}article>:first-child{margin-top:0}
p{margin:0 0 .6em;orphans:2;widows:2}ul,ol{margin:.4em 0;padding-left:1.7em}li>p{margin-bottom:.2em}a{color:#111;text-decoration:underline}blockquote{margin:.6em 0;padding-left:.8em;border-left:2pt solid #bbb;color:#333}hr{border:0;border-top:.5pt solid #bbb;margin:1em 0}
code{font-family:'Source Code Pro','Microsoft YaHei',monospace}p code,li>code,td code{font-size:95%;background:transparent;color:#111}mark{background:transparent;color:#111;text-decoration:underline}
pre.print-code{margin:.6em 0 .9em;padding:4pt 0;border-top:.5pt solid #ccc;border-bottom:.5pt solid #ccc;background:#fff;color:#111;font:400 ${font}pt/1.35 'Source Code Pro','Microsoft YaHei',monospace;white-space:normal;overflow:visible;max-height:none;break-inside:auto;font-variant-ligatures:none;tab-size:4}
.print-code>code{display:block;font:inherit;white-space:normal}.print-code-line{display:block;position:relative;min-height:1.35em;padding-left:var(--indent);text-indent:calc(-1 * var(--indent));white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid;page-break-inside:avoid}
.numbered .print-code-line{margin-left:3em}.numbered .print-code-line:before{content:attr(data-line);position:absolute;left:-3em;width:2.3em;text-align:right;text-indent:0;color:#555;font-size:.85em;font-variant-numeric:tabular-nums}
.print-code-lead{display:block;break-inside:avoid;page-break-inside:avoid}.print-code.short{break-inside:avoid;page-break-inside:avoid}.print-code-line.tall-line,.print-code-lead.tall-line{break-inside:auto;page-break-inside:auto}
table{width:100%;table-layout:fixed;border-collapse:collapse;margin:.6em 0;font-size:95%;break-inside:auto}th,td{border:.5pt solid #999;padding:4pt 5pt;vertical-align:top;overflow-wrap:anywhere}th{font-weight:700;background:#f4f4f4}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}
img,svg{max-width:100%;height:auto;max-height:${maxHeight - 8}mm;object-fit:contain}img,.print-diagram{break-inside:avoid}math{max-width:100%;overflow-wrap:anywhere}.katex-html{display:none}.katex-mathml{position:static;clip:auto;width:auto;height:auto}aside{font-size:90%}
</style></head><body>${article.outerHTML}</body></html>`;
}
