import { _electron as electron, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await fs.realpath('.');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const zip = path.resolve(args.find(value => value !== '--targeted') ?? path.join(root, 'release', `Moye-${version}-windows-x64.zip`));
const staging = path.join(root, '.test-data');
await fs.mkdir(staging, { recursive: true });
if (await fs.realpath(staging) !== staging) throw new Error('Unexpected smoke-test staging path');
const scratch = await fs.mkdtemp(path.join(staging, 'smoke-zip-'));
const unpacked = path.join(scratch, 'unpacked');
const profile = path.join(scratch, 'profile');
const note = path.join(scratch, '便携版验证.md');
const pdf = path.join(scratch, '导出.pdf');
const executablePath = path.join(unpacked, 'Moye.exe');
const heading = '便携版验证';
const saved = '已保存的中文内容';
const draft = '重启后保留的草稿';
const errors = [];

async function launch(args = []) {
  const env = { ...process.env, TYPORA_REPLICA_USER_DATA: profile };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'TYPORA_REPLICA_TEST', 'TYPORA_REPLICA_DEV_URL']) delete env[name];
  const application = await electron.launch({ executablePath, args, cwd: unpacked, env });
  const watch = page => page.on('pageerror', error => errors.push(error.message));
  application.on('window', watch);
  for (const page of application.windows()) watch(page);
  return application;
}
function editor(page) {
  return page.locator('.editor-slot:not([hidden]) .markdown-editor');
}
async function inspectAbout(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置' });
  await settings.getByRole('tab', { name: '关于' }).click();
  await expect(settings.getByText(`版本 ${version}`, { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '关闭设置' }).click();
}
async function runTargetedTests() {
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const output = path.join(scratch, 'test-results');
  const grep = '原位重命名|设置分类的鼠标|有序列表|组合输入一个 f|更新退出参数|恢复记录写入失败时保留原窗口|长文编辑后只同步状态|文档目录内的相对图片|旧版内嵌图片|打印预览用实际 PDF|文楷主题离线';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--grep', grep, '--output', output], {
      cwd: root, env: { ...process.env, TYPORA_REPLICA_TEST_EXE: executablePath }, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code === 0) return;
  const traces = path.join(root, 'test-results', path.basename(scratch));
  for await (const relative of fs.glob('**/trace.zip', { cwd: output })) {
    const target = path.join(traces, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(output, relative), target);
  }
  throw new Error(`Packaged desktop checks failed (exit code: ${code})`);
}

let application;
try {
  await fs.mkdir(unpacked);
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await exec(tar, ['-xf', zip, '-C', unpacked], { windowsHide: true });
  await fs.copyFile(path.join(root, 'assets', 'replica.png'), path.join(scratch, '图片.png'));
  await fs.writeFile(note, `# ${heading}\n\n便携版中文正文\n\n![本地图片](图片.png)\n`);

  application = await launch([note]);
  let page = await application.firstWindow();
  await expect(editor(page).locator('.md-h1')).toHaveText(heading);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => editor(page).locator('.md-image img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await editor(page).locator('.cm-content').evaluate(element => document.fonts.load('16px "Moye WenKai"', element.textContent).then(fonts => {
    if (!fonts.some(font => font.family.replaceAll('"', '') === 'Moye WenKai' && font.status === 'loaded')) throw new Error('Bundled WenKai did not load');
  }));
  await inspectAbout(page);

  await editor(page).locator('.cm-content').first().focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(saved);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.readFile(note, 'utf8')).toContain(saved);

  // Stub the OS file picker only. PDF generation and saving still use the app.
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, pdf);
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('menuitem', { name: '导出 PDF', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '打印预览' });
  await expect(preview.locator('canvas[data-ready="true"]').first()).toBeVisible({ timeout: 15000 });
  await preview.getByRole('button', { name: '保存 PDF…' }).click();
  await expect(preview).toBeHidden();
  const bytes = await fs.readFile(pdf);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF export did not produce a PDF file');

  await page.getByRole('button', { name: '新建标签页' }).click();
  await editor(page).locator('.cm-content').first().focus();
  await page.keyboard.insertText(draft);
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(editor(page).locator('.cm-content').first()).toContainText(draft);
  expect(errors).toEqual([]);
  console.log(`Moye ${version}: fresh ZIP opened, document saved, PDF generated, and draft restored.`);

  if (args.includes('--targeted')) {
    await application.close();
    application = undefined;
    await runTargetedTests();
  }
} finally {
  try {
    await application?.close();
  } finally {
    if (await fs.realpath(scratch) !== scratch) throw new Error('Smoke-test staging path changed');
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
