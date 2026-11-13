import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.cwd();
const workspaces = new Set<string>();
const applications = new Set<ElectronApplication>();
async function testDirectory() {
  const staging = path.join(await fs.realpath(root), '.test-data');
  await fs.mkdir(staging, { recursive: true });
  if (await fs.realpath(staging) !== staging) throw new Error('测试暂存路径必须位于项目中');
  const directory = await fs.mkdtemp(path.join(staging, 'desktop-'));
  workspaces.add(directory);
  return directory;
}
test.afterEach(async () => {
  const closed = await Promise.allSettled([...applications].map(async application => {
    const child = application.process();
    if (child.exitCode === null && child.signalCode === null) await application.close();
  }));
  const removed = await Promise.allSettled([...workspaces].map(async directory => {
    const resolved = await fs.realpath(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!resolved) return;
    if (resolved !== directory) throw new Error('测试暂存路径发生变化');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }));
  workspaces.clear();
  applications.clear();
  const failures = [...closed, ...removed].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, '测试暂存清理失败');
});

async function launch(profile?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const directory = await testDirectory(); profile ??= path.join(directory, 'profile');
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, TYPORA_REPLICA_USER_DATA: profile, TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.TYPORA_REPLICA_TEST_EXE ?? electronPath as unknown as string;
  const application = await electron.launch({ executablePath, args: process.env.TYPORA_REPLICA_TEST_EXE ? [] : ['.'], cwd: root, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
  applications.add(application);
  application.once('close', () => applications.delete(application));
  const page = await application.firstWindow(); await page.locator('.editor-slot:not([hidden]) .markdown-editor').waitFor();
  return { application, page, directory, profile };
}
const current = (page: Page) => page.locator('.editor-slot:not([hidden])');
async function setContent(page: Page, content: string) { await page.evaluate(content => (window as any).__editor.setContent(content), content); }
async function content(page: Page) { return page.evaluate(() => (window as any).__editor.content()); }
async function execute(page: Page, command: string) { await page.evaluate(command => (window as any).__editor.execute(command), command); }
async function toolbarAction(page: Page, section: string, action: string) {
  const top = ['文件', '编辑'].includes(section) ? section : '编辑';
  await page.getByRole('button', { name: top, exact: true }).click();
  if (top !== section) await page.getByRole('menu', { name: top }).getByRole('menuitem', { name: `${section} ›`, exact: true }).click();
  await page.getByRole('menu', { name: section, exact: true }).getByRole('menuitem', { name: new RegExp(`^${action}( |$)`) }).click();
}
async function chooseSave(application: ElectronApplication, file: string) { await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); }

test('文件菜单、目录进退、资源管理器、另存为和原位重命名贯通桌面入口', async ({}, testInfo) => {
  const { application, page, directory } = await launch();
  const rootFolder = path.join(directory, '笔记');
  const child = path.join(rootFolder, '算法');
  const file = path.join(child, '原始.md');
  const occupied = path.join(child, '同名.md');
  const renamed = path.join(child, '重命名成功.md');
  const tabRenamed = path.join(child, '标签重命名.md');
  const copy = path.join(child, '另存副本.md');
  await fs.mkdir(child, { recursive: true });
  await fs.writeFile(file, '# 编辑时的 Markdown');
  await fs.writeFile(occupied, '# 不能被覆盖');
  try {
    const native = await application.browserWindow(page);
    const screenshot = async (name: string) => {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const png = await native.evaluate(async window => (await window.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64'));
      await fs.writeFile(testInfo.outputPath(name), Buffer.from(png, 'base64'));
    };
    await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, child);
    await expect(page.locator('[data-toolbar-menu="导出"]')).toHaveCount(0);
    await toolbarAction(page, '文件', '打开文件夹');
    const sidebar = page.locator('#sidebar');
    const parent = sidebar.getByRole('button', { name: '上一级文件夹', exact: true });
    const footer = sidebar.getByRole('button', { name: '打开文件夹…', exact: true });
    const menu = page.getByRole('menu', { name: '文件操作', exact: true });
    const renameInput = page.getByRole('textbox', { name: '文件名', exact: true });
    await expect(sidebar.locator('#sidebar-content > :first-child')).toHaveText('..');
    await expect(sidebar.locator('.folder-heading')).toHaveText('算法');
    await expect(footer).toBeVisible();
    await parent.click();
    await expect(sidebar.locator('.folder-heading')).toHaveText('笔记');
    const enter = sidebar.getByRole('button', { name: '进入 算法', exact: true });
    await expect(enter).toBeFocused();
    await expect(page.evaluate(({ rootFolder, directory }) => window.rypota.openChildFolder(rootFolder, directory), { rootFolder, directory })).rejects.toThrow('文件不在当前文件夹中');
    await screenshot('folder-enter.png');
    await enter.press('Enter');
    await expect(sidebar.locator('.folder-heading')).toHaveText('算法');
    await expect(parent).toBeFocused();
    await parent.click();
    await expect(sidebar.locator('.folder-heading')).toHaveText('笔记');
    await footer.click();
    await expect(sidebar.locator('.folder-heading')).toHaveText('算法');
    await parent.click();
    await sidebar.locator('summary').filter({ hasText: '算法' }).click();

    const originalRow = sidebar.getByRole('button', { name: '原始.md', exact: true });
    await application.evaluate(({ shell }) => { shell.showItemInFolder = file => { (globalThis as any).__shownInFolder = file; }; });
    await originalRow.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '在资源管理器中显示', exact: true }).click();
    await expect.poll(() => application.evaluate(() => (globalThis as any).__shownInFolder)).toBe(file);
    await originalRow.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /^重命名/ }).click();
    await expect(renameInput).toBeFocused();
    await renameInput.press('Escape');
    await expect(originalRow).toBeFocused();
    await originalRow.focus();
    await page.keyboard.press('F2');
    await expect(renameInput).toHaveValue('原始.md');
    await expect(sidebar.locator('.sidebar-row.inline-rename .inline-rename-input')).toBeFocused();
    expect(await renameInput.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([0, 2]);
    await screenshot('rename-sidebar-light.png');
    await renameInput.fill('同名');
    await renameInput.press('Enter');
    await expect(page.locator('#toast')).toHaveText('同名文件已存在');
    await expect(renameInput).toHaveAttribute('aria-invalid', 'true');
    expect(await fs.readFile(occupied, 'utf8')).toBe('# 不能被覆盖');
    await renameInput.fill('重命名成功');
    await renameInput.press('Enter');
    await expect(renameInput).toBeHidden();
    const renamedRow = sidebar.getByRole('button', { name: '重命名成功.md', exact: true });
    await expect(renamedRow).toBeVisible();
    await expect(renamedRow).toBeFocused();
    expect(await fs.readFile(renamed, 'utf8')).toBe('# 编辑时的 Markdown');
    await expect(fs.stat(file)).rejects.toThrow();

    await chooseSave(application, copy);
    await renamedRow.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '另存为…', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: '另存副本.md', exact: true })).toBeVisible();
    expect(await fs.readFile(copy, 'utf8')).toBe('# 编辑时的 Markdown');
    await renamedRow.click();
    const activeTab = page.getByRole('tab', { name: '重命名成功.md', exact: true });
    await expect(activeTab).toHaveAttribute('aria-selected', 'true');
    await activeTab.dblclick();
    await expect(renameInput).toHaveValue('重命名成功.md');
    await renameInput.press('Escape');
    await expect(activeTab).toBeFocused();
    await execute(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await native.evaluate(window => { window.setBounds({ width: 760, height: 640 }); window.showInactive(); });
    await current(page).locator('.cm-content').first().focus();
    await page.keyboard.press('F2');
    await expect(page.locator('#tabs .inline-rename-input')).toBeFocused();
    await renameInput.press('ArrowLeft');
    expect(await renameInput.evaluate(input => (input as HTMLInputElement).selectionEnd)).toBe(0);
    await renameInput.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(renameInput).toBeFocused();
    await screenshot('rename-tab-dark-narrow.png');
    await renameInput.fill('标签重命名');
    await renameInput.press('Enter');
    await expect(page.getByRole('tab', { name: '标签重命名.md', exact: true })).toBeVisible();
    expect(await fs.readFile(tabRenamed, 'utf8')).toBe('# 编辑时的 Markdown');
    await screenshot('files.png');

    await execute(page, 'new');
    const backgroundCopy = path.join(child, '后台另存.md');
    await chooseSave(application, backgroundCopy);
    const activeId = await page.locator('.tab.active').getAttribute('data-id');
    await sidebar.getByRole('button', { name: '标签重命名.md', exact: true }).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '另存为…', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: '后台另存.md', exact: true })).toBeVisible();
    await expect(page.locator('.tab.active')).toHaveAttribute('data-id', activeId!);
    expect(await fs.readFile(tabRenamed, 'utf8')).toBe('# 编辑时的 Markdown');
    expect(await fs.readFile(backgroundCopy, 'utf8')).toBe('# 编辑时的 Markdown');
    await setContent(page, '未命名草稿正文');
    await page.locator('.tab.active .tab-close').click();
    await sidebar.getByRole('button', { name: '草稿', exact: true }).click();
    const draftRow = sidebar.locator('[data-file-row]').first();
    await draftRow.dblclick();
    await expect(sidebar.locator('.inline-rename-input')).toBeFocused();
    await renameInput.fill('新草稿名');
    await renameInput.press('Enter');
    await expect(sidebar.getByRole('button', { name: '新草稿名', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '新草稿名', exact: true })).toHaveCount(0);
    await chooseSave(application, path.join(child, '草稿另存.md'));
    await sidebar.getByRole('button', { name: '新草稿名', exact: true }).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '另存为…', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(child, '草稿另存.md'), 'utf8').catch(() => '')).toBe('未命名草稿正文');
  } finally { await application.close(); }
});

test('启动、新建和打开后可立即输入，标签方向键可连续导航并保留各自正文', async () => {
  const { application, page, directory } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(w => { w.show(); w.focus(); });
    await page.keyboard.insertText('启动即写'); expect(await content(page)).toBe('启动即写');
    await execute(page, 'new'); await page.keyboard.insertText('新建即写'); expect(await content(page)).toBe('新建即写');
    await page.locator('#add-tab').click(); await page.keyboard.insertText('点击新建即写'); expect(await content(page)).toBe('点击新建即写');
    await page.locator('.tab.active').focus(); await page.keyboard.press('ArrowLeft'); await expect(page.locator('.tab.active')).toBeFocused(); expect(await content(page)).toBe('新建即写');
    await page.keyboard.press('ArrowLeft'); await expect(page.locator('.tab.active')).toBeFocused(); expect(await content(page)).toBe('启动即写');
    await page.keyboard.press('End'); await expect(page.locator('.tab.active')).toBeFocused(); expect(await content(page)).toBe('点击新建即写');
    const file = path.join(directory, '打开.md'); await fs.writeFile(file, '原文');
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await execute(page, 'open'); await page.keyboard.insertText('直接写'); expect(await content(page)).toContain('直接写');
    await execute(page, 'previous-tab'); await page.keyboard.insertText('继续'); expect(await content(page)).toBe('点击新建即写继续');
  } finally { await application.close(); }
});

test('长文编辑后只同步状态，切到另一窗口时发送新文档正文', async () => {
  const { application, page } = await launch();
  try {
    const long = '# 长文\n\n' + '用于验证工作区更新的正文。\n\n'.repeat(1800);
    await setContent(page, long);
    await expect.poll(() => page.evaluate(async () => (await window.rypota.bootstrap()).documents[0].content.length)).toBe(long.length);
    const revision = await page.evaluate(async () => (await window.rypota.bootstrap()).documents[0].revision);
    await page.evaluate(() => {
      const updates: import('../shared/types').WorkspaceUpdate[] = [];
      (window as any).__workspaceUpdates = updates;
      window.rypota.onState(update => updates.push(update));
    });
    await current(page).locator('.cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('尾');
    const updates = () => page.evaluate(() => (window as any).__workspaceUpdates as import('../shared/types').WorkspaceUpdate[]);
    await expect.poll(async () => (await updates()).some(update => update.documents.some(doc => doc.revision > revision))).toBe(true);
    expect((await updates()).every(update => update.documents.every(doc => doc.content === undefined))).toBe(true);
    expect(await content(page)).toBe(long + '尾');

    const destination = application.waitForEvent('window');
    await execute(page, 'detach');
    const other = await destination;
    await current(other).locator('.markdown-editor').waitFor();
    await expect.poll(() => content(other)).toBe(long + '尾');
  } finally { await application.close(); }
});

test('快捷键名称仅录制绑定，说明按需显示且设置控件可通过键盘访问', async () => {
  const { application, page } = await launch();
  try {
    const raw = '保留选区和正文'; await setContent(page, raw);
    await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 0, head: 4 } }); e.focus(); });
    await execute(page, 'shortcuts'); await page.getByRole('button', { name: '修改关闭文档快捷键', exact: true }).click();
    await expect(page.locator('#preferences')).toBeVisible(); expect(await content(page)).toBe(raw);
    await expect(page.locator('[data-shortcut-id="close-tab"]')).toHaveClass(/recording/); await page.keyboard.press('Escape');
    await expect(page.locator('#preferences')).toBeVisible(); await expect(page.locator('[data-shortcut-id="close-tab"]')).toBeFocused();
    await page.getByRole('tab', { name: '常规', exact: true }).click();
    await expect(page.locator('#code-theme-refresh')).toBeHidden(); await page.locator('#code-theme-select').selectOption('vscode'); await expect(page.locator('#code-theme-refresh')).toBeVisible();
    await page.locator('#code-theme-select').selectOption('github-dark'); await expect(page.locator('#code-theme-refresh')).toBeHidden();
    await page.getByRole('button', { name: '了解中文排版整理' }).focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toBeHidden(); await expect(page.locator('#preferences')).toBeVisible();
    const toggle = page.getByRole('switch', { name: '保存前整理中文排版', exact: true }); await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).toBeChecked();
    await expect.poll(() => page.evaluate(async () => (await window.rypota.bootstrap()).preferences.formatOnSave)).toBe(true);
    await expect(page.locator('#preferences')).toBeVisible();
    expect(await content(page)).toBe(raw);
  } finally { await application.close(); }
});

test('设置下拉使用主题选中态，支持键盘选择和退出', async () => {
  const { application, page } = await launch();
  try {
    await execute(page, 'preferences');
    const theme = page.locator('#theme-select');
    await expect(theme).toHaveValue('light');

    const opened = page.locator('#theme-select:open');
    await theme.click();
    await expect(opened).toBeVisible();
    await expect(theme.locator('option:checked')).toHaveCSS('background-color', 'rgb(220, 233, 224)');
    await page.keyboard.press('ArrowDown');
    await expect(theme.locator('option:focus-visible')).toHaveText('夜间');
    await page.keyboard.press('Escape');
    await expect(opened).toHaveCount(0);
    await expect(page.locator('#preferences')).toBeVisible();
    await expect(theme).toHaveValue('light');

    await page.keyboard.press('Space');
    await expect(opened).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(theme).toHaveValue('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#preferences')).toBeVisible();
  } finally { await application.close(); }
});

test('设置分类的鼠标点击和拖动不高亮文字，键盘焦点仍清晰可见', async () => {
  const { application, page } = await launch();
  try {
    const settings = page.getByRole('button', { name: '设置', exact: true });
    const general = page.getByRole('tab', { name: '常规', exact: true });
    const shortcuts = page.getByRole('tab', { name: '快捷键', exact: true });
    await settings.click();
    await expect(general).toBeFocused();
    await expect(general).toHaveCSS('outline-style', 'none');
    await expect(general).toHaveCSS('box-shadow', 'none');
    await page.locator('#preferences').evaluate(async dialog => {
      await Promise.all(dialog.getAnimations().map(animation => animation.finished));
    });

    await shortcuts.click();
    await expect(shortcuts).toHaveAttribute('aria-selected', 'true');
    await expect(shortcuts).toHaveCSS('box-shadow', 'none');
    const bounds = await shortcuts.boundingBox();
    if (!bounds) throw new Error('快捷键分类不可见');
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(bounds.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 4, y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');

    await page.keyboard.press('ArrowLeft');
    await expect(general).toBeFocused();
    await expect(general).toHaveAttribute('aria-selected', 'true');
    await expect(general).not.toHaveCSS('box-shadow', 'none');
    await expect(general).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('ArrowRight');
    await expect(shortcuts).toBeFocused();
    await expect(shortcuts).not.toHaveCSS('box-shadow', 'none');
    await shortcuts.click();
    await expect(shortcuts).toHaveCSS('box-shadow', 'none');

    const search = page.getByRole('searchbox', { name: '搜索快捷键' });
    await search.fill('关闭文档');
    await search.press('Control+a');
    expect(await search.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([0, 4]);
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.keyboard.press('Control+,');
    await expect(general).toBeFocused();
    await expect(general).not.toHaveCSS('box-shadow', 'none');
  } finally { await application.close(); }
});

test('2026 代码主题独立于正文主题，设置文字不可拖选而输入框仍可选', async () => {
  const { application, page } = await launch();
  try {
    await setContent(page, '正文文字\n\n```cpp\nint main() { return 0; }\n```');
    const block = current(page).locator('.md-code');
    const theme = page.getByRole('button', { name: '主题', exact: true });
    await theme.press('ArrowDown');
    const palettes = page.getByRole('menu', { name: '主题' }).getByRole('group', { name: '代码配色' });
    await expect(palettes.getByRole('menuitemradio', { name: 'GitHub Dark' })).toBeChecked();
    await palettes.getByRole('menuitemradio', { name: '2026 现代深色' }).press('Enter');
    await expect(palettes).toBeHidden();
    await expect(block).toHaveCSS('background-color', 'rgb(18, 19, 20)');

    await execute(page, 'preferences');
    const picker = page.locator('#code-theme-select');
    await expect(picker).toHaveValue('dark-2026');
    await picker.selectOption('light-2026');
    await expect(block).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(async () => (await window.rypota.bootstrap()).preferences.codeTheme)).toBe('light-2026');

    await page.getByRole('tab', { name: '快捷键' }).click();
    const heading = page.locator('.settings-header h2');
    const bounds = await heading.boundingBox();
    if (!bounds) throw new Error('设置标题不可见');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');

    const search = page.getByRole('searchbox', { name: '搜索快捷键' });
    await search.fill('导出');
    await search.press('Control+a');
    expect(await search.evaluate(input => (input as HTMLInputElement).selectionEnd)).toBe(2);
    expect(await search.evaluate(input => (input as HTMLInputElement).selectionStart)).toBe(0);
    await page.getByRole('button', { name: '关闭设置' }).click();
    await current(page).locator('.markdown-editor .cm-content').first().click();
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => (window as any).__editor.active().view.state.selection.main.empty)).toBe(false);
  } finally { await application.close(); }
});

