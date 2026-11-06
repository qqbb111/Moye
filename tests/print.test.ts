import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePrintOptions, printPreferences, optionsFromPreferences, printGeometry } from '../shared/print';
test('打印默认值与两种版式的字号相互独立，非法设置不能进入输出', () => {
  const preferences = printPreferences(); assert.deepEqual(optionsFromPreferences(preferences), { layout: 'portrait', color: 'mono', codeFontPt: 10, lineNumbers: true });
  preferences.layout = 'landscape-two-column'; assert.equal(optionsFromPreferences(preferences).codeFontPt, 9);
  const malformed = printPreferences({ fonts: { portrait: Infinity, 'landscape-two-column': 15 }, color: 'light' }); assert.equal(malformed.fonts.portrait, 10); assert.equal(malformed.fonts['landscape-two-column'], 12);
  const valid = optionsFromPreferences(); for (const patch of [{ codeFontPt: 0 }, { codeFontPt: NaN }, { codeFontPt: 10.1 }, { layout: 'fake' }, { color: 'dark' }, { lineNumbers: 1 }]) assert.throws(() => validatePrintOptions({ ...valid, ...patch }));
  assert.equal(printGeometry('portrait').widthMm, 210); assert.equal(printGeometry('landscape-two-column').widthMm, 297);
});
