import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseMarkdown, walk, startOf, endOf } from '../src/markdown';
import { applyEdits, type TextEdit } from '../shared/markdown-tools';

const extensions = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};
const draft = /^replica-media:\/\/draft\/([a-f0-9]{64}\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico))$/i;
const limit = 20 * 1024 * 1024;
const portablePath = (file: string) => file.replaceAll('\\', '/').replace(/[% #?()[\]<>]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const inside = (directory: string, file: string) => {
  const relative = path.relative(directory, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

async function readImage(file: string) {
  const mime = mimeTypes[path.extname(file).toLowerCase()];
  if (!mime || !(await fs.lstat(file)).isFile()) throw new Error('附件必须是受支持的普通图片文件');
  const handle = await fs.open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('图片格式或大小不受支持（最大 20 MB）');
    const bytes = Buffer.alloc(stat.size);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) throw new Error('图片读取不完整');
      length += bytesRead;
    }
    return { file, bytes, mime };
  } finally { await handle.close(); }
}

export async function readDocumentImage(documentFile: string, imagePath: string, markdown = '') {
  try {
    const directory = path.dirname(documentFile);
    // Markdown may reference Typora's root-relative images when the configured
    // root is within the directory the user opened.
    if (imagePath.startsWith('/') && !imagePath.startsWith('//')) {
      const typoraRoot = /^typora-root-url:\s*["']?([^\n"']+)/m.exec(markdown)?.[1].trim();
      if (typoraRoot) imagePath = path.join(typoraRoot, imagePath);
    }
    const candidate = path.resolve(directory, imagePath);
    if (!inside(directory, candidate) || !extensions.test(candidate)) return null;
    const relative = path.relative(directory, candidate);
    if (process.platform === 'win32' && relative.includes(':')) return null;
    const root = await fs.realpath(directory);
    const file = await fs.realpath(path.join(root, relative));
    if (!inside(root, file) || !extensions.test(file)) return null;
    return await readImage(file);
  } catch { return null; }
}

async function privateDirectory(directory: string, create: boolean) {
  const parent = path.dirname(directory);
  if (create) await fs.mkdir(parent, { recursive: true });
  const canonicalParent = await fs.realpath(parent);
  const expected = path.join(canonicalParent, path.basename(directory));
  if (create) await fs.mkdir(expected, { recursive: true });
  const canonical = await fs.realpath(expected);
  if (path.relative(expected, canonical) || !(await fs.lstat(expected)).isDirectory()) throw new Error('附件目录必须是当前文件夹内的普通目录');
  return canonical;
}

async function storedImage(directory: string, name: string) {
  const candidate = path.join(directory, name);
  const file = await fs.realpath(candidate);
  if (path.relative(candidate, file) || !(await fs.lstat(candidate)).isFile()) throw new Error('附件必须是普通文件');
  const image = await readImage(file);
  if (digest(image.bytes) !== path.parse(name).name.toLowerCase()) throw new Error('附件数据与文件名不匹配');
  return image;
}

async function writeImage(directory: string, name: string, bytes: Buffer, write: (file: string, bytes: Buffer) => Promise<void>) {
  try { await storedImage(directory, name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await write(path.join(directory, name), bytes);
  }
}

export class ImageAttachments {
  constructor(readonly directory: string, private write: (file: string, bytes: Buffer) => Promise<void>) {}
  async put(bytes: Buffer, name: string) {
    if (!extensions.test(name) || bytes.length > limit || !bytes.length) throw new Error('图片格式或大小不受支持（最大 20 MB）');
    const extension = path.extname(name).toLowerCase().replace('.jpeg', '.jpg');
    const filename = digest(bytes) + extension;
    await writeImage(await privateDirectory(this.directory, true), filename, bytes, this.write);
    return `replica-media://draft/${filename}`;
  }
  async readDraft(url: string) {
    const match = draft.exec(url);
    if (!match) return null;
    try { return await storedImage(await privateDirectory(this.directory, false), match[1]); }
    catch { return null; }
  }
  async materialize(source: string, target?: string, previousFile?: string | null) {
    const edits: TextEdit[] = []; const images: Array<{ from: number; to: number; url: string }> = [];
    const ast = parseMarkdown(source); const referenced = new Set<string>();
    walk(ast, node => { if (node.type === 'imageReference') referenced.add(node.identifier!); });
    walk(ast, node => { if (node.type === 'image' || (node.type === 'definition' && referenced.has(node.identifier!))) { if (node.url) images.push({ from: startOf(node), to: endOf(node), url: node.url }); } });
    for (const image of images) {
      const embedded = /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp|x-icon);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(image.url);
      const cached = await this.readDraft(image.url);
      let attachment = cached && { url: image.url, bytes: cached.bytes };
      if (embedded) {
        const bytes = Buffer.from(embedded[2], 'base64');
        if (bytes.length > limit || !bytes.length || bytes.toString('base64').replace(/=+$/, '') !== embedded[2].replace(/=+$/, '')) throw new Error('内嵌图片数据不完整，已保留原文');
        const name = `image.${embedded[1].toLowerCase().replace('svg+xml', 'svg').replace('x-icon', 'ico')}`;
        attachment = { url: await this.put(bytes, name), bytes };
      }
      if (!attachment && target && previousFile && path.resolve(path.dirname(previousFile)) !== path.resolve(path.dirname(target)) && !/^[a-z][\w+.-]*:/i.test(image.url)) {
        let relative = image.url;
        try { relative = decodeURIComponent(relative); } catch { /* A literal percent sign can be part of a filename. */ }
        const local = await readDocumentImage(previousFile, relative, source);
        if (local) attachment = { url: await this.put(local.bytes, path.basename(local.file)), bytes: local.bytes };
      }
      if (!attachment) continue;
      let url = attachment.url;
      if (target) {
        const filename = path.basename(url);
        const name = `${path.basename(target, path.extname(target))}.assets`;
        const directory = await privateDirectory(path.join(path.dirname(target), name), true);
        await writeImage(directory, filename, attachment.bytes, this.write);
        url = portablePath(path.join(name, filename));
      }
      const raw = source.slice(image.from, image.to); const offset = raw.indexOf(image.url);
      if (offset >= 0 && url !== image.url) edits.push({ from: image.from + offset, to: image.from + offset + image.url.length, insert: url });
    }
    return applyEdits(source, edits);
  }
}
