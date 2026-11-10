import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandKeys, normalizeShortcut, shortcutFromEvent, validateShortcuts, restoredShortcuts } from '../shared/commands';

test('命令默认键无冲突，物理按键兼容中文输入法及带 Shift 的标点', () => {
  assert.deepEqual(validateShortcuts({}), {});
  assert.equal(new Set(COMMANDS.map(c => c.id)).size, COMMANDS.length);
  const event = (code: string, key: string, flags = {}) => ({ code, key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...flags });
  assert.equal(shortcutFromEvent(event('Equal', 'Process')), '=');
  assert.equal(shortcutFromEvent(event('BracketLeft', '{', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+[');
  assert.equal(shortcutFromEvent(event('KeyB', 'Process', { ctrlKey: true })), 'Ctrl+B');
  assert.equal(normalizeShortcut('Shift+Ctrl+b'), 'Ctrl+Shift+B');
});

test('快捷键覆盖替换原键，支持清除、换位与恢复；拒绝冲突和系统按键', () => {
  assert.deepEqual(commandKeys('bold', validateShortcuts({ bold: 'Ctrl+Alt+B' })), ['Ctrl+Alt+B']);
  assert.deepEqual(commandKeys('redo', { redo: '' }), []);
  assert.deepEqual(commandKeys('redo', {}), ['Ctrl+Shift+Z', 'Ctrl+Y']);
  assert.deepEqual(validateShortcuts({ bold: 'Ctrl+I', italic: 'Ctrl+B' }), { bold: 'Ctrl+I', italic: 'Ctrl+B' });
  for (const value of [{ bold: 'Ctrl+I' }, { bold: 'B' }, { copy: 'Alt+F4' }, { copy: 'Meta+C' }, { unknown: 'Ctrl+J' }, { copy: '=' }, { copy: 2 }]) assert.throws(() => validateShortcuts(value));
  assert.throws(() => validateShortcuts(JSON.parse('{"__proto__":"Ctrl+J"}')));
  assert.deepEqual(restoredShortcuts({ bold: 'Alt+F4' }), {});
});
