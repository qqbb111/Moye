import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = path.resolve('.test-data', `editing-${randomUUID()}`); await fs.mkdir(directory, { recursive: true });
const env = { ...process.env, TYPORA_REPLICA_USER_DATA: path.join(directory, 'profile'), TYPORA_REPLICA_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath: electronPath, args: ['.'], env });
try {
  const page = await application.firstWindow(); await page.locator('.markdown-editor').waitFor(); const window = await application.browserWindow(page); await window.evaluate(window => { window.setBounds({ width: 1000, height: 960 }); window.showInactive(); });
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="620"><rect width="900" height="620" fill="#ddeeff"/></svg>').toString('base64');
  const source = `![图](${image})\n\n32 位操作系统，每个进程独占 4G 内存（进程虚拟内存地址空间大小）\n\n64 位操作系统，每个进程独占`;
  await page.evaluate(source => { window.__editor.setContent(source); const e = window.__editor.active(); e.view.dispatch({ selection: { anchor: source.length } }); e.focus(); }, source);
  await page.locator('.md-image img').evaluate(async image => { if (!image.complete) await new Promise(resolve => image.onload = resolve); });
  for (const scrolling of [false, true]) {
    const result = await page.evaluate(scrolling => {
      const e = window.__editor.active(); e.view.dispatch({ selection: { anchor: e.content.length } }); e.focus();
      if (scrolling) e.view.scrollDOM.scrollTop = e.view.scrollDOM.scrollHeight;
      const target = [...e.view.contentDOM.querySelectorAll('.cm-line')].find(line => line.textContent.includes('32 位操作系统'));
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT); const node = walker.nextNode(); const range = document.createRange(); range.setStart(node, node.textContent.indexOf('内存地址')); range.collapse(true); const box = range.getBoundingClientRect();
      return { x: box.x, y: box.y + box.height / 2, expected: e.content.indexOf('内存地址'), atCoords: e.view.posAtCoords({ x: box.x, y: box.y + box.height / 2 }), before: e.view.state.selection.main.head, docTop: e.view.documentTop, block: e.view.lineBlockAt(e.content.indexOf('内存地址')), atPosition: e.view.coordsAtPos(e.content.indexOf('内存地址')), lines: [...e.view.contentDOM.children].map(line => ({ text: line.textContent.slice(0, 45), top: line.getBoundingClientRect().top, height: line.getBoundingClientRect().height, offset: e.view.posAtDOM(line) })) };
    }, scrolling);
    await page.mouse.click(result.x, result.y);
    const after = await page.evaluate(() => { const e = window.__editor.active(); const selection = window.getSelection(); return { head: e.view.state.selection.main.head, native: selection?.anchorOffset, line: selection?.anchorNode?.textContent?.slice(0, 70) }; });
    console.log(JSON.stringify({ scrolling, ...result, after }));
    await page.evaluate(() => window.__editor.active().view.requestMeasure()); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  for (const source of ['**JIACU**文字 123', '前文**JIACU**文字 123', '**加粗**文字123', '正文']) {
    await page.evaluate(source => { window.__editor.setContent(source); const e = window.__editor.active(); e.view.dispatch({ selection: { anchor: e.content.length } }); e.focus(); }, source);
    console.log(JSON.stringify(await page.evaluate(() => { const e = window.__editor.active(); return { source: e.content, text: e.view.contentDOM.textContent, strong: [...e.view.dom.querySelectorAll('.md-strong')].map(span => ({ text: span.textContent, width: span.getBoundingClientRect().width, html: span.outerHTML })) }; })));
  }
} finally { await application.close(); }
