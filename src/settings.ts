import { COMMANDS, commandKeys, normalizeShortcut, shortcutConflict, shortcutFromEvent, validateShortcuts, type ShortcutOverrides } from '../shared/commands';
import type { WorkspaceView, ActionResult } from '../shared/types';
import { icon } from './icons';
import { APP_NAME } from '../shared/branding';
import { version } from '../package.json';
import './themes/settings.css';

const sections = ['常规', '文件', '编辑', '段落', '格式', '视图', '快捷键', '关于'];
type Preferences = WorkspaceView['preferences'];
export class Settings {
  readonly dialog: HTMLDialogElement;
  private section = '常规';
  private shortcuts: ShortcutOverrides = {};
  private recording: string | null = null;
  private origin: HTMLElement | null = null;
  private range: Range | null = null;
  private cellSelection: { from: number; to: number } | null = null;
  private contextDocument: string | null = null;
  constructor(private host: { current(): WorkspaceView; execute(id: string): Promise<void>; save(value: Partial<Preferences>): Promise<ActionResult>; focus(): void }) {
    this.dialog = document.createElement('dialog'); this.dialog.id = 'preferences'; this.dialog.setAttribute('aria-label', '设置');
    this.dialog.innerHTML = `<header class="settings-header"><h2>设置</h2><button type="button" id="settings-close" aria-label="关闭设置">${icon('close')}</button></header>
      <nav class="settings-tabs" role="tablist" aria-label="设置分类">${sections.map((name, i) => `<button type="button" role="tab" id="settings-tab-${i}" data-section="${name}" aria-controls="settings-panel">${name}</button>`).join('')}</nav>
      <section id="settings-panel" role="tabpanel" tabindex="0">
        <div id="settings-general">
          <div class="setting-row"><label for="theme-select">主题</label><select id="theme-select"><option value="workbuddy">WorkBuddy 深色</option><option value="light">白色</option><option value="dark">夜间</option><option value="copilot">Copilot 深色</option></select></div>
          <div class="setting-row"><label for="code-theme-select">代码配色</label><div class="setting-control"><select id="code-theme-select"><option value="github-dark">GitHub Dark</option><option value="modern-dark">现代深色</option><option value="vscode">跟随本机 VS Code</option></select><button type="button" id="code-theme-refresh" aria-label="重新读取 VS Code 配色" title="重新读取 VS Code 配色" hidden>${icon('refresh')}</button></div></div><p id="code-theme-status" role="status" hidden></p>
          <div class="setting-row"><label for="font-size">正文字号</label><input id="font-size" type="number" min="14" max="24"></div>
          <div class="setting-row"><label for="reading-width-select">阅读宽度</label><select id="reading-width-select"><option value="720">紧凑 · 720</option><option value="900">适中 · 900</option><option value="1080">宽阔 · 1080</option></select></div>
          <div class="setting-row"><label for="code-wrap-toggle">代码自动换行</label><input id="code-wrap-toggle" type="checkbox" role="switch"></div>
          <div class="setting-row"><div class="setting-label"><label for="format-save-toggle">保存前整理中文排版</label><button type="button" id="format-save-info" class="setting-info" aria-label="了解中文排版整理" aria-describedby="format-save-help" popovertarget="format-save-help">${icon('info')}</button></div><input id="format-save-toggle" type="checkbox" role="switch"></div>
          <div class="setting-row"><label for="autosave-toggle">自动保存文件</label><input id="autosave-toggle" type="checkbox" role="switch"></div>
          <div class="setting-row"><label for="tabs-toggle">显示标签栏</label><input id="tabs-toggle" type="checkbox" role="switch"></div>
        </div>
        <div id="format-save-help" popover role="tooltip">整理中英文间距和常见标点；代码、公式、地址保持原样。</div>
        <div id="settings-shortcut-tools" hidden><input id="shortcut-search" type="search" placeholder="搜索操作或快捷键" aria-label="搜索快捷键"><button type="button" id="shortcut-reset-all">恢复全部默认</button></div>
        <div id="settings-commands"></div>
        <div id="settings-about" hidden><h3>${APP_NAME}</h3><p>版本 ${version}</p><button type="button" data-settings-command="guide">Markdown 使用指南</button></div>
      </section>
      <footer class="settings-footer"><span id="shortcut-message" role="status"></span><button type="button" value="cancel" id="settings-cancel">取消</button><button type="button" id="preferences-apply">应用</button></footer>`;
    document.body.append(this.dialog);
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => {
      button.onclick = () => { this.hideHelp(); this.section = button.dataset.section!; this.recording = null; this.message(''); this.render(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.get('#settings-panel').animate([{ opacity: .5, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 120, easing: 'ease-out' }); };
      button.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const i = sections.indexOf(this.section), next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
        const tab = this.dialog.querySelector<HTMLButtonElement>(`[data-section="${sections[next]}"]`)!; tab.click(); tab.focus();
      };
    });
    this.get<HTMLButtonElement>('#settings-close').onclick = this.get<HTMLButtonElement>('#settings-cancel').onclick = () => this.dialog.close();
    this.get<HTMLButtonElement>('#preferences-apply').onclick = () => void this.apply();
    this.get<HTMLInputElement>('#shortcut-search').oninput = () => this.renderCommands();
    this.get<HTMLButtonElement>('#shortcut-reset-all').onclick = () => { this.shortcuts = {}; this.recording = null; this.message(''); this.renderCommands(); };
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-settings-command]').forEach(button => button.onclick = () => this.run(button.dataset.settingsCommand!));
    this.dialog.addEventListener('keydown', event => this.record(event), true);
    this.dialog.addEventListener('cancel', event => { if (this.recording) { event.preventDefault(); this.recording = null; this.message(''); this.renderCommands(); } });
    this.dialog.addEventListener('close', () => { this.hideHelp(); this.recording = null; this.restoreFocus(); });
    this.get<HTMLSelectElement>('#code-theme-select').onchange = () => this.updateCodeTheme();
    this.get<HTMLButtonElement>('#code-theme-refresh').onclick = async () => { const button = this.get<HTMLButtonElement>('#code-theme-refresh'); button.disabled = true; try { await this.host.execute('code-refresh'); } finally { button.disabled = false; this.updateCodeTheme(); } };
    this.get('#settings-panel').addEventListener('scroll', () => this.hideHelp(), { passive: true });
    this.get('#format-save-help').addEventListener('beforetoggle', event => { if ((event as ToggleEvent).newState === 'open') { const rect = this.get('#format-save-info').getBoundingClientRect(); const help = this.get('#format-save-help'); help.style.left = `${Math.min(rect.left, innerWidth - 300)}px`; help.style.top = `${rect.bottom + 8}px`; } });
  }
  private get<T extends HTMLElement>(selector: string) { return this.dialog.querySelector<T>(selector)!; }
  open(section = '常规') {
    if (this.dialog.open) return;
    this.contextDocument = this.host.current().activeId;
    this.origin = document.activeElement as HTMLElement | null;
    const selection = window.getSelection(); this.range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    this.cellSelection = null;
    if (this.range && this.origin?.matches('th[contenteditable=true],td[contenteditable=true]') && this.origin.contains(this.range.startContainer) && this.origin.contains(this.range.endContainer)) { const prefix = this.range.cloneRange(); prefix.selectNodeContents(this.origin); prefix.setEnd(this.range.startContainer, this.range.startOffset); const from = prefix.toString().length; this.cellSelection = { from, to: from + this.range.toString().length }; }
    this.section = sections.includes(section) ? section : '常规'; this.recording = null;
    const p = this.host.current().preferences; this.shortcuts = { ...p.shortcuts };
    this.get<HTMLSelectElement>('#theme-select').value = p.theme;
    this.get<HTMLSelectElement>('#code-theme-select').value = p.codeTheme ?? 'github-dark';
    this.get<HTMLInputElement>('#font-size').value = String(p.fontSize);
    this.get<HTMLSelectElement>('#reading-width-select').value = String([720, 900, 1080].reduce((a, b) => Math.abs(b - (p.readingWidth ?? 900)) < Math.abs(a - (p.readingWidth ?? 900)) ? b : a));
    for (const [id, checked] of [['code-wrap-toggle', p.codeWrap], ['format-save-toggle', p.formatOnSave], ['autosave-toggle', p.autoSave], ['tabs-toggle', p.tabs !== false]] as const) this.get<HTMLInputElement>(`#${id}`).checked = !!checked;
    this.message(''); this.render(); this.updateCodeTheme(); this.dialog.showModal(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.dialog.animate([{ opacity: .4, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 140, easing: 'ease-out' }); this.get<HTMLButtonElement>(`[data-section="${this.section}"]`).focus();
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
  private focusKey(id: string) { this.get<HTMLButtonElement>(`[data-shortcut-id="${id}"]`)?.focus(); }
  private restoreFocus() {
    if (this.contextDocument !== this.host.current().activeId) { this.host.focus(); return; }
    if (this.origin?.isConnected && this.origin.closest('#editor-stage')) {
      this.origin.focus({ preventScroll: true });
      if (this.cellSelection && this.origin.matches('th,td') && this.origin.firstChild) { const node = this.origin.firstChild; const range = document.createRange(); range.setStart(node, Math.min(node.textContent?.length ?? 0, this.cellSelection.from)); range.setEnd(node, Math.min(node.textContent?.length ?? 0, this.cellSelection.to)); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return; }
      if (this.range && this.origin.closest('th,td') && this.range.startContainer.isConnected && this.range.endContainer.isConnected) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(this.range); }
    } else this.host.focus();
  }
  private run(id: string) { this.dialog.close(); void this.host.execute(id); }
  private message(text: string) { this.get('#shortcut-message').textContent = text; }
  private render() {
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-section]')) { const active = button.dataset.section === this.section; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
    const panel = this.get('#settings-panel'); panel.setAttribute('aria-labelledby', `settings-tab-${sections.indexOf(this.section)}`); panel.scrollTop = 0;
    this.get('#settings-general').hidden = this.section !== '常规'; this.get('#settings-about').hidden = this.section !== '关于'; this.get('#settings-shortcut-tools').hidden = this.section !== '快捷键';
    this.renderCommands();
  }
  private renderCommands() {
    const list = this.get('#settings-commands'); list.replaceChildren();
    const query = this.get<HTMLInputElement>('#shortcut-search').value.toLowerCase().trim();
    const commands = COMMANDS.filter(c => this.section === '快捷键' ? !query || `${c.label} ${c.category} ${commandKeys(c.id, this.shortcuts).join(' ')}`.toLowerCase().includes(query) : c.category === this.section);
    for (const c of commands) {
      const row = document.createElement('div'); row.className = 'settings-command';
      const action = document.createElement('button'); action.type = 'button'; action.className = 'settings-action'; action.textContent = c.label; action.dataset.settingsCommand = c.id; action.onclick = () => this.section === '快捷键' ? this.startRecording(c.id) : this.run(c.id); if (this.section === '快捷键') action.setAttribute('aria-label', `更改${c.label}绑定`);
      const key = document.createElement('button'); key.type = 'button'; key.className = 'shortcut-key'; key.dataset.shortcutId = c.id; key.setAttribute('aria-label', `修改${c.label}快捷键`);
      key.textContent = this.recording === c.id ? '按下组合键…' : commandKeys(c.id, this.shortcuts).join(' / ') || '未设置';
      key.classList.toggle('recording', this.recording === c.id); key.onclick = () => this.startRecording(c.id);
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'shortcut-clear'; clear.innerHTML = icon('close'); clear.title = `清除${c.label}快捷键`; clear.setAttribute('aria-label', clear.title); clear.onclick = () => { this.shortcuts[c.id] = ''; this.recording = null; this.message(''); this.renderCommands(); this.focusKey(c.id); };
      const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'shortcut-reset'; reset.innerHTML = icon('history'); reset.title = `恢复${c.label}默认快捷键`; reset.setAttribute('aria-label', reset.title); reset.onclick = () => {
        const next = { ...this.shortcuts }; delete next[c.id];
        try { validateShortcuts(next); this.shortcuts = next; this.recording = null; this.message(''); this.renderCommands(); this.focusKey(c.id); } catch (error) { this.message((error as Error).message); }
      };
      row.append(action, key, clear, reset); list.append(row);
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
      const id = this.recording; const next = { ...this.shortcuts, [id]: key }; validateShortcuts(next); this.shortcuts = next; this.recording = null; this.message(''); this.renderCommands(); this.focusKey(id);
    } catch (error) { this.message((error as Error).message); }
  }
  private async apply() {
    const value = <T extends HTMLInputElement | HTMLSelectElement>(id: string) => this.get<T>(id);
    try {
      const shortcuts = validateShortcuts(this.shortcuts), fontSize = Number(value('#font-size').value);
      if (!Number.isFinite(fontSize) || fontSize < 14 || fontSize > 24) throw new Error('正文字号范围为 14–24');
      const result = await this.host.save({ shortcuts, theme: value<HTMLSelectElement>('#theme-select').value as Preferences['theme'], codeTheme: value<HTMLSelectElement>('#code-theme-select').value as Preferences['codeTheme'], fontSize, readingWidth: Number(value('#reading-width-select').value), codeWrap: value<HTMLInputElement>('#code-wrap-toggle').checked, formatOnSave: value<HTMLInputElement>('#format-save-toggle').checked, autoSave: value<HTMLInputElement>('#autosave-toggle').checked, tabs: value<HTMLInputElement>('#tabs-toggle').checked });
      if (!result.ok) throw new Error(result.message ?? '设置保存失败'); this.dialog.close();
    } catch (error) { this.message((error as Error).message); }
  }
}
