import { packager } from '@electron/packager';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
await import('./notices.mjs');
const electronVersion = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version;
const releaseRoot = path.resolve('release/Typora Replica-win32-x64');
if (existsSync(path.join(releaseRoot, 'Typora Replica.exe'))) {
  const installedVersion = readFileSync(path.join(releaseRoot, 'version'), 'utf8').trim().replace(/^v/, '');
  if (installedVersion !== electronVersion) throw new Error('发布目录的 Electron 版本不同，请保留旧版本并选择新的输出目录后打包。');
  const staging = path.resolve('.test-data', `package-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  if (existsSync('dist-electron/renderer-files.json')) {
    const manifest = JSON.parse(await fs.readFile('dist-electron/renderer-files.json', 'utf8'));
    if (!Array.isArray(manifest.files) || !manifest.files.includes('index.html') || manifest.indexHash !== createHash('sha256').update(await fs.readFile('dist/index.html')).digest('hex')) throw new Error('构建清单已过期，请先运行 npm run build。');
    const root = path.resolve('dist');
    for (const file of manifest.files) {
      const source = path.resolve(root, file); if (!source.startsWith(root + path.sep)) throw new Error('构建清单路径不正确');
      const destination = path.join(staging, 'dist', file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination);
    }
    if (existsSync('public')) await fs.cp('public', path.join(staging, 'dist'), { recursive: true });
  } else await fs.cp('dist', path.join(staging, 'dist'), { recursive: true });
  for (const item of ['dist-electron', 'assets', 'docs', 'package.json', 'README.md', 'THIRD_PARTY_NOTICES.txt']) await fs.cp(path.resolve(item), path.join(staging, item), { recursive: true });
  const target = path.join(releaseRoot, 'resources/app.asar');
  const temporary = path.join(releaseRoot, 'resources', `app-${randomUUID()}.asar`);
  const { createPackage } = await import('@electron/asar');
  await createPackage(staging, temporary);
  if (process.argv.includes('--prepare-only')) { console.log(JSON.stringify({ prepared: temporary, releaseRoot })); process.exit(0); }
  await fs.copyFile(target, path.join(releaseRoot, 'resources/app.previous.asar'));
  await fs.rename(temporary, target);
  await fs.copyFile('THIRD_PARTY_NOTICES.txt', path.join(releaseRoot, 'THIRD_PARTY_NOTICES.txt'));
  console.log(`Updated ${releaseRoot}; previous application archive preserved.`);
  process.exit(0);
}
const filename = `electron-v${electronVersion}-win32-x64.zip`;
const checksum = JSON.parse(readFileSync('node_modules/electron/checksums.json', 'utf8'))[filename];
const electronZipDir = ['node_modules/electron/mirror-cache', 'node_modules/electron'].find(directory => existsSync(`${directory}/${filename}`) && createHash('sha256').update(readFileSync(`${directory}/${filename}`)).digest('hex') === checksum);
const paths = await packager({ dir: '.', out: 'release', name: 'Typora Replica', platform: 'win32', arch: 'x64', electronZipDir, asar: true, overwrite: false, executableName: 'Typora Replica', icon: 'assets/replica.ico', prune: false, ignore: [/^\/node_modules/, /^\/release/, /^\/test-results/, /^\/playwright-report/, /^\/\.test-data/, /^\/tests/, /^\/src/, /^\/electron/, /^\/scripts/, /^\/shared/, /^\/\.git/, /^\/playwright\.config/, /^\/tsconfig/], appCopyright: 'Typora Replica contributors', win32metadata: { ProductName: 'Typora Replica', FileDescription: 'Typora Replica Markdown 编辑器', CompanyName: 'Typora Replica', OriginalFilename: 'Typora Replica.exe' } });
console.log(paths.join('\n'));
