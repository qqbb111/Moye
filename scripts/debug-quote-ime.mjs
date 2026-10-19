import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = path.resolve('.test-data', `quote-ime-${randomUUID()}`); await fs.mkdir(directory, { recursive: true });
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.join(directory, 'profile'), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath: electronPath, args: ['.'], env });
try {
  const page = await application.firstWindow(); await page.locator('.markdown-editor').waitFor(); const cdp = await page.context().newCDPSession(page);
  for (const [source, cursor, command] of [['', 0, 'quote'], ['> 原文', 4, null], ['> 原文', 2, null], ['普通正文', 4, null], ['**原文**', 4, null]]) {
    await page.evaluate(({ source, cursor }) => { window.__editor.setContent(source); const e = window.__editor.active(); e.view.dispatch({ selection: { anchor: cursor } }); e.focus(); }, { source, cursor });
    if (command) await page.evaluate(command => window.__editor.execute(command), command);
    const before = await page.evaluate(() => { const e = window.__editor.active(); return { content: e.content, head: e.view.state.selection.main.head, editContext: !!e.view.contentDOM.editContext }; });
    for (const [pinyin, value] of [['n', '你'], ['h', '好'], ['sh', '世'], ['j', '界']]) {
      await cdp.send('Input.imeSetComposition', { text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length });
      await cdp.send('Input.insertText', { text: value });
    }
    const after = await page.evaluate(() => { const e = window.__editor.active(); return { content: e.content, text: e.view.contentDOM.textContent, head: e.view.state.selection.main.head, composing: e.view.composing }; });
    console.log(JSON.stringify({ source, before, after }));
  }
  await page.evaluate(() => { window.__editor.setContent(''); window.__editor.active().focus(); }); await page.keyboard.press('Control+Shift+q'); console.log(JSON.stringify({ shortcutLower: await page.evaluate(() => window.__editor.content()) }));
  await page.evaluate(() => { window.__editor.setContent(''); window.__editor.active().focus(); }); await page.keyboard.press('Control+Shift+Q'); console.log(JSON.stringify({ shortcutUpper: await page.evaluate(() => window.__editor.content()) }));
  for (const source of ['> ', '> 原文', '> **加粗**', '> [链接](https://example.com) 正文', '> 第一行\n> 第二行']) {
    await page.evaluate(source => { window.__editor.setContent(source); const e = window.__editor.active(); e.view.dispatch({ selection: { anchor: source.length } }); e.focus(); }, source);
    for (const [updates, value] of [[['n', 'ni', 'nihao', '你好'], '你好'], [['j', 'jie', 'jieshu', '结束'], '结束'], [['https', 'https://example.com', 'https://example.com/你好'], 'https://example.com/你好']]) {
      for (const text of updates) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
      await cdp.send('Input.insertText', { text: value });
    }
    console.log(JSON.stringify({ sequenceSource: source, after: await page.evaluate(() => window.__editor.content()) }));
  }
} finally { await application.close(); }
