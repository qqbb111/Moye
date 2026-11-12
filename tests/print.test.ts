import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePrintOptions, printPreferences, optionsFromPreferences, printGeometry, printPrefix } from '../shared/print';
test('打印默认值与两种版式的字号相互独立，非法设置不能进入输出', () => {
  const preferences = printPreferences(); assert.deepEqual(optionsFromPreferences(preferences), { layout: 'portrait', color: 'mono', codeFontPt: 10, lineNumbers: true });
  preferences.layout = 'landscape-two-column'; assert.equal(optionsFromPreferences(preferences).codeFontPt, 9);
  const malformed = printPreferences({ fonts: { portrait: Infinity, 'landscape-two-column': 15 }, color: 'light' }); assert.equal(malformed.fonts.portrait, 10); assert.equal(malformed.fonts['landscape-two-column'], 12);
  const valid = optionsFromPreferences(); for (const patch of [{ codeFontPt: 0 }, { codeFontPt: NaN }, { codeFontPt: 10.1 }, { layout: 'fake' }, { color: 'dark' }, { lineNumbers: 1 }]) assert.throws(() => validatePrintOptions({ ...valid, ...patch }));
  assert.equal(printGeometry('portrait').widthMm, 210); assert.equal(printGeometry('landscape-two-column').widthMm, 297);
});

test('分阶段预览限制首页的输入长度，保留换行和完整的 Unicode 字符', () => {
  assert.equal(printPrefix('短文\n'), undefined);
  const code = '第一行\n'.repeat(140);
  assert.equal(printPrefix(code), undefined);
  assert.equal(printPrefix(code + '只出现在最终 PDF 的末尾'), code);
  const long = 'a'.repeat(23_999);
  assert.equal(printPrefix(long + '🙂换行前的长段落\n'), long);
});
