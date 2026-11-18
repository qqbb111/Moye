import { execFile } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { ShortcutDetails } from 'electron';
import { APP_ID, APP_NAME } from '../shared/branding';

type Shortcuts = {
  readShortcutLink(file: string): ShortcutDetails;
  writeShortcutLink(file: string, operation: 'create' | 'update', details: ShortcutDetails): boolean;
};

const legacyLink = /^(?:Typora Replica(?: Markdown 编辑器)?|Rypota)(?: \(\d+\))?\.lnk$/i;
const normalized = (file: string) => path.resolve(file).toLowerCase();

function localLegacyExecutables(executable: string) {
  const directory = path.dirname(executable);
  const release = path.dirname(directory);
  if (path.basename(directory).toLowerCase() !== 'moye-win32-x64' || path.basename(release).toLowerCase() !== 'release') return [];
  return [
    path.join(release, 'Typora Replica-win32-x64', 'Typora Replica.exe'),
    path.resolve(release, '..', '..', 'Rypota', 'release', 'Rypota-win32-x64', 'Rypota.exe'),
  ];
}

export async function repairWindowsShortcuts(shell: Shortcuts, executable: string, appData: string, icon: string, startMenu = true, legacyExecutables: string[] = [], desktop?: string) {
  const details: ShortcutDetails = { target: executable, cwd: path.dirname(executable), args: '', description: APP_NAME, icon, iconIndex: 0, appUserModelId: APP_ID };
  const updated: string[] = [], failed: string[] = [];
  const owned = new Set([executable, ...legacyExecutables].map(normalized));
  const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const taskbar = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  const currentLink = `${APP_NAME}.lnk`;
  if (startMenu) {
    await fs.mkdir(programs, { recursive: true });
    const file = path.join(programs, currentLink);
    if (!await fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) {
      if (shell.writeShortcutLink(file, 'create', details)) updated.push(file); else failed.push(file);
    }
  }
  for (const directory of [...(startMenu ? [programs] : []), ...(desktop ? [desktop] : []), taskbar]) {
    const files: string[] = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const present = new Set(files.map(file => file.toLowerCase()));
    for (const filename of files.filter(file => /\.lnk$/i.test(file))) {
      const original = path.join(directory, filename);
      if (updated.includes(original)) continue;
      try {
        const existing = shell.readShortcutLink(original);
        if (!owned.has(normalized(existing.target))) continue;
        const args = existing.args ?? '';
        // Document shortcuts keep their arguments and grouping. Retarget only a relocated executable.
        if (args.trim() && args.trim() !== '--new-window') {
          if (normalized(existing.target) !== normalized(executable)) {
            if (shell.writeShortcutLink(original, 'update', { target: executable })) updated.push(original); else failed.push(original);
          }
          continue;
        }
        let file = original;
        // Windows stores the pinned .lnk path. Update pins in place to preserve taskbar slots.
        if (directory !== taskbar && legacyLink.test(filename)) {
          const renamed = path.join(directory, args.trim() ? `${APP_NAME} - 新建窗口.lnk` : currentLink);
          const renamedName = path.basename(renamed).toLowerCase();
          if (present.has(renamedName)) {
            const other = shell.readShortcutLink(renamed);
            if (owned.has(normalized(other.target)) && (other.args ?? '') === args) {
              if (!shell.writeShortcutLink(renamed, 'update', { ...details, args })) { failed.push(original); continue; }
              await fs.unlink(original);
              present.delete(filename.toLowerCase());
              if (!updated.includes(renamed)) updated.push(renamed);
              continue;
            }
          } else {
            await fs.rename(original, renamed);
            present.delete(filename.toLowerCase());
            present.add(renamedName);
            file = renamed;
          }
        }
        if (existing.target === details.target && existing.description === details.description && existing.appUserModelId === details.appUserModelId && existing.icon === details.icon && existing.cwd === details.cwd && file === original) continue;
        if (shell.writeShortcutLink(file, 'update', { ...details, args })) updated.push(file); else failed.push(file);
      } catch { failed.push(original); }
    }
  }
  return { updated, failed };
}

async function registerWindowsAssociations(executable: string, icon: string, legacyExecutables: string[]) {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = await fs.readFile(path.join(__dirname, 'windows-associations.ps1'), 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      MOYE_WINDOWS_NAME: APP_NAME,
      MOYE_WINDOWS_EXECUTABLE: executable,
      MOYE_WINDOWS_ICON: icon,
      MOYE_WINDOWS_LEGACY_EXECUTABLES: JSON.stringify(legacyExecutables),
    },
  });
}

export async function repairWindowsIntegration(shell: Shortcuts, executable: string, appData: string, icon: string, legacyExecutables = localLegacyExecutables(executable), desktop?: string) {
  const [shortcuts, associations] = await Promise.allSettled([
    repairWindowsShortcuts(shell, executable, appData, icon, true, legacyExecutables, desktop),
    registerWindowsAssociations(executable, icon, legacyExecutables),
  ]);
  if (shortcuts.status === 'rejected') console.error('Windows shortcuts:', shortcuts.reason);
  else if (shortcuts.value.failed.length) console.error('Windows shortcuts could not be updated:', shortcuts.value.failed);
  if (associations.status === 'rejected') console.error('Windows file associations:', associations.reason);
}
