import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, type ParseError } from 'jsonc-parser';
import { MODERN_DARK, type CodePalette, type CodeThemeSnapshot } from '../shared/code-theme';

type Rule = { scope?: string | string[]; settings?: { foreground?: string; background?: string } };
interface ThemeData { colors: Record<string, string>; rules: Rule[]; semantic: Record<string, any>; files: string[] }
const exists = async (file: string) => fs.access(file).then(() => true, () => false);
const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
async function json(file: string): Promise<any> {
  if ((await fs.stat(file)).size > 5 * 1024 * 1024) throw new Error('主题文件过大');
  const errors: ParseError[] = []; const value = parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !value || typeof value !== 'object') throw new Error('VS Code 配置或主题暂时无法解析'); return value;
}
async function directories(root: string) { try { return (await fs.readdir(root, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => path.join(root, item.name)); } catch { return []; } }
async function appRoots() {
  if (process.env.TYPORA_REPLICA_VSCODE_ROOT) return [path.resolve(process.env.TYPORA_REPLICA_VSCODE_ROOT)];
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local');
  const installs = new Set([path.join(local, 'Programs/Microsoft VS Code'), path.join(local, 'Programs/Microsoft VS Code Insiders'), path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft VS Code')]);
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) if (/[/\\](?:Microsoft VS Code|VSCode)[/\\]bin$/i.test(entry)) installs.add(path.dirname(entry));
  const result: string[] = [];
  for (const install of installs) {
    try {
      const script = await fs.readFile(path.join(install, 'bin/code.cmd'), 'utf8'); const version = /[\\/]([a-f\d]{10})[\\/]resources[\\/]app[\\/]/i.exec(script)?.[1];
      if (version && await exists(path.join(install, version, 'resources/app'))) result.push(path.join(install, version, 'resources/app'));
    } catch { /* Older and system installs use resources/app directly. */ }
    const direct = path.join(install, 'resources/app'); if (await exists(direct)) result.push(direct);
  }
  return [...new Set(result)];
}
async function settingsPath() {
  if (process.env.TYPORA_REPLICA_VSCODE_SETTINGS) return path.resolve(process.env.TYPORA_REPLICA_VSCODE_SETTINGS);
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming');
  for (const app of ['Code', 'Code - Insiders']) { const file = path.join(roaming, app, 'User/settings.json'); if (await exists(file)) return file; }
  return null;
}
async function locateTheme(name: string): Promise<{ file: string; light: boolean } | null> {
  const roots = await appRoots();
  if (/^(?:default )?dark modern$|^现代深色$/i.test(name)) for (const root of roots) {
    const file = path.join(root, 'extensions/theme-defaults/themes/dark_modern.json'); if (await exists(file)) return { file, light: false };
  }
  const extensionRoots = roots.map(root => path.join(root, 'extensions'));
  extensionRoots.push(process.env.TYPORA_REPLICA_VSCODE_EXTENSIONS ?? path.join(os.homedir(), '.vscode/extensions'));
  for (const root of extensionRoots) for (const directory of await directories(root)) {
    try {
      const metadata = await json(path.join(directory, 'package.json')); const themes = metadata.contributes?.themes; if (!Array.isArray(themes)) continue;
      const labels: Record<string, string>[] = [];
      for (const file of ['package.nls.json', 'package.nls.zh-cn.json']) if (await exists(path.join(directory, file))) labels.push(await json(path.join(directory, file)));
      for (const theme of themes) {
        const names = [theme.id, theme.label]; const key = typeof theme.label === 'string' ? /^%(.+)%$/.exec(theme.label)?.[1] : undefined;
        if (key) for (const values of labels) names.push(values[key]);
        if (typeof theme.path === 'string' && names.some(value => typeof value === 'string' && value.toLowerCase() === name.toLowerCase())) return { file: path.resolve(directory, theme.path), light: theme.uiTheme === 'vs' || theme.uiTheme === 'hc-light' };
      }
    } catch { /* A broken unrelated extension must not prevent theme discovery. */ }
  }
  return null;
}
async function loadTheme(file: string, seen = new Set<string>()): Promise<ThemeData> {
  const key = path.resolve(file).toLowerCase(); if (seen.has(key) || seen.size >= 12) throw new Error('主题继承关系不正确'); seen.add(key);
  const value = await json(file); const inherited: ThemeData = typeof value.include === 'string' ? await loadTheme(path.resolve(path.dirname(file), value.include), seen) : { colors: {}, rules: [], semantic: {}, files: [] };
  return { colors: { ...inherited.colors, ...value.colors }, rules: [...inherited.rules, ...(Array.isArray(value.tokenColors) ? value.tokenColors : [])], semantic: { ...inherited.semantic, ...value.semanticTokenColors }, files: [...inherited.files, file] };
}
function scopedSettings(value: any, name: string) {
  const merged = { ...(value ?? {}) };
  for (const [selector, overrides] of Object.entries(value ?? {})) {
    const names = [...selector.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
    if (names.some(pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(name)) && overrides && typeof overrides === 'object') Object.assign(merged, overrides);
  } return merged;
}
function scopeColor(rules: Rule[], targets: string[], fallback: string) {
  let result = fallback; let best = -1;
  for (const rule of rules) {
    const scopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? rule.scope.split(',') : [];
    for (const raw of scopes) {
      if (raw.includes(' - ')) continue; const scope = raw.trim().split(/\s+/).at(-1)!;
      if (!scope || !targets.some(target => target === scope || target.startsWith(scope + '.'))) continue;
      if (scope.length >= best && color(rule.settings?.foreground, '') !== '') { result = rule.settings!.foreground!; best = scope.length; }
    }
  } return result;
}
export function paletteFromTheme(data: ThemeData, settings: any, name: string, light: boolean): CodePalette {
  const custom = scopedSettings(settings['editor.tokenColorCustomizations'], name); const semantic = { ...data.semantic, ...scopedSettings(settings['editor.semanticTokenColorCustomizations'], name).rules };
  const rules: Rule[] = [...data.rules, ...(Array.isArray(custom.textMateRules) ? custom.textMateRules : [])]; const ui = { ...data.colors, ...scopedSettings(settings['workbench.colorCustomizations'], name) };
  const base = { ...MODERN_DARK.palette }; if (light) Object.assign(base, { background: '#FFFFFF', foreground: '#000000', border: '#D4D4D4', keyword: '#0000FF', control: '#AF00DB', type: '#267F99', function: '#795E26', variable: '#001080', number: '#098658', string: '#A31515', comment: '#008000', operator: '#000000', punctuation: '#000000' });
  const get = (scopes: string[], fallback: string, override?: string, semanticKey?: string) => {
    const semanticValue = semanticKey ? semantic[semanticKey] : undefined;
    return color(override, color(typeof semanticValue === 'object' ? semanticValue?.foreground : semanticValue, scopeColor(rules, scopes, fallback)));
  };
  const foreground = color(ui['editor.foreground'], base.foreground);
  return { background: color(ui['editor.background'], base.background), foreground, border: color(ui['widget.border'], color(ui['editorWidget.border'], light ? '#D4D4D4' : '#3C3C3C')),
    keyword: get(['storage.type', 'storage.modifier', 'keyword'], base.keyword, custom.keywords, 'keyword'), control: get(['keyword.control', 'keyword.control.flow'], base.control, custom.keywords),
    type: get(['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], base.type, custom.types, 'type'), function: get(['entity.name.function', 'support.function'], base.function, custom.functions, 'function'),
    variable: get(['variable', 'variable.other', 'variable.other.readwrite'], base.variable, custom.variables, 'variable'), constant: get(['variable.other.constant', 'constant.other'], base.constant, undefined, 'variable.readonly'),
    number: get(['constant.numeric'], base.number, custom.numbers, 'number'), string: get(['string', 'string.quoted'], base.string, custom.strings, 'string'), comment: get(['comment', 'comment.line', 'comment.block'], base.comment, custom.comments, 'comment'),
    operator: get(['keyword.operator'], foreground), punctuation: get(['punctuation'], foreground),
  };
}

export class VscodeThemeSync {
  private timer?: ReturnType<typeof setInterval>;
  private loading?: Promise<CodeThemeSnapshot>;
  private cached?: { name: string; file: string; light: boolean };
  private previous = '';
  current: CodeThemeSnapshot = { ...MODERN_DARK, message: '尚未读取 VS Code 主题' };
  constructor(private onChanged: (theme: CodeThemeSnapshot) => void) {}
  refresh(force = false): Promise<CodeThemeSnapshot> {
    if (this.loading) return this.loading;
    this.loading = this.read(force).then(theme => {
      this.current = theme; const signature = JSON.stringify(theme); if (signature !== this.previous) { this.previous = signature; this.onChanged(theme); } return theme;
    }).finally(() => { this.loading = undefined; }); return this.loading;
  }
  private async read(force: boolean): Promise<CodeThemeSnapshot> {
    try {
      const settingsFile = await settingsPath(); if (!settingsFile) return { ...MODERN_DARK, message: '未找到本机 VS Code 用户设置，使用现代深色' };
      const settings = await json(settingsFile); const name = typeof settings['workbench.colorTheme'] === 'string' ? settings['workbench.colorTheme'] : 'Default Dark Modern';
      if (force || !this.cached || this.cached.name !== name || !await exists(this.cached.file)) { const theme = await locateTheme(name); this.cached = theme ? { name, ...theme } : undefined; }
      if (!this.cached) return { ...MODERN_DARK, message: `未找到“${name}”主题文件，使用现代深色` };
      const data = await loadTheme(this.cached.file);
      return { name, source: 'vscode', kind: this.cached.light ? 'light' : 'dark', palette: paletteFromTheme(data, settings, name, this.cached.light) };
    } catch { return { ...this.current, message: 'VS Code 配置暂时无法读取，保留当前配色并自动重试' }; }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.refresh(); }, 1500); this.timer.unref(); } }
  stop() { clearInterval(this.timer); this.timer = undefined; }
}
