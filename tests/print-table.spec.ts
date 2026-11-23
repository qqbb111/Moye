import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const test = base.extend<{ desktop: { application: ElectronApplication; page: Page } }>({
  desktop: async ({}, use) => {
    const root = await fs.realpath('.'), staging = path.join(root, '.test-data');
    await fs.mkdir(staging, { recursive: true });
    if (await fs.realpath(staging) !== staging) throw new Error('Unexpected print-test staging path');
    const directory = await fs.mkdtemp(path.join(staging, 'desktop-print-'));
    const env: NodeJS.ProcessEnv = { ...process.env, MOYE_USER_DATA: path.join(directory, 'profile'), MOYE_TEST: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    let application: ElectronApplication | undefined;
    try {
      application = await electron.launch({ executablePath: process.env.MOYE_TEST_EXE ?? electronPath as unknown as string, args: process.env.MOYE_TEST_EXE ? [] : ['.'], cwd: root, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
      const page = await application.firstWindow(); await page.locator('.editor-slot:not([hidden]) .markdown-editor').waitFor();
      const native = await application.browserWindow(page); await native.evaluate(window => { window.setBounds({ width: 1250, height: 900 }); window.show(); window.focus(); });
      await use({ application, page });
    } finally {
      try { await application?.close(); } finally {
        if (await fs.realpath(directory) !== directory || path.dirname(directory) !== staging) throw new Error('Print-test staging path changed');
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  },
});

async function openPreview(page: Page, source: string) {
  await page.evaluate(source => (window as any).__editor.setContent(source), source);
  await page.evaluate(() => (window as any).__editor.execute('export-pdf'));
  await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 });
}
async function options(page: Page, layout: string, color: string) {
  const previous = await page.locator('#print-preview').getAttribute('data-preview-id');
  await page.locator('#print-layout').selectOption(layout); await page.locator('#print-color').selectOption(color);
  await expect.poll(() => page.locator('#print-preview').getAttribute('data-preview-id')).not.toBe(previous);
  await expect(page.locator('#print-save')).toBeEnabled({ timeout: 30000 });
}
async function previewBytes(application: ElectronApplication, page: Page) {
  const token = await page.locator('#print-preview').getAttribute('data-preview-id');
  return new Uint8Array(await application.evaluate((_electron, token) => {
    const api = (globalThis as any).__moyeTest;
    return [...api.pdfPreviews.get([...api.windows.keys()][0], token).bytes];
  }, token));
}

test('打印表格左右外框在单栏双栏和各档预览缩放中保持完整', async ({ desktop: { page } }, info) => {
  test.setTimeout(90000);
  for (const columns of [2, 3]) {
    const heading = Array.from({ length: columns }, (_, i) => i === columns - 1 ? '异步' : '同步');
    const row = Array.from({ length: columns }, (_, i) => i === columns - 1 ? 'MQ - 立即返回；消费者按序发通知，**削峰填谷**' : '等待结果');
    const source = '# 表格边框\n\n| ' + heading.join(' | ') + ' |\n| ' + heading.map(() => '---').join(' | ') + ' |\n| ' + row.join(' | ') + ' |\n| ' + row.join(' | ') + ' |';
    await openPreview(page, source);
    for (const layout of ['portrait', 'landscape-two-column']) for (const color of ['mono', 'light']) {
      await options(page, layout, color);
      for (const zoom of ['fit', '0.75', '1', '1.25']) {
        const current = page.locator('#print-pages canvas[data-ready=true]:not([data-previous])').first();
        await expect(current).toBeVisible(); await current.evaluate(canvas => canvas.setAttribute('data-border-probe-old', 'true'));
        await page.locator('#print-zoom').selectOption(zoom);
        const canvas = page.locator('#print-pages canvas[data-ready=true]:not([data-previous]):not([data-border-probe-old])').first();
        await expect(canvas).toBeVisible();
        const score = await canvas.evaluate(element => {
          const canvas = element as HTMLCanvasElement, { width, height } = canvas;
          const pixels = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
          const gray = (x: number, y: number) => {
            const i = (y * width + x) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            return Math.max(r, g, b) - Math.min(r, g, b) < 4 && r > 130 && r < 235;
          };
          const lines: number[] = [];
          for (let y = 0; y < height * .45; y++) {
            let count = 0; for (let x = 0; x < width; x++) if (gray(x, y)) count++;
            if (count > width * .25) lines.push(y);
          }
          if (lines.length < 2) throw new Error('Printed table grid was not found');
          let left = 0, right = width - 1;
          while (!gray(left, lines[0])) left++;
          while (!gray(right, lines[0])) right--;
          let samples = 0, leftVisible = 0, rightVisible = 0;
          for (let y = lines[0] + 3; y < lines.at(-1)! - 2; y++) {
            if (lines.some(line => Math.abs(line - y) <= 2)) continue;
            const visible = (x: number) => {
              let darkest = 255;
              for (let dx = -2; dx <= 2; dx++) if (x + dx >= 0 && x + dx < width) darkest = Math.min(darkest, pixels[(y * width + x + dx) * 4]);
              return darkest < 225;
            };
            samples++; if (visible(left)) leftVisible++; if (visible(right)) rightVisible++;
          }
          return { width, height, left, right, samples, leftCoverage: leftVisible / samples, rightCoverage: rightVisible / samples };
        });
        const label = `${columns} columns, ${layout}, ${color}, zoom ${zoom}: ${JSON.stringify(score)}`;
        expect(score.samples, label).toBeGreaterThan(10);
        expect(score.leftCoverage, label).toBeGreaterThan(.85);
        expect(score.rightCoverage, label).toBeGreaterThan(.85);
        expect(score.rightCoverage, label).toBeGreaterThanOrEqual(score.leftCoverage * .9);
        if (columns === 2 && color === 'mono' && zoom === 'fit') {
          const image = await canvas.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
          await fs.writeFile(info.outputPath(`${layout}-table.png`), Buffer.from(image.split(',')[1], 'base64'));
        }
      }
    }
    await page.locator('#print-close').click();
  }
});

test('打印长表跨页跨栏保留全部行和重复表头', async ({ desktop: { application, page } }) => {
  test.setTimeout(90000);
  const rows = Array.from({ length: 100 }, (_, i) => `| ROW_${String(i).padStart(3, '0')} | 中文说明：等待结果与异步通知，打印长表保持完整。 |`);
  await openPreview(page, '# 长表\n\n| HEADER_LEFT | HEADER_RIGHT |\n| --- | --- |\n' + rows.join('\n') + '\n\nTABLE_END');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const layout of ['portrait', 'landscape-two-column']) for (const color of ['mono', 'light']) {
    await options(page, layout, color);
    const loading = getDocument({ data: await previewBytes(application, page), useSystemFonts: true });
    try {
      const pdf = await loading.promise, found: string[] = []; let complete = '';
      expect(pdf.numPages).toBeGreaterThan(1);
      for (let number = 1; number <= pdf.numPages; number++) {
        const sheet = await pdf.getPage(number);
        const text = (await sheet.getTextContent()).items.map(item => 'str' in item ? item.str : '').join('');
        const identifiers = text.match(/ROW_\d{3}/g) ?? [];
        if (identifiers.length) { expect(text).toContain('HEADER_LEFT'); expect(text).toContain('HEADER_RIGHT'); }
        found.push(...identifiers); complete += text;
      }
      expect(found).toEqual(Array.from({ length: 100 }, (_, i) => `ROW_${String(i).padStart(3, '0')}`));
      expect(complete).toContain('TABLE_END');
    } finally { await loading.destroy(); }
  }
});
