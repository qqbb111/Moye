import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseMarkdown, walk, startOf, endOf } from '../src/markdown';
import { applyEdits, type TextEdit } from '../shared/markdown-tools';

const extensions = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const draft = /^replica-media:\/\/draft\/([a-f0-9]{64}\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico))$/i;
const limit = 20 * 1024 * 1024;
const portablePath = (file: string) => file.replaceAll('\\', '/').replace(/[% #?()[\]<>]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());

export class ImageAttachments {
  constructor(readonly directory: string, private write: (file: string, bytes: Buffer) => Promise<void>) {}
  file(url: string) { const match = draft.exec(url); return match ? path.join(this.directory, match[1]) : null; }
  async put(bytes: Buffer, name: string) {
    if (!extensions.test(name) || bytes.length > limit || !bytes.length) throw new Error('图片格式或大小不受支持（最大 20 MB）');
    const extension = path.extname(name).toLowerCase().replace('.jpeg', '.jpg'); const digest = createHash('sha256').update(bytes).digest('hex');
    const filename = digest + extension; await fs.mkdir(this.directory, { recursive: true });
    const destination = path.join(this.directory, filename);
    if (!await fs.access(destination).then(() => true, () => false)) await this.write(destination, bytes);
    return `replica-media://draft/${filename}`;
  }
  async materialize(source: string, target?: string, previousFile?: string | null) {
    const edits: TextEdit[] = []; const images: Array<{ from: number; to: number; url: string }> = [];
    const ast = parseMarkdown(source); const referenced = new Set<string>();
    walk(ast, node => { if (node.type === 'imageReference') referenced.add(node.identifier!); });
    walk(ast, node => { if (node.type === 'image' || (node.type === 'definition' && referenced.has(node.identifier!))) { if (node.url) images.push({ from: startOf(node), to: endOf(node), url: node.url }); } });
    for (const image of images) {
      const embedded = /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp|x-icon);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(image.url);
      let cached = this.file(image.url); let name = '';
      if (embedded) {
        const bytes = Buffer.from(embedded[2], 'base64');
        if (bytes.length > limit || !bytes.length || bytes.toString('base64').replace(/=+$/, '') !== embedded[2].replace(/=+$/, '')) throw new Error('内嵌图片数据不完整，已保留原文');
        name = `image.${embedded[1].toLowerCase().replace('svg+xml', 'svg').replace('x-icon', 'ico')}`;
        cached = this.file(await this.put(bytes, name));
      }
      if (!cached && target && previousFile && path.resolve(path.dirname(previousFile)) !== path.resolve(path.dirname(target)) && !/^(?:[a-z][\w+.-]*:|[/\\])/i.test(image.url)) {
        const candidate = path.resolve(path.dirname(previousFile), decodeURIComponent(image.url));
        if (extensions.test(candidate)) { try { const bytes = await fs.readFile(candidate); cached = this.file(await this.put(bytes, path.basename(candidate))); } catch { /* Preserve pre-existing broken links when saving a document. */ } }
      }
      if (!cached) continue;
      let url = `replica-media://draft/${path.basename(cached)}`;
      if (target) {
        const directory = path.join(path.dirname(target), `${path.basename(target, path.extname(target))}.assets`); await fs.mkdir(directory, { recursive: true });
        const destination = path.join(directory, path.basename(cached));
        if (!await fs.access(destination).then(() => true, () => false)) await this.write(destination, await fs.readFile(cached));
        url = portablePath(path.relative(path.dirname(target), destination));
      }
      const raw = source.slice(image.from, image.to); const offset = raw.indexOf(image.url);
      if (offset >= 0 && url !== image.url) edits.push({ from: image.from + offset, to: image.from + offset + image.url.length, insert: url });
    }
    return applyEdits(source, edits);
  }
}