test('编辑器右键菜单跟随主题，键盘复制保留表格选区', async () => {
  const { application, page } = await launch();
  try {
    await setContent(page, '正文\n\n| 标题 |\n| --- |\n| 表格选区 |');
    const cell = current(page).locator('.md-table td').first();
    await cell.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '编辑操作' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '删除当前列' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();
    await cell.evaluate(element => window.getSelection()?.setBaseAndExtent(element.firstChild!, 1, element.firstChild!, 3));

    await page.keyboard.press('Shift+F10');
    await expect(menu.getByRole('menuitem', { name: '在当前行后插入一行' })).toBeFocused();
    await expect(menu.locator(':focus-visible')).toHaveCSS('outline-color', 'rgb(72, 124, 104)');
    await page.keyboard.press('End');
    for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(cell).toBeFocused();
    expect(await page.evaluate(() => window.rypota.clipboard('read'))).toBe('格选');
  } finally { await application.close(); }
});

test('文件冲突使用应用弹窗，取消保留两份内容并可另存或确认覆盖', async () => {
  const { application, page, directory } = await launch();
  try {
    const original = path.join(directory, '原始.md');
    const copy = path.join(directory, '副本.md');
    const save = () => page.evaluate(() => { void (window as any).__editor.execute('save'); });
    await fs.writeFile(original, '打开时的内容');
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, original);
    await page.evaluate(() => window.rypota.updatePreferences({ autoSave: false, theme: 'light' }));
    await execute(page, 'open');
    await setContent(page, '我的修改');
    await fs.writeFile(original, '磁盘修改');
    await save();

    const conflict = page.getByRole('dialog', { name: '磁盘文件已变更' });
    await expect(conflict.getByRole('button', { name: '取消' })).toBeFocused();
    await expect(conflict).toHaveCSS('background-color', 'rgb(251, 250, 247)');
    await page.keyboard.press('Escape');
    await expect(conflict).toBeHidden();
    expect(await content(page)).toBe('我的修改');
    expect(await fs.readFile(original, 'utf8')).toBe('磁盘修改');

    await chooseSave(application, copy);
    await save();
    await conflict.getByRole('button', { name: '另存为…' }).click();
    await expect.poll(() => fs.readFile(copy, 'utf8').catch(() => '')).toBe('我的修改');
    expect(await fs.readFile(original, 'utf8')).toBe('磁盘修改');

    await setContent(page, '确认覆盖后的内容');
    await fs.writeFile(copy, '副本的磁盘修改');
    await save();
    await conflict.getByRole('button', { name: '覆盖磁盘文件' }).click();
    await expect.poll(() => fs.readFile(copy, 'utf8')).toBe('确认覆盖后的内容');
  } finally { await application.close(); }
});

test('文件侧栏只展示当前上下文，快速打开按路径区分同名文件并支持点击外部关闭', async () => {
  const { application, page, directory } = await launch();
  try {
    const first = path.join(directory, '课程', '笔记.md'), second = path.join(directory, '竞赛', '笔记.md');
    for (const file of [first, second]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, file === first ? '# 课程笔记' : '# 竞赛笔记'); }
    await application.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [first, second]); await execute(page, 'open');
    await execute(page, 'files'); await expect(page.locator('#sidebar-content [aria-current=page]')).toHaveText('笔记.md');
    await expect(page.locator('#sidebar-open-folder')).toBeVisible();
    await page.locator('#sidebar-filter').fill('不存在'); await expect(page.locator('#sidebar-content')).toContainText('没有匹配的文件');
    await execute(page, 'quick-open'); await page.locator('#quick-input').fill('笔记'); await expect(page.locator('.quick-result')).toHaveCount(2);
    await expect(page.locator('.quick-result small')).toHaveText([path.dirname(first), path.dirname(second)]); await expect(page.locator('.quick-current')).toHaveCount(1);
    await page.locator('#quick-input').fill('课程'); await page.keyboard.press('Enter'); expect(await content(page)).toBe('# 课程笔记');
    await execute(page, 'quick-open'); await page.locator('.titlebar').click({ position: { x: 8, y: 8 }, force: true }); await expect(page.locator('#quick-open')).toBeHidden();
    await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, path.dirname(first));
    await page.locator('#sidebar-filter').fill(''); await page.locator('#sidebar-open-folder').click();
    await expect(page.locator('.folder-heading')).toHaveText('课程');
    await expect(page.locator('#sidebar-content [data-file-row]')).toHaveCount(1);
    await expect(page.locator('#sidebar-content [aria-current=page]')).toHaveText('笔记.md'); expect(await content(page)).toBe('# 课程笔记');
  } finally { await application.close(); }
});

test('更新退出参数走正常保存流程，多窗口草稿在再次启动后仍可恢复', async () => {
  const first = await launch(); let restored: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await setContent(first.page, '更新之前第一份草稿');
    const secondPromise = first.application.waitForEvent('window'); await execute(first.page, 'new-window'); const second = await secondPromise;
    await second.locator('.markdown-editor').waitFor(); await setContent(second, '第二个窗口尚未保存的内容');
    const nativeProcess = first.application.process();
    const env: NodeJS.ProcessEnv = { ...process.env, TYPORA_REPLICA_TEST: '1', TYPORA_REPLICA_USER_DATA: first.profile }; delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(process.env.TYPORA_REPLICA_TEST_EXE ?? electronPath as unknown as string, [...(process.env.TYPORA_REPLICA_TEST_EXE ? [] : ['.']), '--quit-for-update'], { cwd: root, env });
    await expect.poll(() => nativeProcess.exitCode, { timeout: 20000 }).toBe(0);
    restored = await launch(first.profile);
    await expect.poll(async () => Promise.all(restored!.application.windows().map(page => content(page)))).toEqual(expect.arrayContaining(['更新之前第一份草稿', '第二个窗口尚未保存的内容']));
  } finally { await first.application.close().catch(() => {}); await restored?.application.close(); }
});

test('恢复记录写入失败时保留原窗口，解除故障后退出并恢复新内容', async () => {
  let instance = await launch();
  try {
    const { application, page, profile } = instance;
    await setContent(page, '故障前的草稿');
    await expect(page.locator('#save-status')).toContainText('草稿已保存');
    const secondOpened = application.waitForEvent('window');
    await execute(page, 'new-window');
    const second = await secondOpened;
    await second.locator('.markdown-editor').waitFor();
    await application.evaluate(() => {
      const store = (globalThis as any).__replicaTest.store;
      const persist = store.persist.bind(store);
      store.persist = (closedWindow?: string) => closedWindow ? Promise.reject(new Error('模拟关闭状态写入失败')) : persist();
      (globalThis as any).__resumePersistence = () => { store.persist = persist; };
    });
    await page.locator('[data-control="close"]').click();
    await expect(page.locator('#toast')).toContainText('窗口保持打开');
    await expect(page.locator('#editor-stage')).toBeVisible();
    await setContent(page, '失败后依然可以写入草稿');
    await expect.poll(() => fs.readFile(path.join(profile, 'recovery/workspace.json'), 'utf8')).toContain('失败后依然可以写入草稿');
    await application.evaluate(() => (globalThis as any).__resumePersistence());
    const closed = page.waitForEvent('close');
    await page.locator('[data-control="close"]').click();
    await closed;
    await instance.application.close();
    instance = await launch(profile);
    await expect.poll(() => instance.page.evaluate(async () => (await window.rypota.bootstrap()).drafts.map(draft => draft.content))).toContain('失败后依然可以写入草稿');
  } finally {
    if (instance.application.process().exitCode === null) {
      await instance.application.evaluate(() => (globalThis as any).__resumePersistence?.()).catch(() => {});
      await instance.application.close();
    }
  }
});

test('设置集中分类，操作保留正文与表格选区，快捷键录制冲突提示和重启持久化', async () => {
  let app = await launch();
  try {
    const page = app.page;
    await setContent(page, '需要加粗的文字');
    await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 0, head: 4 } }); e.focus(); });
    await toolbarAction(page, '格式', '加粗');
    expect(await content(page)).toBe('**需要加粗**的文字');
    await execute(page, 'preferences'); await page.getByRole('tab', { name: '快捷键', exact: true }).click();
    await expect(page.getByRole('tablist', { name: '设置分类' }).getByRole('tab')).toHaveText(['常规', '快捷键', '关于']);
    await page.getByRole('navigation', { name: '快捷键分类' }).getByRole('button', { name: '文件', exact: true }).click();
    await page.getByText('导出 PDF', { exact: true }).click(); await expect(page.locator('[data-shortcut-id="export-pdf"]')).toHaveClass(/recording/);
    await expect(page.locator('#print-preview')).toHaveCount(0); await page.keyboard.press('Escape');
    await page.getByRole('navigation', { name: '快捷键分类' }).getByRole('button', { name: '格式', exact: true }).click();
    await page.getByRole('button', { name: '修改加粗快捷键', exact: true }).click(); await page.keyboard.press('Control+i'); await expect(page.locator('#shortcut-message')).toContainText('冲突');
    await page.keyboard.press('Control+Alt+b'); await expect(page.locator('[data-shortcut-id="bold"]')).toHaveText('Ctrl+Alt+B');
    await expect.poll(() => page.evaluate(async () => (await window.rypota.bootstrap()).preferences.shortcuts?.bold)).toBe('Ctrl+Alt+B');
    await page.locator('#settings-close').click();
    await setContent(page, '选择'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 0, head: 2 } }); e.focus(); });
    await page.keyboard.press('Control+b'); expect(await content(page)).toBe('选择');
    await page.keyboard.press('Control+Alt+b'); expect(await content(page)).toBe('**选择**');
    const profile = app.profile; await app.application.close(); app = await launch(profile);
    await execute(app.page, 'preferences'); await app.page.getByRole('tab', { name: '快捷键', exact: true }).click();
    await app.page.locator('#shortcut-search').fill('加粗'); await expect(app.page.locator('[data-shortcut-id="bold"]')).toHaveText('Ctrl+Alt+B');
    await app.page.getByRole('button', { name: '恢复加粗默认快捷键', exact: true }).click(); await app.page.locator('#settings-close').click();
    await setContent(app.page, '| 列一 | 列二 |\n| --- | --- |\n| 内容 | 数据 |');
    const cell = current(app.page).locator('td').first(); await cell.click();
    await cell.evaluate(cell => { const range = document.createRange(); range.selectNodeContents(cell); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range); });
    await toolbarAction(app.page, '格式', '加粗');
    expect(await content(app.page)).toContain('| **内容** | 数据 |');
  } finally { await app.application.close(); }
});

test('重绑撤销和粘贴作用于代码编辑器，旧快捷键停用且高亮可清除', async () => {
  const { application, page } = await launch();
  try {
    await page.evaluate(() => window.rypota.updatePreferences({ shortcuts: { undo: 'Alt+U', redo: 'Alt+R', paste: 'Alt+V', highlight: '' } }));
    await setContent(page, '```cpp\nint value = 1;\n```\n\n正文');
    const code = current(page).locator('.code-content .cm-content'); await code.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' // 新内容');
    await page.keyboard.press('Control+z'); expect(await content(page)).toContain('// 新内容');
    await page.keyboard.press('Alt+u'); expect(await content(page)).not.toContain('// 新内容');
    await page.keyboard.press('Alt+r'); expect(await content(page)).toContain('// 新内容');
    await application.evaluate(({ clipboard }) => clipboard.writeText('粘贴')); await page.keyboard.press('Alt+v'); await expect.poll(() => content(page)).toContain('新内容粘贴');
    await setContent(page, '选中文字'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 0, head: 2 } }); e.focus(); });
    await page.keyboard.insertText('='); expect(await content(page)).toBe('=文字');
    await page.evaluate(() => window.rypota.updatePreferences({ shortcuts: {} }));
  } finally { await application.close(); }
});

test('源码与排版切换保留可见光标的编辑位置及撤销历史', async () => {
  const { application, page } = await launch();
  const prefix = Array.from({ length: 60 }, (_, n) => `第 ${n} 段：正文用于检查滚动位置。\n\n`).join('');
  const code = Array.from({ length: 90 }, (_, n) => `int value_${n} = ${n};`).join('\n');
  const raw = `${prefix}## 目标标题\n\n目标段落里的当前位置。\n\n\`\`\`cpp\n${code}\n\`\`\`\n\n| 表头 | 类型 |\n| --- | --- |\n| 目标单元格 | 数据 |\n\n结尾`;
  try {
    await setContent(page, raw);
    for (const needle of ['当前位置', 'value_65', '目标单元格']) {
      if (!await page.evaluate(() => (window as any).__editor.active().source)) await page.keyboard.press('Control+/');
      await page.evaluate(position => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: position }, effects: e.view.constructor.scrollIntoView(position, { y: 'start', yMargin: 60 }) }); e.focus(); }, raw.indexOf(needle) + 2);
      await expect.poll(() => page.evaluate(() => { const { view } = (window as any).__editor.active(); const cursor = view.coordsAtPos(view.state.selection.main.head); const bounds = view.scrollDOM.getBoundingClientRect(); return !!cursor && cursor.top >= bounds.top && cursor.bottom <= bounds.bottom; })).toBe(true);
      await page.keyboard.press('Control+/');
      if (needle === 'value_65') await expect(current(page).locator('.code-content .cm-content')).toBeFocused();
      if (needle === '目标单元格') await expect(current(page).locator('td').first()).toBeFocused();
      await page.keyboard.insertText('X'); await expect.poll(() => content(page)).toBe(raw.slice(0, raw.indexOf(needle) + 2) + 'X' + raw.slice(raw.indexOf(needle) + 2));
      await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
      await page.keyboard.press('Control+/');
      await expect.poll(() => page.evaluate(() => (window as any).__editor.active().source)).toBe(true);
      expect(await content(page)).toBe(raw);
    }
  } finally { await application.close(); }
});

test('源码与排版切换跟随当前阅读位置，光标在屏幕外也不跳回去', async () => {
  const { application, page } = await launch();
  const prose = Array.from({ length: 80 }, (_, n) => `## 第 ${n} 节\n\n段落 ${n}：检查长文中正在阅读的位置。`).join('\n\n');
  const code = Array.from({ length: 160 }, (_, n) => `int sample_${n} = ${n};`).join('\n');
  const table = Array.from({ length: 70 }, (_, n) => `| 表格行 ${n}：定位测试 | 对应内容 |`).join('\n');
  const raw = `${prose}\n\n\`\`\`cpp\n${code}\n\`\`\`\n\n| 标题 | 内容 |\n| --- | --- |\n${table}\n\n结束`;
  const line = (text: string) => current(page).locator('.cm-line, .md-table tr').filter({ hasText: text }).first();
  const offset = (text: string) => line(text).evaluate(el => el.getBoundingClientRect().top - el.closest('.markdown-editor')!.querySelector('.cm-scroller')!.getBoundingClientRect().top);
  const atTop = async (text: string) => {
    await line(text).evaluate(el => { const scroller = el.closest('.markdown-editor')!.querySelector('.cm-scroller')!; scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 5; });
    await expect.poll(() => offset(text)).toBeCloseTo(-5, 0);
  };
  try {
    const window = await application.browserWindow(page); await window.evaluate(w => { w.setBounds({ width: 1280, height: 850 }); w.show(); w.focus(); });
    await setContent(page, raw);
    const target = '段落 46：';
    await page.evaluate(pos => { const { view } = (window as any).__editor.active(); view.dispatch({ selection: { anchor: 0 }, effects: view.constructor.scrollIntoView(pos, { y: 'center' }) }); }, raw.indexOf(target));
    await atTop(target);
    const before = await offset(target);
    await page.keyboard.press('Control+/');
    await expect.poll(async () => Math.abs(await offset(target) - before)).toBeLessThan(2);
    await page.locator('#source-mode').click();
    await expect.poll(async () => Math.abs(await offset(target) - before)).toBeLessThan(2);

    await page.keyboard.press('Control+/');
    await expect.poll(async () => Math.abs(await offset(target) - before)).toBeLessThan(2);
    const codeTarget = 'int sample_120 =';
    await page.evaluate(pos => { const { view } = (window as any).__editor.active(); view.dispatch({ effects: view.constructor.scrollIntoView(pos, { y: 'center' }) }); }, raw.indexOf(codeTarget));
    await atTop(codeTarget);
    await page.keyboard.press('Control+/');
    await expect.poll(async () => Math.abs(await offset(codeTarget) + 5)).toBeLessThan(2);
    await page.keyboard.press('Control+/');
    await expect.poll(async () => Math.abs(await offset(codeTarget) + 5)).toBeLessThan(2);
    const tableTarget = '表格行 26：';
    await page.evaluate(pos => { const { view } = (window as any).__editor.active(); view.dispatch({ effects: view.constructor.scrollIntoView(pos, { y: 'center' }) }); }, raw.indexOf(tableTarget));
    await atTop(tableTarget);
    await page.locator('#source-mode').click();
    await expect.poll(async () => Math.abs(await offset(tableTarget) + 5)).toBeLessThan(2);
    await page.keyboard.press('Control+/');
    await expect.poll(async () => Math.abs(await offset(tableTarget) + 5)).toBeLessThan(2);
    expect(await page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head)).toBe(0);
    expect(await content(page)).toBe(raw);
  } finally { await application.close(); }
});

