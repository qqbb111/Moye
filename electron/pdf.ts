import { BrowserWindow, net } from 'electron';
import { randomUUID } from 'node:crypto';
import { printGeometry, type PrintOptions, type PdfPreviewResult } from '../shared/print';

interface CachedPdf { id: string; documentId: string; title: string; path: string | null; bytes: Buffer; options: PrintOptions }
interface Slot { epoch: number; tail: Promise<void>; window?: BrowserWindow; value?: CachedPdf }
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export class PdfPreviews {
  private slots = new Map<string, Slot>();
  release(owner: string) { const slot = this.slots.get(owner); if (!slot) return; slot.epoch++; slot.value = undefined; if (slot.window && !slot.window.isDestroyed()) slot.window.destroy(); this.slots.delete(owner); }
  get(owner: string, id: string): CachedPdf { const pdf = this.slots.get(owner)?.value; if (!pdf || pdf.id !== id) throw new Error('预览已失效，请重新生成'); return pdf; }
  async preview(owner: string, document: { id: string; title: string; path: string | null }, html: string, options: PrintOptions): Promise<PdfPreviewResult> {
    let slot = this.slots.get(owner); if (!slot) { slot = { epoch: 0, tail: Promise.resolve() }; this.slots.set(owner, slot); }
    const epoch = ++slot.epoch, previous = slot.tail; slot.value = undefined;
    let done!: () => void; slot.tail = new Promise<void>(resolve => { done = resolve; });
    const current = () => this.slots.get(owner) === slot && slot.epoch === epoch;
    await previous;
    let window: BrowserWindow | undefined;
    try {
      if (!current()) return { ok: false, canceled: true };
      if (!/<head>/i.test(html)) throw new Error('打印文档格式不正确');
      html = html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">`);
      for (const match of [...html.matchAll(/src="((?:replica-media:|https?:)[^"]+)"/g)]) {
        const response = await net.fetch(match[1].replaceAll('&amp;', '&'), { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('图片无法加载，请检查文档中的图片地址');
        const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 20 * 1024 * 1024) throw new Error('图片过大，无法生成打印预览');
        html = html.replaceAll(match[1], `data:${response.headers.get('content-type') ?? 'image/png'};base64,${bytes.toString('base64')}`);
      }
      if (!current()) return { ok: false, canceled: true };
      const geometry = printGeometry(options.layout), width = Math.round((geometry.widthMm - 24) * 96 / 25.4);
      window = new BrowserWindow({ show: false, width, height: 1000, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, backgroundThrottling: false } }); slot.window = window;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const maxHeight = (geometry.heightMm - geometry.topMm - geometry.bottomMm) * 96 / 25.4;
      const problem = await window.webContents.executeJavaScript(`(async()=>{try{
        await document.fonts.ready;
        await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
        if([...document.images].some(image=>!image.naturalWidth)) throw Error('图片解码失败');
        const columnWidth=${options.layout === 'portrait' ? width : (width - 8 * 96 / 25.4) / 2};
        for(const math of document.querySelectorAll('math')){
          const block=math.closest('p,li,td,th,blockquote');
          const style=block?getComputedStyle(block):null;
          const available=Math.max(1,Math.min(columnWidth,block?block.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight):columnWidth));
          math.style.maxWidth='none';
          const natural=math.getBoundingClientRect().width;
          if(natural>available)math.style.fontSize=(parseFloat(getComputedStyle(math).fontSize)*available/natural)+'px';
          math.style.maxWidth='100%';
        }
        for(const code of document.querySelectorAll('.print-code')){
          const rows=[...code.querySelectorAll('.print-code-line')];let count=0;
          for(const row of rows){const height=row.getBoundingClientRect().height;count+=Math.max(1,Math.round(height/parseFloat(getComputedStyle(row).lineHeight)));if(height>${maxHeight})row.classList.add('tall-line');}
          if(count<=12)code.classList.add('short');
          for(const lead of code.querySelectorAll('.print-code-lead'))if(lead.getBoundingClientRect().height>${maxHeight})lead.classList.add('tall-line');
        }
        return null;
      }catch(error){return error.message;}})()`);
      if (problem) throw new Error(problem);
      if (!current()) return { ok: false, canceled: true };
      const footer = `<div style="width:100%;padding:0 12mm;display:flex;justify-content:space-between;font:8pt 'Microsoft YaHei','Segoe UI',sans-serif;color:#555"><span style="max-width:75%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escape(document.title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
      const bytes = await window.webContents.printToPDF({ pageSize: 'A4', landscape: options.layout !== 'portrait', printBackground: true, scale: 1, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer, margins: { top: 12 / 25.4, bottom: 14 / 25.4, left: 12 / 25.4, right: 12 / 25.4 } });
      if (!current()) return { ok: false, canceled: true };
      const id = randomUUID(); slot.value = { id, documentId: document.id, title: document.title, path: document.path, bytes, options };
      return { ok: true, previewId: id, bytes: new Uint8Array(bytes) };
    } catch (error) { return current() ? { ok: false, message: (error as Error).message } : { ok: false, canceled: true }; }
    finally { if (window && !window.isDestroyed()) window.destroy(); if (slot.window === window) slot.window = undefined; done(); }
  }
}
