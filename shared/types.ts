import type { ShortcutOverrides } from './commands';
import type { CodeThemePreference, CodeThemeSnapshot } from './code-theme';
import type { PrintOptions, PrintPreferences, PdfPreviewResult, PdfFirstPage } from './print';
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
  preferences: { autoSave: boolean; theme: 'light' | 'dark' | 'copilot' | 'workbuddy'; fontSize: number; sidebar?: boolean; tabs?: boolean; codeTheme?: CodeThemePreference; formatOnSave?: boolean; codeWrap?: boolean; readingWidth?: number; sidebarWidth?: number; appearanceRevision?: number; shortcuts?: ShortcutOverrides; print?: PrintPreferences };
  codeTheme?: CodeThemeSnapshot;
  recovered: boolean;
}
export type AppCommand = string;
export interface FolderEntry { name: string; path: string; directory: boolean }
export interface FolderView { path: string; entries: FolderEntry[]; hasParent: boolean }
export type DocumentReference = { id: string } | { path: string };
export interface ActionResult { ok: boolean; message?: string; canceled?: boolean; conflict?: boolean }
export type SaveMode = 'save' | 'save-as' | 'overwrite-conflict';
export type UpdateAction = 'status' | 'check' | 'download' | 'cancel' | 'install';
export interface UpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'preparing' | 'ready' | 'installing' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  message?: string;
}
export interface RypotaBridge {
  bootstrap(): Promise<WorkspaceView>;
  newDocument(): Promise<ActionResult>;
  openDocuments(): Promise<ActionResult>;
  openRecent(path: string): Promise<ActionResult>;
  activateDocument(id: string): Promise<ActionResult>;
  reorderDocuments(ids: string[]): Promise<ActionResult>;
  updateDocument(id: string, content: string, revision: number): void;
  saveDocument(id: string, mode?: SaveMode): Promise<ActionResult>;
  renameDocument(document: DocumentReference, name: string): Promise<ActionResult>;
  revealDocument(document: DocumentReference): Promise<ActionResult>;
  saveFolderFileAs(path: string): Promise<ActionResult>;
  organizeImages(id: string): Promise<ActionResult>;
  closeDocument(id: string): Promise<ActionResult>;
  restoreDraft(id: string): Promise<ActionResult>;
  newWindow(): Promise<ActionResult>;
  detachDocument(id: string): Promise<ActionResult>;
  updatePreferences(preferences: Partial<WorkspaceView['preferences']>): Promise<ActionResult>;
  refreshCodeTheme(): Promise<ActionResult>;
  portableUpdate(action: UpdateAction): Promise<UpdateState>;
  onPortableUpdate(listener: (state: UpdateState) => void): () => void;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  openExternal(url: string): Promise<ActionResult>;
  openFolder(): Promise<FolderView | null>;
  openParentFolder(path: string): Promise<FolderView | null>;
  listFolder(path: string): Promise<FolderEntry[]>;
  openFolderFile(path: string): Promise<ActionResult>;
  insertImage(id: string, data?: { bytes: number[]; name: string }): Promise<{ url?: string; message?: string }>;
  exportDocument(id: string, format: 'html' | 'pdf', html: string): Promise<ActionResult>;
  previewPdf(id: string, html: string, options: PrintOptions, requestId?: string): Promise<PdfPreviewResult>;
  previewPdfFirstPage(id: string, html: string, options: PrintOptions, requestId: string): Promise<void>;
  onPdfFirstPage(listener: (page: PdfFirstPage) => void): () => void;
  savePdf(previewId: string, fonts?: PrintPreferences['fonts']): Promise<ActionResult>;
  releasePdf(): Promise<void>;
  fullscreen(): void;
  paste(): Promise<ActionResult>;
  clipboard(action: 'read' | 'write', text?: string): Promise<string>;
  finishClose(token: string): void;
  onState(listener: (view: WorkspaceView) => void): () => void;
  onCommand(listener: (command: AppCommand) => void): () => void;
  onPrepareClose(listener: (token: string) => void): () => void;
  onMessage(listener: (message: string) => void): () => void;
}
declare global { interface Window { rypota: RypotaBridge } }
