import { _electron as electron, expect } from '@playwright/test';
import executablePath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const packaged = process.argv.includes('--packaged');
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.resolve('.test-data', `copilot-${randomUUID()}`), TYPORA_REPLICA_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const example = path.resolve('docs/Copilot排版示例.md');
const application = await electron.launch({
  executablePath: packaged ? path.resolve('release/Typora Replica-win32-x64/Typora Replica.exe') : executablePath,
  args: packaged ? [example] : ['.', example], env,
});
const page = await application.firstWindow(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(window => { window.setBounds({ width: 884, height: 620 }); window.showInactive(); });
  await expect(page.locator('.md-h2').first()).toHaveText('2. OSPF 属于哪一层？');
  await page.evaluate(() => window.__editor.execute('copilot'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'copilot');
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const stage = page.locator('#editor-stage'); const box = await stage.boundingBox();
  await page.mouse.move(5, 5);
  await page.screenshot({ path: 'docs/copilot-preview.png', clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 399.2) } });
  await page.screenshot({ path: 'docs/copilot-window.png' });
  const metrics = await page.evaluate(() => {
    const find = selector => { const element = document.querySelector(selector); const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return { font: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, color: style.color, background: style.backgroundColor, borderLeft: style.borderLeft, x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
    return { dpr: devicePixelRatio, prose: find('.markdown-editor > .cm-scroller'), heading: find('.md-h2'), quote: find('.md-quote'), code: find('.code-content .cm-scroller') };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const fonts = {};
  for (const [name, selector] of [['prose', '.md-quote .md-strong span'], ['code', '.code-content .cm-line']]) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    fonts[name] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  }
  await fs.writeFile('docs/copilot-style-report.json', JSON.stringify({ metrics, fonts, errors }, null, 2) + '\n');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ packaged, metrics, fonts }, null, 2));
} finally { await application.close(); }