test('打印预览用实际 PDF 离线显示，保存字节一致并独立记住版式字号，编辑主题和原文不变', async () => {
  const { application, page, directory } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1250, height: 900 }); window.showInactive(); });
    const raw = '# 打印检查\n\n## 长代码\n\n```cpp\n' + Array.from({ length: 180 }, (_, i) => i === 49 ? '' : `    int code_${String(i).padStart(4, '0')} = ${i}; // PRINT_${String(i).padStart(4, '0')} 中文注释${i === 60 ? ' long_identifier_'.repeat(16) : ''}`).join('\n') + '\n```\n\n| 算法 | 复杂度 |\n| --- | --- |\n| BFS | O(n+m) |\n\n$$a^2+b^2=c^2$$\n\nPRINT_END';
    await setContent(page, raw); await execute(page, 'export-pdf');
    await expect(page.locator('#print-close')).not.toBeFocused(); await expect(page.locator('#print-close [data-icon=close]')).toHaveCount(1);
    await expect(page.locator('#print-preview')).toBeVisible(); await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 }); await expect(page.locator('#print-pages canvas[data-ready=true]').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.print-settings > p:not([hidden])')).toHaveCount(0);
    await expect(page.locator('#print-layout')).toHaveValue('portrait'); await expect(page.locator('#print-color')).toHaveValue('mono'); await expect(page.locator('#print-font')).toHaveValue('10'); await expect(page.locator('#print-lines')).toBeChecked();
    await page.locator('#print-font').fill('10.5'); await page.locator('#print-layout').selectOption('landscape-two-column'); await expect(page.locator('#print-font')).toHaveValue('9');
    await page.locator('#print-font').fill('9.5'); await page.locator('#print-color').selectOption('light'); await page.locator('#print-color').selectOption('mono'); await page.locator('#print-color').selectOption('light'); await page.locator('#print-lines').uncheck();
    await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 });
    await page.locator('#print-zoom').selectOption('0.75'); await expect(page.locator('#print-pages canvas[data-ready=true]').first()).toBeVisible(); await page.locator('#print-zoom').selectOption('fit');
    const token = await page.locator('#print-preview').getAttribute('data-preview-id');
    const bytes = await application.evaluate((_electron, token) => { const api = (globalThis as any).__replicaTest; return [...api.pdfPreviews.get([...api.windows.keys()][0], token).bytes]; }, token);
    const destination = path.join(directory, 'print-preview.pdf'); await chooseSave(application, destination); await page.locator('#print-save').click(); await expect(page.locator('#print-preview')).not.toBeVisible();
    expect(Buffer.from(await fs.readFile(destination)).equals(Buffer.from(bytes))).toBe(true); expect(await content(page)).toBe(raw); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await execute(page, 'export-pdf'); await expect(page.locator('#print-layout')).toHaveValue('landscape-two-column'); await expect(page.locator('#print-font')).toHaveValue('9.5'); await expect(page.locator('#print-lines')).not.toBeChecked();
    await page.locator('#print-layout').selectOption('portrait'); await expect(page.locator('#print-font')).toHaveValue('10.5');
    await page.evaluate(() => (window as any).__editor.setContent('# 原文已更新')); await expect(page.locator('#print-stale')).toBeVisible();
    await page.locator('#print-refresh').click(); await expect(page.locator('#print-stale')).toBeHidden(); await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 });
    const closedToken = await page.locator('#print-preview').getAttribute('data-preview-id'); await page.keyboard.press('Escape'); await expect(page.locator('#print-preview')).not.toBeVisible();
    const result = await page.evaluate(token => window.rypota.savePdf(token!), closedToken); expect(result.ok).toBe(false);
    expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('PDF 预览拒绝跨窗口保存与无效选项，过期排版结果和关闭后的缓存不可保存', async () => {
  const { application, page } = await launch();
  try {
    const id = await page.evaluate(async () => (await window.rypota.bootstrap()).activeId!);
    await application.evaluate(({ app }) => { (globalThis as any).__pdfWindows = 0; app.on('browser-window-created', () => { (globalThis as any).__pdfWindows++; }); });
    const html = '<!doctype html><html><head></head><body>PRINT JOB</body></html>';
    const options = { layout: 'portrait' as const, color: 'mono' as const, codeFontPt: 10, lineNumbers: true };
    const result = await page.evaluate(async ({ id, html, options }) => Promise.all([window.rypota.previewPdf(id, html, options), window.rypota.previewPdf(id, html, options)]), { id, html, options });
    expect(result[0].ok).toBe(false); expect(result[1].ok).toBe(true); if (!result[1].ok) throw new Error('Latest preview was not retained');
    let token = result[1].previewId;
    const beforeCache = await application.evaluate(() => (globalThis as any).__pdfWindows);
    const beforeBytes = await application.evaluate((_electron, token) => { const api = (globalThis as any).__replicaTest; return api.pdfPreviews.get([...api.windows.keys()][0], token).bytes.toString('base64'); }, token);
    await page.evaluate(() => window.rypota.releasePdf()); expect((await page.evaluate(token => window.rypota.savePdf(token), token)).ok).toBe(false);
    const cached = await page.evaluate(({ id, html, options }) => window.rypota.previewPdf(id, html, options), { id, html, options }); if (!cached.ok) throw new Error('Cached preview failed');
    expect(cached.previewId).not.toBe(token); token = cached.previewId;
    expect(Buffer.from(cached.bytes).toString('base64')).toBe(beforeBytes); expect(await application.evaluate(() => (globalThis as any).__pdfWindows)).toBe(beforeCache);
    const changed = await page.evaluate(({ id, html, options }) => window.rypota.previewPdf(id, html.replace('PRINT JOB', 'CHANGED JOB'), options), { id, html, options }); expect(changed.ok).toBe(true);
    if (changed.ok) token = changed.previewId;
    expect(await application.evaluate(() => (globalThis as any).__pdfWindows)).toBe(beforeCache + 1);
    const invalid = await page.evaluate(({ id, html, options }) => window.rypota.previewPdf(id, html, { ...options, codeFontPt: 0 }), { id, html, options }); expect(invalid.ok).toBe(false);
    await execute(page, 'new-window'); await expect.poll(() => application.windows().length).toBe(2); const other = application.windows().find(window => window !== page)!; await other.locator('.markdown-editor').waitFor();
    expect((await other.evaluate(token => window.rypota.savePdf(token), token)).ok).toBe(false);
    expect((await other.evaluate(({ id, html, options }) => window.rypota.previewPdf(id, html, options), { id, html, options })).ok).toBe(false);
    const broken = await page.evaluate(({ id, options }) => window.rypota.previewPdf(id, '<html><head></head><body><img src="data:image/png;base64,bad"></body></html>', options), { id, options }); expect(broken.ok).toBe(false); if (!broken.ok) expect(broken.message).toContain('图片解码失败');
    await page.evaluate(() => window.rypota.releasePdf()); expect((await page.evaluate(token => window.rypota.savePdf(token), token)).ok).toBe(false);
    const owner = await page.evaluate(async () => (await window.rypota.bootstrap()).windowId);
    const native = await application.browserWindow(page); await native.evaluate(window => window.close());
    await expect.poll(() => application.evaluate((_electron, owner) => !(globalThis as any).__replicaTest.pdfPreviews.recent.has(owner), owner)).toBe(true);
  } finally { await application.close(); }
});

test('长文先排版开头，整份完成前不可保存，接收旧请求的首页不改变当前预览', async () => {
  const { application, page, directory } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await application.evaluate(({ app }) => {
      (globalThis as any).__holdFull = true;
      app.on('browser-window-created', (_event, window) => {
        const load = window.loadURL.bind(window);
        window.loadURL = async (url, options) => {
          const html = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString();
          if (html.includes('PRINT_END')) (globalThis as any).__fullHtmlLength = html.length;
          else (globalThis as any).__prefixHtmlLength = html.length;
          return load(url, options);
        };
        const print = window.webContents.printToPDF.bind(window.webContents);
        window.webContents.printToPDF = async options => {
          if (!options?.pageRanges && (globalThis as any).__holdFull) await new Promise<void>(resolve => { (globalThis as any).__releaseFull = resolve; });
          const bytes = await print(options); if (options?.pageRanges === '1') (globalThis as any).__firstPage = bytes.toString('base64'); return bytes;
        };
      });
    });
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1250, height: 900 }); window.showInactive(); });
    const raw = '# 分阶段打印\n\n```cpp\n' + Array.from({ length: 180 }, (_, i) => `int line_${String(i).padStart(3, '0')} = ${i}; // 中文注释`).join('\n') + '\n```\n\nPRINT_END';
    await setContent(page, raw); await execute(page, 'export-pdf'); await expect(page.locator('#print-pages canvas[data-ready=true]').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#print-page-count')).toHaveText('首页预览');
    await expect(page.locator('#print-save')).toBeDisabled(); await expect(page.locator('#print-preview')).not.toHaveAttribute('data-preview-id');
    const first = await application.evaluate(() => (globalThis as any).__firstPage); await fs.writeFile(path.join(directory, 'first-page.pdf'), Buffer.from(first, 'base64'));
    await expect.poll(() => application.evaluate(() => (globalThis as any).__fullHtmlLength > (globalThis as any).__prefixHtmlLength)).toBe(true);
    await application.evaluate(() => { (globalThis as any).__holdFull = false; (globalThis as any).__releaseFull(); });
    await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 }); expect(Number.parseInt(await page.locator('#print-page-count').innerText())).toBeGreaterThan(1);
    const token = await page.locator('#print-preview').getAttribute('data-preview-id'); const count = await page.locator('.print-page').count();
    await application.evaluate(({ }, first) => {
      const api = (globalThis as any).__replicaTest; api.windows.values().next().value.webContents.send('pdf:first-page', { requestId: '00000000-0000-0000-0000-000000000000', documentId: 'wrong-document', bytes: new Uint8Array(Buffer.from(first, 'base64')) });
    }, first);
    await expect(page.locator('.print-page')).toHaveCount(count); await expect(page.locator('#print-preview')).toHaveAttribute('data-preview-id', token!);
    const last = page.locator('.print-page').last();
    await expect(last.locator('canvas')).toHaveCount(0);
    await last.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await expect(last.locator('canvas[data-ready=true]')).toBeVisible();
    await expect(page.locator('.print-page').first().locator('canvas')).toHaveCount(0);
    const destination = path.join(directory, 'complete.pdf'); await chooseSave(application, destination); await page.locator('#print-save').click(); await expect(page.locator('#print-preview')).not.toBeVisible(); expect(await content(page)).toBe(raw); expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('精简界面保留文件入口，移除模式且窄窗口可用', async () => {
  const { application, page } = await launch();
  try {
    expect(await application.evaluate(({ app }) => app.getName())).toBe('墨页 Moye');
    await expect(page).toHaveTitle(/墨页 Moye$/);
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 640, height: 650 }); window.show(); window.focus(); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.document-heading,.quick-actions,#sidebar-close,#open-folder,#reading-time,#reading-width')).toHaveCount(0);
    await expect(page.locator('[data-menu-index]')).toHaveCount(0); await expect(page.locator('#settings-open')).toHaveCount(1);
    await expect(page.locator('#tabbar')).toBeVisible();
    await toolbarAction(page, '文件', '快速打开');
    await expect(page.locator('#quick-open')).toBeVisible(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建标签页', exact: true }).click(); await expect(page.locator('.tab')).toHaveCount(2);
    await setContent(page, '# 精简界面\n\n正文');
    await page.keyboard.press('F8'); await page.keyboard.press('F9');
    await execute(page, 'preferences'); await expect(page.locator('#preferences')).toBeVisible();
    await expect(page.locator('#focus-toggle,#typewriter-toggle')).toHaveCount(0);
    await expect(page.locator('#preferences')).not.toContainText('专注模式'); await expect(page.locator('#preferences')).not.toContainText('打字机模式');
    await page.locator('#reading-width-select').selectOption('1080');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--reading-width'))).toBe('1080px');
    expect(await content(page)).toBe('# 精简界面\n\n正文');
  } finally { await application.close(); }
});

test('侧栏与标签切换平滑，快速反向操作和减少动态效果仍能立即编辑', async () => {
  const { application, page } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => { window.show(); window.focus(); });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await setContent(page, '# 原文\n\n正在写作的内容');
    await execute(page, 'sidebar');
    const during = await page.locator('#sidebar').evaluate(sidebar => {
      const animation = sidebar.getAnimations()[0]; if (!animation) return null;
      animation.pause(); animation.currentTime = 110;
      const box = sidebar.getBoundingClientRect(); const width = box.right - Math.max(0, box.left); animation.play(); return width;
    });
    expect(during).toBeGreaterThan(0); expect(during).toBeLessThan(256);
    await expect(page.locator('#sidebar-resize')).toBeVisible();
    for (let i = 0; i < 4; i++) await execute(page, 'sidebar');
    await expect(page.locator('#sidebar')).toBeVisible(); await expect(page.locator('#sidebar-resize')).toBeVisible();
    await expect.poll(() => page.locator('#sidebar').evaluate(e => Math.round(e.getBoundingClientRect().width))).toBe(256);
    await execute(page, 'new'); await setContent(page, '第二页'); await execute(page, 'previous-tab');
    const animated = await current(page).evaluate(slot => slot.getAnimations().length); expect(animated).toBeGreaterThan(0);
    await page.evaluate(() => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: editor.content.length } }); editor.focus(); });
    await page.keyboard.insertText('继续'); expect(await content(page)).toBe('# 原文\n\n正在写作的内容继续');
    await page.keyboard.press('Control+z'); expect(await content(page)).toBe('# 原文\n\n正在写作的内容');
    await execute(page, 'next-tab'); expect(await content(page)).toBe('第二页');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await execute(page, 'sidebar'); await expect(page.locator('#sidebar')).toBeHidden();
    await execute(page, 'sidebar'); await expect(page.locator('#sidebar-resize')).toBeVisible();
    expect(await page.locator('#sidebar').evaluate(e => e.getAnimations().length)).toBe(0);
    await execute(page, 'previous-tab'); expect(await current(page).evaluate(e => e.getAnimations().length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await application.close(); }
});

test('段落回车后的退格和 Delete 整体合并，保留 Shift+Enter 和源码换行语义', async () => {
  const { application, page } = await launch();
  const caret = (position: number) => page.evaluate(position => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: position } }); editor.focus(); }, position);
  try {
    for (const theme of ['workbuddy', 'dark']) {
      await execute(page, theme); await setContent(page, '前文'); await caret(2);
      await page.keyboard.press('Enter'); expect(await content(page)).toBe('前文\n\n');
      await page.keyboard.press('Backspace'); expect(await content(page)).toBe('前文');
      await page.keyboard.press('Control+z'); expect(await content(page)).toBe('前文\n\n');
      await page.keyboard.press('Control+Shift+z'); expect(await content(page)).toBe('前文');
      await page.keyboard.press('Enter'); await page.keyboard.insertText('后文'); await caret(4);
      await page.keyboard.press('Backspace'); expect(await content(page)).toBe('前文后文');
      await setContent(page, '前文\n\n后文'); await caret(2); await page.keyboard.press('Delete'); expect(await content(page)).toBe('前文后文');
      await setContent(page, '前文'); await caret(2); await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('同行段落'); expect(await content(page)).toBe('前文  \n同行段落');
    }
    await setContent(page, '前文\n\n\n后文'); await caret(5); await page.keyboard.press('Backspace'); expect(await content(page)).toBe('前文\n\n后文');
    await execute(page, 'toggle-source'); await setContent(page, '前文\n\n后文'); await caret(4); await page.keyboard.press('Backspace'); expect(await content(page)).toBe('前文\n后文');
    await setContent(page, '前文'); await caret(2); await page.keyboard.press('Enter'); expect(await content(page)).toBe('前文\n');
  } finally { await application.close(); }
});

