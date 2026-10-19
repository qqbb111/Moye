import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const packaged = process.argv.includes('--packaged');
const directory = path.resolve('.test-data', `writing-${randomUUID()}`); await fs.mkdir(directory, { recursive: true });
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.join(directory, 'profile'), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath: packaged ? path.resolve(process.env.TYPORA_REPLICA_PREVIEW_EXE ?? 'release/Typora Replica-win32-x64/Typora Replica.exe') : electronPath, args: packaged ? [] : ['.'], env });
const page = await application.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.locator('.markdown-editor').waitFor(); const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1080, height: 850 }); window.showInactive(); });
  await page.evaluate(() => window.__editor.execute('copilot'));
  const source = '## 写作，顺手一点\n\n在GitHub上记录Markdown,代码和图片都保留。\n\n这段文字待高亮。\n\n```cpp\n// 中文API：代码保持原样\nint count = 42;\n```\n\n';
  await page.evaluate(source => { window.__editor.setContent(source); const editor = window.__editor.active(); editor.view.dispatch({ selection: { anchor: 0 } }); editor.focus(); }, source);
  await page.keyboard.press('Alt+Shift+f'); expect(await page.evaluate(() => window.__editor.content())).toContain('在 GitHub 上记录 Markdown，代码和图片都保留。');
  await page.evaluate(() => { const editor = window.__editor.active(); const from = editor.content.indexOf('待高亮'); editor.view.dispatch({ selection: { anchor: from, head: from + 3 } }); editor.focus(); });
  expect(await page.evaluate(() => !document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Equal', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })))).toBe(true);
  await expect(page.locator('.md-highlight')).toHaveText('待高亮'); await page.keyboard.press('='); await expect(page.locator('.md-highlight')).toHaveCount(0); await page.keyboard.press('=');
  await expect(page.locator('.md-highlight')).toHaveText('待高亮');
  await page.evaluate(() => { const editor = window.__editor.active(); editor.view.dispatch({ selection: { anchor: editor.content.length } }); editor.focus(); }); await page.keyboard.press('Control+t');
  const table = page.locator('table'); await expect(table.locator('th').first()).toBeFocused();
  const alignment = await table.evaluate(element => { const box = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect(); return Math.abs((box.left + box.right) / 2 - (parent.left + parent.right) / 2); }); expect(alignment).toBeLessThan(2);
  for (const [index, text] of ['功能', '状态', '中文整理', '已完成'].entries()) { await page.keyboard.insertText(text); if (index < 3) await page.keyboard.press('Tab'); } await page.keyboard.press('Enter');
  const png = await fs.readFile('assets/replica.png');
  await page.evaluate(bytes => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], '图片.png', { type: 'image/png' })); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, [...png]);
  await expect.poll(() => page.locator('.md-image img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  const file = path.join(directory, '写作验证.md'); await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); await page.evaluate(() => window.__editor.execute('save'));
  const saved = await fs.readFile(file, 'utf8'); expect(saved).not.toContain('base64'); expect(saved).not.toContain('replica-media:'); expect(saved).toContain('写作验证.assets/'); expect(saved).toContain('// 中文API：代码保持原样');
  await expect.poll(() => page.locator('.md-image img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await page.evaluate(async () => { await document.fonts.ready; document.querySelector('.markdown-editor > .cm-scroller').scrollTop = 0; }); await page.mouse.move(5, 5); await page.screenshot({ path: 'docs/writing-preview.png' });
  expect(errors).toEqual([]); console.log(JSON.stringify({ packaged, writing: 'passed', imeEqualEvent: 'passed', tableCentered: alignment < 2, imageBytes: png.length, markdownCharacters: saved.length, errors }));
} finally { await application.close(); }
