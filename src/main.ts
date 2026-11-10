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
import { MarkdownEditor, exportHTML, editorAction } from './editor';
import { Settings } from './settings';
import { COMMANDS, commandKeys, shortcutFromEvent } from '../shared/commands';
import { selectLine } from '@codemirror/commands';
import { headings } from './markdown';
import type { WorkspaceView, DocumentView, ActionResult, FolderEntry } from '../shared/types';

const bridge = window.rypota;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const app = $('#app');
app.innerHTML = `<header class="titlebar"><span class="app-mark" title="${APP_NAME}"><img class="app-logo" src="${logo}" alt=""><span class="brand-name">${APP_SHORT_NAME}<small>MOYE</small></span></span><nav class="menubar" aria-label="应用操作"><span class="menu-spacer"></span><button id="settings-open" data-command="preferences" title="设置" aria-label="设置">${icon('settings-gear')}<span>设置</span></button></nav><div class="window-controls"><button data-control="minimize" aria-label="最小化" title="最小化">${icon('chrome-minimize')}</button><button data-control="maximize" aria-label="最大化" title="最大化">${icon('chrome-maximize')}</button><button data-control="close" aria-label="关闭窗口" title="关闭窗口">${icon('chrome-close')}</button></div></header>
  <div class="workspace"><aside id="sidebar" hidden><div class="sidebar-heading"><strong id="folder-name">文档</strong></div><div class="sidebar-tabs"><button data-library="outline" class="active">${icon('list-tree')}大纲</button><button data-library="files">${icon('files')}文件</button><button data-library="drafts">${icon('history')}草稿</button></div><label class="sidebar-filter">${icon('filter')}<input id="sidebar-filter" type="search" aria-label="筛选侧栏" placeholder="筛选当前列表…" autocomplete="off"></label><div id="sidebar-content"></div></aside><div id="sidebar-resize" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin="200" aria-valuemax="420" aria-valuenow="256" tabindex="0" hidden></div>
  <main><div id="tabbar" hidden><div id="tabs" role="tablist" aria-label="打开的文档"></div><button id="add-tab" aria-label="新建标签页" title="新建标签页">${icon('add')}</button></div><div id="editor-stage"></div><div id="empty" hidden><button id="new-empty">${icon('new-file')}新建文档</button><button id="open-empty">${icon('folder-opened')}打开文件…</button></div><footer><button id="toggle-sidebar" aria-label="切换侧栏" title="切换侧栏 Ctrl+Shift+L">${icon('layout-sidebar-left')}</button><button id="source-mode" aria-label="源码模式" title="源码模式 Ctrl+/">${icon('code')}</button><span id="save-status" role="status"></span><span class="footer-space"></span><button id="word-count" title="字数统计">0 字</button><span id="mode-label"></span></footer></main></div>
  <div id="menu" role="menu" hidden></div><div id="toast" role="status" hidden></div>
  <dialog id="quick-open"><h2>快速打开</h2><input id="quick-input" placeholder="搜索标题或路径…" aria-label="快速打开文件名" role="combobox" aria-controls="quick-results" aria-expanded="true" aria-autocomplete="list" autocomplete="off"><div id="quick-results" role="listbox" aria-label="文件搜索结果"></div><p class="quick-help"><kbd>↑ ↓</kbd> 选择 <kbd>Enter</kbd> 打开 <kbd>Esc</kbd> 返回写作</p><button id="quick-close">关闭</button></dialog>
`;