test('Windows 快捷方式补齐稳定应用标识，保护其他应用和文档专属入口', async () => {
  test.skip(process.platform !== 'win32'); const { application, directory, profile } = await launch();
  try {
    const pin = path.join(directory, 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'); await fs.mkdir(pin, { recursive: true });
    const links = { legacy: path.join(pin, '旧入口.lnk'), other: path.join(pin, '其他应用.lnk'), document: path.join(pin, '某份文档.lnk'), start: path.join(directory, 'Microsoft/Windows/Start Menu/Programs/墨页 Moye.lnk'), otherExe: path.join(directory, 'other.exe') };
    await application.evaluate(({ shell }, links) => {
      shell.writeShortcutLink(links.legacy, { target: process.execPath, args: '--new-window', description: '旧名称' });
      shell.writeShortcutLink(links.other, { target: links.otherExe, appUserModelId: 'Other.App' });
      shell.writeShortcutLink(links.document, { target: process.execPath, args: 'document.md', appUserModelId: 'Document.App' });
    }, links);
    const beforeOther = await fs.readFile(links.other), beforeDocument = await fs.readFile(links.document);
    const result = await application.evaluate(async ({ app, shell }, { directory, links }) => {
      const api = (globalThis as any).__replicaTest;
      const outcome = await api.repairWindowsShortcuts(shell, process.execPath, directory, api.appIconPath);
      return { ...outcome, legacy: shell.readShortcutLink(links.legacy), start: shell.readShortcutLink(links.start), appId: api.appId, userData: app.getPath('userData') };
    }, { directory, links });
    expect(result.failed).toEqual([]); expect(result.updated).toHaveLength(2); expect(result.legacy.appUserModelId).toBe('HanHan.TyporaReplica'); expect(result.start.appUserModelId).toBe(result.appId);
    expect(result.legacy.description).toBe('墨页 Moye'); expect(result.legacy.args).toBe('--new-window'); expect(result.legacy.icon).toBe(result.start.icon); expect(beforeOther.equals(await fs.readFile(links.other))).toBe(true); expect(beforeDocument.equals(await fs.readFile(links.document))).toBe(true); expect(result.userData).toBe(profile);
  } finally { await application.close(); }
});

test('文楷主题离线使用应用内嵌字形', async () => {
  const { application, page } = await launch();
  try {
    await page.route(/^https?:/, route => route.abort());
    await setContent(page, '霞鹜文楷用于中文正文。');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    for (const theme of ['light', 'dark', 'copilot'] as const) {
      await page.evaluate(theme => window.rypota.updatePreferences({ theme }), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const line = current(page).locator('.cm-line').filter({ hasText: '霞鹜文楷用于中文正文。' });
      await line.evaluate(async element => {
        element.id = 'wenkai-probe';
        await document.fonts.load('16px "Moye WenKai"', element.textContent ?? '');
      });
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#wenkai-probe' });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      expect(fonts.some(font => font.postScriptName === 'LXGWWenKai-Regular' && font.isCustomFont && font.glyphCount >= 10), JSON.stringify(fonts)).toBe(true);
    }
  } finally { await application.close(); }
});

test('WorkBuddy 排版、嵌入字体、行号槽与 Shiki github-dark 代表色实际生效', async () => {
  const { application, page, directory } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1100, height: 900 }); window.showInactive(); });
    const raw = '# 图论\n\n## 搜索与拓扑\n\n### BFS\n\n正文采用参考字体。\n\n```cpp\n// 注释\nint value = 5;\nvoid bfs(int sx) { return; }\n```\n\n| 题面信号 | 去哪 |\n| --- | --- |\n| 最长链 | 直径 |\n\n结尾';
    await setContent(page, raw); await execute(page, 'workbuddy'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'workbuddy');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(31, 31, 31)');
    const slot = current(page); await expect(slot.locator('.md-h1')).toHaveCSS('font-size', '26px'); await expect(slot.locator('.md-h2')).toHaveCSS('font-size', '22px'); await expect(slot.locator('.md-h3')).toHaveCSS('font-size', '18px');
    const block = slot.locator('.md-code'); await expect(block).toHaveCSS('background-color', 'rgb(30, 30, 30)'); await expect(block).toHaveCSS('border-radius', '10px');
    await expect(block.locator('.cm-editor')).toHaveAttribute('data-shiki', 'ready', { timeout: 15000 }); await page.evaluate(async () => { await document.fonts.ready; });
    for (const [word, color] of [['int', 'rgb(249, 117, 131)'], ['// 注释', 'rgb(106, 115, 125)'], ['5', 'rgb(121, 184, 255)'], ['bfs', 'rgb(179, 146, 240)']]) await expect(block.locator('.shiki-token').filter({ hasText: new RegExp('^' + word + '$') }).first()).toHaveCSS('color', color);
    await expect(block.locator('.cm-scroller')).toHaveCSS('font-size', '14px'); await expect(block.locator('.cm-gutters')).toHaveCSS('min-width', '44px');
    const number = block.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^1$/ }); const line = block.locator('.cm-line').first(); expect(Math.abs((await number.boundingBox())!.y - (await line.boundingBox())!.y)).toBeLessThan(2);
    await block.locator('.shiki-token').filter({ hasText: /^int$/ }).first().evaluate(element => { let leaf: Element = element; while (leaf.firstElementChild) leaf = leaf.firstElementChild; leaf.setAttribute('data-font-probe', 'code'); });
    const cdp = await page.context().newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); const { root } = await cdp.send('DOM.getDocument'); const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-font-probe="code"]' });
    const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }); expect(fonts.fonts.some(font => font.familyName === 'Source Code Pro' && font.isCustomFont && font.glyphCount > 0), JSON.stringify(fonts.fonts)).toBe(true);
    await expect(slot.locator('.md-table th').first()).toHaveCSS('background-color', 'rgb(37, 37, 38)'); await expect(slot.locator('.md-table th').first()).toHaveCSS('text-align', 'left'); await expect(slot.locator('.md-table td').first()).toHaveCSS('background-color', 'rgb(19, 20, 20)');
    const exported = path.join(directory, 'workbuddy.html'); await chooseSave(application, exported); await execute(page, 'export-html');
    await expect.poll(() => fs.readFile(exported, 'utf8').catch(() => '')).toContain('Source Code Pro');
    const html = await fs.readFile(exported, 'utf8'); expect(html).toContain('data:font/woff2;base64,'); expect(html).toContain('background:#1f1f1f'); expect(html).toContain('rgb(249, 117, 131)'); expect(html).toContain('class="line"');
    expect(await content(page)).toBe(raw);
  } finally { await application.close(); }
});

test('标题栏导出 HTML 后表格占满正文，窄屏长单元格仍会折行', async () => {
  const { application, page, directory } = await launch();
  try {
    const target = path.join(directory, 'table.html');
    await setContent(page, '# 导出排版\n\n| 名称 | 地址 |\n| --- | --- |\n| 链接 | https://example.org/' + 'long'.repeat(90) + ' |');
    for (const [label, theme] of [['夜间', 'dark'], ['白色', 'light'], ['WorkBuddy 深色', 'workbuddy'], ['Copilot 深色', 'copilot']]) {
      await page.getByRole('button', { name: '主题', exact: true }).click();
      await page.getByRole('menu', { name: '主题' }).getByRole('menuitemradio', { name: label, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await chooseSave(application, target);
      const expectedBg = await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--bg').trim());
      await toolbarAction(page, '文件', '导出 HTML');
      await expect.poll(() => fs.readFile(target, 'utf8').catch(() => '')).toContain(`--bg:${expectedBg}`);
      const opened = application.waitForEvent('window');
      await application.evaluate(({ BrowserWindow }, file) => { const preview = new BrowserWindow({ width: 400, height: 600, show: false }); void preview.loadFile(file); }, target);
      const html = await opened;
      await html.locator('table').waitFor();
      const layout = await html.locator('table').evaluate(table => {
        const { paddingLeft, paddingRight } = getComputedStyle(document.body);
        const available = document.body.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight);
        return { difference: Math.abs(available - table.getBoundingClientRect().width), pageFits: document.documentElement.scrollWidth <= innerWidth };
      });
      expect(layout.difference).toBeLessThan(2);
      expect(layout.pageFits).toBe(true);
      await html.evaluate(() => window.close());
    }
  } finally { await application.close(); }
});

test('Shiki 异步着色不打断代码组合输入、选区与撤销，换语言和主题后不残留旧颜色', async () => {
  const { application, page } = await launch();
  try {
    await execute(page, 'workbuddy');
    const code = 'int value = 42;\n// '; await setContent(page, '```cpp\n' + code + '\n```\n\n结尾'); const block = current(page).locator('.md-code'); const editor = block.locator('.cm-content');
    await expect(block.locator('.cm-editor')).toHaveAttribute('data-shiki', 'ready', { timeout: 15000 }); await editor.focus(); await page.keyboard.press('Control+End');
    const cdp = await page.context().newCDPSession(page); await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 }); await cdp.send('Input.insertText', { text: '中文' });
    await expect.poll(() => content(page)).toContain('// 中文\n```'); await expect(block.locator('.cm-editor')).toHaveAttribute('data-shiki', 'ready'); expect((await content(page)).match(/中文/g)).toHaveLength(1); await expect(editor).toBeFocused();
    await page.keyboard.insertText('输入'); await expect.poll(() => content(page)).toContain('// 中文输入\n```'); await expect(block.locator('.cm-editor')).toHaveAttribute('data-shiki', 'ready'); const typed = await content(page);
    await page.keyboard.press('Control+z'); await expect.poll(() => content(page)).not.toBe(typed); expect(await content(page)).not.toContain('输入'); await page.keyboard.press('Control+Shift+z'); await expect.poll(() => content(page)).toBe(typed);
    await block.hover(); await block.getByRole('textbox', { name: '代码语言', exact: true }).fill('plaintext'); await block.getByRole('textbox', { name: '代码语言', exact: true }).press('Tab'); await expect(block.locator('.cm-editor')).toHaveAttribute('data-shiki', 'fallback'); await expect(block.locator('.shiki-token')).toHaveCount(0);
    await block.getByRole('textbox', { name: '代码语言', exact: true }).fill('cpp'); await block.getByRole('textbox', { name: '代码语言', exact: true }).press('Tab'); await expect(block.locator('.cm-editor')).toHaveAttribute('data-shiki', 'ready');
    await execute(page, 'code-modern'); await expect(block.locator('.cm-editor')).toHaveAttribute('data-shiki', 'disabled'); await expect(block.locator('.shiki-token')).toHaveCount(0); await expect(block.locator('.cm-line span').filter({ hasText: /^42$/ })).toHaveCSS('color', 'rgb(181, 206, 168)');
  } finally { await application.close(); }
});

test('长代码可横向滚动或悬挂折行，切换不改原文和撤销并在重启后恢复', async () => {
  let app = await launch(); const code = 'void build(int n) {\n    for (int i = 1; i <= n; ++i) dfn[i] = scc[i] = szc[i] = in[i] = vis[i] = 0, graph[i].clear(), reverse_graph[i].clear();\n}'; const raw = `# 算法笔记\n\n\`\`\`cpp\n${code}\n\`\`\`\n\n结尾`;
  try {
    const native = await app.application.browserWindow(app.page); await native.evaluate(window => { window.setBounds({ width: 920, height: 760 }); window.showInactive(); });
    await app.page.evaluate(() => window.rypota.updatePreferences({ codeWrap: false }));
    await setContent(app.page, raw); const block = current(app.page).locator('.md-code'); const scroller = block.locator('.cm-scroller'); const wrap = block.getByRole('button', { name: '代码自动换行', exact: true });
    await expect(wrap).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => scroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);
    expect(await app.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const longLine = block.locator('.cm-line').filter({ hasText: 'for (int i = 1;' }); const flatHeight = (await longLine.boundingBox())!.height;
    await block.hover(); await wrap.click(); await expect(wrap).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await longLine.boundingBox())!.height).toBeGreaterThan(flatHeight * 1.5);
    expect(await longLine.evaluate(element => parseFloat(getComputedStyle(element).textIndent))).toBeLessThan(0); expect(await content(app.page)).toBe(raw);
    await block.locator('.cm-content').click(); await app.page.keyboard.press('Alt+z'); await expect(wrap).toHaveAttribute('aria-pressed', 'false');
    await app.page.keyboard.press('Control+End'); await app.page.keyboard.insertText('\n// 新内容');
    await wrap.click(); await app.page.keyboard.press('Control+z'); await expect.poll(() => content(app.page)).toBe(raw);
    await execute(app.page, 'new'); await execute(app.page, 'previous-tab'); await block.locator('.cm-content').focus();
    const tabs = app.page.locator('.tab'); await tabs.last().dragTo(tabs.first(), { targetPosition: { x: 4, y: 18 } });
    await expect(block.locator('.cm-content')).toBeFocused(); await app.page.keyboard.press('Control+End'); await app.page.keyboard.insertText('\n// 拖动后仍在代码里');
    await expect.poll(() => content(app.page)).toContain('// 拖动后仍在代码里\n```'); await app.page.keyboard.press('Control+z'); await expect.poll(() => content(app.page)).toBe(raw);
    await app.application.evaluate(({ clipboard }) => { clipboard.writeText = async (value: string) => { (globalThis as any).__copied = value; }; });
    await block.getByRole('button', { name: '复制代码', exact: true }).click(); expect(await app.application.evaluate(() => (globalThis as any).__copied)).toBe(code);
    await expect.poll(() => fs.readFile(path.join(app.profile, 'recovery/workspace.json'), 'utf8').then(JSON.parse).then(data => data.preferences.codeWrap)).toBe(true);
    const profile = app.profile; await app.application.close(); app = await launch(profile); expect(await content(app.page)).toBe(raw);
    await expect(current(app.page).getByRole('button', { name: '代码自动换行', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { await app.application.close(); }
});

test('侧栏筛选、拖动及键盘调整宽度和阅读宽度在重启后保留，显示操作不改正文', async () => {
  let app = await launch(); const raw = '# 总览\n\n## 网络通信\n\n正文\n\n## 进程调度\n\n结尾';
  try {
    const native = await app.application.browserWindow(app.page); await native.evaluate(window => { window.setBounds({ width: 1200, height: 850 }); window.showInactive(); });
    await setContent(app.page, raw); await execute(app.page, 'outline');
    await expect(app.page.locator('#sidebar-content .sidebar-row')).toHaveCount(3); await app.page.getByRole('searchbox', { name: '筛选侧栏' }).fill('网络');
    await expect(app.page.locator('#sidebar-content .sidebar-row')).toHaveCount(1); await expect(app.page.locator('#sidebar-content')).toContainText('网络通信');
    await app.page.getByRole('searchbox', { name: '筛选侧栏' }).press('Escape'); await expect(app.page.locator('#sidebar-content .sidebar-row')).toHaveCount(3);
    const separator = app.page.getByRole('separator', { name: '调整侧栏宽度' }); const box = (await separator.boundingBox())!;
    await separator.hover(); await expect(separator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)'); expect(await separator.evaluate(element => getComputedStyle(element, '::after').width)).toBe('1px');
    await app.page.mouse.move(box.x + box.width / 2, box.y + 90); await app.page.mouse.down(); await app.page.mouse.move(box.x + box.width / 2 + 54, box.y + 90, { steps: 8 }); await app.page.mouse.up();
    await expect(separator).toHaveAttribute('aria-valuenow', '310'); await separator.focus(); await app.page.keyboard.press('ArrowRight'); await expect(separator).toHaveAttribute('aria-valuenow', '320');
    await execute(app.page, 'preferences'); await app.page.locator('#reading-width-select').selectOption('720');
    await expect.poll(() => app.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--reading-width'))).toBe('720px'); await expect(app.page.locator('#reading-width-select')).toHaveValue('720'); await app.page.locator('#settings-close').click();
    expect(await content(app.page)).toBe(raw); const profile = app.profile; await app.application.close(); app = await launch(profile);
    await expect(app.page.getByRole('separator', { name: '调整侧栏宽度' })).toHaveAttribute('aria-valuenow', '320'); await expect.poll(() => app.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--reading-width'))).toBe('720px'); expect(await content(app.page)).toBe(raw);
  } finally { await app.application.close(); }
});

test('快速打开去重并支持方向键选择和路径搜索，中文组合输入回车不误打开', async () => {
  const { application, page, directory } = await launch();
  try {
    for (const name of ['01-算法.md', '02-系统.md']) {
      const file = path.join(directory, name); await fs.writeFile(file, '# ' + name);
      await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file); await execute(page, 'open');
    }
    await execute(page, 'previous-tab'); await page.keyboard.press('Control+p'); await expect(page.locator('#quick-results button')).toHaveCount(2);
    await expect(page.locator('#quick-results button').first()).toHaveAttribute('aria-selected', 'true'); await page.keyboard.press('ArrowDown'); await expect(page.locator('#quick-results button').last()).toHaveAttribute('aria-selected', 'true'); await page.keyboard.press('Enter');
    await expect(page.locator('#quick-open')).not.toBeVisible(); await expect(page.locator('.tab.active .tab-label')).toContainText('02-系统.md');
    await page.keyboard.press('Control+p'); await page.locator('#quick-input').fill('01-算法'); await expect(page.locator('#quick-results button')).toHaveCount(1);
    await page.locator('#quick-input').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))); await expect(page.locator('#quick-open')).toBeVisible();
    await page.keyboard.press('Enter'); await expect(page.locator('.tab.active .tab-label')).toContainText('01-算法.md');
    await page.keyboard.press('Control+p'); await page.locator('#quick-input').fill('不会存在的标题'); await expect(page.locator('.quick-empty')).toHaveText('没有匹配的文件'); await page.keyboard.press('Escape'); await expect(page.locator('#quick-open')).not.toBeVisible();
  } finally { await application.close(); }
});

