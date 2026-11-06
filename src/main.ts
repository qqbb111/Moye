import 'katex/dist/katex.min.css';
import '@fontsource/open-sans/latin-400.css';
import '@fontsource/open-sans/latin-400-italic.css';
import '@fontsource/open-sans/latin-700.css';
import './styles.css';
import './themes/copilot.css';
import './themes/code.css';
import './themes/controls.css';
import './themes/workbuddy.css';
import { icon, type IconName } from './icons';
import logo from '../assets/moye.svg?url';
import { APP_NAME, APP_SHORT_NAME } from '../shared/branding';
import { markdownStatistics, toggleMarkup, applyEdits } from '../shared/markdown-tools';
import { MODERN_DARK } from '../shared/code-theme';
import { EditorView } from '@codemirror/view';
import { undo, redo, isolateHistory } from '@codemirror/commands';
import { MarkdownEditor, exportHTML } from './editor';
import { headings } from './markdown';
import type { WorkspaceView, DocumentView, ActionResult, FolderEntry } from '../shared/types';

const bridge = window.rypota;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const app = $('#app');
app.innerHTML = `<header class="titlebar"><span class="app-mark" title="${APP_NAME}"><img class="app-logo" src="${logo}" alt=""><span class="brand-name">${APP_SHORT_NAME}<small>MOYE</small></span></span><nav class="menubar" aria-label="应用菜单">${['文件', '编辑', '段落', '格式', '视图', '主题', '帮助'].map((label, index) => `<button data-menu-index="${index}" aria-haspopup="true">${label}</button>`).join('')}<span class="menu-spacer"></span><div class="quick-actions"><button data-command="quick-open" aria-label="快速打开" title="快速打开 Ctrl+P">${icon('search')}</button><button data-command="focus" aria-label="专注写作" title="专注写作 F8">${icon('layout-centered')}</button><button data-command="preferences" aria-label="偏好设置" title="偏好设置 Ctrl+,">${icon('settings-gear')}</button></div></nav><div class="window-controls"><button data-control="minimize" aria-label="最小化" title="最小化">${icon('chrome-minimize')}</button><button data-control="maximize" aria-label="最大化" title="最大化">${icon('chrome-maximize')}</button><button data-control="close" aria-label="关闭窗口" title="关闭窗口">${icon('chrome-close')}</button></div></header>
  <div class="workspace"><aside id="sidebar" hidden><div class="sidebar-heading"><strong id="folder-name">文档</strong><button id="sidebar-close" aria-label="关闭侧栏" title="关闭侧栏">${icon('close')}</button></div><div class="sidebar-tabs"><button data-library="outline" class="active">${icon('list-tree')}大纲</button><button data-library="files">${icon('files')}文件</button><button data-library="drafts">${icon('history')}草稿</button></div><label class="sidebar-filter">${icon('filter')}<input id="sidebar-filter" type="search" aria-label="筛选侧栏" placeholder="筛选当前列表…" autocomplete="off"></label><div id="sidebar-content"></div><button id="open-folder" class="sidebar-bottom">${icon('folder-opened')}打开文件夹…</button></aside><div id="sidebar-resize" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin="200" aria-valuemax="420" aria-valuenow="256" tabindex="0" hidden></div>
  <main><div id="tabbar" hidden><div id="tabs" role="tablist" aria-label="打开的文档"></div><button id="add-tab" aria-label="新建标签页" title="新建标签页">${icon('add')}</button></div><div class="document-heading"><button id="document-switch" data-command="quick-open" title="切换文档 Ctrl+P">${icon('markdown')}<span id="caption">未命名</span>${icon('chevron-right')}</button><span id="document-location">本机草稿</span><span class="heading-space"></span><button data-command="new" aria-label="新建文档" title="新建文档 Ctrl+N">${icon('new-file')}</button><button data-command="open" aria-label="打开文档" title="打开文档 Ctrl+O">${icon('folder-opened')}</button></div><div id="editor-stage"></div><div id="empty" hidden><button id="new-empty">${icon('new-file')}新建文档</button><button id="open-empty">${icon('folder-opened')}打开文件…</button></div><footer><button id="toggle-sidebar" aria-label="切换侧栏" title="切换侧栏 Ctrl+Shift+L">${icon('layout-sidebar-left')}</button><button id="source-mode" aria-label="源码模式" title="源码模式 Ctrl+/">${icon('code')}</button><span id="save-status" role="status"></span><span class="footer-space"></span><button id="reading-width" aria-label="阅读宽度" title="切换阅读宽度">${icon('layout-centered')}<span>适中</span></button><span id="reading-time"></span><button id="word-count" title="字数统计">0 字</button><span id="mode-label"></span></footer></main></div>
  <div id="menu" role="menu" hidden></div><div id="toast" role="status" hidden></div>
  <dialog id="preferences"><form method="dialog"><h2>偏好设置</h2><label>主题<select id="theme-select"><option value="workbuddy">WorkBuddy 深色</option><option value="light">白色</option><option value="dark">夜间</option><option value="copilot">Copilot 深色</option></select></label><div class="code-theme-setting"><label>代码配色<select id="code-theme-select"><option value="github-dark">GitHub Dark · Shiki</option><option value="modern-dark">现代深色</option><option value="vscode">跟随本机 VS Code</option></select></label><p id="code-theme-status"></p></div><label>正文字号<input id="font-size" type="number" min="14" max="24"></label><label>阅读宽度<select id="reading-width-select"><option value="720">紧凑 · 720</option><option value="900">适中 · 900</option><option value="1080">宽阔 · 1080</option></select></label><label><input id="code-wrap-toggle" type="checkbox">代码自动换行（代码块内 Alt+Z）</label><label><input id="format-save-toggle" type="checkbox">保存前整理中文排版（含自动保存）</label><p>默认关闭。开启后整理正文空格和常见标点，保留代码、公式和地址；可以撤销。</p><label><input id="autosave-toggle" type="checkbox">自动保存已打开的文件</label><p>未命名文档会保存为本地草稿，重新打开后恢复。</p><label><input id="tabs-toggle" type="checkbox">多个文档显示标签页</label><label><input id="focus-toggle" type="checkbox">专注模式</label><label><input id="typewriter-toggle" type="checkbox">打字机模式</label><div class="dialog-buttons"><button value="cancel">关闭</button><button id="preferences-apply" value="default">应用</button></div></form></dialog>
  <dialog id="quick-open"><h2>快速打开</h2><input id="quick-input" placeholder="搜索标题或路径…" aria-label="快速打开文件名" role="combobox" aria-controls="quick-results" aria-expanded="true" aria-autocomplete="list" autocomplete="off"><div id="quick-results" role="listbox" aria-label="文件搜索结果"></div><p class="quick-help"><kbd>↑ ↓</kbd> 选择 <kbd>Enter</kbd> 打开 <kbd>Esc</kbd> 返回写作</p><button id="quick-close">关闭</button></dialog>
  <dialog id="about"><h2>${APP_NAME}</h2><p>一个保留 Markdown 原文的即时排版编辑器。</p><p>版本 0.5.0 · 安静写作，顺手记录</p><p>Ctrl+/ 源码 · Ctrl+S 保存 · Ctrl+Shift+N 新窗口</p><button id="about-close">关闭</button></dialog>`;

