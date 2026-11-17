import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { LEGACY_DATA_DIRECTORY } from '../shared/branding';

const migrationMarker = '.moye-profile-migrated';

export function profilePaths(appData: string, override?: string) {
  const userData = override ? path.resolve(override) : path.join(appData, 'Moye');
  const recovery = path.join(userData, 'recovery');
  const legacyUserData = override ? undefined : path.join(appData, LEGACY_DATA_DIRECTORY);
  const legacyRecovery = legacyUserData && path.join(legacyUserData, 'recovery');
  // Older executables and the portable updater still contact the legacy lock.
  const lock = legacyUserData && legacyRecovery && existsSync(legacyUserData) && (
    existsSync(path.join(recovery, migrationMarker)) || (!existsSync(recovery) && existsSync(legacyRecovery)))
    ? legacyUserData : userData;
  return { userData, recovery, legacyUserData, legacyRecovery, lock };
}

async function isDirectory(directory: string) {
  const entry = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!entry) return false;
  if (!entry.isDirectory()) throw new Error(`数据目录必须是普通文件夹：${directory}`);
  return true;
}

export async function migrateUserData(paths: ReturnType<typeof profilePaths>) {
  const { legacyUserData, legacyRecovery, userData, recovery } = paths;
  if (!legacyUserData || !legacyRecovery) return;
  const destinationExists = await isDirectory(recovery);
  if (destinationExists && existsSync(path.join(recovery, migrationMarker))) return;
  if (!await isDirectory(legacyUserData) || !await isDirectory(legacyRecovery)) return;
  await fs.mkdir(userData, { recursive: true });
  await isDirectory(userData);
  if (destinationExists) return { notice: `检测到两份独立的恢复数据，墨页已打开当前数据。旧草稿、图片和设置仍保存在 ${legacyRecovery}。` };

  const staging = await fs.mkdtemp(path.join(userData, '.migration-'));
  try {
    const copy = path.join(staging, 'recovery');
    await fs.cp(legacyRecovery, copy, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async source => {
        const entry = await fs.lstat(source);
        if (!entry.isDirectory() && !entry.isFile()) throw new Error(`无法复制恢复数据中的链接或特殊文件：${source}`);
        return true;
      },
    });
    await fs.writeFile(path.join(copy, migrationMarker), '', { flag: 'wx' });
    if (await isDirectory(recovery)) throw new Error(`恢复目录已存在：${recovery}`);
    await fs.rename(copy, recovery);
    return { migratedFrom: legacyUserData };
  } catch (error) {
    throw new Error(`无法迁移旧草稿、图片和设置。原数据保留在 ${legacyRecovery}。\n${(error as Error).message}`, { cause: error });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(error => console.error('Migration cleanup:', error));
  }
}
