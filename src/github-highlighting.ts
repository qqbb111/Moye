import { StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { HighlighterCore } from 'shiki/core';

const tokenUpdate = StateEffect.define<{ document: Text; decorations: DecorationSet }>();
export const githubTokens = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(tokenUpdate) && effect.value.document === transaction.state.doc) value = effect.value.decorations;
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

// Import only supported grammars; all assets are bundled for offline use.
const grammars = {
  cpp: () => import('@shikijs/langs/cpp'), c: () => import('@shikijs/langs/c'),
  javascript: () => import('@shikijs/langs/javascript'), typescript: () => import('@shikijs/langs/typescript'),
  python: () => import('@shikijs/langs/python'), java: () => import('@shikijs/langs/java'),
  json: () => import('@shikijs/langs/json'), bash: () => import('@shikijs/langs/bash'),
  css: () => import('@shikijs/langs/css'), html: () => import('@shikijs/langs/html'),
  rust: () => import('@shikijs/langs/rust'), go: () => import('@shikijs/langs/go'),
  sql: () => import('@shikijs/langs/sql'), yaml: () => import('@shikijs/langs/yaml'),
  csharp: () => import('@shikijs/langs/csharp'), markdown: () => import('@shikijs/langs/markdown'),
};
const aliases: Record<string, string> = { 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', cs: 'csharp', 'c#': 'csharp', yml: 'yaml', md: 'markdown', rs: 'rust' };
let shared: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();
function highlighter() {
  return shared ??= Promise.all([import('shiki/core'), import('shiki/engine/oniguruma')]).then(([core, engine]) => core.createHighlighterCore({
    themes: [import('@shikijs/themes/github-dark')], langs: [], engine: engine.createOnigurumaEngine(import('shiki/wasm')),
  }));
}

export async function tokenizeGithub(source: string, language: string) {
  const raw = language.trim().toLowerCase(), name = aliases[raw] ?? raw;
  const loader = grammars[name as keyof typeof grammars];
  if (!loader || source.length > 250_000) return null;
  const instance = await highlighter();
  if (!instance.getLoadedLanguages().includes(name)) {
    if (!loading.has(name)) loading.set(name, loader().then(grammar => instance.loadLanguage(grammar)));
    await loading.get(name);
  }
  return instance.codeToTokens(source, { lang: name, theme: 'github-dark' }).tokens;
}

export function attachGithubHighlighting(view: EditorView, language: () => string) {
  let enabled = false, destroyed = false, generation = 0;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = (delay = 80) => {
    clearTimeout(timer); const revision = ++generation;
    if (!enabled || destroyed) return;
    view.dom.dataset.shiki = 'loading';
    timer = setTimeout(() => { void (async () => {
      if (view.composing) { refresh(60); return; }
      const document = view.state.doc; const tokens = await tokenizeGithub(document.toString(), language());
      if (destroyed || !enabled || revision !== generation || view.state.doc !== document) return;
      if (view.composing) { refresh(60); return; }
      if (!tokens) { view.dispatch({ effects: tokenUpdate.of({ document, decorations: Decoration.none }) }); view.dom.dataset.shiki = 'fallback'; return; }
      const ranges = tokens.flatMap(line => line.filter(token => token.content.length > 0).map(token => {
        const flags = token.fontStyle ?? 0;
        const style = `color:${token.color};font-style:${flags & 1 ? 'italic' : 'normal'};font-weight:${flags & 2 ? '700' : '400'};${flags & 4 ? 'text-decoration:underline' : ''}`;
        return Decoration.mark({ class: 'shiki-token', attributes: { style, 'data-shiki-color': token.color ?? '' } }).range(token.offset, token.offset + token.content.length);
      }));
      view.dispatch({ effects: tokenUpdate.of({ document, decorations: Decoration.set(ranges, true) }) });
      view.dom.dataset.shiki = 'ready';
    })().catch(() => { if (!destroyed && revision === generation) view.dom.dataset.shiki = 'fallback'; }); }, delay);
  };
  return {
    refresh,
    setEnabled(value: boolean) {
      if (enabled === value) return; enabled = value;
      if (value) refresh(0);
      else { generation++; clearTimeout(timer); view.dispatch({ effects: tokenUpdate.of({ document: view.state.doc, decorations: Decoration.none }) }); view.dom.dataset.shiki = 'disabled'; }
    },
    destroy() { destroyed = true; generation++; clearTimeout(timer); },
  };
}
