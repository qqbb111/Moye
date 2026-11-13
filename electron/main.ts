import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DocumentStore, FileConflictError, atomicWrite } from './store';
import { readDocumentImage } from './images';
import type { ActionResult, AppCommand, SaveMode, UpdateAction, WorkspaceUpdate } from '../shared/types';
import type { DocumentReference } from '../shared/types';
import { BUILTIN_CODE_THEMES } from '../shared/code-theme';
import { VscodeThemeSync } from './vscode-theme';
import { APP_ID, APP_NAME, LEGACY_DATA_DIRECTORY } from '../shared/branding';
import { repairWindowsShortcuts } from './windows-integration';
import { PdfPreviews } from './pdf';
import { validatePrintOptions, printPreferences } from '../shared/print';
import { PortableUpdates } from './portable-updates';

app.setName(APP_NAME);
const appId = APP_ID;
if (process.platform === 'win32') app.setAppUserModelId(appId);
// A product rename must not move recovery data or split the single-instance lock.
app.setPath('userData', process.env.TYPORA_REPLICA_USER_DATA ? path.resolve(process.env.TYPORA_REPLICA_USER_DATA) : path.join(app.getPath('appData'), LEGACY_DATA_DIRECTORY));
const appIconPath = app.isPackaged ? path.join(path.dirname(process.execPath), 'moye.ico') : path.resolve(__dirname, '../assets/replica.ico');
protocol.registerSchemesAsPrivileged([
  { scheme: 'replica', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'replica-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const windows = new Map<string, BrowserWindow>();
const deliveredRevisions = new Map<string, Map<string, number>>();
const pdfPreviews = new PdfPreviews();
const allowedClose = new Set<number>();
const closing = new Set<number>();
const pendingClose = new Map<string, { sender: number; finish: (prepared: boolean) => void }>();
const folders = new Map<string, string>();
const folderNavigation = new Map<string, symbol>();
const fileWatchers = new Map<string, { file: string; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> }>();
const store = new DocumentStore(path.join(app.getPath('userData'), 'recovery'));
const devUrl = process.env.TYPORA_REPLICA_DEV_URL;
const assetRoot = path.resolve(__dirname, '../dist');
let quitting = false;
let quitInProgress = false;
let closingInOrder: Promise<void> = Promise.resolve();
let updateRequest = (url: string, options: RequestInit) => net.fetch(url, options);
const updates = new PortableUpdates({ version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'),
  supported: app.isPackaged && process.platform === 'win32' && process.arch === 'x64', request: (url, options) => updateRequest(url, options),
  changed: state => { for (const window of windows.values()) if (!window.isDestroyed()) window.webContents.send('update:state', state); },
});
const codeTheme = new VscodeThemeSync(() => publish());
function workspaceChrome(id: string) {
  const theme = store.preferences.codeTheme ?? 'modern-dark';
  return { maximized: windows.get(id)?.isMaximized() ?? false, codeTheme: theme === 'vscode' ? codeTheme.current : BUILTIN_CODE_THEMES[theme] };
}
function rememberRevisions(id: string, view: Pick<WorkspaceUpdate, 'documents' | 'drafts'>) {
  deliveredRevisions.set(id, new Map([...view.documents, ...view.drafts].map(doc => [doc.id, doc.revision])));
}
function newBlankWindow() { const id = store.newWindow(); store.newDocument(id); return createWindow(id); }
function relaunchCommand() { return [process.execPath, ...(!app.isPackaged ? [app.getAppPath()] : [])].map(value => `"${value}"`).join(' ') + ' --new-window'; }

function publish(edit?: Parameters<DocumentStore['onChanged']>[0]) {
  if (edit) deliveredRevisions.get(edit.windowId)?.set(edit.documentId, edit.revision);
  for (const [id, window] of windows) if (!window.isDestroyed() && store.windows.has(id)) {
    const revisions = deliveredRevisions.get(id);
    if (!revisions) continue;
    const view = store.workspaceUpdate(id, revisions);
    window.webContents.send('workspace:state', { ...view, ...workspaceChrome(id) });
    rememberRevisions(id, view);
  }
  for (const [id, item] of fileWatchers) if (!store.owner(id) || store.documents.get(id)?.path !== item.file) { item.watcher.close(); clearTimeout(item.timer); fileWatchers.delete(id); }
  for (const document of store.documents.values()) if (document.path && store.owner(document.id) && !fileWatchers.has(document.id)) {
    try {
      const item: { file: string; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> } = { file: document.path, watcher: watch(path.dirname(document.path), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString().toLowerCase() !== path.basename(item.file).toLowerCase()) return;
        clearTimeout(item.timer); item.timer = setTimeout(() => { void store.refreshFromDisk(document.id).catch(() => {}); }, 200);
      }) }; item.watcher.on('error', () => {}); fileWatchers.set(document.id, item);
    } catch { /* Read-only filesystems can still be edited and saved explicitly. */ }
  }
}
store.onChanged = publish;
store.onError = message => { for (const window of windows.values()) if (!window.isDestroyed()) window.webContents.send('app:message', message); };
function notify(window: BrowserWindow, message: string) { if (!window.isDestroyed()) window.webContents.send('app:message', message); }
function windowIdOf(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const entry = [...windows.entries()].find(([, value]) => value === window);
  const url = event.senderFrame?.url ?? '';
  if (!entry || event.senderFrame !== event.sender.mainFrame || !(url.startsWith('replica://app/') || (devUrl && new URL(url).origin === new URL(devUrl).origin))) throw new Error('请求来源不正确');
  return entry[0];
}
function requireOwned(windowId: string, id: string) { if (typeof id !== 'string' || store.owner(id) !== windowId) throw new Error('找不到当前窗口中的文档'); }
async function collectEdits(window: BrowserWindow) {
  if (window.isDestroyed() || window.webContents.isCrashed()) return;
  const entry = [...windows].find(([, candidate]) => candidate === window);
  if (!entry || !deliveredRevisions.has(entry[0])) return;
  const token = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const finish = (prepared: boolean) => {
      clearTimeout(timer); pendingClose.delete(token);
      if (prepared) resolve(); else reject(new Error('未能收集窗口中的最新编辑，请重试'));
    };
    const timer = setTimeout(() => finish(false), 5000);
    pendingClose.set(token, { sender: window.webContents.id, finish });
    try { window.webContents.send('window:prepare-close', token); } catch { finish(false); }
  });
}
function cancelClose(window: BrowserWindow) {
  try { if (!window.isDestroyed() && !window.webContents.isCrashed()) window.webContents.send('window:cancel-close'); } catch {}
}
async function collectAndFlushWindows() {
  await closingInOrder;
  const results = await Promise.allSettled([...windows.values()].map(collectEdits));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  await store.flush();
}
function createWindow(id: string = store.newWindow()) {
  const window = new BrowserWindow({ width: 1320, height: 880, minWidth: 640, minHeight: 420, frame: false, show: false, backgroundColor: store.preferences.theme === 'light' ? '#fbfaf7' : '#1f1f1f', title: APP_NAME, icon: appIconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: process.env.TYPORA_REPLICA_TEST !== '1' } });
  windows.set(id, window);
  window.on('closed', () => deliveredRevisions.delete(id));
  window.webContents.on('did-start-loading', () => deliveredRevisions.delete(id));
  window.on('maximize', () => publish()); window.on('unmaximize', () => publish());
  if (process.platform === 'win32') window.setAppDetails({ appId, appIconPath, appIconIndex: 0, relaunchCommand: relaunchCommand(), relaunchDisplayName: APP_NAME });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => { if (process.env.TYPORA_REPLICA_TEST !== '1') window.show(); });
  window.on('focus', () => { for (const documentId of store.windows.get(id)?.documentIds ?? []) void store.refreshFromDisk(documentId).catch(() => {}); });
  window.on('close', event => {
    if (allowedClose.has(window.id) || quitting) return;
    event.preventDefault();
    if (closing.has(window.id) || quitInProgress) return;
    closing.add(window.id);
    closingInOrder = closingInOrder.then(async () => {
      try {
        await collectEdits(window);
        await store.flush();
        if (windows.size > 1) await store.removeWindow(id);
        allowedClose.add(window.id); window.close();
      } catch (error) {
        closing.delete(window.id); cancelClose(window);
        notify(window, `暂时无法安全保存草稿，窗口保持打开：${(error as Error).message}`);
      }
    });
  });
  window.on('closed', () => { pdfPreviews.dispose(id); windows.delete(id); folders.delete(id); folderNavigation.delete(id); allowedClose.delete(window.id); closing.delete(window.id); });
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer stopped:', details.reason); void store.persist().catch(() => {}); });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadURL('replica://app/index.html');
  return window;
}
async function openFile(windowId: string, file: string) {
  if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(file)) throw new Error('请选择 Markdown 或文本文件');
  const previousId = store.windows.get(windowId)?.activeId; const previous = previousId ? store.documents.get(previousId) : undefined;
  const result = await store.openFile(windowId, file);
  if (previous && !previous.path && !previous.content && result.windowId === windowId && result.id !== previous.id) void store.closeDocument(windowId, previous.id).catch(() => { /* Persistence reports its own failure. */ });
  store.activate(result.windowId, result.id);
  const target = windows.get(result.windowId)!; if (target.isMinimized()) target.restore(); target.focus();
  if (result.windowId !== windowId) notify(windows.get(windowId)!, '这份文件已经在另一个窗口打开，已切换到那个窗口。');
}
function registerIpc() {
  ipcMain.handle('update:portable', async (event, action: UpdateAction) => {
    windowIdOf(event);
    if (action === 'check') await updates.check();
    else if (action === 'download') await updates.download();
    else if (action === 'cancel') updates.cancel();
    else if (action === 'install' && !quitInProgress && !quitting) {
      quitInProgress = true;
      const installed = await updates.install(collectAndFlushWindows);
      if (installed) { quitting = true; app.quit(); }
      else { quitInProgress = false; for (const window of windows.values()) cancelClose(window); }
    }
    return updates.state;
  });
  ipcMain.handle('pdf:preview', async (event, documentId: string, html: string, options, requestId?: string) => {
    try {
      const owner = windowIdOf(event); requireOwned(owner, documentId); if (typeof html !== 'string' || html.length > 30 * 1024 * 1024) throw new Error('打印文档过大');
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId))) throw new Error('打印请求不正确');
      return await pdfPreviews.preview(owner, { ...store.documents.get(documentId)! }, html, validatePrintOptions(options), requestId);
    }
    catch (error) { return { ok: false, message: (error as Error).message }; }
  });
  ipcMain.handle('pdf:first-page-request', async (event, documentId: string, html: string, options, requestId: string) => {
    const owner = windowIdOf(event);
    requireOwned(owner, documentId);
    if (typeof html !== 'string' || html.length > 2 * 1024 * 1024 || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
    await pdfPreviews.previewFirstPage(owner, store.documents.get(documentId)!.title, html, validatePrintOptions(options), requestId, bytes => {
      if (!event.sender.isDestroyed()) event.sender.send('pdf:first-page', { requestId, documentId, bytes });
    });
  });
  ipcMain.handle('pdf:release', event => { pdfPreviews.release(windowIdOf(event)); });
  ipcMain.handle('workspace:bootstrap', event => {
    const id = windowIdOf(event);
    const view = store.view(id);
    rememberRevisions(id, view);
    return { ...view, ...workspaceChrome(id), recoveryNotices: store.recoveryNotices };
  });
  ipcMain.handle('clipboard:text', async (event, action: string, text?: string) => { windowIdOf(event); if (action === 'write' && typeof text === 'string') { await clipboard.writeText(text); return ''; } if (action === 'read') return clipboard.readText(); throw new Error('剪贴板操作不受支持'); });
  const handle = (channel: string, action: (windowId: string, ...args: any[]) => Promise<void> | void) => {
    ipcMain.handle(channel, async (event, ...args): Promise<ActionResult> => {
      try { await action(windowIdOf(event), ...args); return { ok: true }; }
      catch (error) {
        if (error instanceof FileConflictError) return { ok: false, conflict: true };
        if ((error as Error).message === 'canceled') return { ok: false, canceled: true };
        return { ok: false, message: (error as Error).message };
      }
    });
  };
  handle('pdf:save', async (owner, previewId: string, fonts) => {
    const pdf = pdfPreviews.get(owner, previewId); requireOwned(owner, pdf.documentId);
    const result = await dialog.showSaveDialog(windows.get(owner)!, { title: '保存打印 PDF', defaultPath: (pdf.path ?? pdf.title).replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) throw new Error('canceled');
    // A replacement request while the save dialog was open invalidates this job.
    pdfPreviews.get(owner, previewId); requireOwned(owner, pdf.documentId); await atomicWrite(result.filePath, pdf.bytes);
    const preferences = printPreferences({ ...store.preferences.print, ...(fonts ? { fonts } : {}) }); preferences.layout = pdf.options.layout; preferences.color = pdf.options.color; preferences.lineNumbers = pdf.options.lineNumbers; preferences.fonts[pdf.options.layout] = pdf.options.codeFontPt;
    store.setPreferences({ print: preferences }); await store.persist();
  });
  handle('document:new', id => { store.newDocument(id); });
  handle('document:activate', (windowId, id: string) => store.activate(windowId, id));
  handle('document:images', (windowId, id: string) => store.organizeImages(windowId, id));
  handle('document:reorder', async (windowId, ids: string[]) => { store.reorderDocuments(windowId, ids); await store.persist(); });
  handle('document:open', async windowId => {
    const result = await dialog.showOpenDialog(windows.get(windowId)!, { title: '打开 Markdown 文档', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown', 'mdown', 'mkd'] }, { name: '文本文件', extensions: ['txt'] }] });
    if (result.canceled) throw new Error('canceled');
    for (const file of result.filePaths) await openFile(windowId, file);
  });
  handle('document:recent', async (windowId, file: string) => { if (!store.recent.includes(file)) throw new Error('找不到这个最近使用的文件'); await openFile(windowId, file); });
  const saveAs = async (windowId: string, filename: string) => {
    const result = await dialog.showSaveDialog(windows.get(windowId)!, {
      title: '另存为', defaultPath: /\.(md|markdown|mdown|mkd|txt)$/i.test(filename) ? filename : filename + '.md',
      filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown', 'mdown', 'mkd'] }, { name: '文本文件', extensions: ['txt'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) throw new Error('canceled');
    return result.filePath;
  };
  handle('document:save', async (windowId, id: string, mode: SaveMode = 'save') => {
    if (mode !== 'save-as') requireOwned(windowId, id);
    const document = store.accessibleDocument(windowId, id);
    if (mode === 'overwrite-conflict') {
      if (!document.path || document.status !== 'conflict') throw new Error('保存状态已变化，请重新保存。');
      await store.save(id, undefined, true);
    } else if (mode === 'save-as' || !document.path) {
      const target = await saveAs(windowId, document.path ?? document.title);
      store.accessibleDocument(windowId, id);
      await store.save(id, target, true);
    } else await store.save(id);
    await store.persist();
  });
  handle('document:close', (windowId, id: string) => store.closeDocument(windowId, id));
  handle('document:restore', (windowId, id: string) => store.restore(windowId, id));
  handle('window:new', () => { newBlankWindow(); });
  handle('document:detach', (windowId, id: string) => { requireOwned(windowId, id); const destination = store.newWindow(); store.moveDocument(windowId, id, destination); createWindow(destination); });
  handle('preferences:update', async (_windowId, preferences) => {
    const previousCodeTheme = store.preferences.codeTheme;
    store.setPreferences(preferences);
    const codeThemeChanged = previousCodeTheme !== store.preferences.codeTheme;
    if (codeThemeChanged && store.preferences.codeTheme !== 'vscode') codeTheme.stop();
    publish();
    if (codeThemeChanged && store.preferences.codeTheme === 'vscode') { await codeTheme.refresh(); if (store.preferences.codeTheme === 'vscode') codeTheme.start(); }
    await store.persist();
  });
  handle('edit:paste', windowId => windows.get(windowId)!.webContents.paste());
  handle('code-theme:refresh', async () => { await codeTheme.refresh(true); publish(); });
  const folderEntries = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => !entry.isSymbolicLink() && !entry.name.startsWith('.') && (entry.isDirectory() || /\.(md|markdown|mdown|mkd|txt)$/i.test(entry.name))).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN')).map(entry => ({ name: entry.name, path: path.join(directory, entry.name), directory: entry.isDirectory() }));
  };
  const checkFolder = async (id: string, candidate: string) => {
    const root = folders.get(id); if (!root || typeof candidate !== 'string') throw new Error('请先选择文件夹');
    const real = await fs.realpath(candidate); const relative = path.relative(root, real);
    if (folders.get(id) !== root || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('文件不在当前文件夹中');
    return real;
  };
  const checkFolderFile = async (id: string, file: string) => {
    const real = await checkFolder(id, file);
    if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(real) || !(await fs.lstat(file)).isFile()) throw new Error('请选择 Markdown 或文本文件');
    return real;
  };
  const beginFolderNavigation = (id: string) => {
    const navigation = Symbol();
    folderNavigation.set(id, navigation);
    return navigation;
  };
  const selectFolder = async (id: string, input: string, navigation: symbol) => {
    const directory = await fs.realpath(input);
    const entries = await folderEntries(directory);
    if (folderNavigation.get(id) !== navigation) return null;
    folders.set(id, directory);
    return { path: directory, entries, hasParent: path.dirname(directory) !== directory };
  };
  ipcMain.handle('folder:open', async event => {
    const id = windowIdOf(event);
    const navigation = beginFolderNavigation(id);
    const result = await dialog.showOpenDialog(windows.get(id)!, { title: '打开文件夹', defaultPath: folders.get(id), properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return selectFolder(id, result.filePaths[0], navigation);
  });
  ipcMain.handle('folder:parent', async (event, current: string) => {
    const id = windowIdOf(event), root = folders.get(id);
    if (!root || root !== current) return null;
    const parent = path.dirname(root);
    return parent === root ? null : selectFolder(id, parent, beginFolderNavigation(id));
  });
  ipcMain.handle('folder:child', async (event, current: string, child: string) => {
    const id = windowIdOf(event), root = folders.get(id);
    if (!root || root !== current) return null;
    const navigation = beginFolderNavigation(id);
    const directory = await checkFolder(id, child);
    if (directory === root || !(await fs.stat(directory)).isDirectory()) throw new Error('请选择子文件夹');
    return selectFolder(id, directory, navigation);
  });
  ipcMain.handle('folder:list', async (event, directory: string) => folderEntries(await checkFolder(windowIdOf(event), directory)));
  handle('folder:file', async (id, file: string) => openFile(id, await checkFolderFile(id, file)));
  handle('document:rename', async (windowId, reference: DocumentReference, name: string) => {
    if ('id' in reference) await store.renameDocument(windowId, reference.id, name);
    else await store.renameFolderFile(windowId, await checkFolderFile(windowId, reference.path), name);
    await store.persist();
  });
  handle('document:reveal', async (windowId, reference: DocumentReference) => {
    const file = 'id' in reference ? store.accessibleDocument(windowId, reference.id).path : await checkFolderFile(windowId, reference.path);
    if (!file || !(await fs.stat(file).catch(() => null))?.isFile()) throw new Error('找不到磁盘上的原文件');
    shell.showItemInFolder(file);
  });
  handle('folder:file-save-as', async (windowId, file: string) => {
    const source = await checkFolderFile(windowId, file);
    const target = await saveAs(windowId, source);
    await store.saveFolderFileCopy(await checkFolderFile(windowId, file), target);
    await store.persist();
  });
  ipcMain.handle('image:insert', async (event, id: string, data?: { bytes: number[]; name: string }) => {
    try {
      const owner = windowIdOf(event); requireOwned(owner, id); const doc = store.documents.get(id)!;
      let bytes: Buffer; let name: string;
      if (data) {
        if (!Array.isArray(data.bytes) || data.bytes.length > 20 * 1024 * 1024 || !/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(data.name)) throw new Error('图片格式或大小不受支持');
        bytes = Buffer.from(data.bytes); name = path.basename(data.name);
      } else {
        const result = await dialog.showOpenDialog(windows.get(owner)!, { title: '插入图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'] }] });
        if (result.canceled || !result.filePaths[0]) return {};
        name = path.basename(result.filePaths[0]); bytes = await fs.readFile(result.filePaths[0]);
        if (bytes.length > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
      }
      return { url: await store.images.put(bytes, name) };
    } catch (error) { return { message: (error as Error).message }; }
  });
  handle('document:export-html', async (id, docId: string, html: string) => {
    requireOwned(id, docId); if (typeof html !== 'string' || html.length > 30 * 1024 * 1024) throw new Error('无法导出此文档');
    const doc = store.documents.get(docId)!; const result = await dialog.showSaveDialog(windows.get(id)!, { title: '导出 HTML', defaultPath: (doc.path ?? doc.title).replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') + '.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (result.canceled || !result.filePath) throw new Error('canceled');
    for (const match of [...html.matchAll(/src="(replica-media:[^"]+)"/g)]) {
      const response = await net.fetch(match[1].replaceAll('&amp;', '&')); if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer()); const mime = response.headers.get('content-type') ?? 'image/png';
      html = html.replace(match[1], `data:${mime};base64,${bytes.toString('base64')}`);
    }
    await atomicWrite(result.filePath, html);
  });
  handle('link:open', async (_windowId, url: string) => { const parsed = new URL(url); if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error('暂不支持打开这类链接'); await shell.openExternal(parsed.href); });
  ipcMain.on('document:update', (event, payload) => { try { const id = windowIdOf(event); if (!payload || typeof payload.content !== 'string') return; store.update(id, payload.id, payload.content, payload.revision, true); } catch (error) { console.error('Update rejected:', (error as Error).message); } });
  ipcMain.on('window:ready-close', (event, token: string, prepared: boolean) => {
    const pending = pendingClose.get(token);
    if (pending?.sender !== event.sender.id || typeof prepared !== 'boolean') return;
    try { windowIdOf(event); pending.finish(prepared); } catch {}
  });
  ipcMain.on('window:control', (event, action: string) => {
    try { const window = windows.get(windowIdOf(event))!; if (action === 'minimize') window.minimize(); else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize(); else if (action === 'close') window.close(); } catch {}
  });
  ipcMain.on('window:fullscreen', event => { const window = windows.get(windowIdOf(event))!; window.setFullScreen(!window.isFullScreen()); });
}
function installMenu() {
  // The visible menu and shortcuts belong to the renderer. Native accelerators
  // otherwise consume keys before the Markdown and embedded code editors see them.
  Menu.setApplicationMenu(null);
}
async function registerProtocols() {
  protocol.handle('replica', async request => {
    const url = new URL(request.url); const file = path.resolve(assetRoot, `.${decodeURIComponent(url.pathname)}`);
    if (url.hostname !== 'app' || !file.startsWith(assetRoot + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  protocol.handle('replica-media', async request => {
    const missing = () => new Response('Not found', { status: 404 });
    try {
      if (request.method !== 'GET') return missing();
      const url = new URL(request.url);
      let image;
      if (url.hostname === 'draft') {
        image = await store.images.readDraft(url.href);
      } else if (url.hostname === 'document') {
        const [id, ...parts] = url.pathname.slice(1).split('/');
        const document = store.documents.get(id);
        if (document?.path && store.owner(id)) image = await readDocumentImage(document.path, decodeURIComponent(parts.join('/')), document.content);
      }
      if (!image) return missing();
      return new Response(new Uint8Array(image.bytes), {
        headers: {
          'Content-Type': image.mime, 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        },
      });
    } catch { return missing(); }
  });
}
const initialFiles = process.argv.filter(arg => /\.(md|markdown|mdown|mkd)$/i.test(arg)).map(file => path.resolve(file));
let launchReady = false;
const queuedLaunches: Array<{ argv: string[]; cwd: string }> = [];
function handleLaunch(argv: string[], cwd: string) {
  if (!launchReady) { queuedLaunches.push({ argv, cwd }); return; }
  if (argv.includes('--quit-for-update')) { app.quit(); return; }
  if (quitting || quitInProgress) return;
  const files = argv.filter(arg => /\.(md|markdown|mdown|mkd)$/i.test(arg));
  const target = [...windows.keys()][0];
  if (!files.length || argv.includes('--new-window') || !target) newBlankWindow();
  if (files.length) { const destination = argv.includes('--new-window') || !target ? [...windows.keys()].at(-1)! : target; for (const file of files) void openFile(destination, path.resolve(cwd, file)).catch(error => notify(windows.get(destination)!, error.message)); }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, cwd) => handleLaunch(argv, cwd));
  void app.whenReady().then(async () => {
    if (process.platform === 'win32' && app.isPackaged && !process.env.TYPORA_REPLICA_USER_DATA && process.env.TYPORA_REPLICA_TEST !== '1') {
      void repairWindowsShortcuts(shell, process.execPath, app.getPath('appData'), appIconPath).catch(error => console.error('Shortcut repair:', error));
      app.setUserTasks([{ program: process.execPath, arguments: '--new-window', iconPath: appIconPath, iconIndex: 0, title: '新建窗口', description: '新建一个墨页窗口' }]);
    }
    await store.initialize(); await updates.takeResult(); if (store.preferences.codeTheme === 'vscode') { await codeTheme.refresh(); codeTheme.start(); }
    await registerProtocols(); registerIpc(); installMenu();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (!store.windows.size) { const id = store.newWindow(); store.newDocument(id); }
    for (const id of store.windows.keys()) createWindow(id);
    if (process.argv.includes('--new-window') && [...store.documents.values()].some(doc => doc.path || doc.content)) newBlankWindow();
    if (process.env.TYPORA_REPLICA_TEST === '1') (globalThis as any).__replicaTest = { store, windows, openFile, createWindow, relaunchCommand, codeTheme, appId, appIconPath, repairWindowsShortcuts, pdfPreviews, setUpdateRequest: (request: typeof updateRequest) => { updateRequest = request; } };
    const target = process.argv.includes('--new-window') ? [...windows.keys()].at(-1)! : [...windows.keys()][0]; for (const file of initialFiles) await openFile(target, file).catch(error => notify(windows.get(target)!, error.message));
    launchReady = true; for (const request of queuedLaunches.splice(0)) handleLaunch(request.argv, request.cwd);
  }).catch(error => { console.error(error); dialog.showErrorBox(`${APP_NAME} 无法启动`, error.message); app.exit(1); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    void (async () => {
      try { await collectAndFlushWindows(); await updates.discard(); quitting = true; app.quit(); }
      catch (error) {
        quitInProgress = false;
        for (const window of windows.values()) cancelClose(window);
        store.onError(`暂时无法安全保存草稿，窗口保持打开：${(error as Error).message}`);
      }
    })();
  });
  app.on('window-all-closed', () => { quitting = true; codeTheme.stop(); for (const item of fileWatchers.values()) { item.watcher.close(); clearTimeout(item.timer); } store.dispose(); void updates.discard().finally(() => app.quit()); });
}
