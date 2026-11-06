import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DocumentView, WorkspaceView } from '../shared/types';
import { tidyChineseMarkdown, applyEdits } from '../shared/markdown-tools';
import { ImageAttachments } from './images';

interface DocumentRecord extends DocumentView {
  savedContent: string;
  diskHash: string | null;
  eol: '\n' | '\r\n';
  bom: boolean;
}
interface WindowRecord { id: string; documentIds: string[]; activeId: string | null }
interface Snapshot { version: 1; documents: DocumentRecord[]; windows: WindowRecord[]; recent: string[]; preferences: WorkspaceView['preferences'] }
export class FileConflictError extends Error { constructor(message = '文件已被其他程序修改。当前编辑内容已保留，请选择另存为或确认覆盖。') { super(message); this.name = 'FileConflictError'; } }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const pathKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export async function atomicWrite(target: string, contents: Buffer | string) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.rypota-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close(); handle = undefined;
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, target); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(30 * (attempt + 1));
      }
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
function decode(bytes: Buffer) {
  if (bytes.length > 10 * 1024 * 1024) throw new Error('第一版支持 10 MB 以内的 Markdown 文件。');
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes); }
  catch { throw new Error('这个文件不是 UTF-8 编码，请先转换为 UTF-8 后打开。'); }
  return { content: content.replace(/\r\n/g, '\n'), eol: (content.includes('\r\n') ? '\r\n' : '\n') as '\n' | '\r\n', bom };
}

