import { EditorState, StateEffect, StateField, Prec, EditorSelection, Compartment, ChangeSet, type Extension } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, drawSelection, dropCursor, rectangularSelection, highlightActiveLine, lineNumbers, type DecorationSet } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo, selectLine, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { parseMarkdown, walk, startOf, endOf, plainText, headings, tableRows, serializeTable, type MarkdownNode } from './markdown';
import { vscodeHighlightStyle } from './code-highlighting';
import { attachGithubHighlighting, githubTokens, tokenizeGithub } from './github-highlighting';
import { copyIcon, checkIcon } from './code-icons';
import { icon, type IconName } from './icons';
import { textEdits, toggleMarkup, tidyChineseMarkdown } from '../shared/markdown-tools';

const sourceEffect = StateEffect.define<boolean>();
const quoteCompositionEffect = StateEffect.define<boolean>();
const quoteCompositionField = StateField.define({ create: () => false, update(value, transaction) { for (const effect of transaction.effects) if (effect.is(quoteCompositionEffect)) value = effect.value; return value; } });
const emoji: Record<string, string> = { smile: '😄', smiling: '😊', grin: '😁', laughing: '😆', joy: '😂', heart: '❤️', blush: '😊', wink: '😉', cry: '😢', sob: '😭', angry: '😠', thinking: '🤔', thinking_face: '🤔', sunglasses: '😎', star: '⭐', sparkles: '✨', fire: '🔥', rocket: '🚀', tada: '🎉', warning: '⚠️', check: '✅', white_check_mark: '✅', x: '❌', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', clap: '👏', pray: '🙏', eyes: '👀', memo: '📝', book: '📖', bulb: '💡', computer: '💻', bug: '🐛', coffee: '☕', apple: '🍎', penguin: '🐧', cat: '🐱', dog: '🐶', flag_cn: '🇨🇳', cn: '🇨🇳', ok_hand: '👌', muscle: '💪', 100: '💯' };
function completeEmoji(context: CompletionContext) {
  const match = context.matchBefore(/:[a-z_0-9+-]*/); if (!match || (!context.explicit && match.text.length < 2)) return null;
  return { from: match.from, options: Object.entries(emoji).map(([name, value]) => ({ label: `:${name}:`, detail: value, apply: `:${name}:`, type: 'text' })), validFor: /^:[a-z_0-9+-]*$/ };
}
export const sourceField = StateField.define({ create: () => false, update(value, transaction) { for (const effect of transaction.effects) if (effect.is(sourceEffect)) value = effect.value; return value; } });
type Host = { id: string; media: (url: string) => string; link: (url: string) => void; changed: (value: string) => void; codeWrap?: () => boolean; setCodeWrap?: (value: boolean) => void; workbuddy?: () => boolean; githubDark?: () => boolean };

// Continuation lines keep a little more indent than the original code line.
const hangingCodeIndent = EditorView.decorations.compute(['doc'], state => {
  const ranges = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const row = state.doc.line(number); let columns = 0;
    for (const character of /^\s*/.exec(row.text)![0]) columns += character === '\t' ? state.tabSize - columns % state.tabSize : 1;
    const indent = Math.min(columns + 2, 40);
    ranges.push(Decoration.line({ attributes: { style: `padding-left:${indent}ch!important;text-indent:-${indent}ch` } }).range(row.from));
  }
  return Decoration.set(ranges);
});
type Context = { node: MarkdownNode; from: number; to: number; source: string; host: Host; signature?: string };
const widgetEditors = new WeakMap<HTMLElement, EditorView>();
function focusEmbedded(view: EditorView, position: number) {
  const focus = () => {
    if (view.state.field(sourceField)) return true;
    const root = [...view.dom.querySelectorAll<HTMLElement>('.md-block')].find(root => Number(root.dataset.from) <= position && Number(root.dataset.to) >= position); if (!root) return false;
    const code = widgetEditors.get(root); if (code) { code.focus(); return true; }
    const field = root.querySelector('textarea') ?? root.querySelector<HTMLElement>('th,td'); field?.focus(); return !!field;
  };
  if (!focus()) requestAnimationFrame(focus);
}
function enterAfter(view: EditorView, to: number) {
  const end = view.state.doc.length; const insert = to === end ? '\n\n' : '';
  view.dispatch({ changes: insert ? { from: end, insert } : undefined, selection: { anchor: Math.min(to + 1, end + insert.length) }, scrollIntoView: true }); view.focus();
}
function renderNode(node: MarkdownNode, host: Host): Node {
  if (node.type === 'text') { const text = node.value ?? ''; if (!/==[^=\n]+==/.test(text)) return document.createTextNode(text); const fragment = document.createDocumentFragment(); let previous = 0; for (const match of text.matchAll(/==([^=\n]+)==/g)) { fragment.append(document.createTextNode(text.slice(previous, match.index))); const mark = document.createElement('mark'); mark.className = 'md-highlight'; mark.textContent = match[1]; fragment.append(mark); previous = match.index! + match[0].length; } fragment.append(document.createTextNode(text.slice(previous))); return fragment; }
  if (node.type === 'html') { const span = document.createElement('span'); span.innerHTML = DOMPurify.sanitize(node.value ?? ''); return span; }
  if (node.type === 'inlineMath' || node.type === 'math') { const span = document.createElement('span'); span.innerHTML = katex.renderToString(node.value ?? '', { throwOnError: false, displayMode: node.type === 'math', strict: 'ignore', trust: false }); return span; }
  if (node.type === 'image') { const image = document.createElement('img'); image.src = host.media(node.url ?? ''); image.alt = node.alt ?? ''; return image; }
  if (node.type === 'footnoteReference') { const sup = document.createElement('sup'); sup.textContent = node.identifier ?? ''; return sup; }
  const tags: Record<string, string> = { strong: 'strong', emphasis: 'em', delete: 'del', inlineCode: 'code', link: 'a', paragraph: 'p', break: 'br', list: node.ordered ? 'ol' : 'ul', listItem: 'li', blockquote: 'blockquote' };
  const element = document.createElement(tags[node.type] ?? 'span');
  if (node.type === 'list' && node.ordered) (element as HTMLOListElement).start = node.start ?? 1;
  if (node.type === 'link') { (element as HTMLAnchorElement).href = node.url ?? ''; element.onclick = event => { event.preventDefault(); host.link(node.url ?? ''); }; }
  if (node.value) element.textContent = node.value; else appendChildren(element, node.children ?? [], host);
  return element;
}
function appendChildren(parent: Element, children: MarkdownNode[], host: Host) {
  const stack: Element[] = [parent];
  for (const child of children) {
    const tag = child.type === 'html' ? /^<(\/)?(u|sub|sup|mark)>$/i.exec(child.value ?? '') : null;
    if (tag && !tag[1]) { const element = document.createElement(tag[2]); stack[stack.length - 1].append(element); stack.push(element); }
    else if (tag?.[1] && stack.length > 1) stack.pop();
    else stack[stack.length - 1].append(renderNode(child, host));
  }
}
class InlineWidget extends WidgetType {
  constructor(readonly kind: string, readonly content: string, readonly host: Host) { super(); }
  eq(other: InlineWidget) { return other.kind === this.kind && other.content === this.content; }
  toDOM() {
    const element = document.createElement('span'); element.className = `md-${this.kind}`;
    if (this.kind === 'math') element.innerHTML = katex.renderToString(this.content, { throwOnError: false, strict: 'ignore', trust: false });
    else if (this.kind === 'image') { const [url, alt] = JSON.parse(this.content); const image = document.createElement('img'); image.src = this.host.media(url); image.alt = alt; element.append(image); }
    else if (this.kind === 'footnote') { const [label, detail] = JSON.parse(this.content); element.textContent = label; element.title = detail; }
    else element.textContent = this.content;
    return element;
  }
  ignoreEvent() { return false; }
}
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly position: number) { super(); }
  eq(other: TaskWidget) { return other.checked === this.checked && other.position === this.position; }
  toDOM(view: EditorView) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked; input.className = 'md-checkbox'; input.setAttribute('aria-label', '切换任务完成状态');
    input.onclick = event => { event.stopPropagation(); view.dispatch({ changes: { from: this.position, to: this.position + 3, insert: this.checked ? '[ ]' : '[x]' } }); }; return input;
  }
  ignoreEvent() { return true; }
}
class BlockWidget extends WidgetType {
  constructor(readonly context: Context, readonly kind: string) { super(); }
  eq(other: BlockWidget) { return this.kind === other.kind && this.context.signature === other.context.signature && this.context.source === other.context.source && this.context.from === other.context.from && this.context.host.id === other.context.host.id; }
  toDOM(view: EditorView) {
    const root = document.createElement('div'); root.className = `md-block md-${this.kind}`; (root as any).context = this.context;
    root.dataset.from = String(this.context.from); root.dataset.to = String(this.context.to);
    if (this.kind === 'code') this.code(root, view);
    else if (this.kind === 'table') this.table(root, view);
    else if (this.kind === 'math') {
      const result = document.createElement('div'); result.className = 'math-result'; result.innerHTML = katex.renderToString(this.context.node.value ?? '', { displayMode: true, throwOnError: false, strict: 'ignore', trust: false });
      const input = document.createElement('textarea'); input.className = 'math-input'; input.value = this.context.node.value ?? ''; input.setAttribute('aria-label', 'LaTeX 公式');
      input.addEventListener('input', () => { result.innerHTML = katex.renderToString(input.value, { displayMode: true, throwOnError: false, strict: 'ignore', trust: false }); const ctx: Context = (root as any).context; view.dispatch({ changes: { from: ctx.from, to: ctx.to, insert: `$$\n${input.value}\n$$` } }); }); root.append(result, input);
    } else if (this.kind === 'toc') {
      const title = document.createElement('div'); title.className = 'toc-title'; title.textContent = '目录'; root.append(title);
      for (const heading of headings(view.state.doc.toString())) { const button = document.createElement('button'); button.textContent = heading.text; button.style.paddingLeft = `${(heading.level - 1) * 18}px`; button.onclick = () => { view.dispatch({ selection: { anchor: heading.offset }, effects: EditorView.scrollIntoView(heading.offset, { y: 'start' }) }); view.focus(); }; root.append(button); }
    } else if (this.kind === 'image') root.append(renderNode(this.context.node, this.context.host));
    else if (this.kind === 'html') root.innerHTML = DOMPurify.sanitize(this.context.node.value ?? '');
    else if (this.kind === 'rule') root.append(document.createElement('hr'));
    else { const pre = document.createElement('pre'); pre.textContent = this.context.source; root.append(pre); }
    if (!['code', 'table', 'math', 'toc'].includes(this.kind)) root.ondblclick = () => { const ctx: Context = (root as any).context; view.dispatch({ selection: { anchor: ctx.from + 1 } }); view.focus(); };
    const frame = document.createElement('div'); frame.className = 'md-widget'; frame.append(root);
    const observer = new ResizeObserver(() => view.requestMeasure()); observer.observe(root);
    (frame as any).disposeMeasure = () => observer.disconnect();
    root.addEventListener('load', () => view.requestMeasure(), true);
    root.addEventListener('error', () => view.requestMeasure(), true);
    return frame;
  }
  code(root: HTMLElement, outer: EditorView) {
    const ctx = this.context; const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar';
    const language = document.createElement('input'); language.value = ctx.node.lang ?? ''; language.placeholder = '选择语言'; language.setAttribute('aria-label', '代码语言');
    const copy = document.createElement('button'); copy.className = 'code-copy'; copy.innerHTML = copyIcon; copy.title = '复制代码'; copy.setAttribute('aria-label', '复制代码'); let copyTimer: ReturnType<typeof setTimeout>;
    const wrap = document.createElement('button'); wrap.className = 'code-wrap'; wrap.innerHTML = icon('word-wrap'); wrap.title = '代码自动换行 Alt+Z'; wrap.setAttribute('aria-label', '代码自动换行'); wrap.onmousedown = event => event.preventDefault();
    const count = document.createElement('span'); count.className = 'code-lines';
    const wrapConfig = new Compartment(); let wrapping = !!ctx.host.codeWrap?.();
    const wrapExtensions = (enabled: boolean) => enabled ? [EditorView.lineWrapping, hangingCodeIndent] : [];
    const paintWrap = () => { wrap.setAttribute('aria-pressed', String(wrapping)); root.dataset.wrapping = String(wrapping); };
    const setWrap = (enabled: boolean) => { if (wrapping === enabled) return; wrapping = enabled; code.dispatch({ effects: wrapConfig.reconfigure(wrapExtensions(enabled)) }); paintWrap(); };
    const toggleWrap = () => { setWrap(!wrapping); ctx.host.setCodeWrap?.(wrapping); return true; }; wrap.onclick = toggleWrap; paintWrap();
    const updateCount = (state: EditorState) => { count.textContent = `${state.doc.lines} 行`; };
    copy.onmousedown = event => event.preventDefault();
    copy.onclick = () => { const editor = widgetEditors.get(root); void window.rypota.clipboard('write', editor?.state.doc.toString() ?? '').then(() => { clearTimeout(copyTimer); copy.innerHTML = checkIcon; copy.dataset.copied = 'true'; copy.title = '已复制'; copy.setAttribute('aria-label', '已复制'); copyTimer = setTimeout(() => { copy.innerHTML = copyIcon; delete copy.dataset.copied; copy.title = '复制代码'; copy.setAttribute('aria-label', '复制代码'); }, 1500); }).catch(() => { copy.title = '复制失败，请重试'; }); };
    toolbar.append(language, count, wrap, copy); const content = document.createElement('div'); content.className = 'code-content'; root.append(toolbar, content);
    let applying = false;
    const commit = (value: string) => {
      if (applying) return; const current: Context = (root as any).context;
      const fence = /^\s*(`{3,}|~{3,})/.exec(current.source)?.[1] ?? '```';
      const closing = fence[0].repeat(Math.max(fence.length, ...[...value.matchAll(new RegExp(`${fence[0]}+`, 'g'))].map(match => match[0].length + 1)));
      const replacement = `${closing}${language.value.trim()}\n${value}\n${closing}`;
      outer.dispatch({ changes: { from: current.from, to: current.to, insert: replacement } });
    };
    const languageConfig = new Compartment(); const gutterConfig = new Compartment(); let numbered = !!ctx.host.workbuddy?.();
    let github: ReturnType<typeof attachGithubHighlighting>;
    const extensions: Extension[] = [history(), drawSelection(), githubTokens, syntaxHighlighting(vscodeHighlightStyle), languageConfig.of([]), gutterConfig.of(numbered ? lineNumbers() : []), wrapConfig.of(wrapExtensions(wrapping)), bracketMatching(), keymap.of([{ key: 'Alt-z', run: toggleWrap }, { key: 'Mod-Shift-z', run: redo }, indentWithTab, ...defaultKeymap, ...historyKeymap]), EditorView.contentAttributes.of({ 'aria-label': '代码块编辑区', spellcheck: 'false' }), EditorView.updateListener.of(update => { if (update.docChanged) { updateCount(update.state); github?.refresh(); commit(update.state.doc.toString()); } })];
    const code = new EditorView({ state: EditorState.create({ doc: ctx.node.value ?? '', extensions }), parent: content }); widgetEditors.set(root, code);
    github = attachGithubHighlighting(code, () => language.value);
    const setAppearance = (workbuddy: boolean, githubDark: boolean) => {
      if (numbered !== workbuddy) { numbered = workbuddy; code.dispatch({ effects: gutterConfig.reconfigure(workbuddy ? lineNumbers() : []) }); }
      root.dataset.githubDark = String(githubDark); github.setEnabled(githubDark);
    };
    (root as any).setCodeAppearance = setAppearance; (root as any).disposeGithub = github.destroy;
    setAppearance(numbered, !!ctx.host.githubDark?.());
    (root as any).setCodeWrap = setWrap; updateCount(code.state);
    if ((ctx.node.lang ?? '').toLowerCase() === 'mermaid') {
      root.classList.add('md-diagram'); const preview = document.createElement('div'); preview.className = 'diagram-preview'; root.prepend(preview); let sequence = 0; let timer: ReturnType<typeof setTimeout>;
      const draw = (value: string) => { const revision = ++sequence; clearTimeout(timer); timer = setTimeout(() => { void import('mermaid').then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'Open Sans, 霞鹜文楷, LXGW WenKai, Microsoft YaHei UI, sans-serif' });
        try { const result = await mermaid.render(`diagram-${crypto.randomUUID()}`, value); if (revision === sequence && root.isConnected) preview.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } }); }
        catch { if (revision === sequence) preview.textContent = '图表语法尚未完成，继续编辑代码即可。'; }
      }).catch(() => { preview.textContent = '图表暂时无法加载。'; }); }, 180); };
      draw(ctx.node.value ?? ''); const sync = (root as any).syncDiagram = draw;
      preview.onclick = () => { code.requestMeasure(); code.focus(); };
      root.onmouseenter = () => code.requestMeasure();
      (root as any).diagramDispose = () => { sequence++; clearTimeout(timer); };
      void sync;
    }
    let languageRevision = 0; let languageName = '';
    const syncLanguage = (name: string) => { name = name.trim().toLowerCase(); if (name === languageName) return; languageName = name; github.refresh(0); const revision = ++languageRevision; const selected = languages.find(item => item.name.toLowerCase() === name || item.alias.includes(name));
      if (!selected) { code.dispatch({ effects: languageConfig.reconfigure([]) }); return; }
      void selected.load().then(support => { if (revision === languageRevision && root.isConnected) code.dispatch({ effects: languageConfig.reconfigure(support) }); }).catch(() => {});
    };
    (root as any).syncLanguage = syncLanguage; syncLanguage(language.value);
    language.onchange = () => commit(code.state.doc.toString());
    (root as any).syncCode = (value: string) => { if (code.state.doc.toString() === value) return; applying = true; code.dispatch({ changes: { from: 0, to: code.state.doc.length, insert: value } }); applying = false; };
    root.addEventListener('keydown', event => { if (event.key === 'ArrowDown' && code.state.selection.main.head === code.state.doc.length) { event.preventDefault(); enterAfter(outer, ((root as any).context as Context).to); } });
  }
  table(root: HTMLElement, outer: EditorView) {
    const toolbar = document.createElement('div'); toolbar.className = 'table-toolbar'; const table = document.createElement('table');
    let rows = tableRows(this.context.source); let align = this.context.node.align ?? []; let currentRow = 1; let currentCol = 0;
    const commit = (isolated = false) => { const ctx: Context = (root as any).context; outer.dispatch({ changes: { from: ctx.from, to: ctx.to, insert: serializeTable(rows, align) }, annotations: isolated ? isolateHistory.of('full') : undefined }); };
    const action = (label: string, glyph: IconName, title: string, handler: () => void) => { const button = document.createElement('button'); button.innerHTML = icon(glyph); button.append(document.createTextNode(label.replace(/^[+−]\s*/, ''))); button.setAttribute('aria-label', label); button.title = title; button.onmousedown = event => event.preventDefault(); button.onclick = handler; toolbar.append(button); };
    action('+ 行', 'add', '在当前行后插入一行', () => { rows.splice(currentRow + 1, 0, rows[0].map(() => '')); commit(); });
    action('+ 列', 'add', '在当前列后插入一列', () => { for (const row of rows) row.splice(currentCol + 1, 0, ''); align.splice(currentCol + 1, 0, null); commit(); });
    action('− 行', 'remove', '删除当前数据行', () => { if (currentRow > 0 && rows.length > 2) { rows.splice(currentRow, 1); commit(); } });
    action('− 列', 'remove', '删除当前列', () => { if (rows[0].length > 1) { for (const row of rows) row.splice(currentCol, 1); align.splice(currentCol, 1); commit(); } });
    for (const [label, value, glyph] of [['左', 'left', 'arrow-left'], ['中', 'center', 'dash'], ['右', 'right', 'arrow-right']] as const) action(label, glyph, '设置当前列对齐', () => { align[currentCol] = value; commit(); });
    const draw = () => {
      table.replaceChildren(); rows.forEach((row, index) => { const tr = document.createElement('tr'); row.forEach((value, col) => {
        const cell = document.createElement(index === 0 ? 'th' : 'td'); cell.tabIndex = 0; cell.style.textAlign = align[col] ?? ''; cell.dataset.row = String(index); cell.dataset.col = String(col); cell.dataset.value = value;
        const ast = parseMarkdown(value); appendChildren(cell, ast.children?.[0]?.children ?? [], this.context.host);
        cell.onfocus = () => { currentRow = index; currentCol = col; cell.contentEditable = 'true'; cell.textContent = rows[index][col]; const range = document.createRange(); range.selectNodeContents(cell); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); };
        cell.onblur = () => { const value = cell.textContent ?? ''; cell.contentEditable = 'false'; if (value !== rows[index][col]) { rows[index][col] = value; commit(); } cell.replaceChildren(); appendChildren(cell, parseMarkdown(value).children?.[0]?.children ?? [], this.context.host); };
        cell.onbeforeinput = event => event.stopPropagation(); cell.onpaste = event => event.stopPropagation();
        cell.oninput = event => { event.stopPropagation(); rows[index][col] = cell.textContent ?? ''; commit(!event.isTrusted); };
        cell.onkeydown = event => {
          event.stopPropagation();
          if (event.key === 'Tab') { event.preventDefault(); const cells = [...table.querySelectorAll<HTMLElement>('th,td')]; const next = cells[cells.indexOf(cell) + (event.shiftKey ? -1 : 1)]; if (next) next.focus(); else if (!event.shiftKey) { cell.blur(); rows.push(rows[0].map(() => '')); commit(); table.querySelector<HTMLElement>('tr:last-child td')?.focus(); } }
          if (event.key === 'Enter') { event.preventDefault(); cell.blur(); enterAfter(outer, ((root as any).context as Context).to); }
          if (event.key === 'Escape') { event.preventDefault(); cell.textContent = rows[index][col]; cell.blur(); outer.focus(); }
        }; tr.append(cell);
      }); table.append(tr); });
    }; draw(); const content = document.createElement('div'); content.className = 'table-content'; content.append(table); root.append(toolbar, content);
    (root as any).syncTable = (ctx: Context) => {
      const focused = root.contains(document.activeElement) && document.activeElement?.matches('th[contenteditable=true],td[contenteditable=true]') ? document.activeElement as HTMLElement : null;
      const oldText = focused?.textContent ?? ''; const native = window.getSelection(); let anchor = 0, head = 0;
      const offset = (node: Node | null, at: number) => { if (!node || !focused?.contains(node)) return 0; const range = document.createRange(); range.selectNodeContents(focused); range.setEnd(node, at); return range.toString().length; };
      if (focused && native) { anchor = offset(native.anchorNode, native.anchorOffset); head = offset(native.focusNode, native.focusOffset); }
      const r = Number(focused?.dataset.row ?? 0), c = Number(focused?.dataset.col ?? 0);
      rows = tableRows(ctx.source); align = ctx.node.align ?? [];
      const structural = table.rows.length !== rows.length || [...table.rows].some((row, index) => row.cells.length !== rows[index]?.length);
      if (!focused || structural) { if (focused) focused.onblur = null; draw(); }
      const field = focused ? table.rows[Math.min(r, rows.length - 1)]?.cells[Math.min(c, rows[0].length - 1)] : null;
      for (const row of [...table.rows]) for (const cell of [...row.cells]) {
        const next = rows[Number(cell.dataset.row)]?.[Number(cell.dataset.col)] ?? ''; cell.style.textAlign = align[Number(cell.dataset.col)] ?? '';
        if (cell !== field && cell.dataset.value !== next) { cell.replaceChildren(); appendChildren(cell, parseMarkdown(next).children?.[0]?.children ?? [], this.context.host); }
        cell.dataset.value = next;
      }
      if (field && (structural || field.textContent !== rows[Number(field.dataset.row)][Number(field.dataset.col)])) {
        const value = rows[Number(field.dataset.row)][Number(field.dataset.col)]; field.focus(); field.textContent = value; if (!field.firstChild) field.append(document.createTextNode(''));
        const changes = ChangeSet.of(textEdits(oldText, value), oldText.length); const mappedAnchor = changes.mapPos(anchor, 1), mappedHead = changes.mapPos(head, anchor === head ? 1 : -1);
        window.getSelection()?.setBaseAndExtent(field.firstChild!, mappedAnchor, field.firstChild!, mappedHead);
      }
    };
  }
  updateDOM(frame: HTMLElement) {
    const root = frame.firstElementChild as HTMLElement;
    if (!['code', 'table', 'math'].includes(this.kind) || !root.classList.contains(`md-${this.kind}`)) return false;
    (root as any).context = this.context; root.dataset.from = String(this.context.from); root.dataset.to = String(this.context.to);
    if (this.kind === 'code') { (root as any).syncCode(this.context.node.value ?? ''); (root as any).syncDiagram?.(this.context.node.value ?? ''); (root as any).syncLanguage?.(this.context.node.lang ?? ''); const input = root.querySelector('input')!; if (document.activeElement !== input) input.value = this.context.node.lang ?? ''; if (root.classList.contains('md-diagram') !== (this.context.node.lang === 'mermaid')) return false; }
    if (this.kind === 'table') (root as any).syncTable(this.context);
    if (this.kind === 'math' && !root.contains(document.activeElement)) { root.querySelector('textarea')!.value = this.context.node.value ?? ''; root.querySelector('.math-result')!.innerHTML = katex.renderToString(this.context.node.value ?? '', { displayMode: true, throwOnError: false, strict: 'ignore', trust: false }); }
    return true;
  }
  destroy(frame: HTMLElement) { (frame as any).disposeMeasure?.(); const root = frame.firstElementChild as HTMLElement; (root as any).diagramDispose?.(); (root as any).disposeGithub?.(); widgetEditors.get(root)?.destroy(); }
  ignoreEvent() { return true; }
}
function previewDecorations(state: EditorState, ast: MarkdownNode, host: Host): DecorationSet {
  if (state.field(sourceField)) return Decoration.none;
  const source = state.doc.toString(); const ranges: ReturnType<Decoration['range']>[] = [];
  const definitions = new Map<string, string>(); const footnotes = new Map<string, string>();
  const orderedMarkers = new WeakMap<MarkdownNode, { number: number; width: string }>();
  walk(ast, node => {
    if (node.type === 'definition') definitions.set(node.identifier!, node.url!);
    if (node.type === 'footnoteDefinition') footnotes.set(node.identifier!, plainText(node));
    if (node.type === 'list' && node.ordered) { const start = node.start ?? 1; const width = `${Math.max(String(start).length, String(start + (node.children?.length ?? 1) - 1).length) + 2}ch`; node.children?.forEach((item, index) => orderedMarkers.set(item, { number: start + index, width })); }
  });
  const selection = state.selection.main;
  const active = (from: number, to: number) => selection.empty ? selection.head >= from && selection.head <= to : selection.from < to && selection.to > from;
  const hide = (from: number, to: number) => { if (to > from) ranges.push(Decoration.replace({}).range(from, to)); };
  const mark = (from: number, to: number, cls: string, attributes?: Record<string, string>) => { if (to > from) ranges.push(Decoration.mark({ class: cls, attributes }).range(from, to)); };
  const line = (from: number, cls: string, attributes?: Record<string, string>) => ranges.push(Decoration.line({ class: cls, attributes }).range(state.doc.lineAt(from).from));
  const block = (node: MarkdownNode, kind: string, always = false) => {
    const from = startOf(node), to = endOf(node); if (!always && active(from, to)) return false;
    ranges.push(Decoration.replace({ block: true, widget: new BlockWidget({ node, from, to, source: source.slice(from, to), host, signature: kind === 'toc' ? JSON.stringify(headings(source)) : undefined }, kind) }).range(from, to)); return true;
  };
  const visit = (node: MarkdownNode, parent?: MarkdownNode) => {
    const from = startOf(node), to = endOf(node); const raw = source.slice(from, to);
    const topLevel = !parent || parent.type === 'root';
    if (node.type === 'code' && topLevel && raw.includes('\n') && /^\s*(`{3,}|~{3,})/.test(raw) && /\n\s*(`{3,}|~{3,})\s*$/.test(raw)) { block(node, 'code', true); return; }
    if (node.type === 'code' && !topLevel) for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) line(state.doc.line(n).from, 'md-nested-code');
    if (node.type === 'table' && topLevel) { block(node, 'table', true); return; }
    if (node.type === 'math' && topLevel) { block(node, 'math', true); return; }
    if (node.type === 'thematicBreak') { if (block(node, 'rule')) return; }
    if (node.type === 'html' && raw.includes('\n') && block(node, 'html')) return;
    if (node.type === 'paragraph' && /^\[toc\]$/i.test(raw.trim()) && block(node, 'toc')) return;
    if (node.type === 'image' && parent?.type === 'paragraph' && parent.children?.length === 1) { block(node, 'image', true); return; }
    if (node.type === 'heading') {
      line(from, `md-heading md-h${node.depth}`); const prefix = /^#{1,6}\s+/.exec(raw);
      if (prefix) hide(from, from + prefix[0].length);
      const suffix = /\s+#+\s*$/.exec(raw); if (suffix) hide(to - suffix[0].length, to);
      if (!prefix) { const newline = raw.indexOf('\n'); if (newline >= 0) hide(from + newline, to); }
    }
    if (node.type === 'blockquote') {
      for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) { const row = state.doc.line(number); line(row.from, 'md-quote'); const marker = /^(\s*>\s?)+/.exec(row.text); if (marker) { if (active(row.from, row.to)) mark(row.from, row.from + marker[0].length, 'md-quote-marker'); else hide(row.from, row.from + marker[0].length); } }
    }
    if (node.type === 'listItem') {
      const row = state.doc.lineAt(from); const ordered = orderedMarkers.get(node);
      line(from, (node.checked !== null && node.checked !== undefined ? 'md-task' : 'md-list') + (ordered && from === row.from ? ' md-ordered-hanging' : ''), ordered ? { style: `--list-marker-width:${ordered.width}` } : undefined);
      const prefix = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(raw);
      if (prefix && ordered) {
        const delimiter = /^\s*\d+([.)])/.exec(prefix[0])?.[1] ?? '.'; const label = `${ordered.number}${delimiter}`;
        // Retain the real source text in the editable DOM for IME/clipboard offsets.
        mark(from + prefix[1].length, from + prefix[0].length, 'md-list-number', { 'data-list-marker': label, 'aria-label': label });
      }
      if (prefix && !active(row.from, row.to)) {
        if (node.checked !== null && node.checked !== undefined) {
          const task = raw.indexOf('[', prefix[0].length); if (task >= 0) { hide(from + (ordered ? prefix[0].length : prefix[1].length), from + task); ranges.push(Decoration.replace({ widget: new TaskWidget(node.checked, from + task) }).range(from + task, from + task + 3)); }
        } else if (!parent?.ordered) ranges.push(Decoration.replace({ widget: new InlineWidget('bullet', '•', host) }).range(from + prefix[1].length, from + prefix[0].length));
      }
      if (node.checked) mark(from, to, 'md-completed');
    }
    if (['strong', 'emphasis', 'delete', 'inlineCode', 'link', 'linkReference'].includes(node.type)) {
      const cls: Record<string, string> = { strong: 'md-strong', emphasis: 'md-em', delete: 'md-del', inlineCode: 'md-inline-code', link: 'md-link', linkReference: 'md-link' };
      const innerFrom = node.children?.length ? startOf(node.children[0]) : from + (/^`+/.exec(raw)?.[0].length ?? 1);
      const innerTo = node.children?.length ? endOf(node.children[node.children.length - 1]) : to - (/`+$/.exec(raw)?.[0].length ?? 1);
      const url = node.url ?? definitions.get(node.identifier ?? ''); mark(innerFrom, innerTo, cls[node.type], url ? { 'data-href': url } : undefined);
      if (!active(from, to)) { hide(from, innerFrom); hide(innerTo, to); }
    }
    if (node.type === 'inlineMath' && !active(from, to)) { ranges.push(Decoration.replace({ widget: new InlineWidget('math', node.value ?? '', host) }).range(from, to)); return; }
    if (node.type === 'image' && !active(from, to)) { ranges.push(Decoration.replace({ widget: new InlineWidget('image', JSON.stringify([node.url, node.alt]), host) }).range(from, to)); return; }
    if (node.type === 'footnoteReference' && !active(from, to)) { ranges.push(Decoration.replace({ widget: new InlineWidget('footnote', JSON.stringify([node.identifier, footnotes.get(node.identifier!) ?? '']), host) }).range(from, to)); return; }
    if (node.type === 'footnoteDefinition') { line(from, 'md-footnote-definition'); const prefix = /^\[\^[^\]]+\]:\s*/.exec(raw); if (prefix && !active(from, to)) hide(from, from + prefix[0].length); }
    if (node.type === 'html' && !raw.includes('\n') && !active(from, to)) { if (/^<\/?(?:u|sub|sup|mark)>$/i.test(raw)) hide(from, to); }
    if (node.type === 'text') {
      for (const match of raw.matchAll(/:([a-z_0-9+-]+):/g)) if (emoji[match[1]]) { const offset = from + match.index!; if (!active(offset, offset + match[0].length)) ranges.push(Decoration.replace({ widget: new InlineWidget('emoji', emoji[match[1]], host) }).range(offset, offset + match[0].length)); }
      for (const match of raw.matchAll(/(==)([^=\n]+)\1|(\^)([^\^\n]+)\3|(?<!~)(~)([^~\n]+)\5(?!~)/g)) {
        const offset = from + match.index!; const delimiter = match[1] ?? match[3] ?? match[5]; const length = delimiter.length;
        mark(offset + length, offset + match[0].length - length, match[1] ? 'md-highlight' : match[3] ? 'md-sup' : 'md-sub');
        if (!active(offset, offset + match[0].length)) { hide(offset, offset + length); hide(offset + match[0].length - length, offset + match[0].length); }
      }
    }
    if (node.type === 'paragraph') for (const match of raw.matchAll(/<(u|sub|sup|mark)>([\s\S]*?)<\/\1>/g)) {
      const offset = from + match.index!; const opening = match[1].length + 2; const closing = opening + 1;
      mark(offset + opening, offset + match[0].length - closing, { u: 'md-underline', sub: 'md-sub', sup: 'md-sup', mark: 'md-highlight' }[match[1]]!);
    }
    for (const child of node.children ?? []) visit(child, node);
  };
  visit(ast);
  // YAML front matter stays readable, but receives a compact metadata block style.
  const yaml = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(source);
  if (yaml) { const to = yaml[0].trimEnd().length; for (let n = 1; n <= state.doc.lineAt(to).number; n++) line(state.doc.line(n).from, 'md-frontmatter'); }
  return Decoration.set(ranges, true);
}
function highlightSelection(view: EditorView): boolean {
  const { from, to } = view.state.selection.main; if (from === to) return false;
  let code = false;
  walk(parseMarkdown(view.state.doc.toString()), node => { if (node.type === 'code' && startOf(node) < to && endOf(node) > from) code = true; });
  if (code) return false; wrapSelection(view, '=='); return true;
}
export function wrapSelection(view: EditorView, left: string, right = left) {
  const selection = view.state.selection.main; const result = toggleMarkup(view.state.doc.toString(), selection.from, selection.to, left, right);
  view.dispatch({ changes: result.changes, selection: { anchor: result.anchor, head: result.head }, annotations: isolateHistory.of('full'), scrollIntoView: true }); view.focus();
}
export function setBlock(view: EditorView, prefix: string) {
  const selection = view.state.selection.main; const changes: Array<{ from: number; to: number; insert: string }> = [];
  const start = view.state.doc.lineAt(selection.from).number; const end = view.state.doc.lineAt(!selection.empty && view.state.doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to).number;
  for (let n = start; n <= end; n++) { const row = view.state.doc.line(n); const previous = /^(#{1,6}\s+|>[ \t]?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/.exec(row.text)?.[0] ?? ''; changes.push({ from: row.from, to: row.from + previous.length, insert: previous === prefix || (prefix === '> ' && previous.startsWith('>')) ? '' : prefix }); }
  const mapping = view.state.changes(changes);
  view.dispatch({ changes: mapping, selection: view.state.selection.map(mapping, 1), annotations: isolateHistory.of('full'), scrollIntoView: true }); view.focus();
}
function insertBlock(view: EditorView, content: string, cursorOffset: number) {
  let { from, to } = view.state.selection.main;
  if (from === to) { const widget = [...view.dom.querySelectorAll<HTMLElement>('.md-block')].find(root => Number(root.dataset.from) < from && Number(root.dataset.to) > from); if (widget) from = to = Number(widget.dataset.to); }
  const prefix = view.state.sliceDoc(0, from), suffix = view.state.sliceDoc(to);
  const before = from > 0 ? '\n'.repeat(Math.max(0, 2 - (/\n{1,2}$/.exec(prefix)?.[0].length ?? 0))) : '';
  const after = '\n'.repeat(Math.max(0, 2 - (/^\n{1,2}/.exec(suffix)?.[0].length ?? 0)));
  view.dispatch({ changes: { from, to, insert: before + content + after }, selection: { anchor: from + before.length + cursorOffset }, annotations: isolateHistory.of('full'), scrollIntoView: true }); view.focus();
  focusEmbedded(view, from + before.length + cursorOffset);
}
export function editorAction(view: EditorView, action: string): boolean {
  if (action === 'undo') return undo(view); if (action === 'redo') return redo(view);
  if (action === 'find' || action === 'replace') return openSearchPanel(view);
  if (action === 'tidy-chinese') { const selected = view.state.selection.main; const changes = tidyChineseMarkdown(view.state.doc.toString(), selected.empty ? undefined : { from: selected.from, to: selected.to }); if (changes.length) view.dispatch({ changes, annotations: isolateHistory.of('full') }); return true; }
  if (/^heading-[0-6]$/.test(action)) { setBlock(view, action === 'heading-0' ? '' : '#'.repeat(Number(action.slice(-1))) + ' '); return true; }
  if (action === 'heading-increase' || action === 'heading-decrease') { const depth = /^(#{1,6})\s/.exec(view.state.doc.lineAt(view.state.selection.main.head).text)?.[1].length ?? 0; const next = Math.max(0, Math.min(6, depth + (action === 'heading-increase' ? 1 : -1))); setBlock(view, next ? '#'.repeat(next) + ' ' : ''); return true; }
  const formats: Record<string, [string, string?]> = { bold: ['**'], italic: ['*'], underline: ['<u>', '</u>'], strike: ['~~'], 'inline-code': ['`'], highlight: ['=='], subscript: ['~'], superscript: ['^'] };
  if (formats[action]) { wrapSelection(view, ...formats[action]); return true; }
  const blocks: Record<string, string> = { quote: '> ', bullet: '- ', ordered: '1. ', task: '- [ ] ' };
  if (blocks[action]) { setBlock(view, blocks[action]); return true; }
  if (action === 'link') { wrapSelection(view, '[', '](https://)'); return true; }
  if (action === 'image') { wrapSelection(view, '![', '](图片路径)'); return true; }
  if (action === 'code') { const selected = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to); insertBlock(view, '```\n' + selected + '\n```', 4); return true; }
  if (action === 'math') { insertBlock(view, '$$\n\n$$', 3); return true; }
  if (action === 'table') { insertBlock(view, '| 标题 | 标题 |\n| --- | --- |\n|  |  |', 2); return true; }
  if (action === 'toc') { insertBlock(view, '[toc]', 5); return true; }
  if (action === 'rule') { insertBlock(view, '---', 3); return true; }
  if (action === 'clear-format') { const { from, to } = view.state.selection.main; view.dispatch({ changes: { from, to, insert: view.state.sliceDoc(from, to).replace(/\*\*|~~|==|`|\*/g, '') } }); return true; }
  return false;
}
function smartEnter(view: EditorView): boolean {
  if (view.state.field(sourceField)) return false;
  const selection = view.state.selection.main;
  const row = view.state.doc.lineAt(selection.head);
  const heading = /^#{1,6}[ \t]+/.exec(row.text);
  if (selection.empty && heading) {
    if (!row.text.slice(heading[0].length).trim()) { view.dispatch({ changes: { from: row.from, to: row.to }, selection: { anchor: row.from }, annotations: isolateHistory.of('full') }); return true; }
    if (selection.head <= row.from + heading[0].length) { view.dispatch({ changes: { from: row.from, insert: '\n' }, selection: { anchor: row.from + 1 + heading[0].length }, annotations: isolateHistory.of('full'), scrollIntoView: true }); return true; }
  }
  if (!selection.empty || selection.head !== row.to) {
    if (selection.empty && insertNewlineContinueMarkup(view)) return true;
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert: '\n\n' }, selection: { anchor: selection.from + 2 }, annotations: isolateHistory.of('full'), scrollIntoView: true }); return true;
  }
  if (row.number === 1 && row.text === '---') { view.dispatch({ changes: { from: row.to, insert: '\n\n---\n\n' }, selection: { anchor: row.to + 1 } }); return true; }
  if (/^\s*(`{3,}|~{3,})\w*$/.test(row.text)) { const fence = /^\s*(`{3,}|~{3,})/.exec(row.text)![1]; view.dispatch({ changes: { from: row.to, insert: `\n\n${fence}\n` }, selection: { anchor: row.to + 1 } }); focusEmbedded(view, row.to + 1); return true; }
  if (row.text === '$$') { view.dispatch({ changes: { from: row.to, insert: '\n\n$$\n' }, selection: { anchor: row.to + 1 } }); focusEmbedded(view, row.to + 1); return true; }
  if (/^\s*\|.*\|\s*$/.test(row.text) && row.text.split('|').length > 2 && (row.number === 1 || !view.state.doc.line(row.number - 1).text.trim().startsWith('|'))) {
    const cells = tableRows(row.text)[0]; const separator = '\n| ' + cells.map(() => '---').join(' | ') + ' |\n| ' + cells.map(() => '').join(' | ') + ' |\n';
    view.dispatch({ changes: { from: row.to, insert: separator }, selection: { anchor: row.to + 1 } }); focusEmbedded(view, row.to + 1); return true;
  }
  if (insertNewlineContinueMarkup(view)) return true;
  view.dispatch({ changes: { from: selection.from, to: selection.to, insert: row.text.trim() ? '\n\n' : '\n' }, selection: { anchor: selection.from + (row.text.trim() ? 2 : 1) }, scrollIntoView: true }); return true;
}
export class MarkdownEditor {
  readonly view: EditorView;
  constructor(parent: HTMLElement, content: string, readonly host: Host) {
    let compositionSequence = 0;
    const finishComposition = (view: EditorView, sequence: number) => { requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!view.dom.isConnected || sequence !== compositionSequence) return;
      if (view.compositionStarted) { finishComposition(view, sequence); return; }
      if (view.state.field(quoteCompositionField)) { view.dispatch({ effects: quoteCompositionEffect.of(false) }); host.changed(view.state.doc.toString()); }
    })); };
    const preview = StateField.define<{ ast: MarkdownNode; decorations: DecorationSet }>({
      create(state) { const ast = parseMarkdown(state.doc.toString()); return { ast, decorations: previewDecorations(state, ast, host) }; },
      update(value, transaction) { if (transaction.state.field(quoteCompositionField)) return { ast: value.ast, decorations: value.decorations.map(transaction.changes) };
        const ast = transaction.docChanged || transaction.startState.field(quoteCompositionField) ? parseMarkdown(transaction.state.doc.toString()) : value.ast;
        if (transaction.docChanged || transaction.selection || transaction.effects.length) return { ast, decorations: previewDecorations(transaction.state, ast, host) }; return value; },
      provide: field => EditorView.decorations.from(field, value => value.decorations),
    });
    const actions: Record<string, string> = { 'Mod-b': 'bold', 'Mod-i': 'italic', 'Mod-u': 'underline', 'Alt-Shift-5': 'strike', 'Mod-k': 'link', 'Mod-Shift-i': 'image', 'Mod-Shift-k': 'code', 'Mod-Shift-m': 'math', 'Mod-Shift-q': 'quote', 'Mod-t': 'table', 'Mod-Shift-[': 'ordered', 'Mod-Shift-]': 'bullet', 'Mod-Shift-`': 'inline-code' };
    for (let n = 0; n <= 6; n++) actions[`Mod-${n}`] = `heading-${n}`;
    const bindings = Object.entries(actions).map(([key, action]) => ({ key, run: (view: EditorView) => editorAction(view, action), preventDefault: true }));
    bindings.push({ key: 'Mod-Shift-z', run: redo, preventDefault: true });
    bindings.push({ key: 'Mod-l', run: selectLine, preventDefault: true });
    bindings.push({ key: 'Mod-=', run: view => editorAction(view, 'heading-increase'), preventDefault: true });
    bindings.push({ key: 'Mod--', run: view => editorAction(view, 'heading-decrease'), preventDefault: true });
    bindings.push({ key: 'Backspace', preventDefault: false, run(view) {
      const { from, to } = view.state.selection.main;
      if (from === to && from > 0 && ['()', '[]', '{}', '""', "''", '``'].includes(view.state.sliceDoc(from - 1, from + 1))) { view.dispatch({ changes: { from: from - 1, to: from + 1 }, selection: { anchor: from - 1 } }); return true; }
      if (!view.state.field(sourceField) && from === to) { const row = view.state.doc.lineAt(from); const prefix = /^#{1,6}\s+/.exec(row.text); if (prefix && from <= row.from + prefix[0].length) { view.dispatch({ changes: { from: row.from, to: row.from + prefix[0].length }, selection: { anchor: row.from } }); return true; } if (deleteMarkupBackward(view)) return true; }
      return false;
    } });
    this.view = new EditorView({ parent, state: EditorState.create({ doc: content, extensions: [sourceField, quoteCompositionField, preview, history(), drawSelection(), dropCursor(), rectangularSelection(), highlightActiveLine(), EditorView.lineWrapping, markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }), syntaxHighlighting(defaultHighlightStyle), bracketMatching(), search({ top: true }), Prec.high(keymap.of([{ key: 'Enter', run: smartEnter }, { key: 'Shift-Enter', run(view) { const { from, to } = view.state.selection.main; const insert = view.state.field(sourceField) ? '\n' : '  \n'; view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } }); return true; } }, ...bindings, { key: 'Mod-h', run: openSearchPanel, preventDefault: true }])), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]), EditorView.contentAttributes.of({ 'aria-label': 'Markdown 文档编辑区', spellcheck: 'false', autocapitalize: 'off' }), EditorView.editorAttributes.of(view => ({ class: 'markdown-editor', 'data-source': String(view.state.field(sourceField)) })),
      EditorView.updateListener.of(update => { if (update.docChanged) host.changed(update.state.doc.toString()); }),
      EditorView.domEventHandlers({
        compositionstart(_event, view) { if (view.hasFocus && !view.state.field(sourceField) && /^\s*>/.test(view.state.doc.lineAt(view.state.selection.main.head).text)) { compositionSequence++; view.dispatch({ effects: quoteCompositionEffect.of(true) }); } return false; },
        compositionend(_event, view) { if (view.state.field(quoteCompositionField)) finishComposition(view, compositionSequence); return false; },
        click(event) { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-href]'); if (target && (event.ctrlKey || event.metaKey)) { event.preventDefault(); host.link(target.dataset.href!); return true; } return false; }
      }),
      EditorView.inputHandler.of((view, from, to, text) => {
        if (view.composing || text.length !== 1) return false;
        if (text === '=' && from !== to) return highlightSelection(view);
        const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`', '*': '*', '~': '~', '=': '=', '^': '^' };
        const next = view.state.sliceDoc(to, to + 1); if (from === to && /[)\]}"'`]/.test(text) && next === text) { view.dispatch({ selection: { anchor: to + 1 } }); return true; }
        if (!pairs[text]) return false;
        if (from === to && ['*', '~', '=', '^', '`'].includes(text)) return false;
        if (from === to && /[\p{L}\p{N}]/u.test(next)) return false;
        if (from === to && /["']/.test(text) && /[\p{L}\p{N}]/u.test(view.state.sliceDoc(Math.max(0, from - 1), from))) return false;
        const selected = view.state.sliceDoc(from, to); view.dispatch({ changes: { from, to, insert: text + selected + pairs[text] }, selection: { anchor: from + 1, head: to + 1 } }); return true;
      }),
    ] }) });
    this.view.dispatch({ effects: StateEffect.appendConfig.of([autocompletion({ override: [completeEmoji] }), EditorState.phrases.of({ Find: '查找', Replace: '替换', next: '下一处', previous: '上一处', all: '全部', 'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配', replace: '替换', 'replace all': '全部替换', close: '关闭' })]) });
  }
  get content() { return this.view.state.doc.toString(); }
  get source() { return this.view.state.field(sourceField); }
  setCodeWrap(enabled: boolean) { for (const root of this.view.dom.querySelectorAll<HTMLElement>('.md-code')) (root as any).setCodeWrap?.(enabled); }
  setCodeAppearance(workbuddy: boolean, githubDark: boolean) { for (const root of this.view.dom.querySelectorAll<HTMLElement>('.md-code')) (root as any).setCodeAppearance?.(workbuddy, githubDark); }
  setSource(source: boolean) { this.view.dispatch({ effects: sourceEffect.of(source) }); this.view.dom.dataset.source = String(source); this.view.focus(); }
  replace(content: string) { if (this.view.compositionStarted && this.view.state.field(quoteCompositionField)) return; if (content !== this.content) this.view.dispatch({ changes: textEdits(this.content, content), annotations: isolateHistory.of('full') }); }
  insertImage(url: string, alt = '图片') { const label = alt.replace(/[\[\]\\\r\n]/g, ' '); const markdown = `![${label}](${url})`; insertBlock(this.view, markdown, markdown.length + 2); }
  action(action: string) { return editorAction(this.view, action); }
  highlightSelection() { return highlightSelection(this.view); }
  focus() { this.view.focus(); }
  destroy() { this.view.destroy(); }
}

export async function exportHTML(source: string, host: Host): Promise<string> {
  const root = document.createElement('article');
  const render = (node: MarkdownNode): Node => {
    if (node.type === 'heading') { const heading = document.createElement(`h${node.depth}`); for (const child of node.children ?? []) heading.append(renderNode(child, host)); return heading; }
    if (node.type === 'thematicBreak') return document.createElement('hr');
    if (node.type === 'code') { const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = node.value ?? ''; pre.append(code); return pre; }
    if (node.type === 'table') { const table = document.createElement('table'); (node.children ?? []).forEach((row, index) => { const tr = document.createElement('tr'); (row.children ?? []).forEach((cell, col) => { const td = document.createElement(index ? 'td' : 'th'); td.style.textAlign = node.align?.[col] ?? ''; for (const child of cell.children ?? []) td.append(renderNode(child, host)); tr.append(td); }); table.append(tr); }); return table; }
    return renderNode(node, host);
  }; for (const child of parseMarkdown(source).children ?? []) {
    if (child.type === 'yaml') continue;
    if (child.type === 'code' && child.lang !== 'mermaid' && host.workbuddy?.()) {
      const value = child.value ?? ''; const pre = document.createElement('pre'); pre.className = 'wb-code'; const code = document.createElement('code');
      const colored = host.githubDark?.() ? await tokenizeGithub(value, child.lang ?? '').catch(() => null) : null;
      const lines = colored ?? value.split('\n').map(content => [{ content, color: '#e1e4e8', fontStyle: 0 }]);
      for (const [index, tokens] of lines.entries()) {
        const line = document.createElement('span'); line.className = 'line';
        for (const token of tokens) { const span = document.createElement('span'); span.textContent = token.content; span.style.color = token.color ?? '#e1e4e8'; if ((token.fontStyle ?? 0) & 1) span.style.fontStyle = 'italic'; if ((token.fontStyle ?? 0) & 2) span.style.fontWeight = '700'; line.append(span); }
        code.append(line); if (index < lines.length - 1) code.append(document.createTextNode('\n'));
      }
      pre.append(code); root.append(pre); continue;
    }
    if (child.type === 'code' && child.lang === 'mermaid') {
      try { const { default: mermaid } = await import('mermaid'); mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false }); const diagram = await mermaid.render(`export-${crypto.randomUUID()}`, child.value ?? ''); const block = document.createElement('div'); block.innerHTML = DOMPurify.sanitize(diagram.svg, { USE_PROFILES: { svg: true, svgFilters: true } }); root.append(block); continue; } catch { /* Incomplete diagrams remain readable as code. */ }
    }
    root.append(render(child));
  } return root.innerHTML;
}
