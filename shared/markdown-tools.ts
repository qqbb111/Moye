import diff from 'fast-diff';
import { parseMarkdown, startOf, endOf, plainText, type MarkdownNode } from '../src/markdown';

export interface TextEdit { from: number; to: number; insert: string }
export function textEdits(before: string, after: string): TextEdit[] {
  const result: TextEdit[] = []; let position = 0; let pending: TextEdit | undefined;
  for (const [operation, text] of diff(before, after)) {
    if (operation === 0) { if (pending) result.push(pending); pending = undefined; position += text.length; }
    else { pending ??= { from: position, to: position, insert: '' }; if (operation < 0) { position += text.length; pending.to = position; } else pending.insert += text; }
  }
  if (pending) result.push(pending); return result;
}
export function applyEdits(source: string, edits: TextEdit[]) { for (const edit of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to); return source; }

const han = /\p{Script=Han}/u;
const cjkLatinBoundary = (left: string, right: string) => (han.test(left) && /[A-Za-z0-9]/.test(right)) || (/[A-Za-z0-9%°]/.test(left) && han.test(right));
export function tidyChineseText(text: string): string {
  // Addresses and paths are prose tokens too; their spelling must stay exact.
  const protectedToken = /(?:https?:\/\/|(?:moye|replica)-media:\/\/|data:image\/)[^\s<>]+|\b[A-Za-z]:[\\/][^\s<>]+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[\p{L}\p{N}_./\\-]+\.(?:md|txt|cpp|hpp|h|py|js|ts|tsx|json|ya?ml|html|css|png|jpe?g|svg)\b/gu;
  const tidy = (value: string) => {
    value = value.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
    value = value.replace(/(\p{Script=Han})([A-Za-z0-9])/gu, '$1 $2').replace(/([A-Za-z0-9%°])(\p{Script=Han})/gu, '$1 $2');
    value = value.replace(/(C\+\+|C#)(\p{Script=Han})/giu, '$1 $2');
    value = value.replace(/(\d)(Gbps|Mbps|GHz|MHz|kHz|KiB|MiB|GiB|KB|MB|GB|TB|Hz|ms|cm|mm|km|kg|px|mL)(?=$|[^A-Za-z])/g, '$1 $2').replace(/(\d)[ \t]+([%°℃])/g, '$1$2');
    const punctuation: Record<string, string> = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！', '.': '。' };
    value = value.replace(/(\p{Script=Han})[ \t]*([,;:!?]|\.(?!\.))/gu, (_all, previous, mark) => previous + punctuation[mark]);
    value = value.replace(/([,;:!?])[ \t]*(?=\p{Script=Han})/gu, mark => punctuation[mark.trim()] ?? mark);
    value = value.replace(/(\p{Script=Han})[ \t]*\(([^()\n]+)\)/gu, '$1（$2）');
    return value.replace(/[ \t]+([，。！？；：、）】》])/g, '$1').replace(/([，。！？；：、（【《])[ \t]+(?=\S)/g, '$1').replace(/([！？])\1+/g, '$1');
  };
  let output = ''; let position = 0;
  for (const match of text.matchAll(protectedToken)) { output += tidy(text.slice(position, match.index)) + match[0]; position = match.index! + match[0].length; }
  return output + tidy(text.slice(position));
}

export function tidyChineseMarkdown(source: string, range = { from: 0, to: source.length }): TextEdit[] {
  const edits: TextEdit[] = []; const prefixes = new Set<number>();
  const visit = (node: MarkdownNode, protectedParent = false) => {
    const protectedNode = protectedParent || ['code', 'inlineCode', 'math', 'inlineMath', 'html', 'yaml', 'image', 'imageReference', 'definition'].includes(node.type) || (node.type === 'link' && plainText(node) === node.url);
    if (protectedNode) return;
    if (node.type === 'text') {
      const from = Math.max(startOf(node), range.from), to = Math.min(endOf(node), range.to); if (to <= from) return;
      const raw = source.slice(from, to); const next = tidyChineseText(raw); if (next !== raw) edits.push({ from, to, insert: next });
    }
    const children = node.children ?? [];
    if (['paragraph', 'heading', 'strong', 'emphasis', 'delete', 'tableCell'].includes(node.type)) {
      for (let index = 1; index < children.length; index++) {
        const left = children[index - 1], right = children[index]; const at = startOf(right);
        if (at < range.from || at > range.to || /\s/.test(source.slice(endOf(left) - 1, endOf(left))) || /\s/.test(source.slice(at, at + 1))) continue;
        const leftLast = plainText(left).slice(-1), rightFirst = plainText(right).slice(0, 1);
        if (cjkLatinBoundary(leftLast, rightFirst) || (left.type === 'inlineCode' && han.test(rightFirst)) || (right.type === 'inlineCode' && han.test(leftLast))) prefixes.add(at);
      }
    }
    for (const child of children) visit(child);
  }; visit(parseMarkdown(source));
  for (const at of prefixes) { const existing = edits.find(edit => edit.from === at); if (existing) existing.insert = ' ' + existing.insert; else edits.push({ from: at, to: at, insert: ' ' }); }
  return textEdits(source, applyEdits(source, edits));
}

const wordSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
function formattingWord(source: string, position: number) {
  let result: { from: number; to: number } | undefined;
  const visit = (node: MarkdownNode, parent?: MarkdownNode) => {
    if (['code', 'inlineCode', 'math', 'inlineMath', 'html', 'yaml', 'image', 'definition'].includes(node.type)) return;
    if (node.type === 'text') {
      const start = startOf(node), end = endOf(node);
      const at = parent?.type === 'strong' && endOf(parent) === position ? end : position;
      if (at > start && at <= end) for (const part of wordSegmenter.segment(source.slice(start, end))) {
        if (part.isWordLike && start + part.index < at && start + part.index + part.segment.length >= at) result = { from: start + part.index, to: start + part.index + part.segment.length };
      }
    }
    for (const child of node.children ?? []) visit(child, node);
  }; visit(parseMarkdown(source)); return result;
}
export function toggleMarkup(source: string, from: number, to: number, left: string, right = left): { changes: TextEdit[]; anchor: number; head: number } {
  if (from === to && left === '**') {
    const word = formattingWord(source, from);
    if (word) {
      const result = toggleMarkup(source, word.from, word.to, left, right); let cursor = from;
      for (const edit of result.changes) { if (edit.to <= from) cursor += edit.insert.length - (edit.to - edit.from); else if (edit.from <= from) cursor = edit.from + (cursor - from) + edit.insert.length; }
      return { ...result, anchor: cursor, head: cursor };
    }
  }
  const selected = source.slice(from, to);
  const result = (start: number, end: number, insert: string, anchor: number, head: number) => ({ changes: textEdits(source, source.slice(0, start) + insert + source.slice(end)), anchor, head });
  if (left === '**' || left === '*') {
    if (selected.length) {
      const leading = /^\s*/.exec(selected)![0].length, trailing = /\s*$/.exec(selected)![0].length;
      if (leading === selected.length) return { changes: [], anchor: from, head: to };
      if (leading || trailing) {
        const trimmed = toggleMarkup(source, from + leading, to - trailing, left, right);
        return trimmed.changes.length ? trimmed : { changes: [], anchor: from, head: to };
      }
    }
    let enclosing: MarkdownNode | undefined;
    let blocks = 0;
    const visit = (node: MarkdownNode) => {
      if (['paragraph', 'heading', 'tableCell'].includes(node.type) && startOf(node) < to && endOf(node) > from) blocks++;
      if (node.type === (left === '**' ? 'strong' : 'emphasis') && startOf(node) <= from && endOf(node) >= to) enclosing = node;
      for (const child of node.children ?? []) visit(child);
    }; visit(parseMarkdown(source));
    if (blocks > 1) return { changes: [], anchor: from, head: to };
    if (enclosing) {
      const start = startOf(enclosing), end = endOf(enclosing); const marker = left; const innerStart = start + left.length, innerEnd = end - left.length;
      if (from >= innerStart && to <= innerEnd && from < to && enclosing.children?.every(child => child.type === 'text')) {
        const wrap = (text: string) => {
          const leading = /^\s*/.exec(text)![0], trailing = /\s*$/.exec(text)![0];
          return text.trim() ? leading + marker + text.slice(leading.length, text.length - trailing.length) + marker + trailing : text;
        };
        const before = source.slice(innerStart, from), after = source.slice(to, innerEnd); const prefix = wrap(before), suffix = wrap(after);
        return result(start, end, prefix + selected + suffix, start + prefix.length, start + prefix.length + selected.length);
      }
      return result(start, end, source.slice(innerStart, innerEnd), start + Math.max(0, Math.min(innerEnd - innerStart, from - innerStart)), start + Math.max(0, Math.min(innerEnd - innerStart, to - innerStart)));
    }
  } else {
    if (selected.length >= left.length + right.length && selected.startsWith(left) && selected.endsWith(right)) return result(from, to, selected.slice(left.length, -right.length), from, to - left.length - right.length);
    if (from >= left.length && source.slice(from - left.length, from) === left && source.slice(to, to + right.length) === right) return result(from - left.length, to + right.length, selected, from - left.length, to - left.length);
  }
  return result(from, to, left + selected + right, from + left.length, to + left.length);
}

export function clearMarkup(source: string, from: number, to: number): { changes: TextEdit[]; anchor: number; head: number } {
  if (from === to) return { changes: [], anchor: from, head: to };
  const removals: Array<{ from: number; to: number }> = [], insertions = new Map<number, string>();
  const insert = (at: number, text: string) => insertions.set(at, (insertions.get(at) ?? '') + text);
  const frame = (start: number, innerStart: number, innerEnd: number, end: number, split = false) => {
    if (from >= innerEnd || to <= innerStart) return;
    const opening = source.slice(start, innerStart), closing = source.slice(innerEnd, end);
    if (!split || (from <= innerStart && to >= innerEnd)) {
      removals.push({ from: start, to: innerStart }, { from: innerEnd, to: end }); return;
    }
    const selectedStart = Math.max(from, innerStart), selectedEnd = Math.min(to, innerEnd);
    const before = source.slice(innerStart, selectedStart), after = source.slice(selectedEnd, innerEnd);
    const beforeEnd = selectedStart - /\s*$/.exec(before)![0].length;
    const afterStart = selectedEnd + /^\s*/.exec(after)![0].length;
    if (beforeEnd > innerStart) insert(beforeEnd, closing); else removals.push({ from: start, to: innerStart });
    if (afterStart < innerEnd) insert(afterStart, opening); else removals.push({ from: innerEnd, to: end });
  };
  const custom = /(==)([^=\n]+)\1|(\^)([^\^\n]+)\3|(?<!~)(~)([^~\n]+)\5(?!~)/g;
  const visit = (node: MarkdownNode) => {
    if (['code', 'math', 'inlineMath', 'yaml', 'image', 'imageReference', 'definition'].includes(node.type)) return;
    const start = startOf(node), end = endOf(node), raw = source.slice(start, end);
    if (node.type === 'inlineCode') {
      const width = /^`+/.exec(raw)?.[0].length ?? 1; frame(start, start + width, end - width, end); return;
    }
    if (['strong', 'emphasis', 'delete'].includes(node.type) && node.children?.length) {
      const innerStart = startOf(node.children[0]), innerEnd = endOf(node.children.at(-1)!);
      const simple = node.children.every(child => child.type === 'text') && !source.slice(innerStart, innerEnd).match(custom);
      frame(start, innerStart, innerEnd, end, simple);
    }
    if (node.type === 'text') for (const match of raw.matchAll(custom)) {
      const at = start + match.index!, width = (match[1] ?? match[3] ?? match[5]).length;
      if ((/\\*$/.exec(source.slice(0, at))![0].length % 2) === 0) frame(at, at + width, at + match[0].length - width, at + match[0].length);
    }
    const tags: Array<{ tag: string; node: MarkdownNode }> = [];
    for (const child of node.children ?? []) {
      const tag = child.type === 'html' ? /^<(\/?)(u|sub|sup|mark)>$/i.exec(child.value ?? '') : null;
      if (tag && !tag[1]) tags.push({ tag: tag[2].toLowerCase(), node: child });
      else if (tag && tags.at(-1)?.tag === tag[2].toLowerCase()) {
        const opening = tags.pop()!.node;
        frame(startOf(opening), endOf(opening), startOf(child), endOf(child));
      }
      visit(child);
    }
  }; visit(parseMarkdown(source));
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of removals.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const previous = merged.at(-1);
    if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to); else merged.push({ ...range });
  }
  const edits = [...merged.map(range => ({ ...range, insert: '' })), ...[...insertions].map(([at, insert]) => ({ from: at, to: at, insert }))];
  const changes = textEdits(source, applyEdits(source, edits));
  const mapping = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  const map = (position: number, assoc: number) => {
    let delta = 0;
    for (const edit of mapping) {
      if (position < edit.from || (position === edit.from && assoc < 0)) break;
      if (position > edit.to || (position === edit.to && edit.from !== edit.to)) delta += edit.insert.length - (edit.to - edit.from);
      else if (position === edit.from && edit.from === edit.to) { if (assoc > 0) delta += edit.insert.length; }
      else return edit.from + delta + (assoc > 0 ? edit.insert.length : 0);
    }
    return position + delta;
  };
  return { changes, anchor: map(from, 1), head: map(to, -1) };
}

export function markdownStatistics(source: string, ast = parseMarkdown(source)) {
  const visible = (node: MarkdownNode): string => {
    if (['image', 'imageReference', 'definition', 'yaml', 'html'].includes(node.type)) return '';
    if (node.type === 'link' && /^data:image\//i.test(node.url ?? '')) return '';
    if (node.value !== undefined) return node.value.replace(/data:image\/[^,\s]+;base64,[A-Za-z0-9+/=]+/g, '');
    return (node.children ?? []).map(visible).join(['root', 'list', 'table', 'tableRow'].includes(node.type) ? '\n' : '');
  };
  const text = visible(ast);
  return { words: (text.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? []).length, characters: text.replace(/\s/g, '').length, lines: source.split('\n').length };
}
