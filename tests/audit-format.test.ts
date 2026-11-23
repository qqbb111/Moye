import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, clearMarkup, toggleMarkup } from '../shared/markdown-tools';
import { parseMarkdown, plainText, walk } from '../src/markdown';

function styles(source: string) {
  const result: string[] = [];
  walk(parseMarkdown(source), node => { if (['strong', 'emphasis', 'delete'].includes(node.type)) result.push(node.type); });
  return result;
}

test('粗体和斜体可按任意顺序叠加，并分别取消', () => {
  for (const order of [['**', '*'], ['*', '**']]) {
    let source = '甲乙', from = 0, to = 2;
    for (const marker of order) {
      const result = toggleMarkup(source, from, to, marker);
      source = applyEdits(source, result.changes); from = result.anchor; to = result.head;
    }
    assert.equal(source, '***甲乙***'); assert.deepEqual(styles(source).sort(), ['emphasis', 'strong']);
    let result = toggleMarkup(source, from, to, '*');
    source = applyEdits(source, result.changes); from = result.anchor; to = result.head;
    assert.equal(source, '**甲乙**'); assert.deepEqual(styles(source), ['strong']);
    result = toggleMarkup(source, from, to, '**');
    assert.equal(applyEdits(source, result.changes), '甲乙');
  }
});

test('边界空白保留在粗体外，再次切换恢复原文', () => {
  for (const [source, from, to, expected] of [
    ['甲乙 丙丁', 0, 3, '**甲乙** 丙丁'],
    ['前文 甲乙', 2, 5, '前文 **甲乙**'],
    [' 甲乙 ', 0, 4, ' **甲乙** '],
    ['\u00a0甲乙\u00a0', 0, 4, '\u00a0**甲乙**\u00a0'],
  ] as const) {
    const result = toggleMarkup(source, from, to, '**'), actual = applyEdits(source, result.changes);
    assert.equal(actual, expected); assert.deepEqual(styles(actual), ['strong']);
    assert.equal(plainText(parseMarkdown(actual)), plainText(parseMarkdown(source)));
    assert.equal(applyEdits(actual, toggleMarkup(actual, result.anchor, result.head, '**').changes), source);
  }
});

test('跨空段加粗保持原文及选区，段内软换行仍可加粗', () => {
  for (const source of ['甲乙\n\n丙丁', ' 甲乙\n \n丙丁 ', '# 标题\n\n正文']) {
    const result = toggleMarkup(source, 0, source.length, '**');
    assert.deepEqual(result, { changes: [], anchor: 0, head: source.length });
  }
  const source = '甲乙\n丙丁', result = toggleMarkup(source, 0, source.length, '**');
  assert.equal(applyEdits(source, result.changes), '**甲乙\n丙丁**');
  assert.deepEqual(styles(applyEdits(source, result.changes)), ['strong']);
});

test('嵌套粗体局部取消保留既有整层取消规则和内层斜体', () => {
  const source = '**甲*乙*丙**', result = toggleMarkup(source, 2, 3, '**');
  const actual = applyEdits(source, result.changes);
  assert.equal(actual, '甲*乙*丙'); assert.deepEqual(styles(actual), ['emphasis']);
});

test('局部取消粗斜体时，未选文字的边界空白留在重新包装的标记外', () => {
  for (const [source, from, to, marker, expected] of [
    ['**甲 乙**', 2, 3, '**', '甲 **乙**'],
    ['**甲 乙**', 4, 5, '**', '**甲** 乙'],
    ['**甲 乙 丙**', 4, 5, '**', '**甲** 乙 **丙**'],
    ['__甲 乙__', 2, 3, '**', '甲 **乙**'],
    ['*甲 乙*', 1, 2, '*', '甲 *乙*'],
    ['**甲\n乙**', 2, 3, '**', '甲\n**乙**'],
  ] as const) {
    const result = toggleMarkup(source, from, to, marker), actual = applyEdits(source, result.changes);
    assert.equal(actual, expected);
    assert.equal(actual.slice(result.anchor, result.head), source.slice(from, to));
    assert.equal(plainText(parseMarkdown(actual)), plainText(parseMarkdown(source)));
    assert.ok(styles(actual).length > 0);
  }
});

test('清除样式保留普通运算符，仅移除实际解析的格式', () => {
  for (const source of ['2 * 3 == 6', '普通 * 星号 == 等号 ~~ 波浪', '\\*保留\\*']) {
    const result = clearMarkup(source, 0, source.length);
    assert.deepEqual(result, { changes: [], anchor: 0, head: source.length });
  }
  const source = '**加粗** + *斜体* + ~~删除~~；2 * 3 == 6。\n\n==高亮==。';
  const result = clearMarkup(source, 0, source.length);
  assert.equal(applyEdits(source, result.changes), '加粗 + 斜体 + 删除；2 * 3 == 6。\n\n高亮。');
});

test('清除部分纯粗体保留选区两侧样式和空白', () => {
  for (const [source, from, to, expected] of [
    ['**前目标后**', 3, 5, '**前**目标**后**'],
    ['**甲 乙**', 2, 3, '甲 **乙**'],
    ['**甲 乙**', 4, 5, '**甲** 乙'],
  ] as const) {
    const result = clearMarkup(source, from, to);
    const actual = applyEdits(source, result.changes);
    assert.equal(actual, expected);
    assert.equal(actual.slice(result.anchor, result.head), source.slice(from, to));
  }
});

test('清除样式保留代码内容、公式和链接，移除实际 HTML 行内样式', () => {
  const source = '`2 * 3 == 6`，<u>下划线</u>，<mark>高亮</mark>，**[链接](https://example.com/a*b)**。\n\n```txt\n**代码** ==原样==\n```\n\n$x * y$';
  const actual = applyEdits(source, clearMarkup(source, 0, source.length).changes);
  assert.equal(actual, '2 * 3 == 6，下划线，高亮，[链接](https://example.com/a*b)。\n\n```txt\n**代码** ==原样==\n```\n\n$x * y$');
  const literal = '`<u>文字</u> **保留**`';
  assert.equal(applyEdits(literal, clearMarkup(literal, 0, literal.length).changes), '<u>文字</u> **保留**');
});
