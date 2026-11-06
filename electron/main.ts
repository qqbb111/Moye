import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DocumentStore, FileConflictError, atomicWrite } from './store';
import type { ActionResult, AppCommand } from '../shared/types';
import { MODERN_DARK, GITHUB_DARK } from '../shared/code-theme';
import { VscodeThemeSync } from './vscode-theme';

app.setName('Typora Replica');
const appId = 'HanHan.TyporaReplica';
if (process.platform === 'win32') app.setAppUserModelId(appId);
if (process.env.TYPORA_REPLICA_USER_DATA) app.setPath('userData', path.resolve(process.env.TYPORA_REPLICA_USER_DATA));
protocol.registerSchemesAsPrivileged([
  { scheme: 'replica', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'replica-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const windows = new Map<string, BrowserWindow>();
const allowedClose = new Set<number>();
const closing = new Set<number>();
const pendingClose = new Map<string, { sender: number; resolve: () => void }>();
const folders = new Map<string, string>();
const fileWatchers = new Map<string, { file: string; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> }>();
const store = new DocumentStore(path.join(app.getPath('userData'), 'recovery'));
const devUrl = process.env.TYPORA_REPLICA_DEV_URL;
const assetRoot = path.resolve(__dirname, '../dist');
let quitting = false;
let quitInProgress = false;
const codeTheme = new VscodeThemeSync(() => publish());
function workspaceView(id: string) { return { ...store.view(id), maximized: windows.get(id)?.isMaximized() ?? false, codeTheme: store.preferences.codeTheme === 'vscode' ? codeTheme.current : store.preferences.codeTheme === 'github-dark' ? GITHUB_DARK : MODERN_DARK }; }
function newBlankWindow() { const id = store.newWindow(); store.newDocument(id); return createWindow(id); }
function relaunchCommand() { return [process.execPath, ...(!app.isPackaged ? [app.getAppPath()] : [])].map(value => `"${value}"`).join(' ') + ' --new-window'; }

function publish() {
  for (const [id, window] of windows) if (!window.isDestroyed() && store.windows.has(id)) window.webContents.send('workspace:state', workspaceView(id));
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
  const token = randomUUID();
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { pendingClose.delete(token); resolve(); }, 5000);
    pendingClose.set(token, { sender: window.webContents.id, resolve: () => { clearTimeout(timer); pendingClose.delete(token); resolve(); } });
    window.webContents.send('window:prepare-close', token);
  });
}
function createWindow(id: string = store.newWindow()) {
  const window = new BrowserWindow({ width: 1320, height: 880, minWidth: 640, minHeight: 420, frame: false, show: false, backgroundColor: '#ffffff', title: 'Typora Replica', icon: path.resolve(__dirname, '../assets/replica.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: process.env.TYPORA_REPLICA_TEST !== '1' } });
  windows.set(id, window);
  window.on('maximize', publish); window.on('unmaximize', publish);
  if (process.platform === 'win32') window.setAppDetails({ appId, appIconPath: app.isPackaged ? process.execPath : path.resolve(__dirname, '../assets/replica.ico'), appIconIndex: 0, relaunchCommand: relaunchCommand(), relaunchDisplayName: '新建 Replica 窗口' });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => { if (process.env.TYPORA_REPLICA_TEST !== '1') window.show(); });
  window.on('focus', () => { for (const documentId of store.windows.get(id)?.documentIds ?? []) void store.refreshFromDisk(documentId).catch(() => {}); });
  window.on('close', event => {
    if (allowedClose.has(window.id) || quitting) return;
    event.preventDefault();
    if (closing.has(window.id)) return;
    closing.add(window.id);
    void (async () => {
      await collectEdits(window);
      try {
        await store.flush();
        if (windows.size > 1) { store.removeWindow(id); await store.persist(); }
        allowedClose.add(window.id); window.close();
      } catch (error) { closing.delete(window.id); notify(window, `暂时无法安全保存草稿，窗口保持打开：${(error as Error).message}`); }
    })();
  });
  window.on('closed', () => { windows.delete(id); allowedClose.delete(window.id); closing.delete(window.id); });
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer stopped:', details.reason); void store.persist().catch(() => {}); });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadURL('replica://app/index.html');
  return window;
}
async function openFile(windowId: string, file: string) {
  if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(file)) throw new Error('请选择 Markdown 或文本文件');
  const previousId = store.windows.get(windowId)?.activeId; const previous = previousId ? store.documents.get(previousId) : undefined;
  const result = await store.openFile(windowId, file);
  if (previous && !previous.path && !previous.content && result.windowId === windowId && result.id !== previous.id) store.closeDocument(windowId, previous.id);
  store.activate(result.windowId, result.id);
  const target = windows.get(result.windowId)!; if (target.isMinimized()) target.restore(); target.focus();
  if (result.windowId !== windowId) notify(windows.get(windowId)!, '这份文件已经在另一个窗口打开，已切换到那个窗口。');
}
function registerIpc() {
  ipcMain.handle('workspace:bootstrap', event => workspaceView(windowIdOf(event)));
  ipcMain.handle('clipboard:text', async (event, action: string, text?: string) => { windowIdOf(event); if (action === 'write' && typeof text === 'string') { await clipboard.writeText(text); return ''; } if (action === 'read') return clipboard.readText(); throw new Error('剪贴板操作不受支持'); });
  const handle = (channel: string, action: (windowId: string, ...args: any[]) => Promise<void> | void) => {
    ipcMain.handle(channel, async (event, ...args): Promise<ActionResult> => {
      try { await action(windowIdOf(event), ...args); return { ok: true }; }
      catch (error) { if ((error as Error).message === 'canceled') return { ok: false, canceled: true }; return { ok: false, message: (error as Error).message }; }
    });
  };
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
  handle('document:save', async (windowId, id: string, saveAs = false) => {
    requireOwned(windowId, id); const document = store.documents.get(id)!;
    const chooseDestination = async () => {
      const result = await dialog.showSaveDialog(windows.get(windowId)!, { title: '保存 Markdown 文档', defaultPath: document.path ?? `${document.title}.md`, filters: [{ name: 'Markdown 文档', extensions: ['md'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
      if (result.canceled || !result.filePath) throw new Error('canceled');
      await store.save(id, result.filePath, true);
    };
    if (saveAs || !document.path) await chooseDestination();
    else {
      try { await store.save(id); }
      catch (error) {
        if (!(error instanceof FileConflictError)) throw error;
        const decision = await dialog.showMessageBox(windows.get(windowId)!, { type: 'warning', title: '磁盘文件发生了变化', message: '保留哪一份内容？', detail: '当前编辑内容已经保留为本地草稿。可以另存为新文件，或用当前内容覆盖磁盘文件。', buttons: ['另存为…', '覆盖磁盘文件', '取消'], defaultId: 0, cancelId: 2 });
        if (decision.response === 0) await chooseDestination();
        else if (decision.response === 1) await store.save(id, undefined, true);
        else throw new Error('canceled');
      }
    }
    await store.persist();
  });
  handle('document:close', (windowId, id: string) => store.closeDocument(windowId, id));
  handle('document:restore', (windowId, id: string) => store.restore(windowId, id));
  handle('window:new', () => { newBlankWindow(); });
  handle('document:detach', (windowId, id: string) => { requireOwned(windowId, id); const destination = store.newWindow(); store.moveDocument(windowId, id, destination); createWindow(destination); });
  handle('preferences:update', async (_windowId, preferences) => {
    store.setPreferences(preferences);
    if (store.preferences.codeTheme === 'vscode') { await codeTheme.refresh(); codeTheme.start(); }
    else codeTheme.stop();
    publish(); await store.persist();
  });
  handle('code-theme:refresh', async () => { await codeTheme.refresh(true); publish(); });
  const folderEntries = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => !entry.isSymbolicLink() && !entry.name.startsWith('.') && (entry.isDirectory() || /\.(md|markdown|mdown|mkd|txt)$/i.test(entry.name))).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN')).map(entry => ({ name: entry.name, path: path.join(directory, entry.name), directory: entry.isDirectory() }));
  };
  const checkFolder = async (id: string, candidate: string) => {
    const root = folders.get(id); if (!root || typeof candidate !== 'string') throw new Error('请先选择文件夹');
    const real = await fs.realpath(candidate); const relative = path.relative(root, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件不在当前文件夹中'); return real;
  };
  ipcMain.handle('folder:open', async event => {
    const id = windowIdOf(event); const result = await dialog.showOpenDialog(windows.get(id)!, { title: '打开文件夹', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = await fs.realpath(result.filePaths[0]); folders.set(id, directory); return { path: directory, entries: await folderEntries(directory) };
  });
  ipcMain.handle('folder:list', async (event, directory: string) => folderEntries(await checkFolder(windowIdOf(event), directory)));
  handle('folder:file', async (id, file: string) => openFile(id, await checkFolder(id, file)));
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
  handle('document:export', async (id, docId: string, format: string, html: string) => {
    requireOwned(id, docId); if (!['html', 'pdf'].includes(format) || typeof html !== 'string' || html.length > 30 * 1024 * 1024) throw new Error('无法导出此文档');
    const doc = store.documents.get(docId)!; const result = await dialog.showSaveDialog(windows.get(id)!, { title: `导出 ${format.toUpperCase()}`, defaultPath: (doc.path ?? doc.title).replace(/\.(md|markdown)$/i, '') + '.' + format, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (result.canceled || !result.filePath) throw new Error('canceled');
    for (const match of [...html.matchAll(/src="(replica-media:[^"]+)"/g)]) {
      const response = await net.fetch(match[1].replaceAll('&amp;', '&')); if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer()); const mime = response.headers.get('content-type') ?? 'image/png';
      html = html.replace(match[1], `data:${mime};base64,${bytes.toString('base64')}`);
    }
    if (format === 'html') { await atomicWrite(result.filePath, html); return; }
    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
    try {
      await printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await printWindow.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.complete ? Promise.resolve() : new Promise(r => { i.onload = i.onerror = r })))').catch(() => {});
      const bytes = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } }); await atomicWrite(result.filePath, bytes);
    } finally { printWindow.destroy(); }
  });
  handle('link:open', async (_windowId, url: string) => { const parsed = new URL(url); if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error('暂不支持打开这类链接'); await shell.openExternal(parsed.href); });
  ipcMain.on('document:update', (event, payload) => { try { const id = windowIdOf(event); if (!payload || typeof payload.content !== 'string') return; store.update(id, payload.id, payload.content, payload.revision); } catch (error) { console.error('Update rejected:', (error as Error).message); } });
  ipcMain.on('window:ready-close', (event, token: string) => { const pending = pendingClose.get(token); if (pending?.sender === event.sender.id) pending.resolve(); });
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
    try {
      const url = new URL(request.url);
      if (url.hostname === 'draft') { const file = store.images.file(url.href); return file ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 }); }
      const [id, ...parts] = url.pathname.slice(1).split('/'); const document = store.documents.get(id);
      if (url.hostname !== 'document' || !document?.path) return new Response('Not found', { status: 404 });
      const root = await fs.realpath(path.dirname(document.path)); let imagePath = decodeURIComponent(parts.join('/'));
      const rootSetting = /^typora-root-url:\s*["']?([^\n"']+)/m.exec(document.content)?.[1].trim();
      if (rootSetting && imagePath.startsWith('/')) imagePath = path.join(rootSetting, imagePath);
      const file = await fs.realpath(path.resolve(root, imagePath));
      if (!/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    } catch { return new Response('Not found', { status: 404 }); }
  });
}
const initialFiles = process.argv.filter(arg => /\.(md|markdown|mdown|mkd)$/i.test(arg)).map(file => path.resolve(file));
let launchReady = false;
const queuedLaunches: Array<{ argv: string[]; cwd: string }> = [];
function handleLaunch(argv: string[], cwd: string) {
  if (!launchReady) { queuedLaunches.push({ argv, cwd }); return; }
  const files = argv.filter(arg => /\.(md|markdown|mdown|mkd)$/i.test(arg));
  const target = [...windows.keys()][0];
  if (!files.length || argv.includes('--new-window') || !target) newBlankWindow();
  if (files.length) { const destination = argv.includes('--new-window') || !target ? [...windows.keys()].at(-1)! : target; for (const file of files) void openFile(destination, path.resolve(cwd, file)).catch(error => notify(windows.get(destination)!, error.message)); }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, cwd) => handleLaunch(argv, cwd));
  void app.whenReady().then(async () => {
    await store.initialize(); if (store.preferences.codeTheme === 'vscode') { await codeTheme.refresh(); codeTheme.start(); }
    await registerProtocols(); registerIpc(); installMenu();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (!store.windows.size) { const id = store.newWindow(); store.newDocument(id); }
    for (const id of store.windows.keys()) createWindow(id);
    if (process.argv.includes('--new-window') && [...store.documents.values()].some(doc => doc.path || doc.content)) newBlankWindow();
    if (process.env.TYPORA_REPLICA_TEST === '1') (globalThis as any).__replicaTest = { store, windows, openFile, createWindow, relaunchCommand, codeTheme };
    const target = process.argv.includes('--new-window') ? [...windows.keys()].at(-1)! : [...windows.keys()][0]; for (const file of initialFiles) await openFile(target, file).catch(error => notify(windows.get(target)!, error.message));
    launchReady = true; for (const request of queuedLaunches.splice(0)) handleLaunch(request.argv, request.cwd);
  }).catch(error => { console.error(error); dialog.showErrorBox('Typora Replica 无法启动', error.message); app.exit(1); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    void (async () => {
      try { await Promise.all([...windows.values()].map(collectEdits)); await store.flush(); quitting = true; app.quit(); }
      catch (error) { quitInProgress = false; store.onError(`无法保存恢复记录，请先手动保存文档：${(error as Error).message}`); }
    })();
  });
  app.on('window-all-closed', () => { quitting = true; codeTheme.stop(); for (const item of fileWatchers.values()) { item.watcher.close(); clearTimeout(item.timer); } store.dispose(); app.quit(); });
}
