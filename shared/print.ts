export type PrintLayout = 'portrait' | 'landscape-two-column';
export interface PrintOptions { layout: PrintLayout; color: 'mono' | 'light'; codeFontPt: number; lineNumbers: boolean }
export interface PrintPreferences { layout: PrintLayout; color: PrintOptions['color']; lineNumbers: boolean; fonts: Record<PrintLayout, number> }
export type PdfPreviewResult = { ok: true; previewId: string; bytes: Uint8Array } | { ok: false; canceled?: boolean; message?: string };
export interface PdfFirstPage { requestId: string; documentId: string; bytes: Uint8Array }
export function validatePrintOptions(value: unknown): PrintOptions {
  const v = value as PrintOptions;
  if (!v || !['portrait', 'landscape-two-column'].includes(v.layout) || !['mono', 'light'].includes(v.color) || typeof v.lineNumbers !== 'boolean' || !Number.isFinite(v.codeFontPt) || v.codeFontPt < 8 || v.codeFontPt > 12 || v.codeFontPt * 2 !== Math.round(v.codeFontPt * 2)) throw new Error('打印设置不正确');
  return { layout: v.layout, color: v.color, lineNumbers: v.lineNumbers, codeFontPt: v.codeFontPt };
}
export function printPreferences(value?: Partial<PrintPreferences>): PrintPreferences {
  const font = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.max(8, Math.min(12, n)) * 2) / 2 : fallback;
  return { layout: value?.layout === 'landscape-two-column' ? value.layout : 'portrait', color: value?.color === 'light' ? 'light' : 'mono', lineNumbers: value?.lineNumbers !== false, fonts: { portrait: font(value?.fonts?.portrait, 10), 'landscape-two-column': font(value?.fonts?.['landscape-two-column'], 9) } };
}
export function optionsFromPreferences(value?: PrintPreferences): PrintOptions { const p = printPreferences(value); return { layout: p.layout, color: p.color, lineNumbers: p.lineNumbers, codeFontPt: p.fonts[p.layout] }; }
export const printGeometry = (layout: PrintLayout) => ({ widthMm: layout === 'portrait' ? 210 : 297, heightMm: layout === 'portrait' ? 297 : 210, topMm: 12, bottomMm: 14, sideMm: 12, columnGapMm: 8 });
