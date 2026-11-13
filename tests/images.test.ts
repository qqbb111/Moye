import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocumentImage } from '../electron/images';
import { DocumentStore } from '../electron/store';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
const directories = new Set<string>();
after(async () => {
  for (const directory of directories) {
    if (path.dirname(directory) !== await fs.realpath(os.tmpdir()) || await fs.realpath(directory) !== directory) throw new Error('图片测试暂存路径发生变化');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function setup() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'replica-images-'));
  directories.add(directory);
  const store = new DocumentStore(path.join(directory, 'recovery')); await store.initialize();
  const window = store.newWindow(); return { directory, store, window };
}

test('普通子目录图片和文档内的 Typora 根路径可读取', async () => {
  const { directory, store } = await setup();
  try {
    const assets = path.join(directory, '配图');
    await fs.mkdir(assets);
    const file = path.join(assets, '截图.png');
    await fs.writeFile(file, png);
    const document = path.join(directory, '笔记.md');
    const local = await readDocumentImage(document, '配图/截图.png');
    assert.equal(local?.file, await fs.realpath(file));
    assert.equal(local.mime, 'image/png');
    assert.deepEqual(local.bytes, png);
    assert.deepEqual((await readDocumentImage(document, '/截图.png', '---\ntypora-root-url: 配图\n---'))?.bytes, png);
    assert.equal(await readDocumentImage(document, '配图/尚未创建.png'), null);
  } finally { store.dispose(); }
});

test('草稿图片独立存储，保存后写出相对附件，另存为仍可携带图片', async () => {
  const { directory, store, window } = await setup();
  try {
    const url = await store.images.put(png, '剪贴板.png'); assert.match(url, /^replica-media:\/\/draft\//); assert.deepEqual((await store.images.readDraft(url))?.bytes, png);
    const id = store.newDocument(window, `正文\n\n![图片](${url})\n`); const first = path.join(directory, '中文 笔记.md'); await store.save(id, first);
    const saved = await fs.readFile(first, 'utf8'); assert.ok(!saved.includes('replica-media:')); assert.ok(!saved.includes('base64,')); assert.ok(saved.includes('中文%20笔记.assets/'));
    const relative = /!\[图片\]\(([^)]+)\)/.exec(saved)![1]; assert.deepEqual(await fs.readFile(path.resolve(directory, decodeURIComponent(relative))), png);
    const other = path.join(directory, '其他目录'); await fs.mkdir(other); const second = path.join(other, '新笔记.md'); await store.save(id, second, true);
    const copied = /!\[图片\]\(([^)]+)\)/.exec(await fs.readFile(second, 'utf8'))![1]; assert.deepEqual(await fs.readFile(path.resolve(other, decodeURIComponent(copied))), png);
  } finally { store.dispose(); }
});
test('旧版 Base64 草稿恢复时转换为附件，保留代码块中的图片示例', async () => {
  const { directory, store, window } = await setup(); const embedded = `data:image/png;base64,${png.toString('base64')}`;
  const id = store.newDocument(window, `![图](${embedded})\n\n\`\`\`md\n![代码示例](${embedded})\n\`\`\``); await store.persist(); store.dispose();
  const restored = new DocumentStore(path.join(directory, 'recovery')); await restored.initialize();
  try { const source = restored.documents.get(id)!.content; assert.match(source, /^!\[图\]\(replica-media:\/\/draft\//); assert.ok(source.includes(`![代码示例](${embedded})`)); const url = /^!\[图\]\(([^)]+)\)/.exec(source)![1]; assert.deepEqual((await restored.images.readDraft(url))?.bytes, png); } finally { restored.dispose(); }
});
test('保存整理默认关闭，开启后遵循相同规则并保留代码和原文件备份', async () => {
  const { directory, store, window } = await setup();
  try { const raw = '中文API与10GB。\n\n```cpp\n// 中文API\n```\n'; const file = path.join(directory, '排版.md'); const id = store.newDocument(window, raw); await store.save(id, file); assert.equal(await fs.readFile(file, 'utf8'), raw);
    store.setPreferences({ formatOnSave: true }); await store.save(id); const source = await fs.readFile(file, 'utf8'); assert.ok(source.startsWith('中文 API 与 10 GB。')); assert.ok(source.includes('// 中文API')); assert.equal(store.documents.get(id)!.content, source); assert.equal(store.documents.get(id)!.dirty, false); assert.equal(await fs.readFile(path.join(store.directory, 'backups', `${id}.md`), 'utf8'), raw);
  } finally { store.dispose(); }
});
test('写盘期间继续输入，不会被旧快照的整理结果覆盖', async () => {
  const { directory, store, window } = await setup();
  try {
    store.setPreferences({ autoSave: false, formatOnSave: true }); const id = store.newDocument(window, '旧内容API');
    let release!: () => void; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); const waiting = new Promise<void>(resolve => { release = resolve; });
    const original = store.images.materialize.bind(store.images); store.images.materialize = async (...args) => { started(); await waiting; return original(...args); };
    const file = path.join(directory, '并发保存.md'); const saving = store.save(id, file); await ready;
    store.update(window, id, '用户新输入API', 1); release(); await saving;
    assert.equal(await fs.readFile(file, 'utf8'), '旧内容 API'); assert.equal(store.documents.get(id)!.content, '用户新输入API'); assert.equal(store.documents.get(id)!.dirty, true);
  } finally { store.dispose(); }
});
