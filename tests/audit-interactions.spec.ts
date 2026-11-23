import { test as base, expect, _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type Desktop = { application: ElectronApplication; page: Page; directory: string };
const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({}, use) => {
    const root = await fs.realpath('.'), staging = path.join(root, '.test-data');
    await fs.mkdir(staging, { recursive: true });
    if (await fs.realpath(staging) !== staging) throw new Error('Unexpected test staging path');
    const directory = await fs.mkdtemp(path.join(staging, 'desktop-audit-'));
    const env: NodeJS.ProcessEnv = { ...process.env, MOYE_USER_DATA: path.join(directory, 'profile'), MOYE_TEST: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    let application: ElectronApplication | undefined;
    try {
      application = await electron.launch({ executablePath: process.env.MOYE_TEST_EXE ?? electronPath as unknown as string, args: process.env.MOYE_TEST_EXE ? [] : ['.'], cwd: root, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
      const page = await application.firstWindow(); await current(page).locator('.markdown-editor').waitFor();
      const native = await application.browserWindow(page); await native.evaluate(window => { window.show(); window.focus(); });
      await use({ application, page, directory });
    } finally {
      try { await application?.close(); } finally {
        if (await fs.realpath(directory) !== directory) throw new Error('Test staging path changed');
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  },
});
const current = (page: Page) => page.locator('.editor-slot:not([hidden])');
const content = (page: Page) => page.evaluate(() => (window as any).__editor.content());
const setContent = (page: Page, source: string) => page.evaluate(source => (window as any).__editor.setContent(source), source);
const execute = (page: Page, action: string) => page.evaluate(action => (window as any).__editor.execute(action), action);
const select = (page: Page, anchor: number, head = anchor) => page.evaluate(({ anchor, head }) => {
  const editor = (window as any).__editor.active(); editor.view.dispatch({ selection: { anchor, head } }); editor.focus();
}, { anchor, head });
async function selectCell(cell: Locator, anchor: number, head = anchor) {
  await cell.click();
  await cell.evaluate((cell, { anchor, head }) => {
    if (!cell.firstChild) cell.append(document.createTextNode(''));
    window.getSelection()!.setBaseAndExtent(cell.firstChild!, anchor, cell.firstChild!, head);
  }, { anchor, head });
}
const cellSelection = (cell: Locator) => cell.evaluate(() => {
  const selection = window.getSelection()!;
  return { anchor: selection.anchorOffset, head: selection.focusOffset, text: selection.toString() };
});
async function saveTo(application: ElectronApplication, file: string) {
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
}
async function screenshot(application: ElectronApplication, page: Page, file: string) {
  const window = await application.browserWindow(page); await window.evaluate(window => { window.show(); window.focus(); });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await window.evaluate(async window => (await window.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64'));
  await fs.writeFile(file, Buffer.from(png, 'base64'));
}

test('审查回归 01 保存和退出 PDF 预览保留表格及代码块的实际输入位置', async ({ desktop }) => {
  test.setTimeout(120000);
  const { application, page, directory } = desktop;
  await saveTo(application, path.join(directory, '焦点.md'));
  for (const kind of ['table', 'code']) {
    const raw = kind === 'table' ? '开头\n\n| 名称 |\n| --- |\n| ABCDE |\n\n后文' : '开头\n\n```txt\nABCDE\n```\n\n后文';
    for (const action of ['save', 'preview-escape', 'preview-close']) await test.step(`${kind}: ${action}`, async () => {
      await setContent(page, raw); await select(page, 1);
      const field = kind === 'table' ? current(page).locator('td').first() : current(page).locator('.code-content .cm-content');
      if (kind === 'table') await selectCell(field, 5); else { await field.focus(); await page.keyboard.press('Control+End'); }
      if (action === 'save') { await page.keyboard.press('Control+s'); await expect.poll(() => fs.readFile(path.join(directory, '焦点.md'), 'utf8').catch(() => '')).toBe(raw); }
      else {
        await page.getByRole('button', { name: '文件', exact: true }).click();
        await page.getByRole('menuitem', { name: '导出 PDF', exact: true }).click();
        const preview = page.getByRole('dialog', { name: '打印预览' }); await expect(preview).toBeVisible();
        if (action === 'preview-escape') await page.keyboard.press('Escape'); else await preview.getByRole('button', { name: '关闭打印预览' }).click();
        await expect(preview).toBeHidden();
      }
      await expect(field).toBeFocused();
      if (kind === 'table') await expect.poll(() => cellSelection(field)).toEqual({ anchor: 5, head: 5, text: '' });
      await page.keyboard.insertText('X'); expect(await content(page)).toBe(raw.replace('ABCDE', 'ABCDEX'));
      await execute(page, 'save'); expect(await fs.readFile(path.join(directory, '焦点.md'), 'utf8')).toBe(raw.replace('ABCDE', 'ABCDEX'));
    });
  }
  await test.step('另存为等待期间不抢回用户新选择的焦点', async () => {
    await setContent(page, '开头\n\n| 名称 |\n| --- |\n| ABCDE |'); await selectCell(current(page).locator('td').first(), 5);
    await application.evaluate(({ dialog }) => { dialog.showSaveDialog = () => new Promise(resolve => { (globalThis as any).__resolveAuditSave = resolve; }); });
    await page.evaluate(() => { void (window as any).__editor.execute('save-as'); });
    await expect.poll(() => application.evaluate(() => !!(globalThis as any).__resolveAuditSave)).toBe(true);
    await current(page).locator('.cm-line').filter({ hasText: /^开头$/ }).click();
    const file = path.join(directory, '另存为.md');
    await application.evaluate(({}, file) => (globalThis as any).__resolveAuditSave({ canceled: false, filePath: file }), file);
    await expect.poll(() => fs.readFile(file, 'utf8').catch(() => '')).toContain('ABCDE');
    await expect(current(page).locator('.markdown-editor > .cm-scroller > .cm-content')).toBeFocused();
  });
});

test('审查回归 02 清除实际样式保留普通运算符及撤销选区', async ({ desktop: { page } }) => {
  const expression = '2 * 3 == 6'; await setContent(page, expression); await select(page, 0, expression.length);
  await execute(page, 'clear-format'); expect(await content(page)).toBe(expression);
  const raw = '2 * 3 == 6，**加粗**与 *斜体*。'; await setContent(page, raw); await select(page, 0, raw.length);
  await execute(page, 'clear-format'); expect(await content(page)).toBe('2 * 3 == 6，加粗与 斜体。');
  await page.keyboard.press('Control+z'); expect(await content(page)).toBe(raw);
});

test('审查回归 03 表格逐键输入词间空格并在离格保存后保留', async ({ desktop: { application, page, directory } }) => {
  for (const [first, next] of [['甲', 'B'], ['hello', 'world']]) {
    await setContent(page, `| 名称 |\n| --- |\n| ${first} |`);
    const cell = current(page).locator('td').first(); await selectCell(cell, first.length);
    await page.keyboard.press('Space'); expect(await cell.textContent()).toBe(first + ' ');
    await page.keyboard.type(next); await expect(cell).toHaveText(first + ' ' + next);
    await page.keyboard.press('Tab');
    const file = path.join(directory, `空格-${first}.md`); await saveTo(application, file); await execute(page, 'save-as');
    expect(await fs.readFile(file, 'utf8')).toContain(`| ${first} ${next} |`);
  }
  for (const label of ['左对齐', '居中对齐', '右对齐']) {
    await setContent(page, '| 名称 |\n| --- |\n| 甲 |');
    const cell = current(page).locator('td').first(); await selectCell(cell, 1);
    await page.keyboard.press('Space');
    await current(page).getByRole('button', { name: label, exact: true }).click();
    expect(await cell.textContent()).toBe('甲 ');
    const aligned = await content(page);
    await page.keyboard.press('Control+z'); expect(await cell.textContent()).toBe('甲 '); expect(await content(page)).not.toBe(aligned);
    await page.keyboard.press('Control+Shift+z'); expect(await content(page)).toBe(aligned); expect(await cell.textContent()).toBe('甲 ');
    await page.keyboard.type('B'); await expect(cell).toHaveText('甲 B');
  }
});

test('审查回归 04 表格 Enter 和 ShiftEnter 后的正文与已有后文独立', async ({ desktop: { page } }) => {
  const table = '| 名称 |\n| --- |\n| 甲 |';
  for (const suffix of ['', '\n\n后文', '\n\n\n后文']) for (const key of ['Enter', 'Shift+Enter']) {
    await setContent(page, table + suffix); await selectCell(current(page).locator('td').first(), 1);
    await page.keyboard.press(key); await page.keyboard.insertText('X');
    expect(await content(page)).toBe(table + '\n\nX' + (suffix ? '\n\n后文' : ''));
    await expect(current(page).locator('table tr')).toHaveCount(2);
    await expect(current(page).locator('.cm-line').filter({ hasText: /^X$/ })).toHaveCount(1);
    if (suffix) await expect(current(page).locator('.cm-line').filter({ hasText: /^后文$/ })).toHaveCount(1);
  }
});

test('审查回归 05 列表软换行再回车保留已有下一项的列表身份', async ({ desktop: { page } }) => {
  for (const raw of ['1. 甲乙\n2. 下项', '- 甲乙\n- 下项', '1. 父级\n   - 甲乙\n   - 下项']) {
    await setContent(page, raw); await select(page, raw.indexOf('甲乙') + 2);
    await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('续'); await page.keyboard.press('Enter'); await page.keyboard.insertText('新');
    await expect(current(page).locator('.md-list').filter({ hasText: '下项' })).toHaveCount(1);
    await expect(current(page).locator('.md-list').filter({ hasText: '新' })).toHaveCount(1);
    expect(await content(page)).toContain('下项');
    await page.keyboard.press('Control+z'); expect(await content(page)).not.toContain('新');
  }
  const code = '1. 父项\n\n   ```js\n   const a = 1;\n   ```\n2. 下一项';
  await setContent(page, code); await select(page, code.indexOf('1;') + 2); await page.keyboard.press('Enter');
  await expect(current(page).locator('.md-list-number')).toHaveText(['1.', '2.']);
  expect(await content(page)).not.toContain('const a = 1;\n2. ');
});

test('审查回归 06 粗体与斜体可以按两个顺序叠加和单独取消', async ({ desktop: { page } }) => {
  for (const [first, second] of [['Control+b', 'Control+i'], ['Control+i', 'Control+b']]) {
    await setContent(page, '甲乙'); await select(page, 0, 2); await page.keyboard.press(first); await page.keyboard.press(second);
    await expect(current(page).locator('.md-strong')).toHaveCount(1); await expect(current(page).locator('.md-em')).toHaveCount(1);
    await page.keyboard.press(second); await page.keyboard.press(first); expect(await content(page)).toBe('甲乙');
  }
});

test('审查回归 08 边界空格保持原位，跨段加粗不写入无效星号', async ({ desktop: { page } }) => {
  for (const [raw, anchor, head, expected] of [['甲乙 丙丁', 0, 3, '**甲乙** 丙丁'], ['甲乙 丙丁', 2, 5, '甲乙 **丙丁**'], ['甲乙\n\n丙丁', 0, 6, '甲乙\n\n丙丁']] as const) {
    await setContent(page, raw); await select(page, anchor, head); await page.keyboard.press('Control+b'); expect(await content(page)).toBe(expected);
    if (raw !== expected) { await expect(current(page).locator('.md-strong')).toHaveCount(1); await page.keyboard.press('Control+b'); expect(await content(page)).toBe(raw); }
    else expect(await page.evaluate(() => { const selection = (window as any).__editor.active().view.state.selection.main; return [selection.anchor, selection.head]; })).toEqual([anchor, head]);
  }
});

test('审查回归 09 反向格式选区保留活动端和长文视口', async ({ desktop: { page } }) => {
  await setContent(page, '前文粗体后文'); await select(page, 4, 2); await page.keyboard.press('Control+b');
  const selection = () => page.evaluate(() => { const range = (window as any).__editor.active().view.state.selection.main; return { anchor: range.anchor, head: range.head }; });
  expect(await selection()).toEqual({ anchor: 6, head: 4 });
  await page.keyboard.press('Shift+ArrowLeft'); expect(await selection()).toEqual({ anchor: 6, head: 3 });
  const raw = Array.from({ length: 65 }, (_, index) => `第 ${index} 行正文`).join('\n');
  await setContent(page, raw); await select(page, raw.length); await page.keyboard.press('Control+Shift+Home'); await page.keyboard.press('Control+b');
  expect((await selection()).anchor).toBeGreaterThan((await selection()).head);
  await expect.poll(() => page.evaluate(() => (window as any).__editor.active().view.scrollDOM.scrollTop)).toBeLessThan(40);
});

test('审查回归 10 表格撤销替换同时恢复正反选区与活动格', async ({ desktop: { page } }) => {
  for (const [anchor, head] of [[1, 4], [4, 1], [0, 5]]) {
    await setContent(page, '| 名称 |\n| --- |\n| ABCDE |'); const cell = current(page).locator('td').first();
    await selectCell(cell, anchor, head); await page.keyboard.insertText('x'); await page.keyboard.press('Control+z');
    await expect(cell).toBeFocused(); await expect(cell).toHaveText('ABCDE');
    expect(await cellSelection(cell)).toEqual({ anchor, head, text: anchor === 0 ? 'ABCDE' : 'BCD' });
    await page.keyboard.press('Control+Shift+z'); await expect(cell).toHaveText(anchor === 0 ? 'x' : 'AxE');
    await page.keyboard.press('Control+z'); expect(await cellSelection(cell)).toEqual({ anchor, head, text: anchor === 0 ? 'ABCDE' : 'BCD' });
    await page.keyboard.insertText('Q'); expect(await content(page)).toContain(anchor === 0 ? '| Q |' : '| AQE |');
  }
  await setContent(page, '| 名称 |\n| --- |\n| ABCDE |'); const cell = current(page).locator('td').first();
  await selectCell(cell, 1, 4); await page.keyboard.type('xyz'); await page.keyboard.press('Control+z');
  await expect(cell).toHaveText('ABCDE'); expect(await cellSelection(cell)).toEqual({ anchor: 1, head: 4, text: 'BCD' });
  await page.keyboard.press('Control+Shift+z'); await expect(cell).toHaveText('AxyzE'); expect(await cellSelection(cell)).toEqual({ anchor: 4, head: 4, text: '' });
});

test('审查回归 11 表格选区往返源码模式保留方向与下一次扩选', async ({ desktop: { page } }) => {
  await setContent(page, '| 名称 |\n| --- |\n| ABCDE |'); const cell = current(page).locator('td').first();
  await selectCell(cell, 5, 3); await execute(page, 'toggle-source'); await execute(page, 'toggle-source');
  await expect(cell).toBeFocused(); await expect.poll(() => cellSelection(cell)).toEqual({ anchor: 5, head: 3, text: 'DE' });
  await page.keyboard.press('Shift+ArrowLeft'); expect(await cellSelection(cell)).toEqual({ anchor: 5, head: 2, text: 'CDE' });
});

test('审查回归 12 HTML 导出保留列表内标题和两种任务状态', async ({ desktop: { application, page, directory } }, testInfo) => {
  await setContent(page, '4. ### 编号标题\n5. 普通项\n\n- [x] 已完成\n- [ ] 待处理');
  const file = path.join(directory, '列表.html'); await saveTo(application, file); await execute(page, 'export-html');
  await expect.poll(() => fs.readFile(file, 'utf8').catch(() => '')).toContain('<h3>');
  const opened = application.waitForEvent('window');
  await application.evaluate(async ({ BrowserWindow }, file) => { const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } }); await window.loadFile(file); }, file);
  const exported = await opened; await exported.waitForLoadState();
  const values = await exported.evaluate(() => {
    return { heading: document.querySelector('ol li h3')?.textContent, start: document.querySelector('ol')?.getAttribute('start'), tasks: [...document.querySelectorAll<HTMLInputElement>('li input[type=checkbox]')].map(input => ({ checked: input.checked, disabled: input.disabled, label: input.getAttribute('aria-label') })) };
  });
  expect(values).toEqual({ heading: '编号标题', start: '4', tasks: [{ checked: true, disabled: true, label: '已完成' }, { checked: false, disabled: true, label: '未完成' }] });
  await screenshot(application, exported, testInfo.outputPath('html-lists.png'));
  const window = await application.browserWindow(exported); await window.evaluate(window => window.close());
});

test('审查回归 13 筛选大纲保留真实祖先，折叠不影响其他章节', async ({ desktop: { application, page } }, testInfo) => {
  await setContent(page, '# 项目甲\n\n## 项目入门\n\n# 附录乙\n\n## 项目索引');
  if (!await page.locator('#sidebar').isVisible()) await execute(page, 'sidebar');
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  const first = page.getByRole('treeitem', { name: '项目甲', exact: true });
  await first.getByRole('button', { name: '收起 项目甲', exact: true }).click();
  await page.locator('#sidebar-filter').fill('项目');
  const index = page.getByRole('treeitem', { name: '项目索引', exact: true });
  expect(await index.evaluate(node => node.parentElement!.closest('[role=treeitem]')?.getAttribute('aria-label'))).toBe('附录乙');
  await screenshot(application, page, testInfo.outputPath('outline-filter.png'));
  await first.getByRole('button', { name: '收起 项目甲', exact: true }).click(); await expect(index).toBeVisible();
  await page.locator('#sidebar-filter').fill(''); await expect(first).toHaveAttribute('aria-expanded', 'false'); await expect(index).toBeVisible();
});