test('原文保真、光标语法显隐、排版和真实快捷键', async () => {
  const { application, page } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const raw = '# 中文标题\n\n正文 **加粗** 和 *斜体*、~~删除~~、`code`。\n\n- 第一项\n- [ ] 待办\n\n结尾  \n';
    await setContent(page, raw); await expect(current(page).locator('.md-h1')).toContainText('中文标题'); await expect(current(page).locator('.md-strong')).toHaveText('加粗'); await expect(current(page).locator('.md-checkbox')).toHaveCount(1);
    await page.evaluate(() => { const editor = (window as any).__editor.active(); const pos = editor.content.indexOf('加粗') + 1; editor.view.dispatch({ selection: { anchor: pos } }); editor.focus(); });
    await expect(current(page).locator('.cm-line').filter({ hasText: '正文' })).toContainText('**加粗**');
    await page.evaluate(() => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: editor.content.length } }); editor.focus(); });
    await expect(current(page).locator('.cm-line').filter({ hasText: '正文' })).not.toContainText('**');
    await page.keyboard.press('Control+/'); await expect(current(page).locator('.markdown-editor')).toHaveAttribute('data-source', 'true'); await page.keyboard.press('Control+/'); expect(await content(page)).toBe(raw);
    await page.keyboard.insertText('中文输入'); await expect.poll(() => content(page)).toContain('中文输入'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw); await page.keyboard.press('Control+Shift+z'); await expect.poll(() => content(page)).toContain('中文输入');
    await setContent(page, ''); await current(page).locator('.cm-content').click(); await page.keyboard.type('# '); await page.keyboard.insertText('即时标题'); await page.keyboard.press('Enter'); await page.keyboard.insertText('正文'); await expect(current(page).locator('.md-h1')).toContainText('即时标题'); expect(await content(page)).toContain('# 即时标题\n\n正文'); expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('图片及块组件之后点击正文按实际坐标定位，滚动和主题切换后仍可编辑中间', async () => {
  const { application, page } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1000, height: 900 }); window.show(); window.focus(); });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="620"><rect width="900" height="620" fill="#ddeeff"/></svg>').toString('base64');
    for (const theme of ['light', 'dark', 'copilot', 'workbuddy']) {
      await execute(page, theme);
      const raw = `![图](${image})\n\n32 位操作系统，每个进程独占 4G 内存（进程虚拟内存地址空间大小）\n\n\`\`\`cpp\nint value = 42;\n\`\`\`\n\n| 标题 | 状态 |\n| --- | --- |\n| 内容 | 完成 |\n\n第二段正文的中间位置可以修改\n\n末尾`;
      await setContent(page, raw); await expect.poll(() => current(page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      for (const needle of ['内存地址', '中间位置']) {
        await page.evaluate(() => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: editor.content.length } }); editor.focus(); });
        const line = current(page).locator('.cm-line').filter({ hasText: needle }).last(); await line.scrollIntoViewIfNeeded();
        const point = await line.evaluate((line, needle) => { const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode())) { const at = node.textContent!.indexOf(needle); if (at < 0) continue; const range = document.createRange(); range.setStart(node, at); range.collapse(true); const box = range.getBoundingClientRect(); return { x: box.x + .2, y: box.y + box.height / 2 }; } throw new Error('No text range'); }, needle);
        await page.mouse.click(point.x, point.y); await expect.poll(() => page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head)).toBe(raw.indexOf(needle));
        await page.keyboard.insertText('【定位】'); expect(await content(page)).toBe(raw.replace(needle, '【定位】' + needle)); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
      }
      // A later image resize must invalidate the layout, too.
      await current(page).locator('.md-image img').evaluate(image => { image.style.height = '900px'; });
      const target = current(page).locator('.cm-line').filter({ hasText: '第二段正文' }); await target.scrollIntoViewIfNeeded();
      const point = await target.evaluate(line => { const range = document.createRange(); range.setStart(line.firstChild!, 6); range.collapse(true); const box = range.getBoundingClientRect(); return { x: box.x + .2, y: box.y + box.height / 2 }; });
      await page.mouse.click(point.x, point.y); await expect.poll(() => page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head)).toBe(raw.indexOf('第二段正文') + 6);
    }
  } finally { await application.close(); }
});

test('词尾 Ctrl+B 格式化前一个词，紧邻中文的加粗可连续输入和撤销', async () => {
  const { application, page } = await launch();
  const caret = (position: number) => page.evaluate(position => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: position } }); editor.focus(); }, position);
  try {
    await setContent(page, '例如：JIACU文字 123'); await caret(8); await page.keyboard.press('Control+b'); expect(await content(page)).toBe('例如：**JIACU**文字 123');
    await expect(current(page).locator('.md-strong')).toHaveText('JIACU'); await page.keyboard.insertText('相邻'); expect(await content(page)).toBe('例如：**JIACU**相邻文字 123');
    await page.keyboard.press('Control+z'); expect(await content(page)).toBe('例如：**JIACU**文字 123'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('例如：JIACU文字 123');
    await setContent(page, '中文词语'); await caret(4); await page.keyboard.press('Control+b'); expect(await content(page)).toBe('中文**词语**'); await page.keyboard.press('Control+b'); expect(await content(page)).toBe('中文词语');
    await setContent(page, ''); await caret(0); await page.keyboard.press('Control+b'); await page.keyboard.insertText('JIACU'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.insertText('文字 123');
    await expect(current(page).locator('.md-strong')).toHaveText('JIACU'); expect(await content(page)).toBe('**JIACU**文字 123');
  } finally { await application.close(); }
});

test('标题行首回车整体下移标题，行中拆分和空标题退出均保留合理结构', async () => {
  const { application, page } = await launch();
  const caret = (position: number) => page.evaluate(position => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: position } }); editor.focus(); }, position);
  try {
    for (const position of [0, 4]) {
      await setContent(page, '### 标题内容'); await caret(position); await page.keyboard.press('Enter'); expect(await content(page)).toBe('\n### 标题内容'); await expect(current(page).locator('.md-h3')).toHaveText('标题内容');
      await page.keyboard.insertText('新增'); expect(await content(page)).toBe('\n### 新增标题内容'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('### 标题内容');
    }
    await setContent(page, '### 标题内容'); await caret(6); await page.keyboard.press('Enter'); expect(await content(page)).toBe('### 标题\n\n内容');
    await setContent(page, '### 标题内容'); await caret(8); await page.keyboard.press('Home'); await page.keyboard.press('Enter'); expect(await content(page)).toBe('\n### 标题内容');
    await setContent(page, '### '); await caret(4); await page.keyboard.press('Enter'); expect(await content(page)).toBe('');
  } finally { await application.close(); }
});

test('引用菜单和快捷键创建后光标留在标记之后，可直接输入和撤销', async () => {
  const { application, page } = await launch();
  try {
    for (const mode of ['shortcut', 'menu', 'blurred']) {
      await setContent(page, ''); await current(page).locator('.cm-content').click();
      if (mode === 'menu') { await toolbarAction(page, '段落', '引用'); }
      else { if (mode === 'blurred') await page.locator('#settings-open').focus(); await page.keyboard.press('Control+Shift+Q'); }
      expect(await content(page)).toBe('> '); expect(await page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head)).toBe(2);
      await page.keyboard.insertText('引用正文'); expect(await content(page)).toBe('> 引用正文'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('> '); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('');
    }
    await setContent(page, '原有内容'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 0 } }); e.focus(); }); await page.keyboard.press('Control+Shift+Q'); await page.keyboard.insertText('新增'); expect(await content(page)).toBe('> 新增原有内容');
    await setContent(page, '第一行\n第二行\n保留行'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 0, head: 8 } }); e.focus(); }); await page.keyboard.press('Control+Shift+Q'); expect(await content(page)).toBe('> 第一行\n> 第二行\n保留行');
  } finally { await application.close(); }
});

test('引用内原生输入法多轮组合不重复提交，输入期间不被后台文本替换', async () => {
  const { application, page, profile } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const cdp = await page.context().newCDPSession(page); const raw = '> 已有文字'; await setContent(page, raw);
    await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: e.content.length } }); e.focus(); });
    await cdp.send('Input.imeSetComposition', { text: 'doubao', selectionStart: 6, selectionEnd: 6 });
    await expect.poll(() => content(page)).toBe(raw + 'doubao');
    await page.evaluate(raw => (window as any).__editor.active().replace(raw), raw); expect(await content(page)).toBe(raw + 'doubao');
    await cdp.send('Input.insertText', { text: '豆包' }); let expected = raw + '豆包'; await expect.poll(() => content(page)).toBe(expected);
    for (const [updates, value] of [[['n', 'ni', 'nihao', '你好'], '你好'], [['s', 'shi', 'shuru', '输入'], '输入'], [['c', 'ce', 'ceshi', '测试'], '测试']] as const) {
      for (const text of updates) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
      await cdp.send('Input.insertText', { text: value }); expected += value; await expect.poll(() => content(page)).toBe(expected);
    }
    await expect.poll(() => fs.readFile(path.join(profile, 'recovery/workspace.json'), 'utf8').then(JSON.parse).then(snapshot => snapshot.documents[0].content)).toBe(expected);
    expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('无选区 Ctrl+C/X 和菜单处理整行，选区保持精确并支持撤销和代码行', async () => {
  const { application, page } = await launch();
  const copied = () => application.evaluate(({ clipboard }) => clipboard.readText());
  const caret = (position: number) => page.evaluate(position => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: position } }); editor.focus(); }, position);
  try {
    const raw = '首行\n当前**加粗**行\n尾行'; await setContent(page, raw); await caret(raw.indexOf('\n尾行'));
    await page.keyboard.press('Control+c'); await expect.poll(copied).toBe('当前**加粗**行\n'); expect(await content(page)).toBe(raw);
    await page.keyboard.press('Control+x'); await expect.poll(() => content(page)).toBe('首行\n尾行'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
    await caret(raw.length); await execute(page, 'copy'); expect(await copied()).toBe('尾行\n'); await execute(page, 'cut'); expect(await content(page)).toBe('首行\n当前**加粗**行'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
    await page.evaluate(() => { const editor = (window as any).__editor.active(); const from = editor.content.indexOf('加粗'); editor.view.dispatch({ selection: { anchor: from, head: from + 2 } }); editor.focus(); });
    await execute(page, 'copy'); expect(await copied()).toBe('加粗'); await execute(page, 'cut'); expect(await content(page)).toBe(raw.replace('加粗', '')); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
    for (const [text, at, after] of [['一\n\n二', 2, '一\n二'], ['一\n', 2, '一'], ['仅有一行', 4, '']] as const) { await setContent(page, text); await caret(at); await page.keyboard.press('Control+x'); await expect.poll(() => content(page)).toBe(after); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(text); }
    const long = '自动折行的中文段落'.repeat(100); await setContent(page, long); await caret(long.length); await page.keyboard.press('Control+c'); await expect.poll(copied).toBe(long + '\n');
    await setContent(page, '```cpp\nint a = 1;\nint b = 2;\n```'); const code = current(page).locator('.code-content .cm-content'); await code.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.press('Control+c'); await expect.poll(copied).toBe('int a = 1;\n');
    await page.keyboard.press('Control+x'); await expect.poll(() => content(page)).toBe('```cpp\nint b = 2;\n```'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('```cpp\nint a = 1;\nint b = 2;\n```');
    await setContent(page, '剪贴板失败也要保留正文'); await caret('剪贴板失败也要保留正文'.length); await application.evaluate(({ clipboard }) => { clipboard.writeText = async () => { throw new Error('test clipboard unavailable'); }; });
    await execute(page, 'cut'); expect(await content(page)).toBe('剪贴板失败也要保留正文'); await expect(page.locator('#toast')).toContainText('无法写入剪贴板');
  } finally { await application.close(); }
});

test('有序列表按列表起点连续显示，保留全 1 源码并支持嵌套、续行和导出', async ({}, testInfo) => {
  const { application, page, directory } = await launch();
  try {
    const raw = '1. 代码段\n1. 数据段\n1. BSS 段\n1. 堆段\n1. 文件映射段\n1. 栈段\n\n结尾'; await setContent(page, raw);
    const labels = () => current(page).locator('.md-list-number').evaluateAll(markers => markers.map(marker => marker.getAttribute('data-list-marker')));
    await expect.poll(labels).toEqual(['1.', '2.', '3.', '4.', '5.', '6.']); expect(await content(page)).toBe(raw);
    await expect(current(page).locator('.md-list-number').nth(1)).toHaveAttribute('contenteditable', 'false');
    await expect(current(page).locator('.md-list-number').nth(1)).toHaveText('2.');
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1000, height: 760 }); window.showInactive(); }); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: testInfo.outputPath('ordered-list-preview.png') });
    const body = current(page).locator('.cm-line').filter({ hasText: 'BSS 段' }); const point = await body.evaluate(line => { const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode())) { const index = node.textContent!.indexOf('BSS'); if (index < 0) continue; const range = document.createRange(); range.setStart(node, index + 1); range.collapse(true); const box = range.getBoundingClientRect(); return { x: box.x + .2, y: box.y + box.height / 2 }; } throw new Error('Missing text'); });
    await page.mouse.click(point.x, point.y); expect(await page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head)).toBe(raw.indexOf('BSS') + 1);
    const cdp = await page.context().newCDPSession(page); await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 }); await cdp.send('Input.insertText', { text: '拼' }); await expect.poll(() => content(page)).toBe(raw.replace('BSS', 'B拼SS')); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
    await page.evaluate(() => { const editor = (window as any).__editor.active(); const anchor = editor.content.indexOf('栈段') + 2; editor.view.dispatch({ selection: { anchor } }); editor.focus(); }); await page.keyboard.press('Enter'); await page.keyboard.insertText('新增项目');
    await expect.poll(labels).toEqual(['1.', '2.', '3.', '4.', '5.', '6.', '7.']); expect(await content(page)).toContain('新增项目');
    await execute(page, 'toggle-source'); await expect(current(page).locator('.md-list-number')).toHaveCount(0); await execute(page, 'toggle-source'); await expect.poll(labels).toHaveLength(7);
    const nested = '5. 第五项\n1. 第六项\n\n   3. 子项三\n   1. 子项四\n1. 第七项\n\n分隔段落\n\n0) 零\n1) 一\n\n结尾'; await setContent(page, nested);
    await expect.poll(labels).toEqual(['5.', '6.', '3.', '4.', '7.', '0)', '1)']); expect(await content(page)).toBe(nested);
    const exported = path.join(directory, '列表.html'); await chooseSave(application, exported); await execute(page, 'export-html'); const html = await fs.readFile(exported, 'utf8'); expect(html).toContain('<ol start="5">'); expect(html).toContain('<ol start="3">'); expect(html).toContain('<ol start="0">');
  } finally { await application.close(); }
});

test('组合输入一个 f 时，相邻的已输入字母各自保留字形宽度', async () => {
  const { application, page } = await launch();
  try {
    const raw = '1. ffafa 中文';
    const body = raw.indexOf('ffafa');
    await setContent(page, raw);
    await page.evaluate(async body => {
      const editor = (window as any).__editor.active();
      editor.view.dispatch({ selection: { anchor: body } });
      editor.focus();
      await document.fonts.ready;
    }, body);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'f', selectionStart: 1, selectionEnd: 1 });
    await expect.poll(() => content(page)).toBe('1. fffafa 中文');
    const measured = await page.evaluate(body => {
      const view = (window as any).__editor.active().view;
      const native = window.getSelection()!;
      const widths = [body, body + 1, body + 2].map(position => {
        const { node, offset } = view.domAtPos(position + 1, -1);
        const range = document.createRange();
        range.setStart(node, offset - 1);
        range.setEnd(node, offset);
        return range.getBoundingClientRect().width;
      });
      return { head: view.state.selection.main.head, active: native.anchorNode?.textContent, widths };
    }, body);
    expect(measured.head).toBe(body + 1);
    expect(measured.active).toBe('f');
    expect(Math.min(...measured.widths)).toBeGreaterThan(0);
    expect(Math.max(...measured.widths) - Math.min(...measured.widths)).toBeLessThan(1);
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await expect.poll(() => content(page)).toBe(raw);
  } finally { await application.close(); }
});

test('有序列表正文起点显示拼音、保留光标，编辑列表标题时露出标题标记', async () => {
  const { application, page } = await launch();
  try {
    const raw = '1. 第一项\n1. 第二项\n1. vscode 代码块主题\n\n结尾';
    await setContent(page, raw);
    const position = raw.indexOf('vscode');
    const editor = current(page).locator('.markdown-editor');
    const click = await page.evaluate(position => {
      const view = (window as any).__editor.active().view;
      const caret = view.coordsAtPos(position, 1);
      const marker = view.contentDOM.querySelectorAll('.md-list-number')[2].getBoundingClientRect();
      return { x: caret.left + 1, y: (caret.top + caret.bottom) / 2, markerX: marker.left + 1, gapX: (marker.right + caret.left) / 2 };
    }, position);
    const head = () => page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head);
    for (const x of [click.markerX, click.gapX, click.x]) {
      await page.mouse.click(x, click.y);
      expect(await head()).toBe(position);
    }
    await page.keyboard.press('ArrowLeft');
    expect(await head()).toBe(raw.indexOf('\n1. vscode'));
    await page.mouse.click(click.x + 15, click.y);
    await page.keyboard.press('Home');
    expect(await head()).toBe(position);
    const cdp = await page.context().newCDPSession(page);
    const lefts = [];
    for (const pinyin of ['t', 'tia', 'tianjia']) {
      await cdp.send('Input.imeSetComposition', { text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length });
      await expect.poll(() => content(page)).toBe(raw.replace('vscode', pinyin + 'vscode'));
      expect(await head()).toBe(position + pinyin.length);
      lefts.push(await page.evaluate(pinyin => {
        const native = window.getSelection()!;
        const text = native.anchorNode!;
        const line = text.parentElement!.closest('.cm-line')!;
        if (text.parentElement!.closest('.md-list-number') || !text.textContent?.includes(pinyin) ||
            getComputedStyle(text.parentElement!).color === 'rgba(0, 0, 0, 0)') throw new Error('拼音落在隐藏的列表标记里');
        const caret = native.getRangeAt(0).getBoundingClientRect();
        if (caret.height <= 0 || caret.bottom > line.getBoundingClientRect().bottom + 1) throw new Error('组合输入光标不在正文行');
        return caret.left;
      }, pinyin));
    }
    expect(lefts[1]).toBeGreaterThan(lefts[0]);
    expect(lefts[2]).toBeGreaterThan(lefts[1]);
    await page.evaluate(raw => (window as any).__editor.active().replace(raw), raw);
    expect(await content(page)).toBe(raw.replace('vscode', 'tianjiavscode'));
    const savedContent = () => page.evaluate(async () => (await window.rypota.bootstrap()).documents[0].content);
    expect(await savedContent()).toBe(raw);
    await cdp.send('Input.insertText', { text: '添加' });
    await expect.poll(savedContent).toBe(raw.replace('vscode', '添加vscode'));
    expect(await head()).toBe(position + '添加'.length);
    await page.keyboard.press('Control+z');
    expect(await content(page)).toBe(raw);

    const nested = '1. 1. 嵌套正文\n\n结尾';
    await setContent(page, nested);
    await expect(editor.locator('.md-list-number')).toHaveText(['1.', '1.']);
    await page.keyboard.press('Control+Home');
    expect(await head()).toBe(nested.indexOf('嵌套'));
    await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '拼' });
    await expect.poll(savedContent).toBe('1. 1. 拼嵌套正文\n\n结尾');

    await execute(page, 'toggle-source');
    await page.keyboard.press('Control+Home');
    expect(await head()).toBe(0);
    await page.keyboard.press('Delete');
    await page.keyboard.insertText('5');
    expect(await content(page)).toBe('5. 1. 拼嵌套正文\n\n结尾');
    await execute(page, 'toggle-source');

    const heading = '8. # <- 这个应该是一个显示 bug\n\n正文';
    await setContent(page, heading);
    const title = editor.locator('.md-list.md-h1');
    await expect(title).toContainText('<- 这个应该是一个显示 bug');
    const select = (anchor: number) => page.evaluate(anchor => {
      const view = (window as any).__editor.active().view;
      view.dispatch({ selection: { anchor } });
    }, anchor);
    await select(heading.length);
    await expect(title.locator('.md-heading-marker')).toHaveCount(0);
    await select(heading.indexOf('<-'));
    await expect(title.locator('.md-heading-marker')).toHaveText('#');
    expect(await content(page)).toBe(heading);
  } finally { await application.close(); }
});

