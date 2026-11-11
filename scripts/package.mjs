import { packager } from '@electron/packager';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resedit } from '@electron/packager/resedit';
await import('./notices.mjs');
const productName = '墨页 Moye';
const productVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const zipRelease = process.argv.includes('--zip');
async function brandExecutable(executable) {
  await resedit(executable, { productName, productVersion, fileVersion: productVersion, iconPath: path.resolve('assets/replica.ico'), legalCopyright: 'Moye contributors', win32Metadata: { FileDescription: productName, CompanyName: 'Moye', InternalName: 'Moye', OriginalFilename: path.basename(executable) } });
}
const electronVersion = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version;
const releaseRoot = path.resolve('release/Typora Replica-win32-x64');
const staging = path.resolve('.test-data', `package-${randomUUID()}`);
const dist = path.resolve('dist');
const manifest = JSON.parse(await fs.readFile('dist-electron/renderer-files.json', 'utf8'));
if (!Array.isArray(manifest.files) || !manifest.files.includes('index.html') || manifest.indexHash !== createHash('sha256').update(await fs.readFile('dist/index.html')).digest('hex')) throw new Error('构建清单已过期，请先运行 npm run build。');
async function stageFile(source, relative) {
  const destination = path.join(staging, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}
for (const file of manifest.files) {
  const source = path.resolve(dist, file);
  if (!source.startsWith(dist + path.sep)) throw new Error('构建清单路径不正确');
  await stageFile(source, path.join('dist', file));
}
if (existsSync('public')) await fs.cp('public', path.join(staging, 'dist'), { recursive: true });
for (const file of ['dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-electron/portable-update.ps1', 'package.json', 'THIRD_PARTY_NOTICES.txt']) await stageFile(file, file);

if (!zipRelease && existsSync(path.join(releaseRoot, 'Typora Replica.exe'))) {
  const installedVersion = readFileSync(path.join(releaseRoot, 'version'), 'utf8').trim().replace(/^v/, '');
  if (installedVersion !== electronVersion) throw new Error('发布目录的 Electron 版本不同，请保留旧版本并选择新的输出目录后打包。');
  const target = path.join(releaseRoot, 'resources/app.asar');
  const temporary = path.join(releaseRoot, 'resources', `app-${randomUUID()}.asar`);
  const { createPackage } = await import('@electron/asar');
  await createPackage(staging, temporary);
  const preparedExecutable = path.join(staging, 'Typora Replica.exe');
  await fs.copyFile(path.join(releaseRoot, 'Typora Replica.exe'), preparedExecutable); await brandExecutable(preparedExecutable);
  const preparedIcon = path.resolve('assets/replica.ico');
  if (process.argv.includes('--prepare-only')) { console.log(JSON.stringify({ prepared: temporary, preparedExecutable, preparedIcon, releaseRoot })); process.exit(0); }
  // A running EXE rejects this copy before the application archive is changed.
  await fs.copyFile(preparedExecutable, path.join(releaseRoot, 'Typora Replica.exe'));
  await fs.copyFile(preparedIcon, path.join(releaseRoot, 'moye.ico'));
  await fs.copyFile(target, path.join(releaseRoot, 'resources/app.previous.asar'));
  await fs.rename(temporary, target);
  await fs.copyFile('THIRD_PARTY_NOTICES.txt', path.join(releaseRoot, 'THIRD_PARTY_NOTICES.txt'));
  console.log(`Updated ${releaseRoot}; previous application archive preserved.`);
  process.exit(0);
}
const filename = `electron-v${electronVersion}-win32-x64.zip`;
const checksum = JSON.parse(readFileSync('node_modules/electron/checksums.json', 'utf8'))[filename];
const electronZipDir = ['node_modules/electron/mirror-cache', 'node_modules/electron'].find(directory => existsSync(`${directory}/${filename}`) && createHash('sha256').update(readFileSync(`${directory}/${filename}`)).digest('hex') === checksum);
const name = zipRelease ? 'Moye' : 'Typora Replica';
const paths = await packager({ dir: staging, out: zipRelease ? `${staging}-out` : path.resolve('release'), name, platform: 'win32', arch: 'x64', electronVersion, electronZipDir, asar: true, overwrite: false, executableName: name, icon: path.resolve('assets/replica.ico'), prune: false });
for (const directory of paths) {
  await brandExecutable(path.join(directory, `${name}.exe`));
  await fs.copyFile('assets/replica.ico', path.join(directory, 'moye.ico'));
  await fs.copyFile('THIRD_PARTY_NOTICES.txt', path.join(directory, 'THIRD_PARTY_NOTICES.txt'));
}
if (zipRelease) {
  await fs.mkdir('release', { recursive: true });
  const file = path.resolve('release', `Moye-${productVersion}-windows-x64.zip`);
  const temporary = path.join(path.dirname(file), `.moye-${randomUUID()}.zip`);
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await promisify(execFile)(tar, ['-a', '-cf', temporary, '-C', paths[0], '.'], { windowsHide: true });
  await fs.rename(temporary, file);
  console.log(file);
} else console.log(paths.join('\n'));