export class DocumentStore {
  readonly documents = new Map<string, DocumentRecord>();
  readonly windows = new Map<string, WindowRecord>();
  readonly images: ImageAttachments;
  recent: string[] = [];
  preferences: WorkspaceView['preferences'] = { autoSave: true, theme: 'workbuddy', fontSize: 16, sidebar: false, tabs: true, focus: false, typewriter: false, codeTheme: 'github-dark', codeWrap: true, readingWidth: 900, sidebarWidth: 256, appearanceRevision: 1 };
  recovered = false;
  onChanged: () => void = () => {};
  onError: (message: string) => void = () => {};
  private persistTimer?: ReturnType<typeof setTimeout>;
  private autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private writes = new Map<string, Promise<unknown>>();
  private persistence: Promise<unknown> = Promise.resolve();
  private counter = 0;
  constructor(readonly directory: string, private delays = { autoSave: 1200, recovery: 250 }) { this.images = new ImageAttachments(path.join(directory, 'assets'), atomicWrite); }
  get sessionPath() { return path.join(this.directory, 'workspace.json'); }
  async initialize() {
    await fs.mkdir(path.join(this.directory, 'backups'), { recursive: true });
    let snapshot: Snapshot | null = null;
    for (const candidate of [this.sessionPath, `${this.sessionPath}.bak`]) {
      try {
        const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as Snapshot;
        if (parsed.version !== 1 || !Array.isArray(parsed.documents) || !Array.isArray(parsed.windows)) throw new Error('恢复文件格式不正确');
        snapshot = parsed; break;
      } catch (error) { if (!missing(error)) this.onError('恢复记录无法读取，正在尝试备份。原有文件已保留。'); }
    }
    if (!snapshot) return;
    this.recovered = true;
    this.preferences = { ...this.preferences, ...snapshot.preferences };
    const migrateAppearance = (snapshot.preferences?.appearanceRevision ?? 0) < 1;
    if (migrateAppearance) Object.assign(this.preferences, { theme: 'workbuddy', codeTheme: 'github-dark', codeWrap: true, readingWidth: 900, appearanceRevision: 1 });
    let migratedImages = false;
    this.recent = Array.isArray(snapshot.recent) ? snapshot.recent.filter(x => typeof x === 'string').slice(0, 12) : [];
    for (const item of snapshot.documents) {
      if (typeof item.id !== 'string' || typeof item.content !== 'string' || typeof item.savedContent !== 'string') continue;
      const document: DocumentRecord = { ...item, dirty: item.content !== item.savedContent || (!item.path && item.content.length > 0), status: item.path && item.content === item.savedContent ? 'saved' : 'draft', error: null, draftRevision: item.revision, draftSavedAt: item.draftSavedAt ?? Date.now() };
      if (document.path) {
        try {
          const bytes = await fs.readFile(document.path);
          const currentHash = hash(bytes);
          if (document.dirty && document.diskHash !== currentHash) { document.status = 'conflict'; document.error = '磁盘内容与恢复的草稿不同，已保留草稿。请另存为或手动保存。'; }
          else if (!document.dirty && document.diskHash !== currentHash) {
            Object.assign(document, decode(bytes), { diskHash: currentHash });
            document.savedContent = document.content; document.revision++; document.savedRevision = document.revision;
          }
        } catch { document.status = 'error'; document.error = '原文件暂时无法读取，已恢复本地内容。可以另存为。'; document.dirty = true; }
      }
      if (!document.path && /data:image\//i.test(document.content)) {
        try { const content = await this.images.materialize(document.content); if (content !== document.content) { document.content = content; document.revision++; document.dirty = true; document.status = 'draft'; migratedImages = true; } }
        catch { this.onError('部分草稿图片暂时无法转成附件，原始数据仍已保留。'); }
      }
      this.documents.set(document.id, document);
    }
    const owned = new Set<string>();
    for (const item of snapshot.windows) {
      if (typeof item.id !== 'string' || !Array.isArray(item.documentIds)) continue;
      const ids = item.documentIds.filter(id => this.documents.has(id) && !owned.has(id));
      ids.forEach(id => owned.add(id));
      this.windows.set(item.id, { id: item.id, documentIds: ids, activeId: ids.includes(item.activeId ?? '') ? item.activeId : ids[0] ?? null });
    }
    if (migratedImages || migrateAppearance) await this.persist();
  }
  newWindow() {
    const window: WindowRecord = { id: randomUUID(), documentIds: [], activeId: null };
    this.windows.set(window.id, window); this.changed(); return window.id;
  }
  newDocument(windowId: string, content = '', title?: string) {
    const window = this.requireWindow(windowId);
    const id = randomUUID();
    const document: DocumentRecord = { id, title: title ?? `未命名 ${++this.counter}`, path: null, content, savedContent: '', revision: 0, savedRevision: -1, dirty: content.length > 0, updatedAt: Date.now(), savedAt: null, draftRevision: -1, draftSavedAt: null, status: 'draft', error: null, diskHash: null, eol: '\n', bom: false };
    this.documents.set(id, document); window.documentIds.push(id); window.activeId = id; this.changed(); return id;
  }
  async openFile(windowId: string, file: string) {
    const existing = this.findByPath(file);
    if (existing) { const owner = this.owner(existing.id); if (owner) return { id: existing.id, windowId: owner }; this.restore(windowId, existing.id); return { id: existing.id, windowId }; }
    const bytes = await fs.readFile(file); const decoded = decode(bytes);
    const id = this.newDocument(windowId, decoded.content, path.basename(file));
    const document = this.documents.get(id)!;
    Object.assign(document, decoded, { path: path.resolve(file), savedContent: decoded.content, diskHash: hash(bytes), savedRevision: 0, dirty: false, status: 'saved', savedAt: Date.now() });
    this.touchRecent(file); this.changed(); return { id, windowId };
  }
  findByPath(file: string) { return [...this.documents.values()].find(doc => doc.path && pathKey(doc.path) === pathKey(file)); }
  async refreshFromDisk(id: string) {
    const document = this.documents.get(id); if (!document?.path || document.dirty || document.status === 'saving') return;
    const revision = document.revision; const bytes = await fs.readFile(document.path);
    const latest = this.documents.get(id);
    if (latest !== document || latest.revision !== revision || latest.dirty || latest.status === 'saving' || hash(bytes) === latest.diskHash) return;
    const decoded = decode(bytes); Object.assign(document, decoded, { savedContent: decoded.content, diskHash: hash(bytes), revision: revision + 1, savedRevision: revision + 1, updatedAt: Date.now(), savedAt: Date.now(), status: 'saved', error: null }); this.changed();
  }
  owner(id: string) { return [...this.windows.values()].find(window => window.documentIds.includes(id))?.id; }
  activate(windowId: string, id: string) { this.requireDocument(windowId, id); this.requireWindow(windowId).activeId = id; this.changed(); }
  reorderDocuments(windowId: string, ids: string[]) {
    const window = this.requireWindow(windowId);
    if (!Array.isArray(ids) || ids.length !== window.documentIds.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !window.documentIds.includes(id))) throw new Error('标签顺序不正确，请重试');
    if (ids.every((id, index) => window.documentIds[index] === id)) return;
    window.documentIds = [...ids]; this.changed();
  }
  update(windowId: string, id: string, content: string, revision: number) {
    const document = this.requireDocument(windowId, id);
    if (!Number.isSafeInteger(revision) || revision <= document.revision || typeof content !== 'string') return;
    document.content = content; document.revision = revision; document.updatedAt = Date.now();
    document.dirty = document.path ? content !== document.savedContent : content.length > 0;
    if (document.status !== 'conflict' && document.status !== 'error') document.status = document.dirty || !document.path ? 'draft' : 'saved';
    const previous = this.autoTimers.get(id); if (previous) clearTimeout(previous);
    if (this.preferences.autoSave && document.path && document.dirty && !document.error) {
      this.autoTimers.set(id, setTimeout(() => { this.autoTimers.delete(id); void this.save(id).catch(() => {}); }, this.delays.autoSave));
    }
    this.changed();
  }
  async save(id: string, destination?: string, overwrite = false) {
    const preceding = this.writes.get(id) ?? Promise.resolve();
    const task = preceding.catch(() => {}).then(async () => {
      const document = this.documents.get(id); if (!document) throw new Error('文档已关闭');
      const target = destination ? path.resolve(destination) : document.path;
      if (!target) throw new Error('请先选择保存位置');
      const duplicate = this.findByPath(target); if (duplicate && duplicate.id !== id) throw new Error('这个文件已在其他标签页打开，请选择不同的保存位置。');
      const original = document.content; const revision = document.revision;
      const samePath = document.path && pathKey(document.path) === pathKey(target);
      document.status = 'saving'; this.onChanged();
      try {
        let disk: Buffer | null = null;
        try { disk = await fs.readFile(target); } catch (error) { if (!missing(error)) throw error; }
        if (samePath && !overwrite && (!disk || hash(disk) !== document.diskHash)) throw new FileConflictError();
        if (samePath && disk) {
          const backup = path.join(this.directory, 'backups', `${id}.md`);
          try { await fs.writeFile(backup, disk, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        let content = await this.images.materialize(original, target, document.path);
        if (this.preferences.formatOnSave) content = applyEdits(content, tidyChineseMarkdown(content));
        const output = Buffer.from((document.bom ? '\uFEFF' : '') + content.replace(/\r\n/g, '\n').replace(/\n/g, document.eol), 'utf8');
        await atomicWrite(target, output);
        document.path = target; document.title = path.basename(target); document.diskHash = hash(output);
        if (document.revision === revision && document.content === original && content !== original) { document.content = content; document.revision++; }
        document.savedContent = content; document.savedRevision = document.content === content ? document.revision : revision; document.savedAt = Date.now();
        document.dirty = document.content !== content; document.status = document.dirty ? 'draft' : 'saved'; document.error = null;
        if (document.dirty && this.preferences.autoSave && this.owner(id) && !this.autoTimers.has(id)) this.autoTimers.set(id, setTimeout(() => { this.autoTimers.delete(id); void this.save(id).catch(() => {}); }, this.delays.autoSave));
        this.touchRecent(target); this.changed();
      } catch (error) {
        document.status = error instanceof FileConflictError ? 'conflict' : 'error';
        document.error = error instanceof FileConflictError ? error.message : `保存失败：${(error as Error).message}`;
        this.changed(); throw error;
      }
    });
    this.writes.set(id, task);
    try { await task; } finally { if (this.writes.get(id) === task) this.writes.delete(id); }
  }
  async organizeImages(windowId: string, id: string) {
    const document = this.requireDocument(windowId, id); const original = document.content; const revision = document.revision;
    const content = await this.images.materialize(original, document.path ?? undefined, document.path);
    if (document.content !== original || document.revision !== revision) throw new Error('整理期间文档发生了变化，请重试');
    if (content !== original) this.update(windowId, id, content, revision + 1);
    await this.persist();
  }
  async closeDocument(windowId: string, id: string) {
    const document = this.requireDocument(windowId, id);
    const timer = this.autoTimers.get(id); if (timer) clearTimeout(timer); this.autoTimers.delete(id);
    if (document.path && document.dirty && this.preferences.autoSave && !document.error) await this.save(id).catch(() => {});
    const window = this.requireWindow(windowId); const index = window.documentIds.indexOf(id);
    window.documentIds.splice(index, 1);
    if (window.activeId === id) window.activeId = window.documentIds[Math.min(index, window.documentIds.length - 1)] ?? null;
    if ((!document.dirty && document.path) || (!document.path && !document.content)) this.documents.delete(id);
    this.changed(); await this.persist();
  }
  restore(windowId: string, id: string) {
    const document = this.documents.get(id); if (!document) throw new Error('找不到这个草稿');
    if (this.owner(id)) throw new Error('这个文档已经在一个窗口中打开');
    const window = this.requireWindow(windowId); window.documentIds.push(id); window.activeId = id; this.changed();
  }
  moveDocument(windowId: string, id: string, destinationWindowId: string) {
    this.requireDocument(windowId, id);
    const source = this.requireWindow(windowId); const destination = this.requireWindow(destinationWindowId);
    source.documentIds = source.documentIds.filter(value => value !== id); source.activeId = source.documentIds[0] ?? null;
    destination.documentIds.push(id); destination.activeId = id; this.changed();
  }
  removeWindow(windowId: string) {
    const window = this.requireWindow(windowId);
    for (const id of window.documentIds) { const document = this.documents.get(id); if (document && document.path && !document.dirty) this.documents.delete(id); }
    this.windows.delete(windowId); this.changed();
  }
  setPreferences(preferences: Partial<WorkspaceView['preferences']>) {
    if (typeof preferences.autoSave === 'boolean') this.preferences.autoSave = preferences.autoSave;
    if (typeof preferences.formatOnSave === 'boolean') this.preferences.formatOnSave = preferences.formatOnSave;
    if (typeof preferences.codeWrap === 'boolean') this.preferences.codeWrap = preferences.codeWrap;
    for (const [key, minimum, maximum] of [['readingWidth', 640, 1200], ['sidebarWidth', 200, 420]] as const) {
      const value = preferences[key]; if (typeof value === 'number' && Number.isFinite(value)) this.preferences[key] = Math.round(Math.max(minimum, Math.min(maximum, value)));
    }
    if (preferences.theme === 'light' || preferences.theme === 'dark' || preferences.theme === 'copilot' || preferences.theme === 'workbuddy') this.preferences.theme = preferences.theme;
    if (preferences.codeTheme === 'modern-dark' || preferences.codeTheme === 'vscode' || preferences.codeTheme === 'github-dark') this.preferences.codeTheme = preferences.codeTheme;
    if (typeof preferences.fontSize === 'number' && Number.isFinite(preferences.fontSize)) this.preferences.fontSize = Math.max(14, Math.min(24, preferences.fontSize));
    for (const key of ['sidebar', 'tabs', 'focus', 'typewriter'] as const) if (typeof preferences[key] === 'boolean') this.preferences[key] = preferences[key];
    if (!this.preferences.autoSave) { for (const timer of this.autoTimers.values()) clearTimeout(timer); this.autoTimers.clear(); }
    else for (const document of this.documents.values()) {
      if (!document.path || !document.dirty || document.error || this.autoTimers.has(document.id) || !this.owner(document.id)) continue;
      this.autoTimers.set(document.id, setTimeout(() => { this.autoTimers.delete(document.id); void this.save(document.id).catch(() => {}); }, this.delays.autoSave));
    }
    this.changed();
  }
  view(windowId: string): WorkspaceView {
    const window = this.requireWindow(windowId);
    return { windowId, documents: window.documentIds.map(id => this.publicDocument(this.documents.get(id)!)), activeId: window.activeId, drafts: [...this.documents.values()].filter(doc => !this.owner(doc.id) && doc.dirty).map(doc => this.publicDocument(doc)), recent: [...this.recent], preferences: { ...this.preferences }, recovered: this.recovered };
  }
  private publicDocument(document: DocumentRecord): DocumentView {
    const { savedContent, diskHash, eol, bom, ...view } = document; return { ...view };
  }
  private snapshot(): Snapshot { return { version: 1, documents: [...this.documents.values()].map(doc => ({ ...doc })), windows: [...this.windows.values()].map(window => ({ ...window, documentIds: [...window.documentIds] })), preferences: { ...this.preferences }, recent: [...this.recent] }; }
  async persist() {
    const task = this.persistence.catch(() => {}).then(async () => {
      const snapshot = this.snapshot(); const now = Date.now();
      snapshot.documents.forEach(doc => { doc.draftRevision = doc.revision; doc.draftSavedAt = now; });
      try {
        const previous = await fs.readFile(this.sessionPath, 'utf8');
        let valid = false;
        try { const value = JSON.parse(previous); valid = value.version === 1 && Array.isArray(value.documents) && Array.isArray(value.windows); } catch {}
        if (valid) await atomicWrite(`${this.sessionPath}.bak`, previous);
      } catch (error) { if (!missing(error)) throw error; }
      await atomicWrite(this.sessionPath, JSON.stringify(snapshot));
      snapshot.documents.forEach(saved => { const current = this.documents.get(saved.id); if (current) { current.draftRevision = Math.max(current.draftRevision, saved.revision); current.draftSavedAt = now; } });
      this.onChanged();
    });
    this.persistence = task;
    try { await task; } catch (error) { this.onError(`草稿保存失败，请及时手动保存：${(error as Error).message}`); throw error; }
  }
  async flush(saveFiles = true) {
    if (this.persistTimer) clearTimeout(this.persistTimer); this.persistTimer = undefined;
    for (const timer of this.autoTimers.values()) clearTimeout(timer); this.autoTimers.clear();
    if (saveFiles && this.preferences.autoSave) await Promise.all([...this.documents.values()].filter(doc => doc.path && doc.dirty && !doc.error).map(doc => this.save(doc.id).catch(() => {})));
    await Promise.allSettled([...this.writes.values()]); await this.persist();
  }
  dispose() { if (this.persistTimer) clearTimeout(this.persistTimer); for (const timer of this.autoTimers.values()) clearTimeout(timer); this.autoTimers.clear(); }
  private requireWindow(id: string) { const window = this.windows.get(id); if (!window) throw new Error('窗口已关闭'); return window; }
  private requireDocument(windowId: string, id: string) { if (!this.requireWindow(windowId).documentIds.includes(id)) throw new Error('这个文档不属于当前窗口'); return this.documents.get(id)!; }
  private touchRecent(file: string) { this.recent = [path.resolve(file), ...this.recent.filter(item => pathKey(item) !== pathKey(file))].slice(0, 12); }
  private changed() { this.onChanged(); if (this.persistTimer) clearTimeout(this.persistTimer); this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.persist().catch(() => {}); }, this.delays.recovery); }
}
