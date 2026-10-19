import { _electron as electron } from '@playwright/test';
import executablePath from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.resolve('.test-data', randomUUID()), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath, args: ['.', path.resolve('docs/示例.md')], env });
const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.locator('.md-h1').waitFor(); await page.evaluate(() => document.fonts.ready);
  await page.locator('.code-content .cm-content').waitFor();
  if (process.env.DEBUG_LAYOUT) console.log(await page.evaluate(() => [...document.querySelectorAll('.editor-slot:not([hidden]) > .cm-editor > .cm-scroller,.editor-slot:not([hidden]) > .cm-editor > .cm-scroller > .cm-content,.md-h1')].map(element => {
    const style = getComputedStyle(element); const box = element.getBoundingClientRect();
    return { class: element.className, left: box.left, width: box.width, display: style.display, marginLeft: style.marginLeft, marginRight: style.marginRight, fontFamily: style.fontFamily, flex: style.flex, background: style.backgroundColor };
  })));
  await page.screenshot({ path: 'docs/preview.png' });
  await page.evaluate(() => window.__editor.execute('outline')); await page.screenshot({ path: 'docs/preview-outline.png' });
  await page.evaluate(() => window.__editor.execute('dark')); await page.screenshot({ path: 'docs/preview-dark.png' });
  if (errors.length) throw new Error(errors.join('\n')); console.log('Saved light, outline and dark desktop previews.');
} finally { await app.close(); }
