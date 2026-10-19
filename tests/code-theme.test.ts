import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VscodeThemeSync, paletteFromTheme } from '../electron/vscode-theme';
import { MODERN_DARK } from '../shared/code-theme';

test('主题和用户自定义按通用 token 映射到代码配色', () => {
  const palette = paletteFromTheme({ colors: { 'editor.background': '#101010' }, rules: [{ scope: 'comment', settings: { foreground: '#112233' } }, { scope: 'keyword.control', settings: { foreground: '#445566' } }], semantic: {}, files: [] }, { 'editor.tokenColorCustomizations': { '[Example*]': { comments: '#789abc' } }, 'workbench.colorCustomizations': { '[Example Theme]': { 'editor.background': '#202020' } } }, 'Example Theme', false);
  assert.equal(palette.comment, '#789abc'); assert.equal(palette.control, '#445566'); assert.equal(palette.background, '#202020'); assert.equal(palette.string, MODERN_DARK.palette.string);
});

test('读取 JSONC 和继承主题，刷新用户设置，解析失败保留最近的有效配色', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'replica-theme-'));
  const settings = path.join(directory, 'settings.json'); const theme = path.join(directory, 'extensions/theme-defaults/themes'); await fs.mkdir(theme, { recursive: true });
  await fs.writeFile(path.join(theme, 'base.json'), JSON.stringify({ colors: { 'editor.background': '#222222' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#123456' } }] }));
  await fs.writeFile(path.join(theme, 'dark_modern.json'), '{ // inherited\n "include": "./base.json", "tokenColors": [], }');
  const previous = [process.env.TYPORA_REPLICA_VSCODE_ROOT, process.env.TYPORA_REPLICA_VSCODE_SETTINGS];
  process.env.TYPORA_REPLICA_VSCODE_ROOT = directory; process.env.TYPORA_REPLICA_VSCODE_SETTINGS = settings;
  let changes = 0; const sync = new VscodeThemeSync(() => changes++);
  try {
    await fs.writeFile(settings, '{ // user settings\n "workbench.colorTheme": "Default Dark Modern", }');
    const initial = await sync.refresh(); assert.equal(initial.source, 'vscode'); assert.equal(initial.palette.comment, '#123456'); assert.equal(initial.palette.background, '#222222');
    await fs.writeFile(settings, JSON.stringify({ 'workbench.colorTheme': 'Default Dark Modern', 'editor.tokenColorCustomizations': { comments: '#abcdef' } }));
    assert.equal((await sync.refresh()).palette.comment, '#abcdef');
    await fs.writeFile(settings, '{ incomplete'); const failed = await sync.refresh(); assert.equal(failed.palette.comment, '#abcdef'); assert.match(failed.message!, /自动重试/);
    await fs.writeFile(settings, JSON.stringify({ 'workbench.colorTheme': 'Missing' })); const missing = await sync.refresh(); assert.equal(missing.source, 'builtin'); assert.match(missing.message!, /未找到/); assert.equal(changes, 4);
  } finally { sync.stop(); for (const [index, name] of ['TYPORA_REPLICA_VSCODE_ROOT', 'TYPORA_REPLICA_VSCODE_SETTINGS'].entries()) { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; } }
});