let workspace: WorkspaceView;
const settings = new Settings({ current: () => workspace, execute, save: value => bridge.updatePreferences(value), focus: () => activeEditor()?.focus() });
let printPreview: import('./print-preview').PrintPreview | undefined;
let library = 'outline'; let folder: { path: string; entries: FolderEntry[] } | null = null;
const slots = new Map<string, { element: HTMLElement; editor: MarkdownEditor; applying: boolean }>();
const pendingImages = new Set<Promise<void>>();
let toastTimer: ReturnType<typeof setTimeout>; let renderPending = false; let openedMenu = -1;
let tabSignature = ''; let draggedTab: string | null = null;
let measuredAppearance = '';
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
  const editor = new MarkdownEditor(element, doc.content, { id: doc.id, media: url => media(doc.id, url), link, changed: content => changed(doc.id, content), codeWrap: () => !!workspace.preferences.codeWrap, setCodeWrap: value => { void run(() => bridge.updatePreferences({ codeWrap: value })); }, workbuddy: () => workspace.preferences.theme === 'workbuddy', githubDark: () => workspace.preferences.codeTheme === 'github-dark', highlightWithEquals: () => commandKeys('highlight', workspace.preferences.shortcuts).includes('=') });
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
  const previousId = workspace?.activeId;
  if (workspace) next.documents = next.documents.map(incoming => { const local = workspace.documents.find(doc => doc.id === incoming.id); return local && local.revision > incoming.revision ? { ...incoming, content: local.content, revision: local.revision, dirty: true, status: incoming.error ? incoming.status : 'draft' } : incoming; });
  workspace = next;
  for (const [id, slot] of slots) if (!workspace.documents.some(doc => doc.id === id)) { slot.editor.destroy(); slot.element.remove(); slots.delete(id); }
  const doc = activeDocument(); if (doc) ensureEditor(doc);
  for (const [id, slot] of slots) { slot.element.hidden = id !== workspace.activeId; const current = workspace.documents.find(doc => doc.id === id); if (current && current.content !== slot.editor.content) { slot.applying = true; slot.editor.replace(current.content); slot.applying = false; } }
  render();
  if (previousId && previousId !== workspace.activeId) { const slot = slots.get(workspace.activeId ?? ''); if (slot) reveal(slot.element); }
}
let dragX: number | null = null; let dragFrame = 0;
let floatingTab: { element: HTMLElement; preview: HTMLElement; placeholder: HTMLElement; grabX: number; grabY: number } | null = null;
let releaseTabPointer: (() => void) | null = null;
let cancelTabPointer: (() => void) | null = null;
function floatTab(tab: HTMLElement, x: number, y: number, originX = x, originY = y) {
  const box = tab.getBoundingClientRect();
  const left = tab.offsetLeft, top = tab.offsetTop;
  const placeholder = document.createElement('div'); placeholder.className = 'tab-placeholder'; placeholder.setAttribute('aria-hidden', 'true');
  placeholder.style.width = `${box.width}px`; placeholder.style.height = `${box.height}px`;
  const preview = tab.cloneNode(true) as HTMLElement; preview.className = 'tab-drag-preview'; preview.removeAttribute('role'); preview.removeAttribute('data-id'); preview.removeAttribute('tabindex'); preview.setAttribute('aria-hidden', 'true');
  preview.style.width = `${box.width}px`; preview.style.height = `${box.height}px`;
  floatingTab = { element: tab, preview, placeholder, grabX: originX - box.left, grabY: originY - box.top };
  tab.style.width = `${box.width}px`; tab.style.height = `${box.height}px`; tab.style.left = `${left}px`; tab.style.top = `${top}px`;
  tab.classList.add('dragging'); tab.before(placeholder); document.body.append(preview); document.body.classList.add('tab-dragging');
  positionFloatingTab(x, y);
}
function positionFloatingTab(x: number, y: number) {
  if (!floatingTab) return;
  floatingTab.preview.style.left = `${x - floatingTab.grabX}px`; floatingTab.preview.style.top = `${y - floatingTab.grabY}px`;
}
function clearTabDrop() { for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('drop-before', 'drop-after'); }
function markTabDrop(x: number) {
  const tabs = [...$('#tabs').querySelectorAll<HTMLElement>('.tab')].filter(tab => tab.dataset.id !== draggedTab);
  const before = tabs.find(tab => { const box = tab.getBoundingClientRect(); return x < box.left + box.width / 2; });
  clearTabDrop();
  if (floatingTab) {
    floatingTab.placeholder.classList.remove('outside');
    if (before) before.before(floatingTab.placeholder); else $('#tabs').append(floatingTab.placeholder);
  } else (before ?? tabs.at(-1))?.classList.add(before ? 'drop-before' : 'drop-after');
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
  releaseTabPointer?.(); releaseTabPointer = null; cancelTabPointer = null;
  if (floatingTab) {
    floatingTab.placeholder.remove(); floatingTab.preview.remove(); floatingTab.element.classList.remove('dragging');
    for (const property of ['left', 'top', 'width', 'height']) floatingTab.element.style.removeProperty(property);
    floatingTab = null;
  }
  document.body.classList.remove('tab-dragging');
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
  positionFloatingTab(event.clientX, event.clientY);
  event.preventDefault(); event.dataTransfer.dropEffect = 'move'; dragX = event.clientX; markTabDrop(dragX); $('#tabbar').classList.add('drag-over');
  if (!dragFrame) dragFrame = requestAnimationFrame(scrollTabDrag);
};
$('#tabbar').ondragenter = acceptTabDrag; $('#tabbar').ondragover = acceptTabDrag;
$('#tabbar').ondragleave = event => {
  if ($('#tabbar').contains(event.relatedTarget as Node)) return;
  dragX = null; cancelAnimationFrame(dragFrame); dragFrame = 0; clearTabDrop(); $('#tabbar').classList.remove('drag-over');
  floatingTab?.placeholder.classList.add('outside');
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
      skipClick = false;
      const originX = event.clientX, originY = event.clientY; const previousFocus = document.activeElement as HTMLElement | null; let started = false;
      tab.setPointerCapture(event.pointerId);
      const pointerId = event.pointerId;
      releaseTabPointer = () => {
        window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', finish, true); window.removeEventListener('pointercancel', finish, true); tab.onlostpointercapture = null;
        if (tab.hasPointerCapture(pointerId)) tab.releasePointerCapture(pointerId);
      };
      const inside = (event: PointerEvent) => { const box = $('#tabbar').getBoundingClientRect(); return event.clientY >= box.top && event.clientY <= box.bottom && event.clientX >= box.left && event.clientX <= box.right; };
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (!started && Math.hypot(event.clientX - originX, event.clientY - originY) < 6) return;
        if (!started) { started = true; draggedTab = item.id; floatTab(tab, event.clientX, event.clientY, originX, originY); }
        event.preventDefault();
        positionFloatingTab(event.clientX, event.clientY);
        if (inside(event)) { dragX = event.clientX; markTabDrop(dragX); $('#tabbar').classList.add('drag-over'); if (!dragFrame) dragFrame = requestAnimationFrame(scrollTabDrag); }
        else { dragX = null; clearTabDrop(); $('#tabbar').classList.remove('drag-over'); floatingTab?.placeholder.classList.add('outside'); }
      };
      const finish = (event?: PointerEvent) => {
        if (event && event.pointerId !== pointerId) return;
        if (!started) { releaseTabPointer?.(); releaseTabPointer = null; cancelTabPointer = null; return; }
        const accepted = event?.type === 'pointerup' && inside(event); const before = accepted ? markTabDrop(event.clientX) : null;
        skipClick = true; endTabDrag(); if (accepted) moveTab(item.id, before);
        if (previousFocus?.isConnected && $('#editor-stage').contains(previousFocus)) previousFocus.focus(); else activeEditor()?.focus();
      };
      window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', finish, true); window.addEventListener('pointercancel', finish, true);
      tab.onlostpointercapture = () => finish(); cancelTabPointer = () => finish();
    };
    tab.ondragstart = event => { if (!event.dataTransfer || (event.target as HTMLElement).closest('.tab-close')) { event.preventDefault(); return; } draggedTab = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-replica-tab', item.id); const box = tab.getBoundingClientRect(); floatTab(tab, event.clientX || box.left + box.width / 2, event.clientY || box.top + box.height / 2); };
    tab.ondragend = endTabDrag;
    $('#tabs').append(tab);
  }
}
window.addEventListener('blur', () => cancelTabPointer?.());
window.addEventListener('keydown', event => { if (event.key === 'Escape' && cancelTabPointer) { event.preventDefault(); event.stopImmediatePropagation(); cancelTabPointer(); } }, true);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveals = new WeakMap<HTMLElement, Animation>();
function reveal(element: HTMLElement, distance = 4) {
  reveals.get(element)?.cancel();
  if (reducedMotion()) return;
  const animation = element.animate([{ opacity: .45, transform: `translateY(${distance}px)` }, { opacity: 1, transform: 'translateY(0)' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
  reveals.set(element, animation);
  animation.onfinish = () => { if (reveals.get(element) === animation) reveals.delete(element); };
}
let sidebarVisible: boolean | undefined;
let sidebarMotion: Animation | undefined;
let mainMotion: Animation | undefined;
function syncSidebar(visible: boolean) {
  if (visible === sidebarVisible) return;
  const sidebar = $('#sidebar'), separator = $('#sidebar-resize'), main = $<HTMLElement>('.workspace > main');
  const initial = sidebarVisible === undefined;
  const oldMainLeft = main.getBoundingClientRect().left;
  const oldSidebarLeft = sidebar.hidden ? -(workspace.preferences.sidebarWidth ?? 256) : sidebar.getBoundingClientRect().left;
  sidebarMotion?.cancel(); mainMotion?.cancel(); sidebarMotion = mainMotion = undefined;
  sidebarVisible = visible; sidebar.inert = !visible;
  $('#toggle-sidebar').setAttribute('aria-expanded', String(visible));
  if (!visible && (sidebar.contains(document.activeElement) || document.activeElement === separator)) activeEditor()?.focus();
  separator.hidden = !visible;
  sidebar.classList.toggle('sidebar-leaving', !visible);
  if (initial || reducedMotion()) { sidebar.hidden = !visible; sidebar.classList.remove('sidebar-moving'); return; }
  sidebar.hidden = false; sidebar.classList.add('sidebar-moving');
  // Change layout once, then animate only compositor transforms. Animating width
  // makes every CodeMirror block remeasure on every frame, especially on first use.
  const mainDelta = oldMainLeft - main.getBoundingClientRect().left;
  const baseLeft = sidebar.offsetLeft, width = sidebar.offsetWidth;
  const options = { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' };
  mainMotion = main.animate([{ transform: `translateX(${mainDelta}px)` }, { transform: 'translateX(0)' }], options);
  const animation = sidebar.animate([{ transform: `translateX(${initial ? -width : oldSidebarLeft - baseLeft}px)` }, { transform: `translateX(${visible ? 0 : -width}px)` }], options);
  sidebarMotion = animation;
  animation.onfinish = () => {
    if (sidebarMotion !== animation) return;
    sidebarMotion = undefined; mainMotion = undefined; sidebar.hidden = !sidebarVisible; sidebar.classList.remove('sidebar-moving');
    for (const slot of slots.values()) slot.editor.view.requestMeasure();
  };
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
  const maximize = $('[data-control="maximize"]'); const maximizeIcon = workspace.maximized ? 'chrome-restore' : 'chrome-maximize';
  if (maximize.querySelector('svg')?.dataset.icon !== maximizeIcon) maximize.innerHTML = icon(maximizeIcon);
  maximize.title = workspace.maximized ? '还原' : '最大化'; maximize.setAttribute('aria-label', maximize.title);
  const sidebarIcon = preferences.sidebar ? 'layout-sidebar-left' : 'layout-sidebar-left-off';
  if ($('#toggle-sidebar svg').dataset.icon !== sidebarIcon) $('#toggle-sidebar').innerHTML = icon(sidebarIcon);
  const palette = (workspace.codeTheme ?? MODERN_DARK).palette;
  for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(['background', 'foreground', 'border'].includes(key) ? `--code-${key}` : `--syntax-${key}`, value);
  $('#code-theme-status').hidden = preferences.codeTheme !== 'vscode';
  $('#code-theme-status').textContent = workspace.codeTheme?.message ?? `正在跟随 VS Code：${workspace.codeTheme?.name ?? '现代深色'}`;
  syncSidebar(!!preferences.sidebar); $('#tabbar').hidden = !workspace.documents.length || preferences.tabs === false;
  const title = `${doc?.dirty && doc.path ? '● ' : ''}${doc?.title ?? '未命名'}`; document.title = `${title} — ${APP_NAME}`;
  printPreview?.observe(workspace.documents.find(document => document.id === printPreview?.documentId()));
  renderTabs();
  $('#empty').hidden = Boolean(doc); $('#editor-stage').hidden = !doc;
  $('#source-mode').classList.toggle('active', !!editor?.source); $('#mode-label').textContent = editor?.source ? '源码模式' : '';
  $('#save-status').textContent = doc?.error ?? (doc ? doc.status === 'saving' ? '保存中…' : doc.draftRevision < doc.revision ? '保存草稿…' : doc.path ? doc.dirty ? '修改已保留' : '已保存' : doc.content ? '草稿已保存' : '' : ''); $('#save-status').classList.toggle('error', !!doc?.error);
  $('#save-status').dataset.state = doc?.error ? 'error' : doc?.status === 'saving' || (doc && doc.draftRevision < doc.revision) ? 'pending' : doc?.path && !doc.dirty ? 'saved' : 'draft';
  $('#save-status').title = doc?.error ?? (doc?.path ? `${doc.path}${doc.savedAt ? ' · 上次保存：' + new Date(doc.savedAt).toLocaleTimeString() : ''}` : '草稿仅保存在本机，Ctrl+S 可保存为文件');
  const words = currentStatistics().words; $('#word-count').textContent = `${words.toLocaleString()} 字`;
  for (const [selector, id] of [['#settings-open', 'preferences'], ['#source-mode', 'toggle-source'], ['#toggle-sidebar', 'sidebar'], ['#add-tab', 'new'], ['.code-wrap', 'code-wrap']] as const) for (const button of document.querySelectorAll<HTMLElement>(selector)) { const c = COMMANDS.find(c => c.id === id)!; button.title = [c.label, commandKeys(id, preferences.shortcuts).join(' / ')].filter(Boolean).join(' · '); }
  renderSidebar();
  const appearance = JSON.stringify([preferences.theme, preferences.fontSize, preferences.readingWidth, preferences.sidebar, preferences.sidebarWidth, preferences.codeWrap]);
  if (appearance !== measuredAppearance) { measuredAppearance = appearance; for (const slot of slots.values()) slot.editor.view.requestMeasure(); }
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
function hideMenu() { $('#menu').hidden = true; openedMenu = -1; }
function preferences() { settings.open(); }
function quickOpen() { $<HTMLDialogElement>('#quick-open').showModal(); reveal($('#quick-open'), 4); $<HTMLInputElement>('#quick-input').value = ''; renderQuick(); $<HTMLInputElement>('#quick-input').focus(); }
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
  if (action === 'tabs') return run(() => bridge.updatePreferences({ tabs: workspace.preferences.tabs === false }));
  if (action === 'workbuddy') return run(() => bridge.updatePreferences({ theme: 'workbuddy', codeTheme: 'github-dark', readingWidth: 900 }));
  if (action === 'light' || action === 'dark' || action === 'copilot') return run(() => bridge.updatePreferences({ theme: action }));
  if (action === 'code-github') return run(() => bridge.updatePreferences({ codeTheme: 'github-dark' }));
  if (action === 'code-modern' || action === 'code-vscode') return run(() => bridge.updatePreferences({ codeTheme: action === 'code-vscode' ? 'vscode' : 'modern-dark' }));
  if (action === 'code-refresh') { await run(() => bridge.refreshCodeTheme()); toast(workspace.preferences.codeTheme === 'vscode' ? workspace.codeTheme?.message ?? `已读取 VS Code 主题：${workspace.codeTheme?.name}` : '已重新读取 VS Code 主题；选择“代码配色：跟随 VS Code”即可应用'); return; }
  if (action.startsWith('zoom-')) return run(() => bridge.updatePreferences({ fontSize: action === 'zoom-reset' ? 16 : workspace.preferences.fontSize + (action === 'zoom-in' ? 1 : -1) }));
  if (action === 'auto-save') return run(() => bridge.updatePreferences({ autoSave: !workspace.preferences.autoSave }));
  if (action === 'fullscreen') { bridge.fullscreen(); return; } if (action === 'preferences') { preferences(); return; }
  if (action === 'quick-open') { quickOpen(); return; } if (action === 'about' || action === 'shortcuts') { settings.open(action === 'about' ? '关于' : '快捷键'); return; }
  if (action === 'guide') return run(() => bridge.openExternal('https://support.typora.io/Markdown-Reference/'));
  if (action === 'toggle-source') { editor?.setSource(!editor.source); render(); return; }
  if (action === 'code-wrap') return run(() => bridge.updatePreferences({ codeWrap: !workspace.preferences.codeWrap }));
  if (action === 'select-line') { const focused = document.activeElement?.closest('.cm-content'); const view = focused ? EditorView.findFromDOM(focused as HTMLElement) : editor?.view; if (view) selectLine(view); return; }
  if (action === 'tidy-chinese') { flushAll(); editor?.action(action); editor?.focus(); toast('已整理中文排版，可用 Ctrl+Z 撤销'); return; }
  if (action === 'organize-images' && doc) { flushAll(); return run(() => bridge.organizeImages(doc.id)); }
  if (action === 'next-tab' || action === 'previous-tab') { flushAll(); const index = workspace.documents.findIndex(doc => doc.id === workspace.activeId); const next = workspace.documents[(index + (action === 'next-tab' ? 1 : -1) + workspace.documents.length) % workspace.documents.length]; if (next) return run(() => bridge.activateDocument(next.id)); return; }
  if (action === 'insert-image' && doc && editor) { const result = await bridge.insertImage(doc.id); if (result.message) toast(result.message); if (result.url) editor.insertImage(result.url); return; }
  if (action === 'export-pdf' && doc) {
    if (!printPreview) { const { PrintPreview } = await import('./print-preview'); printPreview = new PrintPreview(id => workspace.documents.find(doc => doc.id === id), media, () => activeEditor()?.focus()); }
    printPreview.open(doc, workspace.preferences.print); return;
  }
  if (action.startsWith('export-') && doc) {
    const workbuddy = workspace.preferences.theme === 'workbuddy';
    const body = await exportHTML(doc.content, { id: doc.id, media: url => media(doc.id, url), link, changed: () => {}, workbuddy: () => workbuddy, githubDark: () => workspace.preferences.codeTheme === 'github-dark' });
    const extraStyle = workbuddy ? (await import('./workbuddy-export')).default : '';
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'"><title>${doc.title.replace(/[<>&"]/g, '')}</title><style>body{font:16px/1.6 'Segoe UI','霞鹜文楷','LXGW WenKai','Microsoft YaHei UI',sans-serif;color:#333;margin:36px auto;max-width:860px;padding:0 30px}h1,h2{border-bottom:1px solid #eee;padding-bottom:.3em}h1{font-size:2.25em}h2{font-size:1.75em}a{color:#4183c4}pre{padding:16px;background:#f6f8fa;white-space:pre-wrap}code{font-family:Consolas,'霞鹜文楷','LXGW WenKai',monospace}table{border-collapse:collapse;margin-left:auto;margin-right:auto}td,th{border:1px solid #ddd;padding:6px 13px}blockquote{border-left:4px solid #ddd;margin-left:0;padding-left:16px;color:#777}img{max-width:100%}.katex-html{display:none}math{font-size:1.1em}p{margin:1em 0}${extraStyle}</style></head><body>${body}</body></html>`;
    return run(() => bridge.exportDocument(doc.id, action === 'export-pdf' ? 'pdf' : 'html', html));
  }
  if (action === 'paste') { if (!document.activeElement?.closest('#editor-stage')) editor?.focus(); return run(() => bridge.paste()); }
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
  if (focused && ['undo', 'redo', 'find', 'replace'].includes(action)) { const nested = EditorView.findFromDOM(focused as HTMLElement); if (nested) editorAction(nested, action); return; }
  if (!formatCell(action)) editor?.action(action);
}

document.addEventListener('mousedown', event => { if (!(event.target as HTMLElement).closest('#menu')) hideMenu(); });
let compositionTarget: EventTarget | null = null;
document.addEventListener('compositionstart', event => { compositionTarget = event.target; }, true);
document.addEventListener('compositionend', () => { compositionTarget = null; }, true);
document.addEventListener('keydown', event => {
  if (!workspace) return;
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { hideMenu(); return; }
  if (!$('#menu').hidden && ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
    event.preventDefault(); event.stopImmediatePropagation();
    const buttons = [...$('#menu').querySelectorAll<HTMLButtonElement>('button')], i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Enter') (document.activeElement as HTMLElement)?.click(); else buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    return;
  }
  const target = document.activeElement as HTMLElement | null;
  const focusedView = target?.closest('.cm-content') ? EditorView.findFromDOM(target) : undefined;
  const key = shortcutFromEvent(event); if (!key) return;
  if (compositionTarget || (key !== '=' && (event.isComposing || focusedView?.composing || activeEditor()?.view.composing))) return;
  const inCell = !!target?.closest('th[contenteditable=true],td[contenteditable=true]');
  const inCode = !!target?.closest('.code-content');
  const textField = !!target?.closest('input,textarea');
  const command = COMMANDS.find(c => commandKeys(c.id, workspace.preferences.shortcuts).includes(key));
  if (!command) {
    // Removed or changed editor shortcuts must not fall through to CodeMirror's
    // built-in keymaps. Text fields retain their usual native editing shortcuts.
    if ((!textField || target?.closest('#editor-stage')) && key.includes('+') && COMMANDS.some(c => Object.hasOwn(workspace.preferences.shortcuts ?? {}, c.id) && c.keys.includes(key))) { event.preventDefault(); event.stopImmediatePropagation(); }
    return;
  }
  if (command.editor && textField) {
    if (target?.closest('#editor-stage') && ['undo', 'redo', 'cut', 'copy', 'paste', 'select-all'].includes(command.id)) { event.preventDefault(); event.stopImmediatePropagation(); if (command.id === 'paste') void bridge.paste(); else document.execCommand(command.id === 'select-all' ? 'selectAll' : command.id); }
    return;
  }
  if (event.keyCode === 229 && key !== '=') return;
  if (key === '=' && command.id === 'highlight') {
    const handled = inCell ? window.getSelection()?.isCollapsed === false && formatCell('highlight') : !inCode && activeEditor()?.view.hasFocus && activeEditor()?.highlightSelection();
    if (handled) { event.preventDefault(); event.stopImmediatePropagation(); } return;
  }
  if (inCode && (command.category === '段落' || command.category === '格式')) return;
  // Ordinary paste retains image/HTML clipboard formats and the editor's paste
  // handlers. Custom paste bindings invoke the same native paste via IPC.
  if (command.id === 'paste' && key === 'Ctrl+V') return;
  event.preventDefault(); event.stopImmediatePropagation(); void execute(command.id);
}, true);
$('#editor-stage').addEventListener('contextmenu', event => {
  event.preventDefault(); const menu = $('#menu'); menu.replaceChildren(); openedMenu = -2;
  const table = (event.target as HTMLElement).closest('.md-table'); const items: Array<[string, () => void]> = table ? [...table.querySelectorAll<HTMLButtonElement>('.table-toolbar button')].map(button => [button.title, () => button.click()]) : [];
  items.push(...[['剪切', 'cut'], ['复制', 'copy'], ['粘贴', 'paste'], ['全选', 'select-all'], ['加粗', 'bold'], ['斜体', 'italic'], ['超链接', 'link']].map(([label, action]) => [label, () => void execute(action)] as [string, () => void]));
  for (const [label, action] of items) { const button = document.createElement('button'); button.textContent = label; button.style.paddingLeft = '20px'; button.onmousedown = event => event.preventDefault(); button.onclick = () => { hideMenu(); action(); }; menu.append(button); }
  menu.style.left = `${Math.min(event.clientX, innerWidth - 290)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - items.length * 29 - 12)}px`; menu.hidden = false;
});
for (const button of document.querySelectorAll<HTMLElement>('[data-control]')) button.onclick = () => bridge.windowControl(button.dataset.control as 'minimize' | 'maximize' | 'close');
for (const button of document.querySelectorAll<HTMLElement>('[data-library]')) button.onclick = () => { const next = button.dataset.library!; if (library === next) return; library = next; $<HTMLInputElement>('#sidebar-filter').value = ''; renderSidebar(); reveal($('#sidebar-content'), 3); };
$('#add-tab').onclick = $('#new-empty').onclick = () => void execute('new'); $('#open-empty').onclick = () => void execute('open');
$('#toggle-sidebar').onclick = () => void execute('sidebar'); $('#source-mode').onmousedown = event => event.preventDefault(); $('#source-mode').onclick = () => void execute('toggle-source');
$('#quick-input').oninput = renderQuick; $('#quick-input').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  const count = $('#quick-results').querySelectorAll('button').length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (count) { quickSelection = (quickSelection + (event.key === 'ArrowDown' ? 1 : -1) + count) % count; paintQuickSelection(); } }
  else if (event.key === 'Enter') { event.preventDefault(); $('#quick-results').querySelectorAll<HTMLButtonElement>('button')[quickSelection]?.click(); }
}; $('#quick-close').onclick = () => $<HTMLDialogElement>('#quick-open').close();
$('#word-count').onclick = () => { const stats = currentStatistics(); toast(`${stats.words} 字 · ${stats.characters} 个正文字符 · ${stats.lines} 行（不计图片和链接目标地址）`); };
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
$('#settings-open').onmousedown = event => event.preventDefault();
bridge.onState(applyState); bridge.onCommand(command => void execute(command)); bridge.onMessage(toast); bridge.onPrepareClose(async token => { await Promise.allSettled([...pendingImages]); flushAll(); bridge.finishClose(token); });
void bridge.bootstrap().then(state => { applyState(state); if (state.recovered) toast('上次的文档和草稿已恢复。'); }).catch(error => toast(`无法读取工作区：${error.message}`));
// Desktop acceptance tests use the public editor state; this does not expose filesystem access.
(window as any).__editor = { active: activeEditor, execute, content: () => activeEditor()?.content, setContent: (content: string) => activeEditor()?.replace(content) };
