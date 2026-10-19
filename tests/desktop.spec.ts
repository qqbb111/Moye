import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.cwd();
async function launch(userData: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, RYPOTA_USER_DATA: userData, RYPOTA_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const cleanEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const application = await electron.launch({ executablePath: electronPath as unknown as string, args: ['.'], cwd: root, env: cleanEnv });
  const page = await application.firstWindow(); await page.locator('.rich-editor[data-ready="true"] .ProseMirror').waitFor(); return { application, page };
}
async function newSource(page: Page, content: string) { await page.locator('#add-tab').click(); await page.locator('.editor-slot:not([hidden]) .rich-editor[data-ready="true"]').waitFor(); await page.locator('#source-mode').click(); await page.locator('.editor-slot:not([hidden]) textarea').fill(content); }
async function chooseSave(application: ElectronApplication, file: string) { await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); }

test('即时排版、多标签历史、文件保存和自动保存', async () => {
  const directory = path.join(root, '.test-data', randomUUID()); await fs.mkdir(directory, { recursive: true }); const { application, page } = await launch(path.join(directory, 'profile'));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.locator('.editor-slot:not([hidden]) h1')).toHaveText('给灵感，留一点空白');
    await page.screenshot({ path: path.join(root, 'test-results', 'welcome-preview.png') });
    await newSource(page, '# 测试文档\n\n这是 **加粗** 的中文正文。\n');
    await page.locator('#rich-mode').click(); await expect(page.locator('.editor-slot:not([hidden]) h1')).toHaveText('测试文档'); await expect(page.locator('.editor-slot:not([hidden]) strong')).toHaveText('加粗');
    await page.locator('.editor-slot:not([hidden]) .ProseMirror').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('编辑区新增内容');
    await page.locator('#add-tab').click(); await page.locator('.tab').nth(1).click(); await expect(page.locator('.editor-slot:not([hidden]) .ProseMirror')).toContainText('编辑区新增内容');
    await page.locator('.editor-slot:not([hidden]) .ProseMirror').click(); await page.keyboard.press('Control+z'); await expect(page.locator('.editor-slot:not([hidden]) .ProseMirror')).not.toContainText('编辑区新增内容');
    await page.keyboard.press('Control+Shift+z'); await expect(page.locator('.editor-slot:not([hidden]) .ProseMirror')).toContainText('编辑区新增内容');
    const file = path.join(directory, '中文文档.md'); await chooseSave(application, file); await page.locator('#save-document').click(); await expect.poll(async () => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toContain('编辑区新增内容');
    await page.locator('#source-mode').click(); await page.locator('.editor-slot:not([hidden]) textarea').fill('# 自动保存\n\n文件自动写回。'); await expect.poll(() => fs.readFile(file, 'utf8')).toContain('文件自动写回');
    await page.locator('#toggle-theme').click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await page.locator('#toggle-theme').click();
    await page.screenshot({ path: path.join(root, 'test-results', 'editor-light.png') }); expect(errors).toEqual([]);
  } finally { await application.close(); }
});
test('真实文件打开、窗口分离和多个独立窗口', async () => {
  const directory = path.join(root, '.test-data', randomUUID()); await fs.mkdir(directory, { recursive: true }); const file = path.join(directory, '打开测试.md'); await fs.writeFile(file, '# 从磁盘打开\n\n原文件。'); const { application, page } = await launch(path.join(directory, 'profile'));
  try {
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.locator('#open-document').click(); await expect(page.locator('.editor-slot:not([hidden]) h1')).toHaveText('从磁盘打开');
    await page.locator('#file-menu-toggle').click(); const nextWindow = application.waitForEvent('window'); await page.locator('[data-menu="detach"]').click(); const detached = await nextWindow; await detached.locator('.rich-editor[data-ready="true"]').waitFor(); await expect(detached.locator('.editor-slot:not([hidden]) h1')).toHaveText('从磁盘打开'); await expect(page.locator('.tab')).toHaveCount(1);
    const thirdWindow = application.waitForEvent('window'); await detached.locator('#new-window').click(); const third = await thirdWindow; await third.locator('.rich-editor[data-ready="true"]').waitFor(); expect(application.windows()).toHaveLength(3);
  } finally { await application.close(); }
});
test('关闭标签保留草稿，并在正常退出和强制结束进程后恢复', async () => {
  const directory = path.join(root, '.test-data', randomUUID()); await fs.mkdir(directory, { recursive: true }); const profile = path.join(directory, 'profile'); let current = await launch(profile);
  try {
    await newSource(current.page, '# 未命名草稿\n\n这段内容必须恢复。'); await expect(current.page.locator('#save-status')).toContainText('草稿已保存到本地');
    await current.page.locator('.tab.active .tab-close').click(); await current.page.locator('#show-drafts').click(); await expect(current.page.locator('.document-row')).toContainText('点击恢复'); await current.page.locator('.document-row').click(); await expect(current.page.locator('.editor-slot:not([hidden]) h1')).toHaveText('未命名草稿');
    await current.application.close(); current = await launch(profile); await expect(current.page.locator('.editor-slot:not([hidden]) .ProseMirror')).toContainText('这段内容必须恢复');
    await current.page.locator('#source-mode').click(); await current.page.locator('.editor-slot:not([hidden]) textarea').fill('# 强制退出前的草稿\n\n已经落盘的最新内容。'); await expect(current.page.locator('#save-status')).toContainText('草稿已保存到本地');
    const process = current.application.process(); const stopped = new Promise<void>(resolve => process.once('exit', () => resolve()));
    if (globalThis.process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(process.pid), '/T', '/F']);
    else process.kill('SIGKILL');
    await stopped;
    current = await launch(profile); await expect(current.page.locator('.editor-slot:not([hidden]) .ProseMirror')).toContainText('已经落盘的最新内容');
  } finally { if (current.application.process().exitCode === null) await current.application.close(); }
});
