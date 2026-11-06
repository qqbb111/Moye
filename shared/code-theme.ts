export interface CodePalette {
  background: string; foreground: string; border: string; keyword: string; control: string;
  type: string; function: string; variable: string; constant: string; number: string;
  string: string; comment: string; operator: string; punctuation: string;
}
export interface CodeThemeSnapshot { name: string; source: 'builtin' | 'vscode'; kind: 'dark' | 'light'; palette: CodePalette; message?: string }
export const MODERN_DARK: CodeThemeSnapshot = {
  name: '现代深色 · Dark Modern', source: 'builtin', kind: 'dark',
  palette: { background: '#1F1F1F', foreground: '#CCCCCC', border: '#3C3C3C', keyword: '#569CD6', control: '#C586C0', type: '#4EC9B0', function: '#DCDCAA', variable: '#9CDCFE', constant: '#4FC1FF', number: '#B5CEA8', string: '#CE9178', comment: '#6A9955', operator: '#D4D4D4', punctuation: '#D4D4D4' },
};
export const GITHUB_DARK: CodeThemeSnapshot = {
  name: 'GitHub Dark · Shiki', source: 'builtin', kind: 'dark',
  palette: { background: '#1E1E1E', foreground: '#E1E4E8', border: '#FFFFFF1F', keyword: '#F97583', control: '#F97583', type: '#F97583', function: '#B392F0', variable: '#E1E4E8', constant: '#79B8FF', number: '#79B8FF', string: '#9ECBFF', comment: '#6A737D', operator: '#F97583', punctuation: '#E1E4E8' },
};