let workspace: WorkspaceView;
let library = 'outline'; let folder: { path: string; entries: FolderEntry[] } | null = null;
const slots = new Map<string, { element: HTMLElement; editor: MarkdownEditor; applying: boolean }>();
const pendingImages = new Set<Promise<void>>();
let toastTimer: ReturnType<typeof setTimeout>; let renderPending = false; let openedMenu = -1;
let tabSignature = ''; let draggedTab: string | null = null;
let sidebarSignature = ''; let resizingSidebar = false; let quickSelection = 0;
const expandedFolders = new Set<string>();
const nameOf = (file: string) => file.split(/[\\/]/).pop() ?? file;
const activeDocument = () => workspace?.documents.find(doc => doc.id === workspace.activeId);
const activeEditor = () => slots.get(workspace?.activeId ?? '')?.editor;
function toast(message: string) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000); }
async function run(action: () => Promise<ActionResult>) { try { const result = await action(); if (!result.ok && result.message) toast(result.message); } catch (error) { toast((error as Error).message); } }
function scheduleRender() { if (renderPending) return; renderPending = true; requestAnimationFrame(() => { renderPending = false; render(); }); }
function changed(id: string, content: string) {
  const doc = workspace.documents.find(item => item.id === id); const slot = slots.get(id); if (!doc || slot?.applying || doc.content === content) return;
  doc.content = content; doc.revision++; doc.dirty = true; doc.updatedAt = Date.now(); if (!doc.error) doc.status = 'draft';
  bridge.updateDocument(id, content, doc.revision); scheduleRender();
  if (workspace.preferences.typewriter) requestAnimationFrame(() => { const view = slot?.editor.view; if (view && view.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) }); });
}
function flushAll() {
  (document.activeElement as HTMLElement)?.blur();
  for (const [id, slot] of slots) changed(id, slot.editor.content);
}
function media(id: string, url: string) {
  if (/^replica-media:\/\/draft\/[a-f0-9]{64}\.[a-z]+$/i.test(url)) return url;
  if (/^(https?:|data:image\/|blob:)/i.test(url)) return url;
  if (/^[a-z]+:/i.test(url) && !/^[a-z]:[\\/]/i.test(url)) return '';
  let decoded = url; try { decoded = decodeURIComponent(url); } catch { /* Literal percent signs in legacy paths stay readable. */ }
  return `replica-media://document/${id}/${encodeURIComponent(decoded.replaceAll('\\', '/'))}`;
}
function link(url: string) {
  if (url.startsWith('#')) { const doc = activeDocument(); const editor = activeEditor(); if (!doc || !editor) return; const heading = headings(doc.content).find(item => item.slug === decodeURIComponent(url.slice(1))); if (heading) { editor.view.dispatch({ selection: { anchor: heading.offset }, effects: EditorView.scrollIntoView(heading.offset, { y: 'start' }) }); editor.focus(); } return; }
  void run(() => bridge.openExternal(url));
}
function ensureEditor(doc: DocumentView) {
  if (slots.has(doc.id)) return;
  const element = document.createElement('div'); element.className = 'editor-slot'; element.dataset.documentId = doc.id; element.hidden = doc.id !== workspace.activeId; $('#editor-stage').append(element);
  const editor = new MarkdownEditor(element, doc.content, { id: doc.id, media: url => media(doc.id, url), link, changed: content => changed(doc.id, content), codeWrap: () => !!workspace.preferences.codeWrap, setCodeWrap: value => { void run(() => bridge.updatePreferences({ codeWrap: value })); }, workbuddy: () => workspace.preferences.theme === 'workbuddy', githubDark: () => workspace.preferences.codeTheme === 'github-dark' });
  slots.set(doc.id, { element, editor, applying: false });
  element.addEventListener('paste', event => {
    let file = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
    if (!file) { const html = event.clipboardData?.getData('text/html') ?? ''; const match = /<img\b[^>]*\bsrc=["'](data:image\/([^;"']+);base64,([A-Za-z0-9+/=]+))["']/i.exec(html); if (match && !html.replace(/<[^>]*>/g, '').trim() && match[3].length < 28 * 1024 * 1024) { const bytes = Uint8Array.from(atob(match[3]), char => char.charCodeAt(0)); file = new File([bytes], `image.${match[2].replace('svg+xml', 'svg')}`, { type: `image/${match[2]}` }); } }
    if (file) { event.preventDefault(); event.stopPropagation(); queueImage(doc.id, file); }
  }, { capture: true });
  element.addEventListener('drop', event => { const file = [...(event.dataTransfer?.files ?? [])].find(file => file.type.startsWith('image/')); if (file) { event.preventDefault(); event.stopPropagation(); queueImage(doc.id, file); } }, { capture: true });
}
function queueImage(id: string, file: File) { const task = pasteImage(id, file); pendingImages.add(task); void task.finally(() => pendingImages.delete(task)); }
async function pasteImage(id: string, file: File) {
  try { const result = await bridge.insertImage(id, { bytes: [...new Uint8Array(await file.arrayBuffer())], name: file.name || 'image.png' });
    if (result.message) toast(result.message); if (result.url) slots.get(id)?.editor.insertImage(result.url, file.name);
  } catch (error) { toast((error as Error).message); }
}
function applyState(next: WorkspaceView) {
  if (workspace) next.documents = next.documents.map(incoming => { const local = workspace.documents.find(doc => doc.id === incoming.id); return local && local.revision > incoming.revision ? { ...incoming, content: local.content, revision: local.revision, dirty: true, status: incoming.error ? incoming.status : 'draft' } : incoming; });
  workspace = next;
  for (const [id, slot] of slots) if (!workspace.documents.some(doc => doc.id === id)) { slot.editor.destroy(); slot.element.remove(); slots.delete(id); }
  const doc = activeDocument(); if (doc) ensureEditor(doc);
  for (const [id, slot] of slots) { slot.element.hidden = id !== workspace.activeId; const current = workspace.documents.find(doc => doc.id === id); if (current && current.content !== slot.editor.content) { slot.applying = true; slot.editor.replace(current.content); slot.applying = false; } }
  render();
}
let dragX: number | null = null; let dragFrame = 0;
function clearTabDrop() { for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('drop-before', 'drop-after'); }
function markTabDrop(x: number) {
  const tabs = [...$('#tabs').querySelectorAll<HTMLElement>('.tab')].filter(tab => tab.dataset.id !== draggedTab);
  const before = tabs.find(tab => { const box = tab.getBoundingClientRect(); return x < box.left + box.width / 2; });
  clearTabDrop(); (before ?? tabs.at(-1))?.classList.add(before ? 'drop-before' : 'drop-after');
  return before?.dataset.id ?? null;
}
function scrollTabDrag() {
  if (!draggedTab || dragX === null) { dragFrame = 0; return; }
  const strip = $('#tabs'); const box = strip.getBoundingClientRect(); const previous = strip.scrollLeft;
  if (dragX < box.left + 32) strip.scrollLeft -= 12; else if (dragX > box.right - 32) strip.scrollLeft += 12;
  if (strip.scrollLeft !== previous) markTabDrop(dragX);
  dragFrame = requestAnimationFrame(scrollTabDrag);
}
function endTabDrag() {
  draggedTab = null; dragX = null; cancelAnimationFrame(dragFrame); dragFrame = 0; clearTabDrop(); $('#tabbar').classList.remove('drag-over');
  for (const tab of document.querySelectorAll('.tab.dragging')) tab.classList.remove('dragging'); renderTabs();
}
function moveTab(moved: string, before: string | null) {
  if (!workspace.documents.some(doc => doc.id === moved)) return;
  const ids = workspace.documents.map(doc => doc.id).filter(id => id !== moved); const index = before ? ids.indexOf(before) : -1;
  ids.splice(index < 0 ? ids.length : index, 0, moved); void run(() => bridge.reorderDocuments(ids));
}
const acceptTabDrag = (event: DragEvent) => {
  if (!draggedTab || !event.dataTransfer) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move'; dragX = event.clientX; markTabDrop(dragX); $('#tabbar').classList.add('drag-over');
  if (!dragFrame) dragFrame = requestAnimationFrame(scrollTabDrag);
};
$('#tabbar').ondragenter = acceptTabDrag; $('#tabbar').ondragover = acceptTabDrag;
$('#tabbar').ondragleave = event => {
  if ($('#tabbar').contains(event.relatedTarget as Node)) return;
  dragX = null; cancelAnimationFrame(dragFrame); dragFrame = 0; clearTabDrop(); $('#tabbar').classList.remove('drag-over');
};
$('#tabbar').ondrop = event => {
  if (!draggedTab) return; event.preventDefault(); event.stopPropagation();
  const moved = draggedTab; const before = markTabDrop(event.clientX); const valid = event.dataTransfer?.getData('application/x-replica-tab') === moved;
  endTabDrag(); if (!valid || !workspace.documents.some(doc => doc.id === moved)) return;
  moveTab(moved, before);
};
function renderTabs() {
  if (draggedTab) return;
  const signature = JSON.stringify([workspace.activeId, workspace.documents.map(item => [item.id, item.title, item.path, item.dirty])]);
  if (signature === tabSignature) return; tabSignature = signature;
  $('#tabs').replaceChildren();
  for (const item of workspace.documents) {
    const tab = document.createElement('div'); tab.className = `tab ${item.id === workspace.activeId ? 'active' : ''}`; tab.role = 'tab'; tab.dataset.id = item.id; tab.setAttribute('aria-selected', String(item.id === workspace.activeId)); tab.tabIndex = 0; tab.title = item.path ?? '本地草稿'; tab.draggable = false;
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = item.title + (item.dirty && item.path ? ' ●' : ''); const close = document.createElement('button'); close.className = 'tab-close'; close.innerHTML = icon('close'); close.draggable = false; close.title = `关闭 ${item.title}`; close.setAttribute('aria-label', `关闭 ${item.title}`); close.onclick = event => { event.stopPropagation(); flushAll(); void run(() => bridge.closeDocument(item.id)); };
    let skipClick = false;
    tab.innerHTML = icon('markdown').replace('class="replica-icon"', 'class="replica-icon tab-file-icon"'); tab.append(label, close); tab.onclick = () => { if (skipClick) { skipClick = false; return; } flushAll(); void run(async () => { const result = await bridge.activateDocument(item.id); activeEditor()?.focus(); return result; }); }; tab.onkeydown = event => { if (event.key === 'Enter') tab.click(); };
    tab.onpointerdown = event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('.tab-close')) return;
      const originX = event.clientX, originY = event.clientY; const previousFocus = document.activeElement as HTMLElement | null; let started = false;
      tab.setPointerCapture(event.pointerId);
      const inside = (event: PointerEvent) => { const box = $('#tabbar').getBoundingClientRect(); return event.clientY >= box.top && event.clientY <= box.bottom && event.clientX >= box.left && event.clientX <= box.right; };
      tab.onpointermove = event => {
        if (!started && Math.hypot(event.clientX - originX, event.clientY - originY) < 6) return;
        if (!started) { started = true; draggedTab = item.id; tab.classList.add('dragging'); }
        event.preventDefault();
        if (inside(event)) { dragX = event.clientX; markTabDrop(dragX); $('#tabbar').classList.add('drag-over'); if (!dragFrame) dragFrame = requestAnimationFrame(scrollTabDrag); }
        else { dragX = null; clearTabDrop(); $('#tabbar').classList.remove('drag-over'); }
      };
      const finish = (event: PointerEvent) => {
        tab.onpointermove = null; tab.onpointerup = null; tab.onpointercancel = null;
        if (!started) return; const before = inside(event) ? markTabDrop(event.clientX) : null; const accepted = event.type !== 'pointercancel' && inside(event);
        skipClick = true; setTimeout(() => { skipClick = false; }, 0); endTabDrag(); if (accepted) moveTab(item.id, before);
        if (previousFocus?.isConnected && $('#editor-stage').contains(previousFocus)) previousFocus.focus(); else activeEditor()?.focus();
      };
      tab.onpointerup = finish; tab.onpointercancel = finish;
    };
    tab.ondragstart = event => { if (!event.dataTransfer || (event.target as HTMLElement).closest('.tab-close')) { event.preventDefault(); return; } draggedTab = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-replica-tab', item.id); tab.classList.add('dragging'); };
    tab.ondragend = endTabDrag;
    $('#tabs').append(tab);
  }
}
let statisticsSource = ''; let statistics = markdownStatistics('');
function currentStatistics() { const source = activeDocument()?.content ?? ''; if (statisticsSource !== source) { statisticsSource = source; statistics = markdownStatistics(source); } return statistics; }
function render() {
  if (!workspace) return; const doc = activeDocument(); const editor = activeEditor(); const preferences = workspace.preferences;
  document.documentElement.dataset.theme = preferences.theme; document.documentElement.style.setProperty('--font-size', `${preferences.fontSize}px`);
  document.documentElement.style.setProperty('--reading-width', `${preferences.readingWidth ?? 900}px`);
  if (!resizingSidebar) document.documentElement.style.setProperty('--sidebar-width', `${preferences.sidebarWidth ?? 256}px`);
  $('#sidebar-resize').hidden = !preferences.sidebar; $('#sidebar-resize').setAttribute('aria-valuenow', String(preferences.sidebarWidth ?? 256));
  for (const slot of slots.values()) { slot.editor.setCodeWrap(!!preferences.codeWrap); slot.editor.setCodeAppearance(preferences.theme === 'workbuddy', preferences.codeTheme === 'github-dark'); }
  const width = preferences.readingWidth ?? 900; $('#reading-width span').textContent = width < 800 ? '紧凑' : width > 960 ? '宽阔' : '适中';
  $('#reading-width').title = `阅读宽度 ${width}，点击切换`;
  const maximize = $('[data-control="maximize"]'); const maximizeIcon = workspace.maximized ? 'chrome-restore' : 'chrome-maximize';
  if (maximize.querySelector('svg')?.dataset.icon !== maximizeIcon) maximize.innerHTML = icon(maximizeIcon);
  maximize.title = workspace.maximized ? '还原' : '最大化'; maximize.setAttribute('aria-label', maximize.title);
  const sidebarIcon = preferences.sidebar ? 'layout-sidebar-left' : 'layout-sidebar-left-off';
  if ($('#toggle-sidebar svg').dataset.icon !== sidebarIcon) $('#toggle-sidebar').innerHTML = icon(sidebarIcon);
  const palette = (workspace.codeTheme ?? MODERN_DARK).palette;
  for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(['background', 'foreground', 'border'].includes(key) ? `--code-${key}` : `--syntax-${key}`, value);
  $('#code-theme-status').textContent = workspace.codeTheme?.message ?? (preferences.codeTheme === 'vscode' ? `正在跟随 VS Code：${workspace.codeTheme?.name ?? '现代深色'}` : preferences.codeTheme === 'github-dark' ? 'Shiki github-dark，TextMate 语法高亮，可离线使用' : '使用 VS Code 现代深色的代码配色');
  app.classList.toggle('focus-mode', !!preferences.focus); app.classList.toggle('typewriter-mode', !!preferences.typewriter);
  $('#sidebar').hidden = !preferences.sidebar; $('#tabbar').hidden = workspace.documents.length <= 1 || preferences.tabs === false;
  const title = `${doc?.dirty && doc.path ? '● ' : ''}${doc?.title ?? '未命名'}`; $('#caption').textContent = title; document.title = `${title} — ${APP_NAME}`;
  $('#document-switch').title = `${doc?.path ?? '本机草稿'} · 切换文档 Ctrl+P`; $('#document-location').textContent = doc?.path ? '本地文档' : '本机草稿';
  renderTabs();
  $('#empty').hidden = Boolean(doc); $('#editor-stage').hidden = !doc;
  $('#source-mode').classList.toggle('active', !!editor?.source); $('#mode-label').textContent = editor?.source ? '源码模式' : preferences.focus ? '专注模式' : preferences.typewriter ? '打字机模式' : '';
  $('#save-status').textContent = doc?.error ?? (doc ? doc.status === 'saving' ? '保存中…' : doc.draftRevision < doc.revision ? '保存草稿…' : doc.path ? doc.dirty ? '修改已保留' : '已保存' : doc.content ? '草稿已保存' : '' : ''); $('#save-status').classList.toggle('error', !!doc?.error);
  $('#save-status').dataset.state = doc?.error ? 'error' : doc?.status === 'saving' || (doc && doc.draftRevision < doc.revision) ? 'pending' : doc?.path && !doc.dirty ? 'saved' : 'draft';
  $('#save-status').title = doc?.error ?? (doc?.path ? `${doc.path}${doc.savedAt ? ' · 上次保存：' + new Date(doc.savedAt).toLocaleTimeString() : ''}` : '草稿仅保存在本机，Ctrl+S 可保存为文件');
  const words = currentStatistics().words; $('#word-count').textContent = `${words.toLocaleString()} 字`;
  $('#reading-time').textContent = words >= 400 ? `约 ${Math.ceil(words / 400)} 分钟` : ''; renderSidebar();
}
function row(label: string, action: () => void, title = '', glyph?: IconName) { const element = document.createElement('button'); element.className = 'sidebar-row'; if (glyph) { element.classList.add('has-icon'); element.innerHTML = icon(glyph); const text = document.createElement('span'); text.className = 'row-label'; text.textContent = label; element.append(text); } else element.textContent = label; element.title = title; element.onclick = action; return element; }
function renderSidebar() {
  if ($('#sidebar').hidden) return;
  const query = $<HTMLInputElement>('#sidebar-filter').value.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(query);
  const outline = library === 'outline' ? headings(activeDocument()?.content ?? '') : [];
  const signature = JSON.stringify([library, query, workspace.activeId, outline, workspace.documents.map(d => [d.id, d.title, d.path]), workspace.drafts.map(d => [d.id, d.title]), workspace.recent, folder?.path, folder?.entries]);
  if (signature === sidebarSignature) return; sidebarSignature = signature;
  const empty = (text: string) => { const hint = document.createElement('p'); hint.className = 'sidebar-empty'; hint.textContent = text; return hint; };
  const container = $('#sidebar-content'); container.replaceChildren();
  for (const button of document.querySelectorAll<HTMLElement>('[data-library]')) button.classList.toggle('active', button.dataset.library === library);
  $('#folder-name').textContent = library === 'files' && folder ? nameOf(folder.path) : library === 'outline' ? activeDocument()?.title ?? '文档大纲' : library === 'drafts' ? '本机草稿' : '文档';
  $('#folder-name').title = library === 'outline' ? activeDocument()?.path ?? '本机草稿' : library === 'files' ? folder?.path ?? '' : '';
  if (library === 'outline') {
    const doc = activeDocument(); if (!doc) return; for (const heading of outline.filter(heading => matches(heading.text))) { const element = row(heading.text, () => { const editor = activeEditor()!; editor.view.dispatch({ selection: { anchor: heading.offset }, effects: EditorView.scrollIntoView(heading.offset, { y: 'start' }) }); editor.focus(); }); element.style.paddingLeft = `${18 + (heading.level - 1) * 12}px`; element.dataset.level = String(heading.level); container.append(element); }
    if (!container.childElementCount) container.append(empty(query ? '没有匹配的标题' : '用 # 写下标题，这里就会出现文档目录。'));
  } else if (library === 'drafts') {
    for (const doc of workspace.drafts.filter(doc => matches(doc.title))) container.append(row(doc.title, () => void run(() => bridge.restoreDraft(doc.id)), '恢复草稿', 'history'));
    if (!container.childElementCount) container.append(empty(query ? '没有匹配的草稿' : '关闭的未命名文档会保留在这里。'));
  } else {
    const title = document.createElement('div'); title.className = 'sidebar-section'; title.textContent = '已打开'; container.append(title);
    for (const doc of workspace.documents.filter(doc => matches(doc.title + ' ' + (doc.path ?? '')))) { const element = row(doc.title, () => { flushAll(); void run(() => bridge.activateDocument(doc.id)); }, doc.path ?? '本地草稿', 'markdown'); element.classList.toggle('selected', doc.id === workspace.activeId); container.append(element); }
    if (folder) { const heading = document.createElement('div'); heading.className = 'sidebar-section'; heading.textContent = '文件夹'; container.append(heading); renderTree(container, query ? folder.entries.filter(entry => !entry.directory && matches(entry.name)) : folder.entries, 0); }
    else for (const file of workspace.recent.filter(file => matches(file)).slice(0, 10)) container.append(row(nameOf(file), () => void run(() => bridge.openRecent(file)), file, 'markdown'));
    if (query && !container.querySelector('.sidebar-row')) container.append(empty('当前列表没有匹配项。'));
  }
}
function renderTree(container: HTMLElement, entries: FolderEntry[], depth: number) {
  for (const entry of entries) {
    if (!entry.directory) { const button = row(entry.name, () => void run(() => bridge.openFolderFile(entry.path)), entry.path, /\.txt$/i.test(entry.name) ? 'file' : 'markdown'); button.style.paddingLeft = `${18 + depth * 14}px`; container.append(button); }
    else {
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.innerHTML = icon('chevron-right').replace('class="replica-icon"', 'class="replica-icon tree-chevron"') + icon('folder'); summary.append(document.createTextNode(entry.name)); summary.style.paddingLeft = `${18 + depth * 14}px`; const children = document.createElement('div'); details.append(summary, children);
      details.addEventListener('toggle', () => { if (details.open) expandedFolders.add(entry.path); else expandedFolders.delete(entry.path); if (details.open && !children.childElementCount) void bridge.listFolder(entry.path).then(entries => { if (children.isConnected) renderTree(children, entries, depth + 1); }).catch(error => toast(error.message)); }); details.open = expandedFolders.has(entry.path); container.append(details);
    }
  }
}
type MenuItem = { label: string; action?: string; shortcut?: string; checked?: boolean; value?: string } | null;
function menuItems(index: number): MenuItem[] {
  const p = workspace.preferences;
  return [
    [{ label: '新建', action: 'new', shortcut: 'Ctrl+N' }, { label: '新建窗口', action: 'new-window', shortcut: 'Ctrl+Shift+N' }, { label: '打开…', action: 'open', shortcut: 'Ctrl+O' }, { label: '打开文件夹…', action: 'folder' }, { label: '快速打开…', action: 'quick-open', shortcut: 'Ctrl+P' }, null, ...workspace.recent.slice(0, 4).map(file => ({ label: nameOf(file), action: 'recent', value: file })), null, { label: '保存', action: 'save', shortcut: 'Ctrl+S' }, { label: '另存为…', action: 'save-as', shortcut: 'Ctrl+Shift+S' }, { label: '自动保存', action: 'auto-save', checked: p.autoSave }, null, { label: '导出 PDF…', action: 'export-pdf' }, { label: '导出 HTML…', action: 'export-html' }, { label: '移到新窗口', action: 'detach' }, { label: '关闭文档', action: 'close-tab', shortcut: 'Ctrl+W' }],
    [{ label: '撤销', action: 'undo', shortcut: 'Ctrl+Z' }, { label: '重做', action: 'redo', shortcut: 'Ctrl+Shift+Z' }, null, { label: '剪切', action: 'cut', shortcut: 'Ctrl+X' }, { label: '复制', action: 'copy', shortcut: 'Ctrl+C' }, { label: '粘贴', action: 'paste', shortcut: 'Ctrl+V' }, { label: '全选', action: 'select-all', shortcut: 'Ctrl+A' }, null, { label: '查找', action: 'find', shortcut: 'Ctrl+F' }, { label: '替换', action: 'replace', shortcut: 'Ctrl+H' }, null, { label: '整理中文排版', action: 'tidy-chinese', shortcut: 'Alt+Shift+F' }, { label: '整理图片附件', action: 'organize-images' }, null, { label: '偏好设置…', action: 'preferences', shortcut: 'Ctrl+,' }],
    [...Array.from({ length: 6 }, (_, n) => ({ label: `${n + 1} 级标题`, action: `heading-${n + 1}`, shortcut: `Ctrl+${n + 1}` })), { label: '段落', action: 'heading-0', shortcut: 'Ctrl+0' }, null, { label: '表格', action: 'table', shortcut: 'Ctrl+T' }, { label: '代码块', action: 'code', shortcut: 'Ctrl+Shift+K' }, { label: '公式块', action: 'math', shortcut: 'Ctrl+Shift+M' }, { label: '引用', action: 'quote', shortcut: 'Ctrl+Shift+Q' }, null, { label: '无序列表', action: 'bullet', shortcut: 'Ctrl+Shift+]' }, { label: '有序列表', action: 'ordered', shortcut: 'Ctrl+Shift+[' }, { label: '任务列表', action: 'task' }, { label: '水平分割线', action: 'rule' }, { label: '目录', action: 'toc' }],
    [{ label: '加粗', action: 'bold', shortcut: 'Ctrl+B' }, { label: '斜体', action: 'italic', shortcut: 'Ctrl+I' }, { label: '下划线', action: 'underline', shortcut: 'Ctrl+U' }, { label: '删除线', action: 'strike', shortcut: 'Alt+Shift+5' }, { label: '代码', action: 'inline-code', shortcut: 'Ctrl+Shift+`' }, { label: '高亮', action: 'highlight', shortcut: '选中后按 =' }, { label: '上标', action: 'superscript' }, { label: '下标', action: 'subscript' }, null, { label: '超链接', action: 'link', shortcut: 'Ctrl+K' }, { label: '图像…', action: 'insert-image', shortcut: 'Ctrl+Shift+I' }, null, { label: '清除样式', action: 'clear-format' }],
    [{ label: '显示侧栏', action: 'sidebar', shortcut: 'Ctrl+Shift+L', checked: !!p.sidebar }, { label: '大纲', action: 'outline', shortcut: 'Ctrl+Shift+1' }, { label: '文件树', action: 'files', shortcut: 'Ctrl+Shift+3' }, { label: '草稿恢复', action: 'drafts' }, null, { label: '源代码模式', action: 'toggle-source', shortcut: 'Ctrl+/', checked: !!activeEditor()?.source }, { label: '专注模式', action: 'focus', shortcut: 'F8', checked: !!p.focus }, { label: '打字机模式', action: 'typewriter', shortcut: 'F9', checked: !!p.typewriter }, { label: '全屏', action: 'fullscreen', shortcut: 'F11' }, { label: '显示标签页', action: 'tabs', checked: p.tabs !== false }, null, { label: '放大字号', action: 'zoom-in', shortcut: 'Ctrl+Shift+=' }, { label: '缩小字号', action: 'zoom-out', shortcut: 'Ctrl+Shift+-' }, { label: '恢复字号', action: 'zoom-reset', shortcut: 'Ctrl+Shift+0' }],
    [{ label: 'WorkBuddy 深色', action: 'workbuddy', checked: p.theme === 'workbuddy' }, { label: '白色', action: 'light', checked: p.theme === 'light' }, { label: '夜间', action: 'dark', checked: p.theme === 'dark' }, { label: 'Copilot 深色', action: 'copilot', checked: p.theme === 'copilot' }, null, { label: '代码配色：GitHub Dark', action: 'code-github', checked: p.codeTheme === 'github-dark' }, { label: '代码配色：现代深色', action: 'code-modern', checked: p.codeTheme === 'modern-dark' }, { label: '代码配色：跟随 VS Code', action: 'code-vscode', checked: p.codeTheme === 'vscode' }, { label: '重新读取 VS Code 主题', action: 'code-refresh' }],
    [{ label: 'Markdown 使用指南', action: 'guide' }, { label: '快捷键', action: 'shortcuts' }, null, { label: '关于墨页', action: 'about' }],
  ][index] as MenuItem[];
}
function showMenu(index: number) {
  const menu = $('#menu'); if (openedMenu === index && !menu.hidden) { hideMenu(); return; }
  openedMenu = index; menu.replaceChildren(); const anchor = document.querySelector<HTMLElement>(`[data-menu-index="${index}"]`)!; const bounds = anchor.getBoundingClientRect(); menu.style.left = `${Math.min(bounds.left, innerWidth - 286)}px`; menu.style.top = `${bounds.bottom}px`;
  for (const item of menuItems(index)) { if (!item) { const separator = document.createElement('hr'); menu.append(separator); continue; }
    const button = document.createElement('button'); button.role = 'menuitem'; const check = document.createElement('span'); check.className = 'menu-check'; check.innerHTML = item.checked ? icon('check') : ''; const label = document.createElement('span'); label.textContent = item.label; const key = document.createElement('kbd'); key.textContent = item.shortcut ?? ''; button.append(check, label, key); button.onmousedown = event => event.preventDefault(); button.onclick = () => { hideMenu(); void execute(item.action!, item.value); }; menu.append(button);
  }
  menu.hidden = false; for (const button of document.querySelectorAll<HTMLElement>('[data-menu-index]')) button.classList.toggle('active', Number(button.dataset.menuIndex) === index);
}
function hideMenu() { $('#menu').hidden = true; openedMenu = -1; for (const button of document.querySelectorAll<HTMLElement>('[data-menu-index]')) button.classList.remove('active'); }
function preferences() {
  const p = workspace.preferences; $<HTMLSelectElement>('#theme-select').value = p.theme; $<HTMLInputElement>('#font-size').value = String(p.fontSize);
  $<HTMLSelectElement>('#code-theme-select').value = p.codeTheme ?? 'modern-dark';
  const width = p.readingWidth ?? 900; $<HTMLSelectElement>('#reading-width-select').value = String([720, 900, 1080].reduce((closest, value) => Math.abs(value - width) < Math.abs(closest - width) ? value : closest)); $<HTMLInputElement>('#code-wrap-toggle').checked = !!p.codeWrap;
  for (const [id, value] of [['format-save-toggle', p.formatOnSave], ['autosave-toggle', p.autoSave], ['tabs-toggle', p.tabs !== false], ['focus-toggle', p.focus], ['typewriter-toggle', p.typewriter]] as const) $<HTMLInputElement>(`#${id}`).checked = !!value;
  $<HTMLDialogElement>('#preferences').showModal();
}
function quickOpen() { $<HTMLDialogElement>('#quick-open').showModal(); $<HTMLInputElement>('#quick-input').value = ''; renderQuick(); $<HTMLInputElement>('#quick-input').focus(); }
function paintQuickSelection() {
  const results = [...$('#quick-results').querySelectorAll<HTMLButtonElement>('button')];
  for (const [index, button] of results.entries()) { const active = index === quickSelection; button.classList.toggle('selected', active); button.setAttribute('aria-selected', String(active)); }
  const selected = results[quickSelection];
  if (selected) { $('#quick-input').setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView({ block: 'nearest' }); }
  else $('#quick-input').removeAttribute('aria-activedescendant');
}
function renderQuick() {
  const terms = $<HTMLInputElement>('#quick-input').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = $('#quick-results'); results.replaceChildren(); quickSelection = 0; const seen = new Set<string>();
  const add = (title: string, file: string | null, key: string, category: string, open: () => Promise<ActionResult>) => {
    if (seen.has(key) || !terms.every(term => (title + ' ' + (file ?? '')).toLocaleLowerCase().includes(term)) || results.childElementCount >= 40) return;
    seen.add(key); const button = document.createElement('button'); button.className = 'quick-result'; button.id = 'quick-result-' + results.childElementCount; button.setAttribute('role', 'option'); button.title = file ?? '本机草稿';
    button.innerHTML = icon('markdown'); const label = document.createElement('span'); label.className = 'quick-result-label'; const name = document.createElement('strong'); name.textContent = title; const detail = document.createElement('small'); detail.textContent = file ?? '未命名草稿 · 仅保存在本机'; label.append(name, detail); const badge = document.createElement('span'); badge.className = 'quick-category'; badge.textContent = category; button.append(label, badge);
    button.onclick = () => { $<HTMLDialogElement>('#quick-open').close(); void run(async () => { const result = await open(); activeEditor()?.focus(); return result; }); }; results.append(button);
  };
  const key = (file: string) => file.replaceAll('\\', '/').toLocaleLowerCase();
  for (const doc of workspace.documents) add(doc.title, doc.path, doc.path ? key(doc.path) : doc.id, '已打开', () => bridge.activateDocument(doc.id));
  for (const file of workspace.recent) add(nameOf(file), file, key(file), '最近', () => bridge.openRecent(file));
  for (const file of folder?.entries ?? []) if (!file.directory) add(file.name, file.path, key(file.path), '文件夹', () => bridge.openFolderFile(file.path));
  if (!results.childElementCount) { const hint = document.createElement('p'); hint.className = 'quick-empty'; hint.textContent = terms.length ? '没有找到匹配的文件，试试标题中的另一个词。' : '打开过的文件和当前文件夹会出现在这里。'; results.append(hint); }
  paintQuickSelection();
}
function formatCell(action: string) {
  const cell = document.activeElement?.closest<HTMLElement>('th[contenteditable=true],td[contenteditable=true]'); if (!cell) return false;
  const formats: Record<string, [string, string]> = { bold: ['**', '**'], italic: ['*', '*'], underline: ['<u>', '</u>'], strike: ['~~', '~~'], 'inline-code': ['`', '`'], highlight: ['==', '=='], link: ['[', '](https://)'] };
  const format = formats[action]; if (!format) return false;
  const selection = window.getSelection(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null; const text = cell.textContent ?? '';
  if (!range || !cell.contains(range.startContainer) || !cell.contains(range.endContainer)) return false;
  const prefix = range.cloneRange(); prefix.selectNodeContents(cell); prefix.setEnd(range.startContainer, range.startOffset); const start = prefix.toString().length; const end = start + range.toString().length;
  const result = toggleMarkup(text, start, end, format[0], format[1]); cell.textContent = applyEdits(text, result.changes); if (!cell.firstChild) cell.append(document.createTextNode(''));
  const next = document.createRange(); next.setStart(cell.firstChild!, result.anchor); next.setEnd(cell.firstChild!, result.head); selection!.removeAllRanges(); selection!.addRange(next); cell.dispatchEvent(new InputEvent('input', { bubbles: true })); return true;
}
async function execute(action: string, value?: string) {
  if (['new', 'open', 'save', 'save-as', 'close-tab', 'detach', 'new-window', 'export-html', 'export-pdf'].includes(action)) await Promise.allSettled([...pendingImages]);
  const doc = activeDocument(); const editor = activeEditor();
  if (['new', 'open', 'save', 'save-as', 'close-tab', 'detach', 'new-window', 'export-html', 'export-pdf'].includes(action)) flushAll();
  if (action === 'new') return run(() => bridge.newDocument()); if (action === 'open') return run(() => bridge.openDocuments());
  if (action === 'save' || action === 'save-as') { if (doc) return run(() => bridge.saveDocument(doc.id, action === 'save-as')); return; }
  if (action === 'close-tab') { if (doc) return run(() => bridge.closeDocument(doc.id)); return; }
  if (action === 'new-window') return run(() => bridge.newWindow()); if (action === 'detach' && doc) return run(() => bridge.detachDocument(doc.id));
  if (action === 'recent' && value) return run(() => bridge.openRecent(value));
  if (action === 'folder') { try { folder = await bridge.openFolder(); if (folder) { library = 'files'; await run(() => bridge.updatePreferences({ sidebar: true })); } } catch (error) { toast((error as Error).message); } return; }
  if (['outline', 'files', 'drafts'].includes(action)) { library = action; return run(() => bridge.updatePreferences({ sidebar: true })); }
  if (action === 'sidebar') return run(() => bridge.updatePreferences({ sidebar: !workspace.preferences.sidebar }));
  if (['focus', 'typewriter', 'tabs'].includes(action)) return run(() => bridge.updatePreferences({ [action]: action === 'tabs' ? workspace.preferences.tabs === false : !workspace.preferences[action as 'focus' | 'typewriter'] }));
  if (action === 'workbuddy') return run(() => bridge.updatePreferences({ theme: 'workbuddy', codeTheme: 'github-dark', readingWidth: 900 }));
  if (action === 'light' || action === 'dark' || action === 'copilot') return run(() => bridge.updatePreferences({ theme: action }));
  if (action === 'code-github') return run(() => bridge.updatePreferences({ codeTheme: 'github-dark' }));
  if (action === 'code-modern' || action === 'code-vscode') return run(() => bridge.updatePreferences({ codeTheme: action === 'code-vscode' ? 'vscode' : 'modern-dark' }));
  if (action === 'code-refresh') { await run(() => bridge.refreshCodeTheme()); toast(workspace.preferences.codeTheme === 'vscode' ? workspace.codeTheme?.message ?? `已读取 VS Code 主题：${workspace.codeTheme?.name}` : '已重新读取 VS Code 主题；选择“代码配色：跟随 VS Code”即可应用'); return; }
  if (action.startsWith('zoom-')) return run(() => bridge.updatePreferences({ fontSize: action === 'zoom-reset' ? 16 : workspace.preferences.fontSize + (action === 'zoom-in' ? 1 : -1) }));
  if (action === 'auto-save') return run(() => bridge.updatePreferences({ autoSave: !workspace.preferences.autoSave }));
  if (action === 'fullscreen') { bridge.fullscreen(); return; } if (action === 'preferences') { preferences(); return; }
  if (action === 'quick-open') { quickOpen(); return; } if (action === 'about' || action === 'shortcuts') { $<HTMLDialogElement>('#about').showModal(); return; }
  if (action === 'guide') return run(() => bridge.openExternal('https://support.typora.io/Markdown-Reference/'));
  if (action === 'toggle-source') { editor?.setSource(!editor.source); render(); return; }
  if (action === 'tidy-chinese') { flushAll(); editor?.action(action); editor?.focus(); toast('已整理中文排版，可用 Ctrl+Z 撤销'); return; }
  if (action === 'organize-images' && doc) { flushAll(); return run(() => bridge.organizeImages(doc.id)); }
  if (action === 'next-tab' || action === 'previous-tab') { flushAll(); const index = workspace.documents.findIndex(doc => doc.id === workspace.activeId); const next = workspace.documents[(index + (action === 'next-tab' ? 1 : -1) + workspace.documents.length) % workspace.documents.length]; if (next) return run(() => bridge.activateDocument(next.id)); return; }
  if (action === 'insert-image' && doc && editor) { const result = await bridge.insertImage(doc.id); if (result.message) toast(result.message); if (result.url) editor.insertImage(result.url); return; }
  if (action.startsWith('export-') && doc) {
    const workbuddy = workspace.preferences.theme === 'workbuddy';
    const body = await exportHTML(doc.content, { id: doc.id, media: url => media(doc.id, url), link, changed: () => {}, workbuddy: () => workbuddy, githubDark: () => workspace.preferences.codeTheme === 'github-dark' });
    const extraStyle = workbuddy ? (await import('./workbuddy-export')).default : '';
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'"><title>${doc.title.replace(/[<>&"]/g, '')}</title><style>body{font:16px/1.6 'Segoe UI','霞鹜文楷','LXGW WenKai','Microsoft YaHei UI',sans-serif;color:#333;margin:36px auto;max-width:860px;padding:0 30px}h1,h2{border-bottom:1px solid #eee;padding-bottom:.3em}h1{font-size:2.25em}h2{font-size:1.75em}a{color:#4183c4}pre{padding:16px;background:#f6f8fa;white-space:pre-wrap}code{font-family:Consolas,'霞鹜文楷','LXGW WenKai',monospace}table{border-collapse:collapse;margin-left:auto;margin-right:auto}td,th{border:1px solid #ddd;padding:6px 13px}blockquote{border-left:4px solid #ddd;margin-left:0;padding-left:16px;color:#777}img{max-width:100%}.katex-html{display:none}math{font-size:1.1em}p{margin:1em 0}${extraStyle}</style></head><body>${body}</body></html>`;
    return run(() => bridge.exportDocument(doc.id, action === 'export-pdf' ? 'pdf' : 'html', html));
  }
  if (['cut', 'copy', 'paste', 'select-all'].includes(action)) {
    const cell = document.activeElement?.closest('th[contenteditable=true],td[contenteditable=true]');
    if (cell) {
      if (action === 'copy' || action === 'cut') { await bridge.clipboard('write', window.getSelection()?.toString() ?? ''); if (action === 'cut') { document.execCommand('delete'); cell.dispatchEvent(new InputEvent('input', { bubbles: true })); } }
      if (action === 'paste') document.execCommand('insertText', false, await bridge.clipboard('read'));
      if (action === 'select-all') { const range = document.createRange(); range.selectNodeContents(cell); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); } return;
    }
    const focusedCode = document.activeElement?.closest('.code-content .cm-editor'); const view = focusedCode ? EditorView.findFromDOM(focusedCode as HTMLElement) : editor?.view; if (!view) return;
    const { from, to } = view.state.selection.main;
    if (action === 'copy' || action === 'cut') {
      const state = view.state; let start = from, end = to; let text = state.sliceDoc(from, to);
      if (from === to) {
        const line = state.doc.lineAt(from); text = line.text + '\n'; start = line.from; end = Math.min(state.doc.length, line.to + 1);
        if (end === line.to && start > 0) start--;
      }
      try { await bridge.clipboard('write', text); } catch (error) { toast(`无法写入剪贴板：${(error as Error).message}`); return; }
      if (action === 'cut' && end > start && view.dom.isConnected) {
        if (view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) { toast('内容或光标已变化，本次仅复制，未剪切'); return; }
        view.dispatch({ changes: { from: start, to: end }, selection: { anchor: start }, annotations: isolateHistory.of('full'), userEvent: 'delete.cut', scrollIntoView: true });
      }
    }
    if (action === 'paste') { const insert = await bridge.clipboard('read'); view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } }); }
    if (action === 'select-all') view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); return;
  }
  // A code block owns its own undo history while its editor has focus.
  const focused = document.activeElement?.closest('.code-content .cm-editor');
  if (focused && (action === 'undo' || action === 'redo')) { const nested = EditorView.findFromDOM(focused as HTMLElement); if (nested) (action === 'undo' ? undo : redo)(nested); return; }
  if (!formatCell(action)) editor?.action(action);
}

