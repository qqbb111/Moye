import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
for (const file of ['electron/main.ts', 'scripts/dev.mjs', 'scripts/package.mjs', 'scripts/notices.mjs', 'scripts/smoke-release.mjs', 'index.html']) {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  source = source.replaceAll('RYPOTA_', 'TYPORA_REPLICA_').replaceAll('__rypotaTest', '__replicaTest').replaceAll('rypota-media', 'replica-media').replaceAll('rypota://', 'replica://').replaceAll("scheme: 'rypota'", "scheme: 'replica'").replaceAll("protocol.handle('rypota'", "protocol.handle('replica'").replaceAll('Rypota', 'Typora Replica');
  fs.writeFileSync(path.join(root, file), source);
}
let main = fs.readFileSync('electron/main.ts', 'utf8');
main = main.replace(/const welcome = [^;]+;/, 'const welcome = "";').replace("store.newDocument(id, welcome, '欢迎使用 Typora Replica')", 'store.newDocument(id)').replace('minWidth: 920, minHeight: 620', 'minWidth: 640, minHeight: 420').replace("backgroundColor: '#f6f5f2'", "backgroundColor: '#ffffff'");
fs.writeFileSync('electron/main.ts', main);
const original = path.resolve('../Rypota/node_modules/electron');
for (const file of ['dist', 'path.txt', 'mirror-cache']) if (fs.existsSync(path.join(original, file)) && !fs.existsSync(path.join(root, 'node_modules/electron', file))) fs.cpSync(path.join(original, file), path.join(root, 'node_modules/electron', file), { recursive: true, errorOnExist: true, force: false });
