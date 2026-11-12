export interface CodePalette {
  background: string; foreground: string; border: string; keyword: string; control: string;
  type: string; function: string; variable: string; constant: string; number: string;
  string: string; comment: string; operator: string; punctuation: string;
}
export interface CodeThemeSnapshot { name: string; source: 'builtin' | 'vscode'; kind: 'dark' | 'light'; palette: CodePalette; message?: string }
export const MODERN_DARK: CodeThemeSnapshot = {
  name: '现代深色', source: 'builtin', kind: 'dark',
  palette: { background: '#1F1F1F', foreground: '#CCCCCC', border: '#3C3C3C', keyword: '#569CD6', control: '#C586C0', type: '#4EC9B0', function: '#DCDCAA', variable: '#9CDCFE', constant: '#4FC1FF', number: '#B5CEA8', string: '#CE9178', comment: '#6A9955', operator: '#D4D4D4', punctuation: '#D4D4D4' },
};
export const GITHUB_DARK: CodeThemeSnapshot = {
  name: 'GitHub Dark', source: 'builtin', kind: 'dark',
  palette: { background: '#1E1E1E', foreground: '#E1E4E8', border: '#FFFFFF1F', keyword: '#F97583', control: '#F97583', type: '#F97583', function: '#B392F0', variable: '#E1E4E8', constant: '#79B8FF', number: '#79B8FF', string: '#9ECBFF', comment: '#6A737D', operator: '#F97583', punctuation: '#E1E4E8' },
};

// Visual Studio Code's 2026 themes, mapped to the editor's syntax categories.
// https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults/themes
const DARK_2026: CodeThemeSnapshot = {
  name: '2026 现代深色', source: 'builtin', kind: 'dark',
  palette: {
    background: '#121314', foreground: '#BBBEBF', border: '#2A2B2C',
    keyword: '#FF7B72', control: '#FF7B72', type: '#79C0FF', function: '#D2A8FF',
    variable: '#C9D1D9', constant: '#79C0FF', number: '#79C0FF', string: '#A5D6FF',
    comment: '#8B949E', operator: '#FF7B72', punctuation: '#BBBEBF',
  },
};
const LIGHT_2026: CodeThemeSnapshot = {
  name: '2026 现代浅色', source: 'builtin', kind: 'light',
  palette: {
    background: '#FFFFFF', foreground: '#202020', border: '#E4E5E6',
    keyword: '#CF222E', control: '#CF222E', type: '#0550AE', function: '#8250DF',
    variable: '#1F2328', constant: '#0550AE', number: '#0550AE', string: '#0A3069',
    comment: '#6E7781', operator: '#CF222E', punctuation: '#202020',
  },
};

export const BUILTIN_CODE_THEMES = {
  'github-dark': GITHUB_DARK,
  'dark-2026': DARK_2026,
  'light-2026': LIGHT_2026,
  'modern-dark': MODERN_DARK,
} as const;
export type CodeThemePreference = keyof typeof BUILTIN_CODE_THEMES | 'vscode';

export function isCodeThemePreference(value: unknown): value is CodeThemePreference {
  return typeof value === 'string' && (value === 'vscode' || Object.hasOwn(BUILTIN_CODE_THEMES, value));
}
