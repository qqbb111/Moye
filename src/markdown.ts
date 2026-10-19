import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export interface MarkdownNode {
  type: string; value?: string; depth?: number; lang?: string; url?: string; alt?: string;
  checked?: boolean | null; ordered?: boolean; start?: number; align?: Array<string | null>;
  identifier?: string; children?: MarkdownNode[];
  position?: { start: { offset: number; line: number }; end: { offset: number; line: number } };
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export const startOf = (node: MarkdownNode) => node.position?.start.offset ?? 0;
export const endOf = (node: MarkdownNode) => node.position?.end.offset ?? 0;
export function parseMarkdown(source: string): MarkdownNode {
  const ast = parser.parse(source) as unknown as MarkdownNode;
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
  if (frontmatter) {
    const end = frontmatter[0].trimEnd().length; ast.children = ast.children?.filter(node => startOf(node) >= end);
    ast.children?.unshift({ type: 'yaml', value: frontmatter[1], position: { start: { offset: 0, line: 1 }, end: { offset: end, line: source.slice(0, end).split('\n').length } } });
  } return ast;
}
export function walk(node: MarkdownNode, visitor: (node: MarkdownNode, parent?: MarkdownNode) => void, parent?: MarkdownNode) {
  visitor(node, parent); for (const child of node.children ?? []) walk(child, visitor, node);
}
export function plainText(node: MarkdownNode): string { return node.value ?? (node.children ?? []).map(plainText).join(''); }
export function headings(source: string) {
  const result: Array<{ level: number; text: string; offset: number; slug: string }> = []; const used = new Map<string, number>();
  walk(parseMarkdown(source), node => {
    if (node.type !== 'heading') return;
    const text = plainText(node); const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
    const count = used.get(base) ?? 0; used.set(base, count + 1);
    result.push({ level: node.depth!, text, offset: startOf(node), slug: base + (count ? `-${count}` : '') });
  }); return result;
}
export function tableRows(source: string): string[][] {
  return source.trim().split('\n').map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim())).filter((_row, index) => index !== 1);
}
export function serializeTable(rows: string[][], align: Array<string | null> = []): string {
  const width = Math.max(1, ...rows.map(row => row.length));
  const line = (row: string[]) => '| ' + Array.from({ length: width }, (_, index) => (row[index] ?? '').replace(/(?<!\\)\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |';
  const separator = Array.from({ length: width }, (_, index) => align[index] === 'center' ? ':---:' : align[index] === 'right' ? '---:' : align[index] === 'left' ? ':---' : '---');
  return [line(rows[0] ?? ['']), line(separator), ...rows.slice(1).map(line)].join('\n');
}
