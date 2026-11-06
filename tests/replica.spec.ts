import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.cwd();
async function launch(profile?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const directory = path.join(root, '.test-data', randomUUID()); await fs.mkdir(directory, { recursive: true }); profile ??= path.join(directory, 'profile');
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, TYPORA_REPLICA_USER_DATA: profile, TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.TYPORA_REPLICA_TEST_EXE ?? electronPath as unknown as string;
  const application = await electron.launch({ executablePath, args: process.env.TYPORA_REPLICA_TEST_EXE ? [] : ['.'], cwd: root, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
  const page = await application.firstWindow(); await page.locator('.editor-slot:not([hidden]) .markdown-editor').waitFor();
  return { application, page, directory, profile };
}
const current = (page: Page) => page.locator('.editor-slot:not([hidden])');
async function setContent(page: Page, content: string) { await page.evaluate(content => (window as any).__editor.setContent(content), content); }
async function content(page: Page) { return page.evaluate(() => (window as any).__editor.content()); }
async function execute(page: Page, command: string) { await page.evaluate(command => (window as any).__editor.execute(command), command); }
async function chooseSave(application: ElectronApplication, file: string) { await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file); }

test('WorkBuddy 排版、嵌入字体、行号槽与 Shiki github-dark 代表色实际生效', async () => {
  const { application, page, directory } = await launch();
  try {
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1100, height: 900 }); window.showInactive(); });
    const raw = '# 图论\n\n## 搜索与拓扑\n\n### BFS\n\n正文采用参考字体。\n\n```cpp\n// 注释\nint value = 5;\nvoid bfs(int sx) { return; }\n```\n\n| 题面信号 | 去哪 |\n| --- | --- |\n| 最长链 | 直径 |\n\n结尾';
    await setContent(page, raw); await expect(page.locator('html')).toHaveAttribute('data-theme', 'workbuddy');
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

test('Shiki 异步着色不打断代码组合输入、选区与撤销，换语言和主题后不残留旧颜色', async () => {
  const { application, page } = await launch();
  try {
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
    await app.page.mouse.move(box.x + box.width / 2, box.y + 90); await app.page.mouse.down(); await app.page.mouse.move(box.x + box.width / 2 + 54, box.y + 90, { steps: 8 }); await app.page.mouse.up();
    await expect(separator).toHaveAttribute('aria-valuenow', '310'); await separator.focus(); await app.page.keyboard.press('ArrowRight'); await expect(separator).toHaveAttribute('aria-valuenow', '320');
    await app.page.getByRole('button', { name: '阅读宽度', exact: true }).click(); await app.page.getByRole('button', { name: '阅读宽度', exact: true }).click();
    await expect(app.page.locator('#reading-width')).toContainText('紧凑'); await execute(app.page, 'preferences'); await expect(app.page.locator('#reading-width-select')).toHaveValue('720'); await app.page.locator('#preferences button[value="cancel"]').click();
    expect(await content(app.page)).toBe(raw); const profile = app.profile; await app.application.close(); app = await launch(profile);
    await expect(app.page.getByRole('separator', { name: '调整侧栏宽度' })).toHaveAttribute('aria-valuenow', '320'); await expect(app.page.locator('#reading-width')).toContainText('紧凑'); expect(await content(app.page)).toBe(raw);
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
    await expect(page.locator('#quick-open')).not.toBeVisible(); await expect(page.locator('#caption')).toContainText('02-系统.md');
    await page.keyboard.press('Control+p'); await page.locator('#quick-input').fill('01-算法'); await expect(page.locator('#quick-results button')).toHaveCount(1);
    await page.locator('#quick-input').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))); await expect(page.locator('#quick-open')).toBeVisible();
    await page.keyboard.press('Enter'); await expect(page.locator('#caption')).toContainText('01-算法.md');
    await page.keyboard.press('Control+p'); await page.locator('#quick-input').fill('不会存在的标题'); await expect(page.locator('.quick-empty')).toContainText('没有找到'); await page.keyboard.press('Escape'); await expect(page.locator('#quick-open')).not.toBeVisible();
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
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1000, height: 900 }); window.showInactive(); });
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
      if (mode === 'menu') { await page.getByRole('button', { name: '段落', exact: true }).click(); await page.getByRole('menuitem', { name: /^引用/ }).click(); }
      else { if (mode === 'blurred') await page.getByRole('button', { name: '段落', exact: true }).focus(); await page.keyboard.press('Control+Shift+Q'); }
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
  await application.evaluate(({ clipboard }) => { let text = ''; clipboard.readText = async () => text; clipboard.writeText = async value => { text = value; }; });
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

