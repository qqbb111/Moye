import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
const renderer = await viteBuild({ base: './', build: { outDir: 'dist', emptyOutDir: false, target: 'chrome130' } });
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', mainFields: ['module', 'main'], external: ['electron'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true });
const files = [...new Set((Array.isArray(renderer) ? renderer : [renderer]).flatMap(bundle => bundle.output.map(item => item.fileName)))].sort();
await fs.writeFile('dist-electron/renderer-files.json', JSON.stringify({ files, indexHash: createHash('sha256').update(await fs.readFile('dist/index.html')).digest('hex') }));
