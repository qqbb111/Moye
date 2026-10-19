import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const packaged = process.argv.includes('--packaged'); const directory = path.resolve('.test-data', `quote-smoke-${randomUUID()}`); await fs.mkdir(directory, { recursive: true });
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.join(directory, 'profile'), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath: packaged ? path.resolve(process.env.TYPORA_REPLICA_PREVIEW_EXE ?? 'release/Typora Replica-win32-x64/Typora Replica.exe') : electronPath, args: packaged ? [] : ['.'], env }); const errors = [];
try {
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.locator('.markdown-editor').waitFor(); const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1000, height: 760 }); window.showInactive(); }); await page.evaluate(() => window.__editor.execute('copilot'));
  const content = () => page.evaluate(() => window.__editor.content()); await page.locator('.markdown-editor .cm-content').click(); await page.keyboard.press('Control+Shift+Q'); expect(await content()).toBe('> ');
  expect(await page.evaluate(() => window.__editor.active().view.state.selection.main.head)).toBe(2); await page.keyboard.insertText('引用内可以直接输入。'); expect(await content()).toBe('> 引用内可以直接输入。');
  await page.keyboard.press('Control+Shift+Q'); expect(await content()).toBe('引用内可以直接输入。');
  expect(await page.evaluate(() => !document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyQ', keyCode: 229, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })))).toBe(true); expect(await content()).toBe('> 引用内可以直接输入。');
  const cdp = await page.context().newCDPSession(page); const original = await content(); await cdp.send('Input.imeSetComposition', { text: 'doubao', selectionStart: 6, selectionEnd: 6 }); await expect.poll(content).toBe(original + 'doubao');
  await page.evaluate(original => window.__editor.active().replace(original), original); expect(await content()).toBe(original + 'doubao'); await cdp.send('Input.insertText', { text: '豆包' }); let expected = original + '豆包'; await expect.poll(content).toBe(expected);
  for (const [updates, text] of [[['sh', 'shuru', '输入'], '输入'], [['w', 'wenzi', '文字'], '文字']]) { for (const text of updates) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); await cdp.send('Input.insertText', { text }); expected += text; await expect.poll(content).toBe(expected); }
  await expect.poll(() => page.evaluate(() => window.__editor.active().view.compositionStarted)).toBe(false);
  const file = path.join(directory, '引用输入验证.md'); await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); await page.evaluate(() => window.__editor.execute('save')); expect(await fs.readFile(file, 'utf8')).toBe(expected);
  await page.evaluate(async () => { await document.fonts.ready; }); await page.mouse.move(5, 5); await page.screenshot({ path: 'docs/quote-ime-preview.png' }); expect(errors).toEqual([]);
  console.log(JSON.stringify({ packaged, shortcut: 'passed', cursorAfterMarker: 'passed', physicalIMEKeyQ: 'passed', nativeComposition: 'passed', backgroundReplaceGuard: 'passed', save: 'passed', errors }));
} finally { await application.close(); }
