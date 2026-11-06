import type { CodeThemeSnapshot } from './code-theme';
import type { PrintOptions, PrintPreferences, PdfPreviewResult } from './print';
export type SaveStatus = 'saved' | 'draft' | 'saving' | 'error' | 'conflict';
export interface DocumentView {
  id: string;
  title: string;
  path: string | null;
  content: string;
  revision: number;
  savedRevision: number;
  dirty: boolean;
  updatedAt: number;
  savedAt: number | null;
  draftRevision: number;
  draftSavedAt: number | null;
  status: SaveStatus;
  error: string | null;
}
export interface WorkspaceView {
  windowId: string;
  maximized?: boolean;
  documents: DocumentView[];
  activeId: string | null;
  drafts: DocumentView[];
  recent: string[];
  preferences: { autoSave: boolean; theme: 'light' | 'dark' | 'copilot' | 'workbuddy'; fontSize: number; sidebar?: boolean; tabs?: boolean; focus?: boolean; typewriter?: boolean; codeTheme?: 'modern-dark' | 'vscode' | 'github-dark'; formatOnSave?: boolean; codeWrap?: boolean; readingWidth?: number; sidebarWidth?: number; appearanceRevision?: number; print?: PrintPreferences };
  codeTheme?: CodeThemeSnapshot;
  recovered: boolean;
}
export type AppCommand = string;
export interface FolderEntry { name: string; path: string; directory: boolean }
export interface ActionResult { ok: boolean; message?: string; canceled?: boolean }
export interface RypotaBridge {
  bootstrap(): Promise<WorkspaceView>;
  newDocument(): Promise<ActionResult>;
  openDocuments(): Promise<ActionResult>;
  openRecent(path: string): Promise<ActionResult>;
  activateDocument(id: string): Promise<ActionResult>;
  reorderDocuments(ids: string[]): Promise<ActionResult>;
  updateDocument(id: string, content: string, revision: number): void;
  saveDocument(id: string, saveAs?: boolean): Promise<ActionResult>;
  organizeImages(id: string): Promise<ActionResult>;
  closeDocument(id: string): Promise<ActionResult>;
  restoreDraft(id: string): Promise<ActionResult>;
  newWindow(): Promise<ActionResult>;
  detachDocument(id: string): Promise<ActionResult>;
  updatePreferences(preferences: Partial<WorkspaceView['preferences']>): Promise<ActionResult>;
  refreshCodeTheme(): Promise<ActionResult>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  openExternal(url: string): Promise<ActionResult>;
  openFolder(): Promise<{ path: string; entries: FolderEntry[] } | null>;
  listFolder(path: string): Promise<FolderEntry[]>;
  openFolderFile(path: string): Promise<ActionResult>;
  insertImage(id: string, data?: { bytes: number[]; name: string }): Promise<{ url?: string; message?: string }>;
  exportDocument(id: string, format: 'html' | 'pdf', html: string): Promise<ActionResult>;
  previewPdf(id: string, html: string, options: PrintOptions): Promise<PdfPreviewResult>;
  savePdf(previewId: string, fonts?: PrintPreferences['fonts']): Promise<ActionResult>;
  releasePdf(): Promise<void>;
  fullscreen(): void;
  clipboard(action: 'read' | 'write', text?: string): Promise<string>;
  finishClose(token: string): void;
  onState(listener: (view: WorkspaceView) => void): () => void;
  onCommand(listener: (command: AppCommand) => void): () => void;
  onPrepareClose(listener: (token: string) => void): () => void;
  onMessage(listener: (message: string) => void): () => void;
}
declare global { interface Window { rypota: RypotaBridge } }