test('有序列表正文起点的光标在点击和退格后大小及位置一致', async () => {
  const { application, page } = await launch();
  try {
    for (const theme of ['light', 'workbuddy']) {
      await execute(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const raw = '1. 正文';
      const body = raw.indexOf('正文');
      await setContent(page, raw);
      const click = await page.evaluate(async body => {
        await document.fonts.ready;
        const { view } = (window as any).__editor.active();
        const marker = view.contentDOM.querySelector('.md-list-number').getBoundingClientRect();
        const text = view.coordsAtPos(body, 1);
        return { y: (text.top + text.bottom) / 2, gap: (marker.right + text.left) / 2, text: text.left + 1 };
      }, body);
      const caret = () => page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const { view } = (window as any).__editor.active();
        const { head } = view.state.selection.main;
        const rect = view.dom.querySelector('.cm-cursor-primary').getBoundingClientRect();
        return { head, height: rect.height, left: rect.left };
      });
      await page.mouse.click(click.text, click.y);
      const expected = await caret();
      expect(expected.head).toBe(body);
      expect(expected.height).toBeGreaterThan(0);
      await page.mouse.click(click.gap, click.y);
      expect(await caret()).toEqual(expected);

      await setContent(page, '1. f正文');
      await page.evaluate(body => {
        const editor = (window as any).__editor.active();
        editor.view.dispatch({ selection: { anchor: body + 1 } });
        editor.focus();
      }, body);
      await page.keyboard.press('Backspace');
      expect(await content(page)).toBe(raw);
      expect(await caret()).toEqual(expected);
      await page.keyboard.insertText('新');
      expect(await content(page)).toBe('1. 新正文');
    }
  } finally { await application.close(); }
});

test('有序列表的隐藏编号不能成为选区，正文、跨行和源码仍可选择', async () => {
  const { application, page } = await launch();
  try {
    const raw = '1. 第一项\n1. 第二项\n1. vscode 代码块主题\n\n结尾';
    const firstBody = raw.indexOf('第一项');
    const body = raw.indexOf('vscode');
    const precedingEnd = raw.indexOf('\n1. vscode');
    await setContent(page, raw);
    const select = (anchor: number, head = anchor) => page.evaluate(({ anchor, head }) => {
      const editor = (window as any).__editor.active();
      editor.view.dispatch({ selection: { anchor, head } });
      editor.focus();
    }, { anchor, head });
    const selected = () => page.evaluate(() => {
      const { from, to } = (window as any).__editor.active().view.state.selection.main;
      return { from, to };
    });

    await select(body);
    await page.keyboard.press('Shift+ArrowLeft');
    expect(await selected()).toEqual({ from: body, to: body });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    await expect.poll(() => content(page)).toBe(raw.replace('vscode', 'pinvscode'));
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await expect.poll(() => content(page)).toBe(raw);
    await expect.poll(() => page.evaluate(() => (window as any).__editor.active().view.compositionStarted)).toBe(false);
    await page.keyboard.press('x');
    expect(await content(page)).toBe(raw.replace('vscode', 'xvscode'));
    await page.keyboard.press('Control+z');
    expect(await content(page)).toBe(raw);

    await select(body);
    await page.keyboard.press('Shift+ArrowLeft');
    await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '拼' });
    await expect.poll(async () => page.evaluate(async () => (await window.rypota.bootstrap()).documents[0].content)).toBe(raw.replace('vscode', '拼vscode'));
    await page.keyboard.press('Control+z');
    expect(await content(page)).toBe(raw);

    await select(body + 2);
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+Home');
    expect(await selected()).toEqual({ from: body, to: body + 2 });
    await page.keyboard.press('Shift+ArrowLeft');
    expect(await selected()).toEqual({ from: body, to: body + 2 });
    await page.keyboard.press('Shift+ArrowRight');
    expect(await selected()).toEqual({ from: body + 1, to: body + 2 });
    await page.keyboard.press('Shift+ArrowRight');
    expect(await selected()).toEqual({ from: body + 2, to: body + 2 });

    await select(precedingEnd - 2, body + 2);
    expect(await selected()).toEqual({ from: precedingEnd - 2, to: body + 2 });
    await select(body + 2, precedingEnd - 2);
    expect(await selected()).toEqual({ from: precedingEnd - 2, to: body + 2 });
    await select(firstBody);
    await page.keyboard.press('Control+a');
    expect(await selected()).toEqual({ from: 0, to: raw.length });

    await execute(page, 'toggle-source');
    await select(body);
    await page.keyboard.press('Shift+ArrowLeft');
    expect(await selected()).toEqual({ from: body - 1, to: body });
    await page.keyboard.press('Control+a');
    expect(await selected()).toEqual({ from: 0, to: raw.length });
  } finally { await application.close(); }
});

test('有序列表可以正向或反向拖选整项，复制和剪切包含编号', async () => {
  const { application, page } = await launch();
  try {
    const raw = '1. 第一项\n1. 第二项\n1. 第三项\n\n结尾';
    const itemStart = raw.indexOf('1. 第二项');
    const itemEnd = raw.indexOf('\n1. 第三项');
    await setContent(page, raw);
    const drag = async (reverse: boolean) => {
      const points = await page.evaluate(itemEnd => {
        const view = (window as any).__editor.active().view;
        const marker = view.contentDOM.querySelectorAll('.md-list-number')[1].getBoundingClientRect();
        const end = view.coordsAtPos(itemEnd, -1);
        return { marker: { x: marker.left + 1, y: marker.top + marker.height / 2 }, end: { x: end.left + 7, y: (end.top + end.bottom) / 2 } };
      }, itemEnd);
      const [from, to] = reverse ? [points.end, points.marker] : [points.marker, points.end];
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
    };
    const selected = () => page.evaluate(() => {
      const { anchor, head } = (window as any).__editor.active().view.state.selection.main;
      return { anchor, head };
    });
    await application.evaluate(({ clipboard }) => {
      clipboard.writeText = async (value: string) => { (globalThis as any).__copiedListItem = value; };
    });
    const copied = () => application.evaluate(() => (globalThis as any).__copiedListItem);

    await drag(false);
    expect(await selected()).toEqual({ anchor: itemStart, head: itemEnd });
    await page.keyboard.press('Control+c');
    await expect.poll(copied).toBe('1. 第二项');
    await drag(true);
    expect(await selected()).toEqual({ anchor: itemEnd, head: itemStart });
    await page.keyboard.press('Control+x');
    await expect.poll(() => content(page)).toBe(raw.slice(0, itemStart) + raw.slice(itemEnd));
    expect(await copied()).toBe('1. 第二项');
    await page.keyboard.press('Control+z');
    expect(await content(page)).toBe(raw);
    await drag(false);
    await page.keyboard.insertText('普通段落');
    expect(await content(page)).toBe(raw.slice(0, itemStart) + '普通段落' + raw.slice(itemEnd));
    await page.keyboard.press('Control+z');
    expect(await content(page)).toBe(raw);
  } finally { await application.close(); }
});

test('表格单元格、Tab 导航、扩展行列和代码块连续输入', async () => {
  const { application, page } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await setContent(page, '| 名称 | 状态 |\n| --- | --- |\n| 原值 | 待办 |\n\n```javascript\nconst x = 1;\n```\n\n结尾\n');
    const table = current(page).locator('table'); await expect(table).toHaveCount(1); const cell = table.locator('td').first(); await cell.click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('修改后的值'); await page.keyboard.press('Tab'); await expect.poll(() => content(page)).toContain('修改后的值');
    await current(page).locator('.md-table').hover(); await current(page).getByRole('button', { name: '+ 行', exact: true }).click(); await expect(table.locator('tr')).toHaveCount(3);
    await current(page).getByRole('button', { name: '+ 列', exact: true }).click(); await expect(table.locator('th')).toHaveCount(3);
    const code = current(page).locator('.code-content .cm-content'); await code.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nconsole.log(x);'); await page.keyboard.insertText('\n第二次连续输入'); await expect.poll(() => content(page)).toContain('第二次连续输入'); await expect(code).toContainText('console.log(x)');
    await page.keyboard.press('Control+z'); await expect.poll(() => content(page)).not.toContain('第二次连续输入'); expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('表格空行保持一行高度，选区使用柔和主题色，插入行后直接编辑', async () => {
  const { application, page } = await launch();
  try {
    await setContent(page, '## 连通性与环\n\n| 题面信号 | 去哪 |\n| --- | --- |\n| 割点与桥 | 双连通分量 |\n|  |  |\n');
    const table = current(page).locator('.md-table table');
    const dataRow = table.locator('tr').nth(1);
    const emptyRow = table.locator('tr').nth(2);
    await expect.poll(async () => Math.abs((await dataRow.boundingBox())!.height - (await emptyRow.boundingBox())!.height)).toBeLessThan(1);

    const cell = dataRow.locator('td').first();
    await cell.click();
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('割点与桥');
    const selection = await cell.evaluate(element => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      context.fillStyle = getComputedStyle(element, '::selection').backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
    expect(selection[3]).toBe(255);
    expect(selection[2]).toBeLessThanOrEqual(selection[1]);

    const toolbar = current(page).getByRole('group', { name: '表格操作' });
    const buttons = (await toolbar.boundingBox())!;
    const grid = (await table.boundingBox())!;
    expect(buttons.y + buttons.height).toBeLessThan(grid.y);
    await toolbar.getByRole('button', { name: '+ 行', exact: true }).click();
    await expect(table.locator('tr')).toHaveCount(4);
    const inserted = table.locator('tr').nth(2);
    await expect(inserted.locator('td').first()).toBeFocused();
    expect(Math.abs((await inserted.boundingBox())!.height - (await dataRow.boundingBox())!.height)).toBeLessThan(1);
    await page.keyboard.insertText('新增条目');
    await expect.poll(() => content(page)).toContain('| 新增条目 |  |');
    await toolbar.getByRole('button', { name: '居中对齐', exact: true }).click();
    await expect(toolbar.getByRole('button', { name: '居中对齐', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(inserted.locator('td').first()).toHaveCSS('text-align', 'center');
    await toolbar.getByRole('button', { name: '− 行', exact: true }).click();
    await expect(table.locator('tr')).toHaveCount(3);
    await page.keyboard.press('Control+z');
    await expect(table.locator('tr')).toHaveCount(4);
    await expect(inserted).toContainText('新增条目');
  } finally { await application.close(); }
});

test('公式、任务勾选、源码修改和深浅主题', async () => {
  const { application, page } = await launch();
  try {
    await setContent(page, '# 排版测试\n\n- [ ] 完成任务\n\n行内 $x^2$ 和 ==高亮==。\n\n$$\nE=mc^2\n$$\n\n结尾\n');
    await expect(current(page).locator('.md-block.md-math .katex')).toHaveCount(1); await current(page).locator('.md-checkbox').check(); await expect.poll(() => content(page)).toContain('- [x] 完成任务');
    await current(page).locator('.md-block.md-math').hover(); const math = current(page).getByLabel('LaTeX 公式'); await math.fill('a^2+b^2=c^2'); await current(page).locator('.cm-line').last().click(); await expect.poll(() => content(page)).toContain('a^2+b^2=c^2');
    await execute(page, 'dark'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await execute(page, 'light'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await execute(page, 'toggle-source'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 0 } }); e.focus(); }); await page.keyboard.insertText('开头'); expect(await content(page)).toMatch(/^开头/);
  } finally { await application.close(); }
});

test('UTF-8 文件打开保存、原换行保留、自动保存和外部修改保护', async () => {
  const { application, page, directory } = await launch(); const file = path.join(directory, '中文文件.md'); const original = '\ufeff# 标题\r\n\r\n**原样**  \r\n'; await fs.writeFile(file, original);
  try {
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file); await execute(page, 'open'); await expect(current(page).locator('.md-h1')).toContainText('标题'); await execute(page, 'save'); expect(await fs.readFile(file, 'utf8')).toBe(original);
    await setContent(page, '# 标题\n\n自动保存内容\n'); await expect.poll(() => fs.readFile(file, 'utf8')).toContain('自动保存内容'); expect(await fs.readFile(file, 'utf8')).toBe('\ufeff# 标题\r\n\r\n自动保存内容\r\n');
    await fs.writeFile(file, '外部程序改动'); await setContent(page, '# 当前编辑仍要保留'); await expect(page.locator('#save-status')).toContainText('其他程序修改'); expect(await fs.readFile(file, 'utf8')).toBe('外部程序改动');
    const saved = path.join(directory, '另存为.md'); await chooseSave(application, saved); await execute(page, 'save-as'); await expect.poll(() => fs.readFile(saved, 'utf8').catch(() => '')).toContain('当前编辑仍要保留');
  } finally { await application.close(); }
});

test('多标签撤销保留、窗口分离、新窗口和正常退出恢复', async () => {
  let currentApp = await launch(); const profile = currentApp.profile;
  try {
    await setContent(currentApp.page, '# 第一个文档\n'); await currentApp.page.locator('.cm-content').click(); await currentApp.page.keyboard.press('Control+End'); await currentApp.page.keyboard.insertText('可撤销内容');
    await execute(currentApp.page, 'new'); await setContent(currentApp.page, '# 第二个文档\n'); await currentApp.page.locator('.tab').first().click(); await currentApp.page.keyboard.press('Control+z'); await expect.poll(() => content(currentApp.page)).not.toContain('可撤销内容');
    const newWindow = currentApp.application.waitForEvent('window'); await execute(currentApp.page, 'detach'); const second = await newWindow; await second.locator('.markdown-editor').waitFor(); await expect(current(second).locator('.md-h1')).toContainText('第一个文档');
    const nextWindow = currentApp.application.waitForEvent('window'); await execute(second, 'new-window'); await nextWindow; expect(currentApp.application.windows()).toHaveLength(3);
    await currentApp.application.close(); currentApp = await launch(profile); await expect.poll(async () => Promise.all(currentApp.application.windows().map(page => content(page)))).toContain('# 第二个文档\n');
  } finally { await currentApp.application.close(); }
});

test('关闭草稿和强制结束后的恢复', async () => {
  let currentApp = await launch();
  try {
    await setContent(currentApp.page, '# 要恢复的草稿\n\n必须留下的内容'); await expect(currentApp.page.locator('#save-status')).toContainText('草稿已保存'); await execute(currentApp.page, 'close-tab'); await execute(currentApp.page, 'drafts'); await currentApp.page.locator('#sidebar-content').getByRole('button', { name: '未命名 1', exact: true }).click(); await expect.poll(() => content(currentApp.page)).toContain('必须留下');
    await setContent(currentApp.page, '# 强制退出前\n\n已经保存的草稿'); await expect(currentApp.page.locator('#save-status')).toContainText('草稿已保存'); const process = currentApp.application.process(); const exited = new Promise<void>(resolve => process.once('exit', () => resolve()));
    if (globalThis.process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(process.pid), '/T', '/F']); else process.kill('SIGKILL'); await exited;
    currentApp = await launch(currentApp.profile); await expect.poll(() => content(currentApp.page)).toContain('已经保存的草稿');
  } finally { if (currentApp.application.process().exitCode === null) await currentApp.application.close(); }
});

test('文件树、相对图片、HTML 和 PDF 导出', async () => {
  const { application, page, directory } = await launch(); const folder = path.join(directory, '笔记'); await fs.mkdir(folder); const file = path.join(folder, '示例.md'); await fs.writeFile(file, '# 导出测试\n\n![本地图片](image.png)\n\n正文 **加粗**。\n'); await fs.copyFile(path.join(root, 'assets/rypota.png'), path.join(folder, 'image.png'));
  try {
    await application.evaluate(({ app }) => { (globalThis as any).__imagePrintWindows = 0; app.on('browser-window-created', () => { (globalThis as any).__imagePrintWindows++; }); });
    await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder); await execute(page, 'folder'); await page.locator('#sidebar-content').getByRole('button', { name: '示例.md' }).click(); await expect(current(page).locator('.md-h1')).toContainText('导出测试');
    const image = current(page).locator('.md-image img'); await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const html = path.join(directory, '导出.html'); await chooseSave(application, html); await execute(page, 'export-html'); await expect.poll(() => fs.readFile(html, 'utf8').catch(() => '')).toContain('<strong>加粗</strong>'); expect(await fs.readFile(html, 'utf8')).toContain('data:image/png;base64,');
    const pdf = path.join(directory, '导出.pdf'); await chooseSave(application, pdf); await execute(page, 'export-pdf'); await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 }); await page.locator('#print-save').click(); await expect.poll(() => fs.readFile(pdf).then(bytes => bytes.subarray(0, 4).toString()).catch(() => '')).toBe('%PDF');
    const created = await application.evaluate(() => (globalThis as any).__imagePrintWindows), previous = await fs.readFile(pdf);
    await fs.copyFile(path.join(root, 'assets/replica.png'), path.join(folder, 'image.png')); await execute(page, 'export-pdf'); await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 });
    expect(await application.evaluate(() => (globalThis as any).__imagePrintWindows)).toBe(created + 1);
    await page.locator('#print-save').click(); await expect(page.locator('#print-preview')).not.toBeVisible(); expect(previous.equals(await fs.readFile(pdf))).toBe(false);
  } finally { await application.close(); }
});

