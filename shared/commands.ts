export type CommandCategory = '文件' | '编辑' | '段落' | '格式' | '视图' | '应用';
export interface Command { id: string; label: string; category: CommandCategory; keys: string[]; editor?: boolean }
const command = (id: string, label: string, category: CommandCategory, keys: string[] = [], editor = false): Command => ({ id, label, category, keys, editor });
export const COMMANDS: Command[] = [
  command('new', '新建文档', '文件', ['Ctrl+N']), command('new-window', '新建窗口', '文件', ['Ctrl+Shift+N']),
  command('open', '打开文件', '文件', ['Ctrl+O']), command('folder', '打开文件夹', '文件'), command('quick-open', '快速打开', '文件', ['Ctrl+P']),
  command('auto-save', '自动保存开关', '文件'), command('save', '保存', '文件', ['Ctrl+S']), command('save-as', '另存为', '文件', ['Ctrl+Shift+S']),
  command('export-pdf', '导出 PDF', '文件'), command('export-html', '导出 HTML', '文件'), command('detach', '移到新窗口', '文件'), command('close-tab', '关闭文档', '文件', ['Ctrl+W']),
  command('undo', '撤销', '编辑', ['Ctrl+Z'], true), command('redo', '重做', '编辑', ['Ctrl+Shift+Z', 'Ctrl+Y'], true),
  command('cut', '剪切', '编辑', ['Ctrl+X'], true), command('copy', '复制', '编辑', ['Ctrl+C'], true), command('paste', '粘贴', '编辑', ['Ctrl+V'], true), command('select-all', '全选', '编辑', ['Ctrl+A'], true),
  command('find', '查找', '编辑', ['Ctrl+F'], true), command('replace', '替换', '编辑', ['Ctrl+H'], true),
  command('tidy-chinese', '整理中文排版', '编辑', ['Alt+Shift+F'], true), command('organize-images', '整理图片附件', '编辑'), command('select-line', '选择当前行', '编辑', ['Ctrl+L'], true),
  ...Array.from({ length: 7 }, (_, n) => command(`heading-${n}`, n ? `${n} 级标题` : '正文', '段落', [`Ctrl+${n}`], true)),
  command('heading-increase', '提升标题级别', '段落', ['Ctrl+='], true), command('heading-decrease', '降低标题级别', '段落', ['Ctrl+-'], true),
  command('table', '表格', '段落', ['Ctrl+T'], true), command('code', '代码块', '段落', ['Ctrl+Shift+K'], true), command('math', '公式块', '段落', ['Ctrl+Shift+M'], true), command('quote', '引用', '段落', ['Ctrl+Shift+Q'], true),
  command('bullet', '无序列表', '段落', ['Ctrl+Shift+]'], true), command('ordered', '有序列表', '段落', ['Ctrl+Shift+['], true), command('task', '任务列表', '段落', [], true), command('rule', '水平分割线', '段落', [], true), command('toc', '目录', '段落', [], true),
  command('bold', '加粗', '格式', ['Ctrl+B'], true), command('italic', '斜体', '格式', ['Ctrl+I'], true), command('underline', '下划线', '格式', ['Ctrl+U'], true), command('strike', '删除线', '格式', ['Alt+Shift+5'], true),
  command('inline-code', '行内代码', '格式', ['Ctrl+Shift+`'], true), command('highlight', '高亮', '格式', ['='], true), command('superscript', '上标', '格式', [], true), command('subscript', '下标', '格式', [], true),
  command('link', '超链接', '格式', ['Ctrl+K'], true), command('insert-image', '图像', '格式', ['Ctrl+Shift+I'], true), command('clear-format', '清除样式', '格式', [], true),
  command('sidebar', '显示或隐藏侧栏', '视图', ['Ctrl+Shift+L']), command('outline', '大纲', '视图', ['Ctrl+Shift+1']), command('files', '文件树', '视图', ['Ctrl+Shift+3']), command('drafts', '草稿恢复', '视图'),
  command('toggle-source', '源码与排版模式切换', '视图', ['Ctrl+/']), command('fullscreen', '全屏', '视图', ['F11']), command('code-wrap', '代码自动换行', '视图', ['Alt+Z']),
  command('tabs', '标签栏开关', '视图'), command('next-tab', '下一个标签', '视图', ['Ctrl+Tab']), command('previous-tab', '上一个标签', '视图', ['Ctrl+Shift+Tab']),
  command('zoom-in', '放大字号', '视图', ['Ctrl+Shift+=']), command('zoom-out', '缩小字号', '视图', ['Ctrl+Shift+-']), command('zoom-reset', '恢复字号', '视图', ['Ctrl+Shift+0']),
  command('preferences', '设置', '应用', ['Ctrl+,']), command('guide', 'Markdown 使用指南', '应用'), command('about', '关于墨页', '应用'), command('code-refresh', '重新读取 VS Code 配色', '应用'),
];
export type ShortcutOverrides = Record<string, string>;
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const special = ['Tab', 'Enter', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'];
export function normalizeShortcut(input: string): string {
  const parts = input.trim().split('+'); const key = parts.pop() ?? '';
  if (!key || !parts.every(p => modifiers.includes(p)) || new Set(parts).size !== parts.length || !(/^[A-Za-z0-9,./;\[\]'`=\\-]$/.test(key) || /^F([1-9]|1\d|2[0-4])$/.test(key) || special.includes(key))) throw new Error('请使用有效的组合键');
  const result = [...modifiers.filter(m => parts.includes(m)), key.length === 1 ? key.toUpperCase() : key].join('+');
  if ((!parts.length || parts.every(p => p === 'Shift')) && key !== '=' && !/^F\d+$/.test(key)) throw new Error('字母或编辑按键需要搭配 Ctrl 或 Alt');
  if (parts.includes('Meta') || ['Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl+Escape', 'Ctrl+Shift+Escape'].includes(result)) throw new Error('此组合键由系统保留');
  return result;
}
export const commandKeys = (id: string, overrides: ShortcutOverrides = {}) => Object.hasOwn(overrides, id) ? (overrides[id] ? [overrides[id]] : []) : COMMANDS.find(c => c.id === id)?.keys ?? [];
export function shortcutConflict(id: string, key: string, overrides: ShortcutOverrides): Command | undefined { return COMMANDS.find(c => c.id !== id && commandKeys(c.id, overrides).includes(key)); }
export function validateShortcuts(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > COMMANDS.length) throw new Error('快捷键设置不正确');
  const result: ShortcutOverrides = {};
  for (const [id, key] of Object.entries(value)) {
    if (!COMMANDS.some(c => c.id === id) || typeof key !== 'string' || key.length > 64) throw new Error('未知命令或快捷键');
    result[id] = key ? normalizeShortcut(key) : '';
    if (result[id] === '=' && id !== 'highlight') throw new Error('单独的等号仅用于选区高亮');
  }
  for (const c of COMMANDS) for (const key of commandKeys(c.id, result)) { const conflict = shortcutConflict(c.id, key, result); if (conflict) throw new Error(`与「${conflict.label}」的 ${key} 冲突`); }
  return result;
}
export function restoredShortcuts(value: unknown): ShortcutOverrides { try { return validateShortcuts(value ?? {}); } catch { return {}; } }
export function shortcutFromEvent(event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  const codes: Record<string, string> = { Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backquote: '`', Slash: '/', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Space: 'Space' };
  const key = codes[event.code] ?? (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : event.key.length === 1 ? event.key.toUpperCase() : event.key);
  if (['Control', 'Shift', 'Alt', 'Meta', 'Process', 'Dead', 'Unidentified'].includes(key)) return null;
  return [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '', key].filter(Boolean).join('+');
}
