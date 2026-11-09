import { BrowserWindow, net, type PrintToPDFOptions } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { printGeometry, type PrintOptions, type PdfPreviewResult } from '../shared/print';

interface CachedPdf { id: string; documentId: string; title: string; path: string | null; bytes: Buffer; options: PrintOptions }
interface Slot { epoch: number; tail: Promise<void>; window?: BrowserWindow; value?: CachedPdf; abort?: AbortController }
const cssString = (text: string) => '"' + text.replace(/["\\<\u0000-\u001f\u007f]/g, c => `\\${(c.charCodeAt(0) || 0xfffd).toString(16)} `) + '"';
export class PdfPreviews {
  private slots = new Map<string, Slot>();
  private recent = new Map<string, Map<string, Buffer>>();
  release(owner: string) { const slot = this.slots.get(owner); if (!slot) return; slot.epoch++; slot.value = undefined; slot.abort?.abort(); if (slot.window && !slot.window.isDestroyed()) slot.window.destroy(); this.slots.delete(owner); }
  dispose(owner: string) { this.release(owner); this.recent.delete(owner); }
  get(owner: string, id: string): CachedPdf { const pdf = this.slots.get(owner)?.value; if (!pdf || pdf.id !== id) throw new Error('预览已失效，请重新生成'); return pdf; }
  async preview(owner: string, document: { id: string; title: string; path: string | null }, html: string, options: PrintOptions, firstPage?: (bytes: Uint8Array) => void): Promise<PdfPreviewResult> {
    let slot = this.slots.get(owner); if (!slot) { slot = { epoch: 0, tail: Promise.resolve() }; this.slots.set(owner, slot); }
    const epoch = ++slot.epoch, previous = slot.tail; slot.value = undefined;
    slot.abort?.abort(); if (slot.window && !slot.window.isDestroyed()) slot.window.destroy(); slot.window = undefined;
    const abort = new AbortController(); slot.abort = abort;
    let done!: () => void; slot.tail = new Promise<void>(resolve => { done = resolve; });
    const current = () => this.slots.get(owner) === slot && slot.epoch === epoch;
    await previous;
    let window: BrowserWindow | undefined;
    try {
      if (!current()) return { ok: false, canceled: true };
      if (!/<head>/i.test(html)) throw new Error('打印文档格式不正确');
      html = html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">`);
      const urls = [...new Set([...html.matchAll(/src="((?:replica-media:|https?:)[^"]+)"/g)].map(match => match[1]))];
      for (let index = 0; index < urls.length; index += 4) {
        const images = await Promise.all(urls.slice(index, index + 4).map(async url => {
          const response = await net.fetch(url.replaceAll('&amp;', '&'), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
          if (!response.ok) throw new Error('图片无法加载，请检查文档中的图片地址');
          const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 20 * 1024 * 1024) throw new Error('图片过大，无法生成打印预览');
          return { url, data: `data:${response.headers.get('content-type') ?? 'image/png'};base64,${bytes.toString('base64')}` };
        }));
        if (!current()) return { ok: false, canceled: true };
        for (const image of images) html = html.replaceAll(image.url, image.data);
      }
      if (!current()) return { ok: false, canceled: true };
      const key = createHash('sha256').update(JSON.stringify([document.id, document.title, document.path, options])).update(html).digest('hex');
      const cached = this.recent.get(owner)?.get(key);
      if (cached) {
        const id = randomUUID(); slot.value = { id, documentId: document.id, title: document.title, path: document.path, bytes: cached, options };
        const recent = this.recent.get(owner)!; recent.delete(key); recent.set(key, cached);
        return { ok: true, previewId: id, bytes: new Uint8Array(cached) };
      }
      // Page margin boxes share the document's font/layout context. Electron's
      // separate header/footer renderer otherwise repeats that work per page.
      const footerStyle = `<style id="moye-print-footer">@page{@bottom-left{content:${cssString(document.title)};font:8pt 'Microsoft YaHei','Segoe UI',sans-serif;color:#555;width:70%;white-space:nowrap}@bottom-right{content:counter(page) ' / ' counter(pages);font:8pt 'Microsoft YaHei','Segoe UI',sans-serif;color:#555;text-align:right}}</style>`;
      html = html.replace(/<\/head>/i, footerStyle + '</head>');
      const geometry = printGeometry(options.layout), width = Math.round((geometry.widthMm - 24) * 96 / 25.4);
      window = new BrowserWindow({ show: false, width, height: 1000, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, backgroundThrottling: false } }); slot.window = window;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const maxHeight = (geometry.heightMm - geometry.topMm - geometry.bottomMm) * 96 / 25.4;
      const problem = await window.webContents.executeJavaScript(`(async()=>{try{
        await document.fonts.ready;
        await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
        if([...document.images].some(image=>!image.naturalWidth)) throw Error('图片解码失败');
        const context=document.createElement('canvas').getContext('2d');context.font='8pt "Microsoft YaHei","Segoe UI",sans-serif';
        const title=${JSON.stringify(document.title)},parts=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(title),part=>part.segment);let label=title;
        while(parts.length&&context.measureText(label).width>${width * .65}){parts.pop();label=parts.join('')+'…';}
        document.getElementById('moye-print-footer').sheet.cssRules[0].cssRules[0].style.content='"'+CSS.escape(label)+'"';
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
        return Math.ceil(document.body.getBoundingClientRect().height/${maxHeight});
      }catch(error){return error.message;}})()`);
      if (typeof problem === 'string') throw new Error(problem);
      if (!current()) return { ok: false, canceled: true };
      const printOptions: PrintToPDFOptions = { pageSize: 'A4', landscape: options.layout !== 'portrait', printBackground: true, scale: 1, displayHeaderFooter: false, generateTaggedPDF: false, margins: { top: 12 / 25.4, bottom: 14 / 25.4, left: 12 / 25.4, right: 12 / 25.4 } };
      if (firstPage && problem > 2) {
        const first = await window.webContents.printToPDF({ ...printOptions, pageRanges: '1' });
        if (!current()) return { ok: false, canceled: true };
        firstPage(new Uint8Array(first));
      }
      const bytes = await window.webContents.printToPDF(printOptions);
      if (!current()) return { ok: false, canceled: true };
      const id = randomUUID(); slot.value = { id, documentId: document.id, title: document.title, path: document.path, bytes, options };
      if (bytes.length <= 16 * 1024 * 1024) {
        let recent = this.recent.get(owner); if (!recent) this.recent.set(owner, recent = new Map()); recent.set(key, bytes);
        while (recent.size > 4 || [...recent.values()].reduce((sum, pdf) => sum + pdf.length, 0) > 32 * 1024 * 1024) recent.delete(recent.keys().next().value!);
      }
      return { ok: true, previewId: id, bytes: new Uint8Array(bytes) };
    } catch (error) { return current() ? { ok: false, message: (error as Error).message } : { ok: false, canceled: true }; }
    finally { abort.abort(); if (window && !window.isDestroyed()) window.destroy(); if (slot.window === window) slot.window = undefined; if (slot.abort === abort) slot.abort = undefined; done(); }
  }
}
