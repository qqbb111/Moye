import { COMMANDS, commandKeys, normalizeShortcut, shortcutConflict, shortcutFromEvent, validateShortcuts, type ShortcutOverrides } from '../shared/commands';
import type { WorkspaceView, ActionResult, UpdateAction, UpdateState } from '../shared/types';
import { icon } from './icons';
import { APP_NAME, THEMES } from '../shared/branding';
import { CODE_THEME_OPTIONS } from '../shared/code-theme';
import { version } from '../package.json';
import './themes/settings.css';

const sections = ['常规', '快捷键', '关于'];
const categories = ['全部', ...new Set(COMMANDS.map(command => command.category))];
const switches = [['code-wrap-toggle', 'codeWrap'], ['format-save-toggle', 'formatOnSave'], ['autosave-toggle', 'autoSave'], ['tabs-toggle', 'tabs']] as const;
type Preferences = WorkspaceView['preferences'];
export class Settings {
  readonly dialog: HTMLDialogElement;
  private section = '常规';
  private shortcuts: ShortcutOverrides = {};
  private category = '全部';
  private writes = Promise.resolve();
  private pendingWrites = 0;
  private saveError = '';
  private recording: string | null = null;
  private origin: HTMLElement | null = null;
  private range: Range | null = null;
  private cellSelection: { from: number; to: number } | null = null;
  private contextDocument: string | null = null;
  private updateState: UpdateState = { phase: 'idle' };
  constructor(private host: { current(): WorkspaceView; execute(id: string): Promise<void>; save(value: Partial<Preferences>): Promise<ActionResult>; focus(): void }) {
    this.dialog = document.createElement('dialog'); this.dialog.id = 'preferences'; this.dialog.setAttribute('aria-label', '设置');
    this.dialog.innerHTML = `<header class="settings-header"><h2>设置</h2><button type="button" id="settings-close" aria-label="关闭设置">${icon('close')}</button></header>
      <nav class="settings-tabs" role="tablist" aria-label="设置分类">${sections.map((name, i) => `<button type="button" role="tab" id="settings-tab-${i}" data-section="${name}" aria-controls="settings-panel">${name}</button>`).join('')}</nav>
      <section id="settings-panel" role="tabpanel" tabindex="0">
        <div id="settings-general">
          <div class="setting-row"><label for="theme-select">主题</label><select id="theme-select">${THEMES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
          <div class="setting-row"><label for="code-theme-select">代码配色</label><div class="setting-control"><select id="code-theme-select">${CODE_THEME_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select><button type="button" id="code-theme-refresh" aria-label="重新读取 VS Code 配色" title="重新读取 VS Code 配色" hidden>${icon('refresh')}</button></div></div><p id="code-theme-status" role="status" hidden></p>
          <div class="setting-row"><label for="font-size">正文字号</label><input id="font-size" type="number" min="14" max="24"></div>
          <div class="setting-row"><label for="reading-width-select">阅读宽度</label><select id="reading-width-select"><option value="720">紧凑 · 720</option><option value="900">适中 · 900</option><option value="1080">宽阔 · 1080</option></select></div>
          <div class="setting-row"><label for="code-wrap-toggle">代码自动换行</label><input id="code-wrap-toggle" type="checkbox" role="switch"></div>
          <div class="setting-row"><div class="setting-label"><label for="format-save-toggle">保存前整理中文排版</label><button type="button" id="format-save-info" class="setting-info" aria-label="了解中文排版整理" aria-describedby="format-save-help" popovertarget="format-save-help">${icon('info')}</button></div><input id="format-save-toggle" type="checkbox" role="switch"></div>
          <div class="setting-row"><label for="autosave-toggle">自动保存文件</label><input id="autosave-toggle" type="checkbox" role="switch"></div>
          <div class="setting-row"><label for="tabs-toggle">显示标签栏</label><input id="tabs-toggle" type="checkbox" role="switch"></div>
        </div>
        <div id="format-save-help" popover role="tooltip">整理中英文间距和常见标点；代码、公式、地址保持原样。</div>
        <div id="settings-shortcuts" hidden>
          <nav class="shortcut-categories" aria-label="快捷键分类">${categories.map(category => `<button type="button" data-shortcut-category="${category}" aria-pressed="${category === '全部'}">${category}</button>`).join('')}</nav>
          <div class="shortcut-list"><input id="shortcut-search" type="search" placeholder="搜索操作或快捷键" aria-label="搜索快捷键"><div id="settings-commands"></div></div>
        </div>
        <div id="settings-about" hidden><h3>${APP_NAME}</h3><div class="about-version"><span>版本 ${version}</span><button type="button" id="check-update">检查更新</button></div><p id="update-status" role="status" hidden></p><progress id="update-progress" aria-label="更新下载进度" max="100" hidden></progress><button type="button" data-settings-command="guide">Markdown 使用指南</button></div>
      </section>
      <p id="shortcut-message" role="status" hidden></p>`;
    document.body.append(this.dialog);
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => {
      button.onclick = () => { this.hideHelp(); this.section = button.dataset.section!; this.recording = null; this.message(''); this.render(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.get('#settings-panel').animate([{ opacity: .5, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 120, easing: 'ease-out' }); };
      button.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const i = sections.indexOf(this.section), next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
        const tab = this.dialog.querySelector<HTMLButtonElement>(`[data-section="${sections[next]}"]`)!; tab.click(); tab.focus();
      };
    });
    this.get<HTMLButtonElement>('#settings-close').onclick = () => this.dialog.close();
    this.get<HTMLButtonElement>('#check-update').onclick = () => void this.performUpdate();
    window.rypota.onPortableUpdate(state => this.renderUpdate(state));
    void window.rypota.portableUpdate('status').then(state => this.renderUpdate(state)).catch(() => {});
    this.get<HTMLInputElement>('#shortcut-search').oninput = () => { this.recording = null; this.message(''); this.renderCommands(); };
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-shortcut-category]')) button.onclick = () => {
      this.category = button.dataset.shortcutCategory!;
      this.recording = null; this.message('');
      for (const item of this.dialog.querySelectorAll('[data-shortcut-category]')) item.setAttribute('aria-pressed', String(item === button));
      this.renderCommands();
    };
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-settings-command]').forEach(button => button.onclick = () => this.run(button.dataset.settingsCommand!));
    this.dialog.addEventListener('keydown', event => this.record(event), true);
    this.dialog.addEventListener('cancel', event => { if (this.recording) { event.preventDefault(); this.recording = null; this.message(''); this.renderCommands(); } });
    this.dialog.addEventListener('close', () => { this.hideHelp(); this.recording = null; this.restoreFocus(); });
    const theme = this.get<HTMLSelectElement>('#theme-select');
    theme.onchange = () => this.persist({ theme: theme.value as Preferences['theme'] });
    const codeTheme = this.get<HTMLSelectElement>('#code-theme-select');
    codeTheme.onchange = () => { this.updateCodeTheme(); this.persist({ codeTheme: codeTheme.value as Preferences['codeTheme'] }); };
    const readingWidth = this.get<HTMLSelectElement>('#reading-width-select');
    readingWidth.onchange = () => this.persist({ readingWidth: Number(readingWidth.value) });
    const fontSize = this.get<HTMLInputElement>('#font-size');
    fontSize.onchange = () => {
      if (fontSize.value && fontSize.checkValidity()) this.persist({ fontSize: Number(fontSize.value) });
      else { fontSize.value = String(this.host.current().preferences.fontSize); this.message('正文字号范围为 14–24。'); }
    };
    fontSize.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); fontSize.blur(); } };
    for (const [id, key] of switches) {
      const input = this.get<HTMLInputElement>(`#${id}`);
      input.onchange = () => this.persist({ [key]: input.checked });
    }
    this.get<HTMLButtonElement>('#code-theme-refresh').onclick = async () => { const button = this.get<HTMLButtonElement>('#code-theme-refresh'); button.disabled = true; try { await this.host.execute('code-refresh'); } finally { button.disabled = false; this.updateCodeTheme(); } };
    this.get('#settings-panel').addEventListener('scroll', () => this.hideHelp(), { passive: true });
    this.get('#format-save-help').addEventListener('beforetoggle', event => { if ((event as ToggleEvent).newState === 'open') { const rect = this.get('#format-save-info').getBoundingClientRect(); const help = this.get('#format-save-help'); help.style.left = `${Math.min(rect.left, innerWidth - 300)}px`; help.style.top = `${rect.bottom + 8}px`; } });
  }
  private get<T extends HTMLElement>(selector: string) { return this.dialog.querySelector<T>(selector)!; }
  private async performUpdate() {
    const actions: Partial<Record<UpdateState['phase'], UpdateAction>> = { idle: 'check', current: 'check', error: 'check', available: 'download', downloading: 'cancel', ready: 'install' };
    const action = actions[this.updateState.phase];
    if (!action) return;
    try { this.renderUpdate(await window.rypota.portableUpdate(action)); }
    catch { this.renderUpdate({ phase: 'error', message: '无法更新，请重试。' }); }
  }
  private renderUpdate(state: UpdateState) {
    this.updateState = state;
    const button = this.get<HTMLButtonElement>('#check-update');
    const progress = this.get<HTMLProgressElement>('#update-progress');
    const status = this.get('#update-status');
    const labels: Partial<Record<UpdateState['phase'], string>> = { checking: '正在检查…', available: '下载更新', downloading: '取消下载', preparing: '正在校验…', ready: '保存草稿并重启', installing: '正在重启…' };
    const messages: Partial<Record<UpdateState['phase'], string>> = { current: '当前已是最新版。', available: `发现新版本 ${state.version}`, downloading: `正在下载 ${state.version}`, ready: `${state.version} 已就绪。更新会关闭所有墨页窗口。` };
    button.textContent = labels[state.phase] ?? '检查更新';
    button.disabled = ['checking', 'preparing', 'installing', 'unsupported'].includes(state.phase);
    progress.hidden = state.phase !== 'downloading';
    if (!progress.hidden) progress.value = state.percent ?? 0;
    const message = state.message ?? messages[state.phase] ?? '';
    if (status.textContent !== message) status.textContent = message;
    status.hidden = !message;
  }
  open(section = '常规') {
    if (this.dialog.open) return;
    this.contextDocument = this.host.current().activeId;
    this.origin = document.activeElement as HTMLElement | null;
    const selection = window.getSelection(); this.range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    this.cellSelection = null;
    if (this.range && this.origin?.matches('th[contenteditable=true],td[contenteditable=true]') && this.origin.contains(this.range.startContainer) && this.origin.contains(this.range.endContainer)) { const prefix = this.range.cloneRange(); prefix.selectNodeContents(this.origin); prefix.setEnd(this.range.startContainer, this.range.startOffset); const from = prefix.toString().length; this.cellSelection = { from, to: from + this.range.toString().length }; }
    this.section = sections.includes(section) ? section : '常规'; this.recording = null;
    this.syncControls();
    this.message(''); this.render(); this.updateCodeTheme(); this.dialog.showModal(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.dialog.animate([{ opacity: .4, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 140, easing: 'ease-out' }); this.get<HTMLButtonElement>(`[data-section="${this.section}"]`).focus();
  }
  private syncControls() {
    if (this.pendingWrites) return;
    const p = this.host.current().preferences; this.shortcuts = { ...p.shortcuts };
    this.get<HTMLSelectElement>('#theme-select').value = p.theme;
    this.get<HTMLSelectElement>('#code-theme-select').value = p.codeTheme ?? 'github-dark';
    this.get<HTMLInputElement>('#font-size').value = String(p.fontSize);
    this.get<HTMLSelectElement>('#reading-width-select').value = String([720, 900, 1080].reduce((a, b) => Math.abs(b - (p.readingWidth ?? 900)) < Math.abs(a - (p.readingWidth ?? 900)) ? b : a));
    for (const [id, key] of switches) this.get<HTMLInputElement>(`#${id}`).checked = key === 'tabs' ? p.tabs !== false : !!p[key];
  }
  syncPreferences(previous?: Preferences) {
    if (!previous || !this.dialog.open || this.pendingWrites) return;
    const current = this.host.current().preferences;
    const shortcutChanged = JSON.stringify(previous.shortcuts) !== JSON.stringify(current.shortcuts);
    if (!shortcutChanged && !(['theme', 'codeTheme', 'fontSize', 'readingWidth', 'codeWrap', 'formatOnSave', 'autoSave', 'tabs'] as const).some(key => previous[key] !== current[key])) return;
    this.syncControls();
    if (shortcutChanged && this.section === '快捷键') this.renderCommands();
  }
  updateCodeTheme() {
    const following = this.get<HTMLSelectElement>('#code-theme-select').value === 'vscode';
    this.get('#code-theme-refresh').hidden = !following;
    const current = this.host.current(); const status = this.get('#code-theme-status');
    status.hidden = !following || current.preferences.codeTheme !== 'vscode';
    status.textContent = current.codeTheme?.message ?? current.codeTheme?.name ?? '';
  }
  private hideHelp() { const help = this.get('#format-save-help'); if (help.matches(':popover-open')) help.hidePopover(); }
  private startRecording(id: string) { this.recording = id; this.message(''); this.renderCommands(); this.focusKey(id); }
  private focusKey(id: string) { (this.get<HTMLButtonElement>(`[data-shortcut-id="${id}"]`) ?? this.get('#shortcut-search')).focus(); }
  private restoreFocus() {
    if (this.contextDocument !== this.host.current().activeId) { this.host.focus(); return; }
    if (this.origin?.isConnected && this.origin.closest('#editor-stage')) {
      this.origin.focus({ preventScroll: true });
      if (this.cellSelection && this.origin.matches('th,td') && this.origin.firstChild) { const node = this.origin.firstChild; const range = document.createRange(); range.setStart(node, Math.min(node.textContent?.length ?? 0, this.cellSelection.from)); range.setEnd(node, Math.min(node.textContent?.length ?? 0, this.cellSelection.to)); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return; }
      if (this.range && this.origin.closest('th,td') && this.range.startContainer.isConnected && this.range.endContainer.isConnected) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(this.range); }
    } else this.host.focus();
  }
  private run(id: string) { this.dialog.close(); void this.host.execute(id); }
  private message(text: string) { const status = this.get('#shortcut-message'); status.textContent = text; status.hidden = !text; }
  private render() {
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-section]')) { const active = button.dataset.section === this.section; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
    const panel = this.get('#settings-panel'); panel.setAttribute('aria-labelledby', `settings-tab-${sections.indexOf(this.section)}`); panel.scrollTop = 0;
    this.get('#settings-general').hidden = this.section !== '常规'; this.get('#settings-about').hidden = this.section !== '关于'; this.get('#settings-shortcuts').hidden = this.section !== '快捷键';
    if (this.section === '快捷键') this.renderCommands();
  }
  private renderCommands() {
    const list = this.get('#settings-commands'); list.replaceChildren();
    const query = this.get<HTMLInputElement>('#shortcut-search').value.toLowerCase().trim();
    const commands = COMMANDS.filter(c => (this.category === '全部' || c.category === this.category) && (!query || `${c.label} ${c.category} ${commandKeys(c.id, this.shortcuts).join(' ')}`.toLowerCase().includes(query)));
    for (const c of commands) {
      const row = document.createElement('div'); row.className = 'settings-command';
      const label = document.createElement('label'); label.className = 'shortcut-label'; label.textContent = c.label;
      const key = document.createElement('button'); key.type = 'button'; key.id = label.htmlFor = `shortcut-${c.id}`; key.className = 'shortcut-key'; key.dataset.shortcutId = c.id; key.setAttribute('aria-label', `修改${c.label}快捷键`);
      key.textContent = this.recording === c.id ? '按下组合键…' : commandKeys(c.id, this.shortcuts).join(' / ') || '未设置';
      key.classList.toggle('recording', this.recording === c.id); key.onclick = () => this.startRecording(c.id);
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'shortcut-clear'; clear.innerHTML = icon('close'); clear.title = `清除${c.label}快捷键`; clear.setAttribute('aria-label', clear.title); clear.disabled = !commandKeys(c.id, this.shortcuts).length; clear.onclick = () => this.changeShortcut(c.id, { ...this.shortcuts, [c.id]: '' });
      const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'shortcut-reset'; reset.innerHTML = icon('history'); reset.title = `恢复${c.label}默认快捷键`; reset.setAttribute('aria-label', reset.title); reset.onclick = () => {
        const next = { ...this.shortcuts }; delete next[c.id];
        this.changeShortcut(c.id, next);
      };
      reset.disabled = !Object.hasOwn(this.shortcuts, c.id);
      row.append(label, key, clear, reset); list.append(row);
    }
    if (this.section === '快捷键' && !commands.length) { const empty = document.createElement('p'); empty.textContent = '没有匹配的操作'; list.append(empty); }
  }
  private record(event: KeyboardEvent) {
    if (!this.recording) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.isComposing || event.key === 'Process') return;
    if (event.key === 'Escape') { const id = this.recording; this.recording = null; this.message(''); this.renderCommands(); this.focusKey(id); return; }
    const raw = shortcutFromEvent(event); if (!raw) return;
    try {
      const key = normalizeShortcut(raw); const conflict = shortcutConflict(this.recording, key, this.shortcuts);
      if (conflict) throw new Error(`与「${conflict.label}」的 ${key} 冲突`);
      this.changeShortcut(this.recording, { ...this.shortcuts, [this.recording]: key });
    } catch (error) { this.message((error as Error).message); }
  }
  private changeShortcut(id: string, next: ShortcutOverrides) {
    try {
      this.shortcuts = validateShortcuts(next); this.recording = null;
      this.persist({ shortcuts: this.shortcuts }); this.renderCommands(); this.focusKey(id);
    } catch (error) { this.message((error as Error).message); }
  }
  private persist(value: Partial<Preferences>) {
    this.message(''); this.pendingWrites++;
    this.writes = this.writes.then(async () => {
      try {
        const result = await this.host.save(value);
        if (!result.ok) throw new Error(result.message ?? '设置保存失败');
      } catch (error) {
        this.saveError = (error as Error).message;
      } finally {
        if (--this.pendingWrites === 0 && this.saveError) {
          this.syncControls();
          if (this.section === '快捷键') this.renderCommands();
          this.message(this.saveError); this.saveError = '';
        }
      }
    });
  }
  flush() { return this.writes; }
}
