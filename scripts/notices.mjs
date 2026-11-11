import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const visited = new Set();
const records = [];
function visit(packagePath) {
  if (visited.has(packagePath)) return;
  visited.add(packagePath);
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  const directory = path.dirname(packagePath);
  const licenses = readdirSync(directory, { withFileTypes: true }).filter(item => item.isFile() && /^(licen[cs]e|copying|notice|ofl)([.-].*)?$/i.test(item.name));
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url ?? metadata.homepage ?? '';
  const texts = licenses.map(item => `${item.name}\n${readFileSync(path.join(directory, item.name), 'utf8')}`).join('\n\n');
  records.push(`${metadata.name} ${metadata.version}\nLicense: ${typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license ?? 'See upstream') }\n${repository}\n\n${texts || 'License information is recorded in the upstream package metadata.'}`);
  const require = createRequire(packagePath);
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    const resolved = (require.resolve.paths(name) ?? []).map(base => path.join(base, name, 'package.json')).find(file => existsSync(file));
    if (resolved) visit(resolved);
  }
}
const own = JSON.parse(readFileSync('package.json', 'utf8'));
for (const name of Object.keys(own.dependencies)) visit(path.resolve('node_modules', name, 'package.json'));
if (existsSync('assets/fonts/LICENSE-SourceCodePro.txt')) records.push(`Source Code Pro\nLicense: SIL Open Font License 1.1\nhttps://github.com/adobe-fonts/source-code-pro\n\n${readFileSync('assets/fonts/LICENSE-SourceCodePro.txt', 'utf8')}`);
records.push(`LXGW WenKai Regular 1.530\nLicense: SIL Open Font License 1.1\nhttps://github.com/lxgw/LxgwWenKai/releases/tag/v1.530\n\n${readFileSync('assets/fonts/LICENSE-LXGWWenKai.txt', 'utf8')}`);
writeFileSync('THIRD_PARTY_NOTICES.txt', `Moye third-party notices\n\nThis inventory covers installed production dependencies; some packages may be removed by bundling. Electron and Chromium notices are included with the desktop runtime.\n\n${records.sort().join('\n\n' + '='.repeat(78) + '\n\n')}\n`);
console.log(`Recorded notices for ${records.length} production packages.`);
