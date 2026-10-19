import { _electron as electron } from '@playwright/test';
import executablePath from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.resolve('.test-data', randomUUID()), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath, args: ['.'], env });
const page = await app.firstWindow(); await page.locator('.markdown-editor').waitFor();
page.on('pageerror', error => console.log('ERROR', error.message));
try {
  await page.evaluate(() => { window.__events = []; document.addEventListener('keydown', event => window.__events.push({ key: event.key, code: event.code, ctrl: event.ctrlKey, shift: event.shiftKey, prevented: event.defaultPrevented }), true); window.__editor.setContent('# 测试\n\n正文\n'); window.__editor.active().view.dispatch({ selection: { anchor: window.__editor.content().length } }); window.__editor.active().focus(); });
  for (const key of ['Control+/', 'Control+/', 'TEXT', 'Control+z', 'Control+Shift+z']) {
    if (key === 'TEXT') await page.keyboard.insertText('输入文本'); else await page.keyboard.press(key);
    console.log(key, await page.evaluate(() => ({ content: window.__editor.content(), focus: document.activeElement?.outerHTML.slice(0, 100), events: window.__events.splice(0) })));
  }
  await page.evaluate(() => window.__editor.execute('redo')); console.log('EXEC REDO', await page.evaluate(() => window.__editor.content()));
} finally { await app.close(); }
