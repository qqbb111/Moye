import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ShortcutDetails } from 'electron';
import { APP_ID, APP_NAME } from '../shared/branding';

type Shortcuts = {
  readShortcutLink(file: string): ShortcutDetails;
  writeShortcutLink(file: string, operation: 'create' | 'update', details: ShortcutDetails): boolean;
};

// Repair only links to this executable; preserve their names and taskbar slots.
export async function repairWindowsShortcuts(shell: Shortcuts, executable: string, appData: string, icon: string, startMenu = true) {
  const details: ShortcutDetails = { target: executable, cwd: path.dirname(executable), args: '', description: APP_NAME, icon, iconIndex: 0, appUserModelId: APP_ID };
  const updated: string[] = [], failed: string[] = [];
  if (startMenu) {
    const directory = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${APP_NAME}.lnk`);
    if (shell.writeShortcutLink(file, 'create', details)) updated.push(file); else failed.push(file);
  }
  const directory = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  const files = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const filename of files.filter(file => /\.lnk$/i.test(file))) {
    const file = path.join(directory, filename);
    try {
      const existing = shell.readShortcutLink(file);
      if (path.resolve(existing.target).toLowerCase() !== path.resolve(executable).toLowerCase()) continue;
      // A document-specific pin must keep its arguments and own grouping.
      if (existing.args?.trim() && existing.args.trim() !== '--new-window') continue;
      if (shell.writeShortcutLink(file, 'update', { ...details, args: existing.args ?? '' })) updated.push(file); else failed.push(file);
    } catch { failed.push(file); }
  }
  return { updated, failed };
}