test('输入转换、列表延续、格式快捷键、查找和菜单剪贴板', async () => {
  const { application, page } = await launch();
  try {
    const body = current(page).locator('.markdown-editor > .cm-scroller > .cm-content');
    await body.click(); await page.keyboard.type('```'); await page.keyboard.press('Enter'); await expect(current(page).locator('.code-content')).toHaveCount(1); await page.keyboard.insertText('连续输入的代码'); await expect.poll(() => content(page)).toContain('连续输入的代码');
    await setContent(page, '- 第一项'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: e.content.length } }); e.focus(); }); await page.keyboard.press('Enter'); await page.keyboard.insertText('第二项'); expect(await content(page)).toContain('- 第一项\n- 第二项');
    await setContent(page, '需要加粗的正文'); await body.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+b'); expect(await content(page)).toBe('**需要加粗的正文**');
    await execute(page, 'copy'); await execute(page, 'new'); await execute(page, 'paste'); await expect.poll(() => content(page)).toBe('需要加粗的正文');
    await page.keyboard.press('Control+f'); await expect(page.getByPlaceholder('查找')).toBeVisible(); await page.getByPlaceholder('查找').fill('加粗'); await page.getByPlaceholder('查找').press('Enter'); await expect(current(page).locator('.cm-searchMatch')).toHaveCount(1); await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+n'); await expect.poll(() => application.windows().length).toBe(2);
  } finally { await application.close(); }
});

test('大纲与目录隐藏标题高亮标记，正文高亮随主题更新', async () => {
  const { application, page } = await launch();
  const raw = '[toc]\n\n## ==重点== 与 `a == b == c`\n\n## <mark>例题</mark>\n\n正文 ==结论==。\n';
  try {
    await setContent(page, raw);
    await page.evaluate(() => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: editor.content.length } }); });
    await execute(page, 'outline');
    const titles = ['重点 与 a == b == c', '例题'];
    await expect(page.locator('#sidebar-content .sidebar-row')).toHaveText(titles);
    await expect(current(page).locator('.md-toc button')).toHaveText(titles);
    await page.locator('#sidebar-content .sidebar-row').last().click();
    expect(await page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head)).toBe(raw.indexOf('## <mark>'));
    const highlights = current(page).locator('.md-heading .md-highlight');
    await expect(highlights).toHaveText(['重点', '例题']);
    await execute(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await highlights.first().evaluate(el => getComputedStyle(el).backgroundColor);
    await execute(page, 'light');
    await expect(highlights.first()).not.toHaveCSS('background-color', dark);
    expect(await content(page)).toBe(raw);
  } finally { await application.close(); }
});

test('目录随标题更新、脚注、YAML 元数据和 Mermaid 预览', async () => {
  const { application, page } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const raw = '---\ntitle: 笔记标题\n---\n\n[toc]\n\n# 第一章\n\n正文[^note] :smile:。\n\n[^note]: 这是脚注内容。\n\n```mermaid\ngraph LR\n  A[开始] --> B[结束]\n```\n'; await setContent(page, raw);
    await expect(current(page).locator('.md-frontmatter')).toHaveCount(3); await expect(current(page).locator('.md-toc button')).toHaveText('第一章'); await expect(current(page).locator('.md-footnote')).toHaveAttribute('title', '这是脚注内容。'); await expect(current(page).locator('.md-emoji')).toHaveText('😄');
    await expect(current(page).locator('.diagram-preview svg')).toHaveCount(1, { timeout: 20000 }); await expect(current(page).locator('.diagram-preview')).toContainText('开始');
    await setContent(page, raw.replace('# 第一章', '# 更新后的章节')); await expect(current(page).locator('.md-toc button')).toHaveText('更新后的章节');
    await execute(page, 'toggle-source'); await execute(page, 'toggle-source'); expect(await content(page)).toBe(raw.replace('# 第一章', '# 更新后的章节')); expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('外部文件实时更新和文档目录内的相对图片路径', async () => {
  const { application, page, directory } = await launch(); const child = path.join(directory, '子目录'); await fs.mkdir(child); await fs.copyFile(path.join(root, 'assets/replica.png'), path.join(child, '图片.png')); const file = path.join(directory, '笔记.md'); await fs.writeFile(file, '# 初始内容\n\n![图片](子目录/图片.png)\n');
  try {
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file); await execute(page, 'open'); await expect(current(page).locator('.md-h1')).toHaveText('初始内容');
    await expect.poll(() => current(page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await fs.writeFile(file, '# 从外部更新\n\n![图片](子目录/图片.png)\n'); await expect(current(page).locator('.md-h1')).toHaveText('从外部更新'); expect(await content(page)).toContain('从外部更新');
  } finally { await application.close(); }
});

test('编辑嵌套引用代码保留外层 Markdown 结构', async () => {
  const { application, page } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const raw = '> ```ts\n> const count = 1;\n> ```\n\n> | A | B |\n> | --- | --- |\n> | one | two |\n'; await setContent(page, raw);
    await expect(current(page).locator('.md-nested-code')).toHaveCount(3);
    await page.evaluate(() => { const e = (window as any).__editor.active(); const anchor = e.content.indexOf('1;') + 1; e.view.dispatch({ selection: { anchor } }); e.focus(); }); await page.keyboard.insertText('0'); expect(await content(page)).toBe(raw.replace('1;', '10;')); expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('Copilot 主题统一从偏好设置选择，重启后仍保留', async () => {
  let currentApp = await launch();
  try {
    const raw = '## 标题\n\n> **引用块**\n\n```\n应用层 HTTP\n传输层 TCP\n```\n'; await setContent(currentApp.page, raw);
    await execute(currentApp.page, 'preferences'); await currentApp.page.locator('#theme-select').selectOption('copilot'); await currentApp.page.locator('#settings-close').click();
    await expect(currentApp.page.locator('html')).toHaveAttribute('data-theme', 'copilot');
    await expect(current(currentApp.page).locator('.md-quote')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await execute(currentApp.page, 'preferences'); await expect(currentApp.page.locator('#theme-select')).toHaveValue('copilot'); await currentApp.page.locator('#settings-close').click();
    expect(await content(currentApp.page)).toBe(raw);
    await currentApp.application.close(); currentApp = await launch(currentApp.profile); await expect(currentApp.page.locator('html')).toHaveAttribute('data-theme', 'copilot'); expect(await content(currentApp.page)).toBe(raw);
    await execute(currentApp.page, 'light'); await expect(currentApp.page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally { await currentApp.application.close(); }
});

test('拖动时整张标签跟随鼠标并保留抓取位置，使用柔和占位且不出现整栏蓝线', async () => {
  const { application, page } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1100, height: 720 }); window.showInactive(); });
    await setContent(page, '第一份'); await execute(page, 'new'); await setContent(page, '第二份'); await execute(page, 'new'); await setContent(page, '第三份');
    await native.evaluate(window => window.focus()); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const ids = await page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id!));
    const first = page.locator(`.tab[data-id="${ids[0]}"]`); const original = (await first.boundingBox())!;
    const grab = { x: original.x + 35, y: original.y + 17 };
    await page.mouse.move(grab.x, grab.y); await page.mouse.down(); await page.mouse.move(grab.x + 70, grab.y + 3, { steps: 8 });
    await expect(first).toHaveClass(/dragging/); await expect(first).toHaveCSS('opacity', '0');
    const preview = page.locator('.tab-drag-preview'); await expect(preview).toHaveCSS('opacity', '1');
    await expect.poll(async () => Math.abs((await preview.boundingBox())!.x - original.x - 70)).toBeLessThan(1);
    const floating = (await preview.boundingBox())!;
    expect(Math.abs(floating.x - original.x - 70)).toBeLessThan(1); expect(Math.abs(floating.y - original.y - 3)).toBeLessThan(1); expect(Math.abs(floating.width - original.width)).toBeLessThan(1);
    await expect(preview.locator('.tab-file-icon')).toBeVisible(); await expect(preview.locator('.tab-label')).toContainText('未命名 1'); await expect(preview.locator('.tab-close')).toBeVisible();
    await expect(page.locator('.tab-placeholder')).toBeVisible(); await expect(page.locator('#tabbar')).toHaveCSS('box-shadow', 'none');
    await page.mouse.move(grab.x + 150, grab.y + 5, { steps: 8 }); await expect.poll(async () => Math.abs((await preview.boundingBox())!.x - floating.x - 80)).toBeLessThan(1); const moved = (await preview.boundingBox())!;
    expect(Math.abs(moved.x - floating.x - 80)).toBeLessThan(1); expect(Math.abs(moved.y - floating.y - 2)).toBeLessThan(1);
    const strip = (await page.locator('#tabs').boundingBox())!; await page.mouse.move(strip.x + strip.width - 40, strip.y + strip.height / 2, { steps: 15 }); await page.mouse.up();
    await expect.poll(() => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id))).toEqual([ids[1], ids[2], ids[0]]);
    await expect(page.locator('.tab-placeholder,.tab.dragging,.tab-drag-preview')).toHaveCount(0); expect(await content(page)).toBe('第三份'); await expect(page.locator('.tab.active')).toHaveAttribute('data-id', ids[2]);
  } finally { await page.mouse.up().catch(() => {}); await application.close(); }
});

test('标签拖动可用 Esc 或丢失指针捕获取消，恢复布局并可继续点击切换', async () => {
  const { application, page } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => window.showInactive());
    await setContent(page, '第一份'); await execute(page, 'new'); await setContent(page, '第二份'); await execute(page, 'new'); await setContent(page, '第三份');
    await native.evaluate(window => window.focus()); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const order = () => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id)); const ids = await order();
    for (const cancel of ['escape', 'capture']) {
      const first = page.locator('.tab').first(), box = (await first.boundingBox())!;
      await first.evaluate(tab => tab.addEventListener('pointerdown', event => { (tab as HTMLElement).dataset.testPointer = String((event as PointerEvent).pointerId); }, { once: true }));
      await page.mouse.move(box.x + 30, box.y + 16); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 18, { steps: 8 }); await expect(first).toHaveClass(/dragging/);
      if (cancel === 'escape') await page.keyboard.press('Escape'); else {
        await first.evaluate(tab => tab.releasePointerCapture(Number((tab as HTMLElement).dataset.testPointer)));
        // Chromium delivers pending capture changes with the next pointer event.
        await page.mouse.move(box.x + 201, box.y + 18);
      }
      await expect(page.locator('.tab-placeholder,.tab.dragging,.tab-drag-preview')).toHaveCount(0); await page.mouse.up();
      expect(await order()).toEqual(ids); expect(await content(page)).toBe('第三份'); await expect(first).not.toHaveCSS('position', 'fixed');
    }
    await page.locator('.tab').first().click(); expect(await content(page)).toBe('第一份');
  } finally { await page.mouse.up().catch(() => {}); await application.close(); }
});

test('鼠标左右拖动标签保持当前编辑和撤销，重启恢复排序', async () => {
  let app = await launch();
  try {
    const { page } = app;
    await setContent(page, '第一个文档'); await execute(page, 'new'); await setContent(page, '第二个文档'); await execute(page, 'new'); await setContent(page, '第三个文档');
    const ids = await page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id!));
    const native = await app.application.browserWindow(page); await native.evaluate(window => window.showInactive());
    await page.locator(`.tab[data-id="${ids[2]}"]`).dragTo(page.locator(`.tab[data-id="${ids[0]}"]`), { targetPosition: { x: 4, y: 18 } });
    await expect.poll(() => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id))).toEqual([ids[2], ids[0], ids[1]]);
    expect(await content(page)).toBe('第三个文档'); await expect(page.locator('.tab.active')).toHaveAttribute('data-id', ids[2]);
    const target = page.locator(`.tab[data-id="${ids[1]}"]`); const bounds = (await target.boundingBox())!;
    await page.locator(`.tab[data-id="${ids[0]}"]`).dragTo(target, { targetPosition: { x: bounds.width - 4, y: 18 } });
    await expect.poll(() => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id))).toEqual([ids[2], ids[1], ids[0]]);
    const held = (await page.locator('.tab.active').elementHandle())!; const transfer = await page.evaluateHandle(() => new DataTransfer());
    await held.dispatchEvent('dragstart', { dataTransfer: transfer });
    await app.application.evaluate(async (_electron, file) => { const state = (globalThis as any).__replicaTest; await state.store.save(state.store.view([...state.windows.keys()][0]).activeId, file); }, path.join(app.directory, '拖动期间保存.md'));
    await expect(page).toHaveTitle(/拖动期间保存\.md/); expect(await held.evaluate(element => element.isConnected)).toBe(true);
    await held.dispatchEvent('dragend', { dataTransfer: transfer }); await expect(page.locator('.tab.active')).toContainText('拖动期间保存.md');
    await page.evaluate(() => (window as any).__editor.active().focus()); await page.keyboard.press('Control+End'); await page.keyboard.insertText('继续编辑'); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('第三个文档');
    await app.application.close(); app = await launch(app.profile);
    expect(await app.page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id))).toEqual([ids[2], ids[1], ids[0]]); expect(await content(app.page)).toBe('第三个文档');
  } finally { await app.application.close(); }
});

test('任务栏重新启动和普通再次启动均创建新的独立空白窗口', async () => {
  const { application, page, profile } = await launch();
  try {
    await setContent(page, '原窗口中不能丢失的草稿');
    const command = await application.evaluate(() => (globalThis as any).__replicaTest.relaunchCommand()); expect(command).toContain('--new-window'); expect(command).toContain('"');
    const env: NodeJS.ProcessEnv = { ...process.env, TYPORA_REPLICA_USER_DATA: profile, TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    for (const flag of [['--new-window'], []]) {
      const count = application.windows().length;
      await promisify(execFile)(electronPath as unknown as string, ['.', ...flag], { cwd: root, env, windowsHide: true, timeout: 15000 });
      await expect.poll(() => application.windows().length).toBe(count + 1);
      const fresh = application.windows().at(-1)!; await fresh.locator('.markdown-editor').waitFor(); expect(await content(fresh)).toBe(''); expect(await content(page)).toBe('原窗口中不能丢失的草稿');
      await setContent(fresh, `窗口 ${count + 1}`); expect(await content(page)).toBe('原窗口中不能丢失的草稿');
    }
  } finally { await application.close(); }
});

test('现代深色语法颜色与图标复制，修改代码语言后立即重新着色', async () => {
  const { application, page } = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const code = '// 注释\nint main() {\n  if (true) return 42;\n  auto text = "hello";\n}'; await setContent(page, `代码测试\n\n\`\`\`cpp\n${code}\n\`\`\`\n`); await execute(page, 'copilot'); await execute(page, 'code-modern');
    const block = current(page).locator('.md-code'); await expect(block).toHaveCSS('background-color', 'rgb(31, 31, 31)');
    await expect(block.locator('.cm-line span').filter({ hasText: /^\/\/ 注释$/ })).toHaveCSS('color', 'rgb(106, 153, 85)');
    await expect(block.locator('.cm-line span').filter({ hasText: /^if$/ })).toHaveCSS('color', 'rgb(197, 134, 192)');
    await expect(block.locator('.cm-line span').filter({ hasText: /^42$/ })).toHaveCSS('color', 'rgb(181, 206, 168)');
    await expect(block.locator('.cm-line span').filter({ hasText: /^"hello"$/ })).toHaveCSS('color', 'rgb(206, 145, 120)');
    await application.evaluate(({ clipboard }) => { clipboard.writeText = async (value: string) => { (globalThis as any).__copied = value; }; });
    await block.hover(); const copy = block.getByRole('button', { name: '复制代码', exact: true }); await expect(copy.locator('svg')).toHaveCount(1); await expect(copy).toHaveText(''); await copy.click(); await expect(block.getByRole('button', { name: '已复制', exact: true })).toHaveCount(1);
    expect(await application.evaluate(() => (globalThis as any).__copied)).toBe(code); expect(await content(page)).toContain(code);
    await expect(block.getByRole('button', { name: '复制代码', exact: true })).toHaveCount(1, { timeout: 3000 });
    await block.getByRole('textbox', { name: '代码语言', exact: true }).fill('plaintext'); await block.getByRole('textbox', { name: '代码语言', exact: true }).press('Tab'); await expect(block.locator('.cm-line span')).toHaveCount(0);
    await block.getByRole('textbox', { name: '代码语言', exact: true }).fill('cpp'); await block.getByRole('textbox', { name: '代码语言', exact: true }).press('Tab'); await expect(block.locator('.cm-line span').filter({ hasText: /^42$/ })).toHaveCSS('color', 'rgb(181, 206, 168)'); expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('跟随 VS Code 设置实时更新颜色，重启后继续同步且保留代码', async () => {
  const directory = await testDirectory(); const themes = path.join(directory, 'extensions/theme-defaults/themes'); await fs.mkdir(themes, { recursive: true });
  await fs.writeFile(path.join(themes, 'dark_modern.json'), JSON.stringify({ colors: { 'editor.background': '#121314' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#123456' } }] }));
  const settings = path.join(directory, 'settings.json'); await fs.writeFile(settings, '{ // test user settings\n "workbench.colorTheme": "Default Dark Modern", }');
  const env = { TYPORA_REPLICA_VSCODE_ROOT: directory, TYPORA_REPLICA_VSCODE_SETTINGS: settings }; let app = await launch(undefined, env);
  try {
    await setContent(app.page, '同步测试\n\n```cpp\n// 注释\nint n = 42;\n```\n'); await execute(app.page, 'code-vscode');
    const block = current(app.page).locator('.md-code'); await expect(block).toHaveCSS('background-color', 'rgb(18, 19, 20)'); await expect(block.locator('.cm-line span').filter({ hasText: /^\/\/ 注释$/ })).toHaveCSS('color', 'rgb(18, 52, 86)');
    const code = block.locator('.cm-content'); await code.click(); await app.page.keyboard.press('Control+End'); await app.page.keyboard.insertText('\n// keep history');
    await fs.writeFile(settings, JSON.stringify({ 'workbench.colorTheme': 'Default Dark Modern', 'editor.tokenColorCustomizations': { comments: '#aabbcc' } }));
    await expect(block.locator('.cm-line span').filter({ hasText: /^\/\/ 注释$/ })).toHaveCSS('color', 'rgb(170, 187, 204)', { timeout: 7000 }); await expect(code).toBeFocused(); await app.page.keyboard.press('Control+z'); expect(await content(app.page)).not.toContain('keep history');
    const raw = await content(app.page); await app.application.close(); app = await launch(app.profile, env);
    expect(await content(app.page)).toBe(raw); await expect(current(app.page).locator('.md-code')).toHaveCSS('background-color', 'rgb(18, 19, 20)'); await execute(app.page, 'preferences'); await expect(app.page.locator('#code-theme-select')).toHaveValue('vscode');
  } finally { await app.application.close(); }
});

test('标签可放到右侧空白和新建按钮区域，移出标签栏取消且顺序可恢复', async () => {
  let app = await launch();
  try {
    const { page } = app; const native = await app.application.browserWindow(page); await native.evaluate(window => window.showInactive());
    await setContent(page, '第一份'); await execute(page, 'new'); await setContent(page, '第二份'); await execute(page, 'new'); await setContent(page, '正在编辑的第三份');
    const ids = await page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id!));
    const order = () => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id));
    const strip = page.locator('#tabs'); const box = (await strip.boundingBox())!;
    await page.locator(`.tab[data-id="${ids[0]}"]`).dragTo(strip, { targetPosition: { x: box.width - 80, y: box.height / 2 } });
    await expect.poll(order).toEqual([ids[1], ids[2], ids[0]]); expect(await content(page)).toBe('正在编辑的第三份');
    await page.locator(`.tab[data-id="${ids[1]}"]`).dragTo(page.locator('#add-tab'));
    await expect.poll(order).toEqual([ids[2], ids[0], ids[1]]); await expect(page.locator('.tab')).toHaveCount(3);
    await page.locator(`.tab[data-id="${ids[0]}"]`).dragTo(page.locator('#editor-stage'), { targetPosition: { x: 8, y: 20 } });
    expect(await order()).toEqual([ids[2], ids[0], ids[1]]); await expect(page.locator('.tab.dragging,.tab.drop-before,.tab.drop-after')).toHaveCount(0);
    const untrusted = await page.evaluateHandle(id => { const data = new DataTransfer(); data.setData('application/x-replica-tab', id); return data; }, ids[0]); await strip.dispatchEvent('drop', { dataTransfer: untrusted }); expect(await order()).toEqual([ids[2], ids[0], ids[1]]);
    await app.application.close(); app = await launch(app.profile);
    expect(await app.page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id))).toEqual([ids[2], ids[0], ids[1]]); expect(await content(app.page)).toBe('正在编辑的第三份');
  } finally { await app.application.close(); }
});

test('溢出标签栏拖到右边缘会持续滚动并可放到最后', async () => {
  const { application, page } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 720, height: 560 }); window.showInactive(); });
    for (let index = 0; index < 13; index++) await execute(page, 'new'); await expect(page.locator('.tab')).toHaveCount(14);
    const ids = await page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id!));
    await page.locator('#tabs').evaluate(strip => { strip.scrollLeft = 0; });
    const first = page.locator('.tab').first(); await first.hover(); const source = (await first.boundingBox())!; const target = (await page.locator('#tabs').boundingBox())!;
    await page.mouse.move(source.x + 35, source.y + 18); await page.mouse.down(); await page.mouse.move(source.x + 45, source.y + 18, { steps: 5 }); await page.mouse.move(target.x + target.width - 3, source.y + 18, { steps: 20 });
    await expect.poll(() => page.locator('#tabs').evaluate(strip => strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2), { timeout: 10000 }).toBe(true);
    await page.mouse.move(target.x + target.width - 5, source.y + 18); await page.mouse.move(target.x + target.width - 3, source.y + 18);
    await page.mouse.up(); await expect.poll(() => page.locator('.tab').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.id))).toEqual([...ids.slice(1), ids[0]]);
    await expect(page.locator('.tab.active')).toHaveAttribute('data-id', ids.at(-1)!);
  } finally { await page.mouse.up().catch(() => {}); await application.close(); }
});

