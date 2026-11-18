import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const packaged = process.argv.includes('--packaged');
const env = { ...process.env, MOYE_USER_DATA: path.resolve('.test-data', `code-${randomUUID()}`), MOYE_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const file = path.resolve('docs/代码配色示例.md');
const application = await electron.launch({ executablePath: packaged ? path.resolve('release/Moye-win32-x64/Moye.exe') : electronPath, args: packaged ? [file] : ['.', file], env });
try {
  const page = await application.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1000, height: 850 }); window.showInactive(); });
  await expect(page.locator('.md-h2')).toHaveText('代码，按熟悉的方式阅读');
  await page.evaluate(() => window.__editor.execute('copilot')); await page.evaluate(async () => { await document.fonts.ready; });
  const block = page.locator('.md-code'); await expect(block.locator('.cm-line span').filter({ hasText: /^while$/ })).toHaveCSS('color', 'rgb(197, 134, 192)');
  await block.hover(); await expect(block.locator('.code-copy svg')).toHaveCount(1);
  await page.screenshot({ path: path.join(env.MOYE_USER_DATA, 'code-modern-preview.png') });
  const original = await page.evaluate(() => window.__editor.content());
  await page.evaluate(() => window.__editor.execute('code-vscode'));
  await expect.poll(() => page.evaluate(() => window.moye.bootstrap().then(view => view.codeTheme.source))).toBe('vscode');
  const view = await page.evaluate(() => window.moye.bootstrap());
  expect(await page.evaluate(() => window.__editor.content())).toBe(original); expect(errors).toEqual([]);
  let relaunch;
  if (packaged) {
    relaunch = await application.evaluate(() => globalThis.__moyeTest.relaunchCommand());
    expect(relaunch).toBe(`"${path.resolve('release/Moye-win32-x64/Moye.exe')}" --new-window`);
    const created = application.waitForEvent('window');
    await promisify(execFile)(path.resolve('release/Moye-win32-x64/Moye.exe'), ['--new-window'], { env, windowsHide: true, timeout: 15000 });
    const fresh = await created; await fresh.locator('.markdown-editor').waitFor();
    expect(await fresh.evaluate(() => window.__editor.content())).toBe('');
    expect(await page.evaluate(() => window.__editor.content())).toBe(original);
  }
  await fs.writeFile(path.join(env.MOYE_USER_DATA, 'code-theme-report.json'), JSON.stringify({ packaged, theme: view.codeTheme, relaunch, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ packaged, source: view.codeTheme.source, theme: view.codeTheme.name, relaunch, errors }));
} finally { await application.close(); }
