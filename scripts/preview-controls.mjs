import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const packaged = process.argv.includes('--packaged');
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.resolve('.test-data', `controls-${randomUUID()}`), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const files = ['代码配色示例.md', 'Copilot排版示例.md', '示例.md'].map(name => path.resolve('docs', name));
const application = await electron.launch({ executablePath: packaged ? path.resolve(process.env.TYPORA_REPLICA_PREVIEW_EXE ?? 'release/Typora Replica-win32-x64/Typora Replica.exe') : electronPath, args: packaged ? [files[0]] : ['.', files[0]], env });
try {
  const page = await application.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.markdown-editor').waitFor();
  const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1280, height: 800 }); window.showInactive(); });
  await application.evaluate(async (_electron, files) => { const state = globalThis.__replicaTest; const id = [...state.windows.keys()][0]; for (const file of files) await state.openFile(id, file); }, files.slice(1));
  await page.evaluate(() => window.__editor.execute('copilot'));
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, path.resolve('docs'));
  await page.evaluate(() => window.__editor.execute('folder'));
  await page.locator('.tab').filter({ hasText: '代码配色示例.md' }).click();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-control="close"] svg')).toHaveAttribute('data-icon', 'chrome-close');
  await page.locator('.editor-slot:not([hidden]) .md-code').hover(); await page.screenshot({ path: 'docs/controls-preview.png' });
  await page.locator('[data-control="close"]').hover(); await page.screenshot({ path: 'docs/window-controls-preview.png', clip: { x: 1280 - 138, y: 0, width: 138, height: 32 } });
  const tabs = await page.locator('.tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.id));
  const box = await page.locator('#tabs').boundingBox();
  await page.locator('.tab').first().dragTo(page.locator('#tabs'), { targetPosition: { x: box.width - 45, y: box.height / 2 } });
  await expect.poll(() => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.id))).toEqual([...tabs.slice(1), tabs[0]]);
  expect(errors).toEqual([]); console.log(JSON.stringify({ packaged, blankDrop: 'passed', errors }));
} finally { await application.close(); }