test('有序列表按列表起点连续显示，保留全 1 源码并支持嵌套、续行和导出', async () => {
  const { application, page, directory } = await launch();
  try {
    const raw = '1. 代码段\n1. 数据段\n1. BSS 段\n1. 堆段\n1. 文件映射段\n1. 栈段\n\n结尾'; await setContent(page, raw);
    const labels = () => current(page).locator('.md-list-number').evaluateAll(markers => markers.map(marker => marker.getAttribute('data-list-marker')));
    await expect.poll(labels).toEqual(['1.', '2.', '3.', '4.', '5.', '6.']); expect(await content(page)).toBe(raw);
    await expect(current(page).locator('.md-list-number').nth(1)).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
    expect(await current(page).locator('.md-list-number').nth(1).evaluate(marker => getComputedStyle(marker, '::after').content)).toBe('"2."');
    const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1000, height: 760 }); window.showInactive(); }); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: 'docs/ordered-list-preview.png' });
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
    await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder); await execute(page, 'folder'); await page.locator('#sidebar-content').getByRole('button', { name: '示例.md' }).click(); await expect(current(page).locator('.md-h1')).toContainText('导出测试');
    const image = current(page).locator('.md-image img'); await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const html = path.join(directory, '导出.html'); await chooseSave(application, html); await execute(page, 'export-html'); await expect.poll(() => fs.readFile(html, 'utf8').catch(() => '')).toContain('<strong>加粗</strong>'); expect(await fs.readFile(html, 'utf8')).toContain('data:image/png;base64,');
    const pdf = path.join(directory, '导出.pdf'); await chooseSave(application, pdf); await execute(page, 'export-pdf'); await expect.poll(() => fs.readFile(pdf).then(bytes => bytes.subarray(0, 4).toString()).catch(() => '')).toBe('%PDF');
  } finally { await application.close(); }
});

test('输入转换、列表延续、格式快捷键、查找和菜单剪贴板', async () => {
  const { application, page } = await launch();
  await application.evaluate(({ clipboard }) => { let text = ''; clipboard.readText = async () => text; clipboard.writeText = async value => { text = value; }; });
  try {
    const body = current(page).locator('.markdown-editor > .cm-scroller > .cm-content');
    await body.click(); await page.keyboard.type('```'); await page.keyboard.press('Enter'); await expect(current(page).locator('.code-content')).toHaveCount(1); await page.keyboard.insertText('连续输入的代码'); await expect.poll(() => content(page)).toContain('连续输入的代码');
    await setContent(page, '- 第一项'); await page.evaluate(() => { const e = (window as any).__editor.active(); e.view.dispatch({ selection: { anchor: e.content.length } }); e.focus(); }); await page.keyboard.press('Enter'); await page.keyboard.insertText('第二项'); expect(await content(page)).toContain('- 第一项\n- 第二项');
    await setContent(page, '需要加粗的正文'); await body.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+b'); expect(await content(page)).toBe('**需要加粗的正文**');
    await execute(page, 'copy'); await execute(page, 'new'); await execute(page, 'paste'); expect(await content(page)).toBe('需要加粗的正文');
    await page.keyboard.press('Control+f'); await expect(page.getByPlaceholder('查找')).toBeVisible(); await page.getByPlaceholder('查找').fill('加粗'); await page.getByPlaceholder('查找').press('Enter'); await expect(current(page).locator('.cm-searchMatch')).toHaveCount(1); await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+n'); await expect.poll(() => application.windows().length).toBe(2);
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

test('外部文件实时更新和父目录图片路径', async () => {
  const { application, page, directory } = await launch(); const child = path.join(directory, '子目录'); await fs.mkdir(child); await fs.copyFile(path.join(root, 'assets/replica.png'), path.join(directory, '图片.png')); const file = path.join(child, '笔记.md'); await fs.writeFile(file, '# 初始内容\n\n![图片](../图片.png)\n');
  try {
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file); await execute(page, 'open'); await expect(current(page).locator('.md-h1')).toHaveText('初始内容');
    await expect.poll(() => current(page).locator('.md-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await fs.writeFile(file, '# 从外部更新\n\n![图片](../图片.png)\n'); await expect(current(page).locator('.md-h1')).toHaveText('从外部更新'); expect(await content(page)).toContain('从外部更新');
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

test('Copilot 主题可从菜单和偏好设置选择，重启后仍保留', async () => {
  let currentApp = await launch();
  try {
    const raw = '## 标题\n\n> **引用块**\n\n```\n应用层 HTTP\n传输层 TCP\n```\n'; await setContent(currentApp.page, raw);
    await currentApp.page.getByRole('button', { name: '主题', exact: true }).click(); await currentApp.page.getByRole('menuitem', { name: 'Copilot 深色' }).click();
    await expect(currentApp.page.locator('html')).toHaveAttribute('data-theme', 'copilot');
    await expect(current(currentApp.page).locator('.md-quote')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await execute(currentApp.page, 'preferences'); await expect(currentApp.page.locator('#theme-select')).toHaveValue('copilot'); await currentApp.page.getByRole('button', { name: '应用', exact: true }).click();
    expect(await content(currentApp.page)).toBe(raw);
    await currentApp.application.close(); currentApp = await launch(currentApp.profile); await expect(currentApp.page.locator('html')).toHaveAttribute('data-theme', 'copilot'); expect(await content(currentApp.page)).toBe(raw);
    await execute(currentApp.page, 'light'); await expect(currentApp.page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally { await currentApp.application.close(); }
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
    await expect(page.locator('#caption')).toContainText('拖动期间保存.md'); expect(await held.evaluate(element => element.isConnected)).toBe(true);
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
  const directory = path.join(root, '.test-data', `theme-${randomUUID()}`); const themes = path.join(directory, 'extensions/theme-defaults/themes'); await fs.mkdir(themes, { recursive: true });
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
    await page.getByRole('button', { name: '段落', exact: true }).click(); await page.getByRole('menuitem', { name: /^表格/ }).click(); await expect(current(page).locator('table')).toHaveCount(2);
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
    await execute(page, 'preferences'); await expect(page.locator('#format-save-toggle')).not.toBeChecked(); await page.locator('#format-save-toggle').check(); await page.locator('#autosave-toggle').uncheck(); await page.getByRole('button', { name: '应用', exact: true }).click();
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
