import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = path.resolve('.test-data', `release-${randomUUID()}`); await fs.mkdir(directory, { recursive: true });
const executablePath = path.resolve(process.env.TYPORA_REPLICA_PREVIEW_EXE ?? 'release/Typora Replica-win32-x64/Typora Replica.exe');
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.join(directory, 'profile'), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath, args: [path.resolve('docs/示例.md')], env });
const page = await application.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  const nativeWindow = await application.browserWindow(page); await nativeWindow.evaluate(window => window.showInactive());
  await expect(page.locator('.md-h1')).toHaveText('Markdown 写作'); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: 'docs/preview.png' });
  await page.evaluate(() => window.__editor.execute('outline')); await page.screenshot({ path: 'docs/preview-outline.png' });
  await page.evaluate(() => window.__editor.execute('dark')); await page.screenshot({ path: 'docs/preview-dark.png' }); await page.evaluate(() => window.__editor.execute('light'));
  await page.keyboard.press('Control+n'); await page.locator('.editor-slot:not([hidden]) .cm-content').click(); await page.keyboard.type('# '); await page.keyboard.insertText('便携版保存测试'); await page.keyboard.press('Enter'); await page.keyboard.insertText('真实 EXE 的中文输入和保存。');
  const file = path.join(directory, '打包验证.md'); await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); await page.keyboard.press('Control+s');
  await expect.poll(() => fs.readFile(file, 'utf8').catch(() => '')).toContain('真实 EXE');
  await page.keyboard.insertText('自动保存也需要通过。'); await expect.poll(() => fs.readFile(file, 'utf8')).toContain('自动保存也需要通过');
  expect(errors).toEqual([]); console.log('PASS: packaged executable, local assets/fonts, live Markdown, Chinese input, save, autosave, themes and screenshots.');
} finally { await application.close(); }