test('Codicons 本地资源可渲染，窗口最大化切换还原图标，关闭悬停红底', async () => {
  const { application, page } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => window.showInactive());
    await expect.poll(() => page.locator('[data-control="close"] svg').evaluate(svg => (svg as SVGGraphicsElement).getBBox().width)).toBeGreaterThan(6);
    await expect(page.locator('[data-control="maximize"] svg')).toHaveAttribute('data-icon', 'chrome-maximize'); await page.locator('[data-control="maximize"]').dispatchEvent('click');
    await expect(page.locator('[data-control="maximize"]')).toHaveAttribute('aria-label', '还原'); await expect(page.locator('[data-control="maximize"] svg')).toHaveAttribute('data-icon', 'chrome-restore'); expect(await native.evaluate(window => window.isMaximized())).toBe(true);
    await page.locator('[data-control="maximize"]').dispatchEvent('click'); await expect(page.locator('[data-control="maximize"] svg')).toHaveAttribute('data-icon', 'chrome-maximize'); expect(await native.evaluate(window => window.isMaximized())).toBe(false);
    const close = page.locator('[data-control="close"]');
    await expect.poll(async () => { await close.hover(); return close.evaluate(button => { const style = getComputedStyle(button); return [style.backgroundColor, style.color]; }); }).toEqual(['rgb(232, 17, 35)', 'rgb(255, 255, 255)']);
    await execute(page, 'sidebar'); await expect(page.locator('#toggle-sidebar svg')).toHaveAttribute('data-icon', 'layout-sidebar-left'); await execute(page, 'sidebar'); await expect(page.locator('#toggle-sidebar svg')).toHaveAttribute('data-icon', 'layout-sidebar-left-off');
  } finally { await application.close(); }
});

test('插入表格后输入留在单元格，Tab 续行与菜单插入均可直接编辑', async () => {
  const { application, page } = await launch(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await setContent(page, '前文正文\n\n'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: e.content.length } }); e.focus(); });
    await page.keyboard.press('Control+t'); const table = current(page).locator('table').first(); await expect(table.locator('th').first()).toBeFocused();
    for (const text of ['列一', '列二', '数据一', '数据二', '新行一']) { await page.keyboard.insertText(text); if (text !== '新行一') await page.keyboard.press('Tab'); }
    await page.keyboard.press('Enter'); await expect(table.locator('tr')).toHaveCount(3);
    const raw = await content(page); expect(raw).toContain('| 列一 | 列二 |'); expect(raw).toContain('| 数据一 | 数据二 |'); expect(raw).toContain('| 新行一 |  |'); expect(raw).toMatch(/^前文正文\n\n\|/);
    await toolbarAction(page, '段落', '表格'); await expect(current(page).locator('table')).toHaveCount(2);
    await page.keyboard.insertText('新表头'); await expect.poll(() => content(page)).toContain('| 新表头 | 标题 |'); expect(errors).toEqual([]);
  } finally { await application.close(); }
});

test('Ctrl+B 取消已有加粗，选中后按等号切换高亮且能撤销', async () => {
  const { application, page } = await launch();
  const select = async (from: number, to: number) => page.evaluate(({ from, to }) => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: from, head: to } }); e.focus(); }, { from, to });
  try {
    for (const [raw, from, to, expected] of [['**加粗文字**', 0, 8, '加粗文字'], ['**加粗文字**', 2, 6, '加粗文字'], ['__加粗文字__', 0, 8, '加粗文字'], ['__加粗文字__', 2, 6, '加粗文字'], ['**前目标后**', 3, 5, '**前**目标**后**']] as const) {
      await setContent(page, raw); await select(from, to); await page.keyboard.press('Control+b'); expect(await content(page)).toBe(expected); await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
    }
    const raw = '前文待高亮后文'; await setContent(page, raw); await select(2, 5); await page.keyboard.press('='); expect(await content(page)).toBe('前文==待高亮==后文'); await expect(current(page).locator('.md-highlight')).toContainText('待高亮'); await page.keyboard.press('='); expect(await content(page)).toBe(raw); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('前文==待高亮==后文');
    await setContent(page, '| 名称 |\n| --- |\n| **加粗** |\n'); const cell = current(page).locator('td'); await cell.click();
    await page.evaluate(() => { const cell = document.querySelector('td[contenteditable=true]')!; const range = document.createRange(); range.setStart(cell.firstChild!, 2); range.setEnd(cell.firstChild!, 4); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range); });
    await page.keyboard.press('Control+b'); await expect.poll(() => content(page)).not.toContain('**加粗**'); await page.keyboard.press('Control+z'); expect(await content(page)).toContain('**加粗**'); await expect(cell).toBeFocused(); await page.keyboard.press('Control+Shift+z'); expect(await content(page)).not.toContain('**加粗**'); await page.keyboard.press('Control+a'); await page.keyboard.press('='); await page.keyboard.press('Enter'); await expect(cell.locator('mark')).toHaveText('加粗');
  } finally { await application.close(); }
});

test('中文输入法 Process 等号键可切换正文和表格高亮，拼音组合期间不拦截', async () => {
  const { application, page } = await launch();
  const pressIMEEqual = (options: { shiftKey?: boolean; composing?: boolean } = {}) => page.evaluate(options => {
    const target = document.activeElement!;
    const event = new KeyboardEvent('keydown', { key: 'Process', code: 'Equal', keyCode: 229, isComposing: true, bubbles: true, cancelable: true, shiftKey: options.shiftKey });
    if (options.composing) target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const allowed = target.dispatchEvent(event);
    if (options.composing) target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    return !allowed;
  }, options);
  try {
    await setContent(page, '前文待高亮后文');
    await page.evaluate(() => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: 2, head: 5 } }); editor.focus(); });
    expect(await pressIMEEqual({ composing: true })).toBe(false); expect(await content(page)).toBe('前文待高亮后文');
    expect(await pressIMEEqual({ shiftKey: true })).toBe(false); expect(await content(page)).toBe('前文待高亮后文');
    expect(await pressIMEEqual()).toBe(true); expect(await content(page)).toBe('前文==待高亮==后文');
    expect(await pressIMEEqual()).toBe(true); expect(await content(page)).toBe('前文待高亮后文');
    await setContent(page, '| 标题 |\n| --- |\n| 表内文字 |\n'); await current(page).locator('td').click(); await page.keyboard.press('Control+a');
    expect(await pressIMEEqual()).toBe(true); expect(await content(page)).toContain('| ==表内文字== |');
    expect(await pressIMEEqual()).toBe(true); expect(await content(page)).toContain('| 表内文字 |');
    await setContent(page, '正文'); await page.evaluate(() => { const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor: 2 } }); editor.focus(); });
    expect(await pressIMEEqual()).toBe(false); expect(await content(page)).toBe('正文');
    await setContent(page, '```cpp\nint value = 1;\n```'); await current(page).locator('.code-content .cm-content').click(); await page.keyboard.press('Control+a');
    expect(await pressIMEEqual()).toBe(false); expect(await content(page)).toBe('```cpp\nint value = 1;\n```');
  } finally { await application.close(); }
});

test('中文整理快捷键可局部操作和单步撤销，保存整理为可选并同步编辑区', async () => {
  const { application, page, directory } = await launch();
  try {
    const raw = '中文API与10GB。\n\n```cpp\n// 中文API\n```\n'; await setContent(page, raw);
    await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: 3 } }); e.focus(); });
    await page.keyboard.press('Alt+Shift+f'); expect(await content(page)).toBe('中文 API 与 10 GB。\n\n```cpp\n// 中文API\n```\n'); expect(await page.evaluate(() => (window as any).__editor.active().view.state.selection.main.head)).toBe(4);
    await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
    const partial = '前文API\n\n中间API\n\n后文API'; await setContent(page, partial);
    await page.evaluate(() => { const e = (window as any).__editor.active(); const from = e.content.indexOf('中间'); e.view.dispatch({ selection: { anchor: from, head: from + 5 } }); e.focus(); });
    await page.keyboard.press('Alt+Shift+f'); expect(await content(page)).toBe('前文API\n\n中间 API\n\n后文API');
    await execute(page, 'preferences'); await expect(page.locator('#format-save-toggle')).not.toBeChecked(); await page.locator('#format-save-toggle').check(); await page.locator('#autosave-toggle').uncheck(); await page.locator('#settings-close').click();
    await expect.poll(() => page.evaluate(async () => (await window.rypota.bootstrap()).preferences.autoSave)).toBe(false);
    const file = path.join(directory, '中文整理.md'); await chooseSave(application, file); await execute(page, 'save'); await expect.poll(() => fs.readFile(file, 'utf8').catch(() => '')).toBe('前文 API\n\n中间 API\n\n后文 API'); await expect.poll(() => content(page)).toBe('前文 API\n\n中间 API\n\n后文 API');
    await page.evaluate(() => (window as any).__editor.active().focus()); await page.keyboard.press('Control+z'); expect(await content(page)).toBe('前文API\n\n中间 API\n\n后文API');
    await page.evaluate(() => (window as any).rypota.updatePreferences({ autoSave: true })); await setContent(page, '自动保存API与20GB。'); await expect.poll(() => fs.readFile(file, 'utf8')).toBe('自动保存 API 与 20 GB。'); await expect.poll(() => content(page)).toBe('自动保存 API 与 20 GB。');
    await setContent(page, '| 标题 |\n| --- |\n| 中文API |\n'); const field = current(page).locator('td'); await field.click();
    await page.evaluate(() => { const cell = document.querySelector('td[contenteditable=true]')!; const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    await page.keyboard.insertText('与20GB'); await expect.poll(() => fs.readFile(file, 'utf8')).toContain('中文 API 与 20 GB'); await expect(field).toBeFocused(); await expect(field).toHaveText('中文 API 与 20 GB'); await page.keyboard.press('Enter'); expect(await content(page)).toContain('中文 API 与 20 GB');
  } finally { await application.close(); }
});

test('粘贴图片不会混入编码文本，草稿和保存后的附件均能恢复', async () => {
  let app = await launch(); const bytes = await fs.readFile(path.join(root, 'assets/replica.png'));
  try {
    await current(app.page).locator('.markdown-editor > .cm-scroller > .cm-content').click();
    await app.page.evaluate(({ bytes, encoded }) => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], '粘贴图片.png', { type: 'image/png' })); data.setData('text/plain', '不应插入的编码' + encoded); data.setData('text/html', `<img src="data:image/png;base64,${encoded}">`); document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, { bytes: [...bytes], encoded: bytes.toString('base64') });
    await expect(current(app.page).locator('.md-image img')).toHaveCount(1); await expect.poll(() => current(app.page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const source = await content(app.page); expect(source.length).toBeLessThan(300); expect(source).toContain('replica-media://draft/'); expect(source).not.toContain('base64'); expect(source).not.toContain('不应插入'); await expect(app.page.locator('#word-count')).toHaveText('0 字');
    const exported = path.join(app.directory, '未命名图片导出.html'); await chooseSave(app.application, exported); await execute(app.page, 'export-html'); await expect.poll(() => fs.readFile(exported, 'utf8').catch(() => '')).toContain(`src="data:image/png;base64,${bytes.toString('base64')}"`);
    await app.application.close(); app = await launch(app.profile); await expect.poll(() => current(app.page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const file = path.join(app.directory, '图片 笔记.md'); await chooseSave(app.application, file); await execute(app.page, 'save'); await expect.poll(() => fs.readFile(file, 'utf8').catch(() => '')).toContain('图片%20笔记.assets/');
    const saved = await fs.readFile(file, 'utf8'); expect(saved).not.toContain('replica-media:'); expect(saved).not.toContain('base64'); const relative = /!\[[^\]]*\]\(([^)]+)\)/.exec(saved)![1]; expect(await fs.readFile(path.resolve(path.dirname(file), decodeURIComponent(relative)))).toEqual(bytes);
    await expect.poll(() => current(app.page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0); await expect(app.page.locator('#word-count')).toHaveText('0 字');
  } finally { await app.application.close(); }
});

test('粘贴图片后立即退出也会等待附件写入并恢复', async () => {
  let app = await launch(); const bytes = [...await fs.readFile(path.join(root, 'assets/replica.png'))];
  try {
    await app.application.evaluate(() => { const images = (globalThis as any).__replicaTest.store.images; const put = images.put.bind(images); images.put = async (...args: any[]) => { await new Promise(resolve => setTimeout(resolve, 150)); return put(...args); }; });
    await current(app.page).locator('.markdown-editor > .cm-scroller > .cm-content').click();
    await app.page.evaluate(bytes => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' })); document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, bytes);
    await app.application.close(); app = await launch(app.profile); expect(await content(app.page)).toContain('replica-media://draft/'); await expect.poll(() => current(app.page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  } finally { await app.application.close(); }
});

test('旧版内嵌图片可整理为附件，编码不计字数且恢复后仍可显示', async () => {
  let app = await launch(); const encoded = (await fs.readFile(path.join(root, 'assets/replica.png'))).toString('base64');
  try {
    await setContent(app.page, `图片说明\n\n![旧图](data:image/png;base64,${encoded})\n`); await expect(app.page.locator('#word-count')).toHaveText('4 字'); await expect.poll(() => current(app.page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await execute(app.page, 'organize-images'); await expect.poll(() => content(app.page)).not.toContain('base64'); expect(await content(app.page)).toContain('replica-media://draft/');
    await setContent(app.page, `图片说明\n\n![旧图](data:image/png;base64,${encoded})\n`); await app.application.close(); app = await launch(app.profile); expect(await content(app.page)).not.toContain('base64'); await expect(app.page.locator('#word-count')).toHaveText('4 字'); await expect.poll(() => current(app.page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  } finally { await app.application.close(); }
});
