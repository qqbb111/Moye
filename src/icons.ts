import sprite from '@vscode/codicons/dist/codicon.svg?url';

// Unmodified Microsoft Codicons, rendered as local SVG symbols (see notices).
export type IconName = 'add' | 'close' | 'chrome-close' | 'chrome-minimize' | 'chrome-maximize' | 'chrome-restore' | 'layout-sidebar-left' | 'layout-sidebar-left-off' | 'code' | 'copy' | 'check' | 'markdown' | 'file' | 'files' | 'folder' | 'folder-opened' | 'chevron-right' | 'list-tree' | 'history' | 'new-file' | 'remove' | 'arrow-left' | 'arrow-right' | 'dash' | 'word-wrap' | 'search' | 'settings-gear' | 'layout-centered' | 'filter';
export function icon(name: IconName) { return `<svg class="replica-icon" data-icon="${name}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="${sprite}#${name}"/></svg>`; }