for (const button of document.querySelectorAll<HTMLElement>('[data-menu-index]')) { button.onmousedown = event => event.preventDefault(); button.onclick = () => showMenu(Number(button.dataset.menuIndex)); button.onmouseenter = () => { if (openedMenu >= 0 && openedMenu !== Number(button.dataset.menuIndex)) showMenu(Number(button.dataset.menuIndex)); }; }
document.addEventListener('mousedown', event => { if (!(event.target as HTMLElement).closest('#menu,.menubar')) hideMenu(); });
let compositionTarget: EventTarget | null = null;
document.addEventListener('compositionstart', event => { compositionTarget = event.target; }, true);
document.addEventListener('compositionend', () => { compositionTarget = null; }, true);
document.addEventListener('focusout', event => { if (compositionTarget === event.target) compositionTarget = null; }, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { hideMenu(); return; }
  if ($<HTMLDialogElement>('#preferences').open || $<HTMLDialogElement>('#quick-open').open) return;
  if (!$('#menu').hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation(); const buttons = [...$('#menu').querySelectorAll<HTMLButtonElement>('button')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    if (event.key === 'Enter') (document.activeElement as HTMLElement)?.click();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') showMenu((openedMenu + (event.key === 'ArrowRight' ? 1 : -1) + 7) % 7); return;
  }
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f')) { event.preventDefault(); event.stopPropagation(); void execute('tidy-chinese'); return; }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { const index = ['f', 'e', 'p', 'o', 'v', 't', 'h'].indexOf(event.key.toLowerCase()); if (index >= 0) { event.preventDefault(); event.stopPropagation(); showMenu(index); return; } }
  let action = '';
  const inCell = !!document.activeElement?.closest('th[contenteditable=true],td[contenteditable=true]');
  // IMEs can report a standalone equals key as Process/229. Handle its physical
  // key before CodeMirror starts composition, but leave an active composition alone.
  if (!compositionTarget && (event.code === 'Equal' || event.key === '=' || event.key === '＝') && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const target = document.activeElement as HTMLElement | null;
    const selectedCell = inCell && window.getSelection()?.isCollapsed === false;
    const editor = activeEditor();
    const handled = selectedCell ? formatCell('highlight') : !inCell && !target?.closest('.code-content') && editor?.view.hasFocus && editor.highlightSelection();
    if (handled) { event.preventDefault(); event.stopPropagation(); return; }
  }
  if (event.ctrlKey || event.metaKey) {
    const clipboardView = document.activeElement?.closest('.cm-content') ? EditorView.findFromDOM(document.activeElement as HTMLElement) : null;
    if (!compositionTarget && !event.shiftKey && !event.altKey && clipboardView?.state.selection.ranges.length === 1 && clipboardView.state.selection.main.empty && (event.code === 'KeyC' || event.key.toLowerCase() === 'c' || event.code === 'KeyX' || event.key.toLowerCase() === 'x')) action = event.code === 'KeyX' || event.key.toLowerCase() === 'x' ? 'cut' : 'copy';
    else if (event.key === '/') action = 'toggle-source';
    else if (event.key.toLowerCase() === 'n') action = event.shiftKey ? 'new-window' : 'new';
    else if (event.key.toLowerCase() === 'o') action = 'open';
    else if (event.key.toLowerCase() === 's') action = event.shiftKey ? 'save-as' : 'save';
    else if (event.key.toLowerCase() === 'w') action = 'close-tab';
    else if (event.shiftKey && event.key.toLowerCase() === 'z') action = 'redo';
    else if (event.shiftKey && event.key.toLowerCase() === 'i') action = 'insert-image';
    else if (!compositionTarget && event.shiftKey && !event.altKey && (event.code === 'KeyQ' || event.key.toLowerCase() === 'q') && !document.activeElement?.closest('input,textarea,.code-content,th[contenteditable=true],td[contenteditable=true]')) action = 'quote';
    else if (inCell && !event.shiftKey && event.key.toLowerCase() === 'b') action = 'bold';
    else if (inCell && !event.shiftKey && event.key.toLowerCase() === 'i') action = 'italic';
    else if (inCell && !event.shiftKey && event.key.toLowerCase() === 'u') action = 'underline';
    else if (inCell && event.key.toLowerCase() === 'a') action = 'select-all';
    else if (inCell && event.key.toLowerCase() === 'z') action = 'undo';
    else if (event.key === 'Tab') action = event.shiftKey ? 'previous-tab' : 'next-tab';
    else if (event.key === ',') action = 'preferences'; else if (event.key.toLowerCase() === 'p') action = 'quick-open';
    else if (event.shiftKey && event.key.toLowerCase() === 'l') action = 'sidebar';
    else if (event.shiftKey && event.code === 'Digit1') action = 'outline'; else if (event.shiftKey && event.code === 'Digit3') action = 'files';
    else if (event.shiftKey && event.code === 'Digit0') action = 'zoom-reset'; else if (event.shiftKey && event.code === 'Equal') action = 'zoom-in'; else if (event.shiftKey && event.code === 'Minus') action = 'zoom-out';
  } else if (event.key === 'F8') action = 'focus'; else if (event.key === 'F9') action = 'typewriter'; else if (event.key === 'F11') action = 'fullscreen';
  if (action) { event.preventDefault(); event.stopPropagation(); void execute(action); }
}, true);
$('#editor-stage').addEventListener('contextmenu', event => {
  event.preventDefault(); const menu = $('#menu'); menu.replaceChildren(); openedMenu = -2;
  const table = (event.target as HTMLElement).closest('.md-table'); const items: Array<[string, () => void]> = table ? [...table.querySelectorAll<HTMLButtonElement>('.table-toolbar button')].map(button => [button.title, () => button.click()]) : [];
  items.push(...[['剪切', 'cut'], ['复制', 'copy'], ['粘贴', 'paste'], ['全选', 'select-all'], ['加粗', 'bold'], ['斜体', 'italic'], ['超链接', 'link']].map(([label, action]) => [label, () => void execute(action)] as [string, () => void]));
  for (const [label, action] of items) { const button = document.createElement('button'); button.textContent = label; button.style.paddingLeft = '20px'; button.onmousedown = event => event.preventDefault(); button.onclick = () => { hideMenu(); action(); }; menu.append(button); }
  menu.style.left = `${Math.min(event.clientX, innerWidth - 290)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - items.length * 29 - 12)}px`; menu.hidden = false;
});
for (const button of document.querySelectorAll<HTMLElement>('[data-control]')) button.onclick = () => bridge.windowControl(button.dataset.control as 'minimize' | 'maximize' | 'close');
for (const button of document.querySelectorAll<HTMLElement>('[data-library]')) button.onclick = () => { library = button.dataset.library!; $<HTMLInputElement>('#sidebar-filter').value = ''; renderSidebar(); };
$('#add-tab').onclick = $('#new-empty').onclick = () => void execute('new'); $('#open-empty').onclick = () => void execute('open');
$('#toggle-sidebar').onclick = $('#sidebar-close').onclick = () => void execute('sidebar'); $('#source-mode').onclick = () => void execute('toggle-source'); $('#open-folder').onclick = () => void execute('folder');
$('#preferences-apply').onclick = () => void run(() => bridge.updatePreferences({ theme: $<HTMLSelectElement>('#theme-select').value as WorkspaceView['preferences']['theme'], codeTheme: $<HTMLSelectElement>('#code-theme-select').value as 'modern-dark' | 'vscode' | 'github-dark', fontSize: Number($<HTMLInputElement>('#font-size').value), readingWidth: Number($<HTMLSelectElement>('#reading-width-select').value), codeWrap: $<HTMLInputElement>('#code-wrap-toggle').checked, autoSave: $<HTMLInputElement>('#autosave-toggle').checked, formatOnSave: $<HTMLInputElement>('#format-save-toggle').checked, tabs: $<HTMLInputElement>('#tabs-toggle').checked, focus: $<HTMLInputElement>('#focus-toggle').checked, typewriter: $<HTMLInputElement>('#typewriter-toggle').checked }));
$('#quick-input').oninput = renderQuick; $('#quick-input').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  const count = $('#quick-results').querySelectorAll('button').length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (count) { quickSelection = (quickSelection + (event.key === 'ArrowDown' ? 1 : -1) + count) % count; paintQuickSelection(); } }
  else if (event.key === 'Enter') { event.preventDefault(); $('#quick-results').querySelectorAll<HTMLButtonElement>('button')[quickSelection]?.click(); }
}; $('#quick-close').onclick = () => $<HTMLDialogElement>('#quick-open').close(); $('#about-close').onclick = () => $<HTMLDialogElement>('#about').close();
$('#word-count').onclick = () => { const stats = currentStatistics(); toast(`${stats.words} 字 · ${stats.characters} 个正文字符 · ${stats.lines} 行（不计图片和链接目标地址）`); };
$('#reading-width').onclick = () => {
  const widths = [720, 900, 1080]; const current = workspace.preferences.readingWidth ?? 900;
  const next = widths.find(width => width > current) ?? widths[0]; void run(() => bridge.updatePreferences({ readingWidth: next }));
};
$('#sidebar-filter').oninput = renderSidebar;
$('#sidebar-filter').onkeydown = event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); $<HTMLInputElement>('#sidebar-filter').value = ''; renderSidebar(); activeEditor()?.focus(); } };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) { button.onmousedown = event => event.preventDefault(); button.onclick = () => void execute(button.dataset.command!); }
const sidebarResize = $('#sidebar-resize');
sidebarResize.onpointerdown = event => {
  if (event.button !== 0) return; event.preventDefault(); resizingSidebar = true;
  const start = event.clientX; const width = $('#sidebar').getBoundingClientRect().width; sidebarResize.setPointerCapture(event.pointerId); app.classList.add('resizing-sidebar');
  let next = width;
  const move = (event: PointerEvent) => { next = Math.round(Math.max(200, Math.min(420, innerWidth - 360, width + event.clientX - start))); document.documentElement.style.setProperty('--sidebar-width', `${next}px`); sidebarResize.setAttribute('aria-valuenow', String(next)); };
  const finish = () => { sidebarResize.onpointermove = null; sidebarResize.onpointerup = null; sidebarResize.onpointercancel = null; resizingSidebar = false; app.classList.remove('resizing-sidebar'); void run(() => bridge.updatePreferences({ sidebarWidth: next })); };
  sidebarResize.onpointermove = move; sidebarResize.onpointerup = finish; sidebarResize.onpointercancel = finish;
};
sidebarResize.onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
  const width = workspace.preferences.sidebarWidth ?? 256; const next = event.key === 'Home' ? 200 : event.key === 'End' ? 420 : width + (event.key === 'ArrowRight' ? 10 : -10);
  void run(() => bridge.updatePreferences({ sidebarWidth: next }));
};
sidebarResize.ondblclick = () => void run(() => bridge.updatePreferences({ sidebarWidth: 256 }));
$('#quick-open').addEventListener('close', () => requestAnimationFrame(() => { if (!document.querySelector('dialog[open]')) activeEditor()?.focus(); }));
bridge.onState(applyState); bridge.onCommand(command => void execute(command)); bridge.onMessage(toast); bridge.onPrepareClose(async token => { await Promise.allSettled([...pendingImages]); flushAll(); bridge.finishClose(token); });
void bridge.bootstrap().then(state => { applyState(state); if (state.recovered) toast('上次的文档和草稿已恢复。'); }).catch(error => toast(`无法读取工作区：${error.message}`));
// Desktop acceptance tests use the public editor state; this does not expose filesystem access.
(window as any).__editor = { active: activeEditor, execute, content: () => activeEditor()?.content, setContent: (content: string) => activeEditor()?.replace(content) };
