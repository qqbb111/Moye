import { BrowserWindow, net, type PrintToPDFOptions } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { printGeometry, type PrintOptions, type PdfPreviewResult } from '../shared/print';

interface CachedPdf { id: string; documentId: string; title: string; path: string | null; bytes: Buffer; options: PrintOptions }
interface PrintJob { abort: AbortController; window?: BrowserWindow }
interface Slot { epoch: number; tail: Promise<void>; value?: CachedPdf; job?: PrintJob }
const cssString = (text: string) => '"' + text.replace(/["\\<\u0000-\u001f\u007f]/g, c => '\\' + (c.charCodeAt(0) || 0xfffd).toString(16) + ' ') + '"';

function stop(job?: PrintJob) {
  job?.abort.abort();
  if (job?.window && !job.window.isDestroyed()) job.window.destroy();
}

async function resolveImages(html: string, signal: AbortSignal) {
  if (!/<head>/i.test(html)) throw new Error('打印文档格式不正确');
  html = html.replace(/<head>/i, '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'; script-src \'none\'; base-uri \'none\'; form-action \'none\'">');
  const urls = [...new Set([...html.matchAll(/src="((?:replica-media:|https?:)[^"]+)"/g)].map(match => match[1]))];
  for (let index = 0; index < urls.length; index += 4) {
    const images = await Promise.all(urls.slice(index, index + 4).map(async url => {
      const response = await net.fetch(url.replaceAll('&amp;', '&'), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error('图片无法加载，请检查文档中的图片地址');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) throw new Error('图片过大，无法生成打印预览');
      return { url, data: 'data:' + (response.headers.get('content-type') ?? 'image/png') + ';base64,' + bytes.toString('base64') };
    }));
    signal.throwIfAborted();
    for (const image of images) html = html.replaceAll(image.url, image.data);
  }
  return html;
}

async function print(html: string, title: string, options: PrintOptions, job: PrintJob, firstPage = false) {
  const signal = job.abort.signal;
  signal.throwIfAborted();
  // Margin boxes avoid Electron's separate header/footer renderer on each page.
  const number = firstPage ? 'counter(page)' : "counter(page) ' / ' counter(pages)";
  const footerStyle = '<style id="moye-print-footer">@page{@bottom-left{content:' + cssString(title) + ';font:8pt "Microsoft YaHei","Segoe UI",sans-serif;color:#555;width:70%;white-space:nowrap}@bottom-right{content:' + number + ';font:8pt "Microsoft YaHei","Segoe UI",sans-serif;color:#555;text-align:right}}</style>';
  html = html.replace(/<\/head>/i, footerStyle + '</head>');
  const geometry = printGeometry(options.layout), width = Math.round((geometry.widthMm - 2 * geometry.sideMm) * 96 / 25.4);
  const window = new BrowserWindow({ show: false, width, height: 1000, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, backgroundThrottling: false } });
  job.window = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html).toString('base64'));
  signal.throwIfAborted();
  const maxHeight = (geometry.heightMm - geometry.topMm - geometry.bottomMm) * 96 / 25.4;
  const columnWidth = options.layout === 'portrait' ? width : (width - geometry.columnGapMm * 96 / 25.4) / 2;
  const problem = await window.webContents.executeJavaScript(`(async () => {
    try {
      await document.fonts.ready;
      const images = Array.from(document.images);
      await Promise.all(images.map(image => image.decode().catch(() => {})));
      if (images.some(image => !image.naturalWidth)) throw Error('图片解码失败');
      const context = document.createElement('canvas').getContext('2d');
      context.font = '8pt "Microsoft YaHei","Segoe UI",sans-serif';
      const title = ${JSON.stringify(title)};
      const parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title), part => part.segment);
      let label = title;
      while (parts.length && context.measureText(label).width > ${width * .65}) {
        parts.pop();
        label = parts.join('') + '…';
      }
      document.getElementById('moye-print-footer').sheet.cssRules[0].cssRules[0].style.content = '"' + CSS.escape(label) + '"';
      const columnWidth = ${columnWidth}, maxHeight = ${maxHeight};
      for (const math of document.querySelectorAll('math')) {
        const block = math.closest('p,li,td,th,blockquote');
        const style = block ? getComputedStyle(block) : null;
        const available = Math.max(1, Math.min(columnWidth, block ? block.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) : columnWidth));
        math.style.maxWidth = 'none';
        const natural = math.getBoundingClientRect().width;
        if (natural > available) math.style.fontSize = (parseFloat(getComputedStyle(math).fontSize) * available / natural) + 'px';
        math.style.maxWidth = '100%';
      }
      for (const code of document.querySelectorAll('.print-code')) {
        const lineHeight = parseFloat(getComputedStyle(code).lineHeight);
        let count = 0;
        for (const row of code.querySelectorAll('.print-code-line')) {
          const height = row.getBoundingClientRect().height;
          count += Math.max(1, Math.round(height / lineHeight));
          if (height > maxHeight) row.classList.add('tall-line');
        }
        if (count <= 12) code.classList.add('short');
        for (const lead of code.querySelectorAll('.print-code-lead')) {
          if (lead.getBoundingClientRect().height > maxHeight) lead.classList.add('tall-line');
        }
      }
    } catch (error) { return error.message; }
  })()`);
  if (typeof problem === 'string') throw new Error(problem);
  signal.throwIfAborted();
  const printOptions: PrintToPDFOptions = {
    pageSize: 'A4', landscape: options.layout !== 'portrait', printBackground: true, scale: 1, displayHeaderFooter: false, generateTaggedPDF: false,
    margins: { top: geometry.topMm / 25.4, bottom: geometry.bottomMm / 25.4, left: geometry.sideMm / 25.4, right: geometry.sideMm / 25.4 },
    ...(firstPage ? { pageRanges: '1' } : {}),
  };
  return window.webContents.printToPDF(printOptions);
}

export class PdfPreviews {
  private slots = new Map<string, Slot>();
  private firstPages = new Map<string, { requestId: string; job: PrintJob }>();
  private recent = new Map<string, Map<string, Buffer>>();

  private releaseFirstPage(owner: string, requestId?: string) {
    const first = this.firstPages.get(owner);
    if (!first || (requestId && first.requestId !== requestId)) return;
    this.firstPages.delete(owner);
    stop(first.job);
  }
  release(owner: string) {
    this.releaseFirstPage(owner);
    const slot = this.slots.get(owner);
    this.slots.delete(owner);
    stop(slot?.job);
  }
  dispose(owner: string) { this.release(owner); this.recent.delete(owner); }
  get(owner: string, id: string): CachedPdf {
    const pdf = this.slots.get(owner)?.value;
    if (!pdf || pdf.id !== id) throw new Error('预览已失效，请重新生成');
    return pdf;
  }
  async previewFirstPage(owner: string, title: string, html: string, options: PrintOptions, requestId: string, deliver: (bytes: Uint8Array) => void) {
    this.releaseFirstPage(owner);
    const job = { abort: new AbortController() }, first = { requestId, job };
    this.firstPages.set(owner, first);
    try {
      html = await resolveImages(html, job.abort.signal);
      const bytes = await print(html, title, options, job, true);
      if (this.firstPages.get(owner) === first) deliver(new Uint8Array(bytes));
    } catch {
      // The optional first page may be canceled or omit a definition used by
      // the prefix. Full-document generation reports authoritative errors.
    } finally {
      if (this.firstPages.get(owner) === first) this.firstPages.delete(owner);
      stop(job);
    }
  }
  async preview(owner: string, document: { id: string; title: string; path: string | null }, html: string, options: PrintOptions, requestId?: string): Promise<PdfPreviewResult> {
    let slot = this.slots.get(owner);
    if (!slot) { slot = { epoch: 0, tail: Promise.resolve() }; this.slots.set(owner, slot); }
    const epoch = ++slot.epoch, previous = slot.tail;
    slot.value = undefined;
    stop(slot.job);
    const job = { abort: new AbortController() };
    slot.job = job;
    let done!: () => void;
    slot.tail = new Promise<void>(resolve => { done = resolve; });
    const current = () => this.slots.get(owner) === slot && slot.epoch === epoch;
    await previous;
    try {
      if (!current()) return { ok: false, canceled: true };
      html = await resolveImages(html, job.abort.signal);
      if (!current()) return { ok: false, canceled: true };
      const key = createHash('sha256').update(JSON.stringify([document.id, document.title, document.path, options])).update(html).digest('hex');
      let recent = this.recent.get(owner);
      const cached = recent?.get(key), bytes = cached ?? await print(html, document.title, options, job);
      if (!current()) return { ok: false, canceled: true };
      const id = randomUUID();
      slot.value = { id, documentId: document.id, title: document.title, path: document.path, bytes, options };
      if (bytes.length <= 16 * 1024 * 1024) {
        if (!recent) this.recent.set(owner, recent = new Map());
        recent.delete(key);
        recent.set(key, bytes);
        while (recent.size > 4 || [...recent.values()].reduce((sum, pdf) => sum + pdf.length, 0) > 32 * 1024 * 1024) recent.delete(recent.keys().next().value!);
      }
      return { ok: true, previewId: id, bytes: new Uint8Array(bytes) };
    } catch (error) { return current() ? { ok: false, message: (error as Error).message } : { ok: false, canceled: true }; }
    finally {
      if (requestId) this.releaseFirstPage(owner, requestId);
      stop(job);
      if (slot.job === job) slot.job = undefined;
      done();
    }
  }
}
