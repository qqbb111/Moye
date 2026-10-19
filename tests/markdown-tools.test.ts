import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, tidyChineseMarkdown, toggleMarkup, markdownStatistics } from '../shared/markdown-tools';

test('中文整理包含基本空格、单位、常见标点和半角数字，重复整理不再变化', () => {
  const source = '在LeanCloud上写C++代码,今天花了５０００元! 光纤10Gbps,提升15 %。';
  const actual = applyEdits(source, tidyChineseMarkdown(source));
  assert.equal(actual, '在 LeanCloud 上写 C++ 代码，今天花了 5000 元！光纤 10 Gbps，提升 15%。'); assert.deepEqual(tidyChineseMarkdown(actual), []);
});
test('只整理可见正文，保留代码、公式、YAML、地址、图片和 Markdown 结构', () => {
  const source = '---\ntitle: 中文API\n---\n\n# 使用GitHub\n\n中文**English**内容用`std::vector<int>`保存。\n\n[中文API](https://example.com/中文API?q=1)\n\n![图](data:image/png;base64,YWJjZA==)\n\n```cpp\n// 中文API\nconst char* url = "a,b";\n```\n\n$x+中文API$\n\n$$\nx=中文API\n$$\n';
  const actual = applyEdits(source, tidyChineseMarkdown(source));
  assert.ok(actual.includes('title: 中文API')); assert.ok(actual.includes('# 使用 GitHub')); assert.ok(actual.includes('中文 **English** 内容用 `std::vector<int>` 保存。'));
  assert.ok(actual.includes('[中文 API](https://example.com/中文API?q=1)')); assert.ok(actual.includes('![图](data:image/png;base64,YWJjZA==)'));
  assert.ok(actual.includes('```cpp\n// 中文API\nconst char* url = "a,b";\n```')); assert.ok(actual.includes('$x+中文API$')); assert.ok(actual.includes('x=中文API\n$$'));
});
test('局部整理仅改变所选范围', () => { const source = '前文API\n\n选择API\n\n后文API'; const from = source.indexOf('选择'); const actual = applyEdits(source, tidyChineseMarkdown(source, { from, to: from + 5 })); assert.equal(actual, '前文API\n\n选择 API\n\n后文API'); });
test('加粗取消支持完整标记、内部文字、下划线标记和局部取消', () => {
  for (const [source, from, to, expected] of [['**加粗**', 0, 6, '加粗'], ['**加粗**', 2, 4, '加粗'], ['__加粗__', 0, 6, '加粗'], ['__加粗__', 2, 4, '加粗'], ['**前目标后**', 3, 5, '**前**目标**后**'], ['__前目标后__', 3, 5, '**前**目标**后**']] as const) {
    const result = toggleMarkup(source, from, to, '**'); assert.equal(applyEdits(source, result.changes), expected); assert.ok(result.anchor <= expected.length && result.head <= expected.length);
  }
  assert.equal(applyEdits('文字', toggleMarkup('文字', 0, 2, '==').changes), '==文字==');
});
test('图片编码和链接目标不进入正文统计', () => {
  const source = '# 你好\n\n正文 [链接](https://example.com/very-long-address) ![图片](data:image/png;base64,' + 'a'.repeat(100000) + ')';
  const stats = markdownStatistics(source); assert.equal(stats.words, 6); assert.equal(stats.characters, 6);
});

test('没有选区时加粗前一个词，保留中文相邻文字并将光标留在词后', () => {
  for (const [source, cursor, expected, next] of [['例如：JIACU文字 123', 8, '例如：**JIACU**文字 123', 12], ['中文词语', 4, '中文**词语**', 8], ['中文**词语**', 8, '中文词语', 4], ['**JIACU**文字', 9, 'JIACU文字', 5], ['foo_bar', 7, '**foo_bar**', 11]] as const) {
    const result = toggleMarkup(source, cursor, cursor, '**'); assert.equal(applyEdits(source, result.changes), expected); assert.equal(result.anchor, next); assert.equal(result.head, next);
  }
  const blank = toggleMarkup('', 0, 0, '**'); assert.equal(applyEdits('', blank.changes), '****'); assert.equal(blank.anchor, 2);
});
