import * as pdfjs from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.mjs?url';
import './themes/print-preview.css';
import { printHTML } from './print-export';
import { icon } from './icons';
import { printPreferences, optionsFromPreferences, type PrintOptions, type PrintPreferences, type PrintLayout } from '../shared/print';
import type { DocumentView } from '../shared/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerURL;
export class PrintPreview {
  readonly dialog = document.createElement('dialog');
  private snapshot!: DocumentView;
  private preferences!: PrintPreferences;
  private generation = 0;
  private paintGeneration = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pdf?: pdfjs.PDFDocumentProxy;
  private loading?: pdfjs.PDFDocumentLoadingTask;
  private worker?: pdfjs.PDFWorker;
  private prepared = new Map<string, string>();
  private preparedSource = '';
  private observer?: IntersectionObserver;
  private renders = new Map<number, pdfjs.RenderTask>();
  private id = '';
  private request?: { id: string; generation: number; documentId: string };
  private interim?: Promise<unknown>;
  private lastLayout: PrintLayout = 'portrait';
  constructor(private read: (id: string) => DocumentView | undefined, private media: (id: string, url: string) => string, private focus: () => void) {
    this.dialog.id = 'print-preview'; this.dialog.setAttribute('aria-label', '打印预览'); this.dialog.tabIndex = -1;
    this.dialog.innerHTML = `<header class="print-header"><div><strong>打印预览</strong><span id="print-document"></span></div><button id="print-close" aria-label="关闭打印预览">${icon('close')}</button></header>
      <div class="print-body"><aside class="print-settings"><label>纸张与版式<select id="print-layout"><option value="portrait">A4 纵向 · 单栏</option><option value="landscape-two-column">A4 横向 · 双栏</option></select></label><label>代码配色<select id="print-color"><option value="mono">黑白省墨</option><option value="light">浅色语法高亮</option></select></label><label>代码字号 <span class="print-unit">pt</span><input id="print-font" type="number" min="8" max="12" step="0.5"></label><label class="print-checkbox"><input id="print-lines" type="checkbox">显示代码行号</label><div id="print-stale" hidden>原文已更新<button id="print-refresh">刷新预览</button></div><button id="print-save" disabled>保存 PDF…</button><p id="print-status" role="alert" hidden></p></aside>
      <section class="print-preview-area"><div class="print-toolbar"><div class="print-page-info"><span id="print-page-count">— 页</span><span id="print-busy" aria-label="正在排版" role="status" hidden></span></div><label>缩放<select id="print-zoom" aria-label="预览缩放"><option value="fit">适合宽度</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option></select></label></div><div id="print-pages" tabindex="0" aria-label="PDF 页面预览"></div></section></div>`;
    document.body.append(this.dialog);
    window.rypota.onPdfFirstPage(page => {
      const request = this.request;
      if (!request || page.requestId !== request.id || page.documentId !== request.documentId || request.generation !== this.generation || !this.dialog.open) return;
      // The first page uses the very same print document and settings. Saving
      // stays disabled until the complete PDF has replaced this initial view.
      this.interim = this.displayPdf(page.bytes, request.generation).catch(() => false);
    });
    this.get<HTMLButtonElement>('#print-close').onclick = () => this.dialog.close();
    this.get('#print-layout').onchange = () => {
      this.rememberFont(); this.lastLayout = this.get<HTMLSelectElement>('#print-layout').value as PrintLayout;
      this.get<HTMLInputElement>('#print-font').value = String(this.preferences.fonts[this.lastLayout]); this.schedule();
    };
    for (const selector of ['#print-color', '#print-font', '#print-lines']) this.get(selector).oninput = () => this.schedule();
    this.get('#print-zoom').onchange = () => this.paintPages();
    let previousWidth = 0; let resizeTimer: ReturnType<typeof setTimeout>;
    new ResizeObserver(() => { const width = this.get('#print-pages').clientWidth; if (width === previousWidth) return; previousWidth = width; clearTimeout(resizeTimer); if (this.dialog.open && this.pdf && !this.get<HTMLButtonElement>('#print-save').disabled && this.get<HTMLSelectElement>('#print-zoom').value === 'fit') resizeTimer = setTimeout(() => void this.paintPages(), 100); }).observe(this.get('#print-pages'));
    this.get('#print-refresh').onclick = () => { const next = this.read(this.snapshot.id); if (next) { this.snapshot = { ...next }; this.observe(next); this.get('#print-document').textContent = next.title; this.schedule(0); } };
    this.get('#print-save').onclick = () => void this.save();
    this.dialog.addEventListener('close', () => { if (this.dialog.open) return; this.dispose(); this.focus(); });
  }
  private get<T extends HTMLElement = HTMLElement>(selector: string) { return this.dialog.querySelector<T>(selector)!; }
  open(document: DocumentView, preferences?: PrintPreferences) {
    if (this.dialog.open) { this.dialog.close(); this.dispose(); }
    this.snapshot = { ...document }; this.preferences = printPreferences(preferences); const options = optionsFromPreferences(this.preferences); this.lastLayout = options.layout;
    this.get<HTMLSelectElement>('#print-layout').value = options.layout; this.get<HTMLSelectElement>('#print-color').value = options.color;
    this.get<HTMLInputElement>('#print-font').value = String(options.codeFontPt); this.get<HTMLInputElement>('#print-lines').checked = options.lineNumbers;
    this.worker = new pdfjs.PDFWorker(); void this.worker.promise.catch(() => {});
    this.get('#print-document').textContent = document.title; this.get('#print-stale').hidden = true; this.get('#print-page-count').textContent = '— 页'; this.dialog.showModal(); this.dialog.focus({ preventScroll: true }); this.schedule(0);
  }
  observe(document?: DocumentView) { if (this.dialog.open) { this.get('#print-stale').hidden = !!document && document.revision === this.snapshot.revision && document.title === this.snapshot.title; this.get<HTMLButtonElement>('#print-refresh').disabled = !document; } }
  documentId() { return this.snapshot?.id; }
  private rememberFont() { const input = this.get<HTMLInputElement>('#print-font'); if (input.checkValidity() && input.value !== '') this.preferences.fonts[this.lastLayout] = Number(input.value); }
  private options(): PrintOptions { return { layout: this.get<HTMLSelectElement>('#print-layout').value as PrintLayout, color: this.get<HTMLSelectElement>('#print-color').value as PrintOptions['color'], codeFontPt: Number(this.get<HTMLInputElement>('#print-font').value), lineNumbers: this.get<HTMLInputElement>('#print-lines').checked }; }
  private schedule(delay = 400) {
    clearTimeout(this.timer); const generation = ++this.generation; this.id = ''; delete this.dialog.dataset.previewId; this.get<HTMLButtonElement>('#print-save').disabled = true; this.get<HTMLSelectElement>('#print-zoom').disabled = true;
    this.dialog.dataset.generation = String(generation);
    this.message(''); this.get('#print-busy').hidden = false; this.get('#print-save').textContent = '正在生成…';
    this.get('#print-pages').style.setProperty('--paper-aspect', this.options().layout === 'portrait' ? '210 / 297' : '297 / 210');
    const input = this.get<HTMLInputElement>('#print-font');
    if (!input.checkValidity() || input.value === '') { this.message('字号范围为 8–12pt，步长 0.5pt'); this.finishBusy(); return; }
    this.rememberFont();
    this.timer = setTimeout(() => void this.generate(generation), delay);
  }
  private async generate(generation: number) {
    const options = this.options(), snapshot = this.snapshot;
    try {
      const source = JSON.stringify([snapshot.id, snapshot.title, snapshot.path, snapshot.content]);
      if (source !== this.preparedSource) { this.prepared.clear(); this.preparedSource = source; }
      const key = JSON.stringify(options);
      let html = this.prepared.get(key);
      if (!html) {
        html = await printHTML(snapshot.content, snapshot.title, { id: snapshot.id, media: url => this.media(snapshot.id, url), link: () => {}, changed: () => {} }, options);
        if (source === this.preparedSource && html.length <= 2 * 1024 * 1024) { this.prepared.set(key, html); if (this.prepared.size > 4) this.prepared.delete(this.prepared.keys().next().value!); }
      }
      if (generation !== this.generation || !this.dialog.open) return;
      const request = { id: crypto.randomUUID(), generation, documentId: snapshot.id }; this.request = request; this.interim = undefined;
      const result = await window.rypota.previewPdf(snapshot.id, html, options, request.id);
      if (generation !== this.generation || !this.dialog.open) return;
      if (!result.ok) { if (!result.canceled) throw new Error(result.message ?? '无法生成 PDF'); return; }
      await this.interim;
      if (generation !== this.generation || !this.dialog.open) return;
      if (await this.displayPdf(result.bytes, generation)) {
        this.id = result.previewId; this.dialog.dataset.previewId = this.id; this.get('#print-page-count').textContent = `${this.pdf!.numPages} 页`;
        this.finishBusy(); this.get<HTMLButtonElement>('#print-save').disabled = false; this.get<HTMLSelectElement>('#print-zoom').disabled = false;
      }
    } catch (error) { if (generation === this.generation && this.dialog.open) { this.message(`预览失败：${(error as Error).message}`); this.finishBusy(); } }
  }
  private message(text: string) { this.get('#print-status').textContent = text; this.get('#print-status').hidden = !text; }
  private async displayPdf(bytes: Uint8Array, generation: number) {
    this.clearPdf(true);
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), worker: this.worker }); this.loading = loading;
    const pdf = await loading.promise;
    if (generation !== this.generation || !this.dialog.open) { await loading.destroy(); return false; }
    this.pdf = pdf; return await this.paintPages() && generation === this.generation && this.dialog.open;
  }
  private finishBusy() { this.get('#print-busy').hidden = true; this.get('#print-save').textContent = '保存 PDF…'; }
  private dispose() { this.generation++; clearTimeout(this.timer); this.clearPdf(); this.worker?.destroy(); this.worker = undefined; this.request = undefined; this.interim = undefined; this.id = ''; delete this.dialog.dataset.previewId; void window.rypota.releasePdf(); }
  private clearPdf(preservePages = false) {
    this.paintGeneration++;
    this.observer?.disconnect(); for (const task of this.renders.values()) task.cancel(); this.renders.clear();
    if (this.loading) void this.loading.destroy().catch(() => {}); this.loading = undefined; this.pdf = undefined; if (!preservePages) this.get('#print-pages').replaceChildren();
  }
  private async paintPages() {
    const pdf = this.pdf; if (!pdf) return false; const painting = ++this.paintGeneration, generation = this.generation;
    this.observer?.disconnect(); for (const render of this.renders.values()) render.cancel(); this.renders.clear(); const pages = this.get('#print-pages');
    const previous = pages.querySelector<HTMLCanvasElement>('.print-page[data-page="1"] canvas[data-ready=true]'), scrollTop = pages.scrollTop; pages.replaceChildren();
    const first = await pdf.getPage(1); if (this.pdf !== pdf || painting !== this.paintGeneration) return false;
    const base = first.getViewport({ scale: 1 }), zoom = this.get<HTMLSelectElement>('#print-zoom').value;
    const scale = zoom === 'fit' ? Math.min(2, Math.max(.2, (pages.clientWidth - 52) / base.width)) : Number(zoom) * 96 / 72;
    const viewport = first.getViewport({ scale });
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement, number = Number(element.dataset.page);
        if (entry.isIntersecting && !element.querySelector('canvas')) void draw(number, element);
        else if (!entry.isIntersecting) { this.renders.get(number)?.cancel(); this.renders.delete(number); const canvas = element.querySelector('canvas'); if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); } }
      }
    }, { root: pages, rootMargin: '500px' }); this.observer = observer;
    const draw = async (number: number, element: HTMLElement) => {
      const canvas = document.createElement('canvas'); element.append(canvas);
      try {
        const page = await pdf.getPage(number); if (this.pdf !== pdf || painting !== this.paintGeneration || !canvas.isConnected) return false;
        const view = page.getViewport({ scale }), ratio = devicePixelRatio; canvas.width = Math.ceil(view.width * ratio); canvas.height = Math.ceil(view.height * ratio); canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
        const task = page.render({ canvas, viewport: view, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }); this.renders.set(number, task); await task.promise;
        if (canvas.isConnected) { canvas.dataset.ready = 'true'; canvas.dataset.generation = String(generation); return true; }
      } catch (error) { if ((error as Error).name !== 'RenderingCancelledException' && this.pdf === pdf && canvas.isConnected) { this.message(`页面预览失败：${(error as Error).message}`); this.finishBusy(); } }
      return false;
    };
    for (let index = 1; index <= pdf.numPages; index++) { const element = document.createElement('div'); element.className = 'print-page'; element.dataset.page = String(index); element.setAttribute('aria-label', `第 ${index} 页`); element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`; pages.append(element); }
    if (previous && Math.abs(parseFloat(previous.style.width) - viewport.width) < 1 && Math.abs(parseFloat(previous.style.height) - viewport.height) < 1) { previous.style.position = 'absolute'; previous.style.inset = '0'; pages.firstElementChild!.append(previous); }
    pages.scrollTop = scrollTop;
    const ready = await draw(1, pages.firstElementChild as HTMLElement);
    if (ready && previous) { previous.remove(); previous.width = previous.height = 0; }
    if (painting !== this.paintGeneration) return false;
    for (const element of pages.children) observer.observe(element);
    return ready;
  }
  private async save() {
    if (!this.id || this.get<HTMLButtonElement>('#print-save').disabled) return;
    this.get<HTMLButtonElement>('#print-save').disabled = true;
    try { const result = await window.rypota.savePdf(this.id, { ...this.preferences.fonts }); if (result.ok) this.dialog.close(); else { this.get<HTMLButtonElement>('#print-save').disabled = false; if (!result.canceled) this.message(result.message ?? '无法保存 PDF'); } }
    catch (error) { this.message((error as Error).message); this.get<HTMLButtonElement>('#print-save').disabled = false; }
  }
}
