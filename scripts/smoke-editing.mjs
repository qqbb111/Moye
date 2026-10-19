import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const packaged = process.argv.includes('--packaged');
const directory = path.resolve('.test-data', `editing-smoke-${randomUUID()}`); await fs.mkdir(directory, { recursive: true });
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.join(directory, 'profile'), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath: packaged ? path.resolve(process.env.TYPORA_REPLICA_PREVIEW_EXE ?? 'release/Typora Replica-win32-x64/Typora Replica.exe') : electronPath, args: packaged ? [] : ['.'], env });
const errors = [];
try {
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.locator('.markdown-editor').waitFor();
  const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1100, height: 950 }); window.showInactive(); }); await page.evaluate(() => window.__editor.execute('dark'));
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="920" height="400"><rect width="920" height="400" rx="12" fill="#36445e"/><text x="460" y="190" text-anchor="middle" font-size="36" fill="#dde7ff">大图片之后，光标也应点到哪里就到哪里。</text><text x="460" y="255" text-anchor="middle" font-size="24" fill="#bbc9e5">点击定位 · 行内格式 · 标题回车 · 撤销</text></svg>').toString('base64');
  const source = `### 编辑行为校验\n\n![布局校验图](${image})\n\n32 位操作系统，每个进程独占 4G 内存（进程虚拟内存地址空间大小）\n\nJIACU文字 123\n\n末尾`;
  const content = () => page.evaluate(() => window.__editor.content());
  const caret = position => page.evaluate(position => { const editor = window.__editor.active(); editor.view.dispatch({ selection: { anchor: position } }); editor.focus(); }, position);
  await page.evaluate(source => window.__editor.setContent(source), source); await caret(source.length); await expect.poll(() => page.locator('.md-image img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  const line = page.locator('.markdown-editor .cm-line').filter({ hasText: '32 位操作系统' }); await line.scrollIntoViewIfNeeded();
  const point = await line.evaluate(line => { const node = line.firstChild; const range = document.createRange(); range.setStart(node, node.textContent.indexOf('内存地址')); range.collapse(true); const box = range.getBoundingClientRect(); return { x: box.x + .2, y: box.y + box.height / 2 }; });
  await page.mouse.click(point.x, point.y); await expect.poll(() => page.evaluate(() => window.__editor.active().view.state.selection.main.head)).toBe(source.indexOf('内存地址'));
  await page.keyboard.insertText('【定位】'); expect(await content()).toBe(source.replace('内存地址', '【定位】内存地址')); await page.keyboard.press('Control+z'); expect(await content()).toBe(source);
  await caret(source.indexOf('JIACU') + 5); await page.keyboard.press('Control+b'); expect(await content()).toBe(source.replace('JIACU', '**JIACU**')); await expect(page.locator('.md-strong')).toHaveText('JIACU');
  await caret('### 编辑行为校验'.length); await page.keyboard.press('Home'); await page.keyboard.press('Enter'); expect(await content()).toBe('\n' + source.replace('JIACU', '**JIACU**')); await expect(page.locator('.md-h3')).toHaveText('编辑行为校验');
  const file = path.join(directory, '编辑行为验证.md'); await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); await page.evaluate(() => window.__editor.execute('save'));
  const saved = await fs.readFile(file, 'utf8'); expect(saved).toContain('**JIACU**文字 123'); expect(saved).toMatch(/^\n### 编辑行为校验/); expect(saved).not.toContain('base64');
  await page.evaluate(async () => { await document.fonts.ready; window.__editor.active().view.scrollDOM.scrollTop = 0; }); await page.mouse.move(5, 5); await page.screenshot({ path: 'docs/editing-preview.png' });
  expect(errors).toEqual([]); console.log(JSON.stringify({ packaged, pointerAfterImage: 'passed', boldAtWord: 'passed', adjacentChinese: 'passed', headingAtStart: 'passed', save: 'passed', errors }));
} finally { await application.close(); }
