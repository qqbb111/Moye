import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentStore, FileConflictError } from '../electron/store';
async function setup() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rypota-store-')); const store = new DocumentStore(path.join(directory, 'recovery'), { autoSave: 35, recovery: 10 }); await store.initialize(); const windowId = store.newWindow(); return { directory, store, windowId }; }

test('打印偏好在重启后保留两套字号，文档和编辑主题保持原样', async () => {
  const { store, windowId } = await setup();
  try {
    const id = store.newDocument(windowId, '打印偏好不会改变代码');
    store.setPreferences({ print: { layout: 'landscape-two-column', color: 'light', lineNumbers: false, fonts: { portrait: 10.5, 'landscape-two-column': 9.5 } } }); await store.flush();
    const restored = new DocumentStore(store.directory); await restored.initialize();
    try { assert.deepEqual(restored.preferences.print, store.preferences.print); assert.equal(restored.preferences.theme, 'workbuddy'); assert.equal(restored.documents.get(id)?.content, '打印偏好不会改变代码'); } finally { restored.dispose(); }
  } finally { store.dispose(); }
});

test('恢复旧版模式设置时移除专注和打字机标记，草稿及其他偏好保留', async () => {
  const { store, windowId } = await setup();
  try {
    const id = store.newDocument(windowId, '旧草稿不能改变'); await store.flush();
    const snapshot = JSON.parse(await fs.readFile(store.sessionPath, 'utf8'));
    Object.assign(snapshot.preferences, { focus: true, typewriter: true, readingWidth: 1080 });
    await fs.writeFile(store.sessionPath, JSON.stringify(snapshot));
    const restored = new DocumentStore(store.directory); await restored.initialize();
    try {
      assert.equal('focus' in restored.preferences, false); assert.equal('typewriter' in restored.preferences, false);
      assert.equal(restored.preferences.readingWidth, 1080); assert.equal(restored.documents.get(id)?.content, '旧草稿不能改变');
    } finally { restored.dispose(); }
  } finally { store.dispose(); }
});

test('阅读宽度、侧栏宽度和代码折行校验范围，恢复时保留草稿和显示偏好', async () => {
  const { store, windowId } = await setup();
  try {
    const id = store.newDocument(windowId, '显示偏好不能影响草稿');
    store.setPreferences({ readingWidth: Infinity, sidebarWidth: NaN });
    assert.equal(store.preferences.readingWidth, 900); assert.equal(store.preferences.sidebarWidth, 256);
    store.setPreferences({ readingWidth: 50000, sidebarWidth: 0, codeWrap: true });
    assert.equal(store.preferences.readingWidth, 1200); assert.equal(store.preferences.sidebarWidth, 200);
    store.setPreferences({ readingWidth: 720, sidebarWidth: 310 }); await store.flush();
    const restored = new DocumentStore(store.directory); await restored.initialize();
    try { assert.equal(restored.preferences.readingWidth, 720); assert.equal(restored.preferences.sidebarWidth, 310); assert.equal(restored.preferences.codeWrap, true); assert.equal(restored.view(windowId).documents.find(doc => doc.id === id)?.content, '显示偏好不能影响草稿'); } finally { restored.dispose(); }
  } finally { store.dispose(); }
});

test('旧版首次升级默认启用 WorkBuddy，保留文档与保存设置，之后尊重用户主题选择', async () => {
  const { store, windowId } = await setup();
  try {
    const id = store.newDocument(windowId, '旧草稿 **一字不改**'); store.setPreferences({ autoSave: false, fontSize: 20, sidebarWidth: 310 }); await store.flush();
    const snapshot = JSON.parse(await fs.readFile(store.sessionPath, 'utf8')); delete snapshot.preferences.appearanceRevision;
    Object.assign(snapshot.preferences, { theme: 'copilot', codeTheme: 'modern-dark', readingWidth: 880, codeWrap: false }); await fs.writeFile(store.sessionPath, JSON.stringify(snapshot));
    const restored = new DocumentStore(store.directory); await restored.initialize();
    try {
      assert.equal(restored.preferences.theme, 'workbuddy'); assert.equal(restored.preferences.codeTheme, 'github-dark'); assert.equal(restored.preferences.codeWrap, true); assert.equal(restored.preferences.readingWidth, 900);
      assert.equal(restored.preferences.autoSave, false); assert.equal(restored.preferences.fontSize, 20); assert.equal(restored.preferences.sidebarWidth, 310);
      assert.equal(restored.documents.get(id)?.content, snapshot.documents[0].content); assert.equal(restored.documents.get(id)?.revision, snapshot.documents[0].revision);
      restored.setPreferences({ theme: 'light', codeTheme: 'modern-dark' }); await restored.flush();
      const again = new DocumentStore(store.directory); await again.initialize();
      try { assert.equal(again.preferences.theme, 'light'); assert.equal(again.preferences.codeTheme, 'modern-dark'); assert.equal(again.preferences.appearanceRevision, 1); assert.equal(again.documents.get(id)?.content, '旧草稿 **一字不改**'); } finally { again.dispose(); }
    } finally { restored.dispose(); }
  } finally { store.dispose(); }
});

test('拖动排序只接受当前窗口的完整标签集合，并持久化顺序和活动文档', async () => {
  const { store, windowId } = await setup();
  try {
    const first = store.newDocument(windowId), second = store.newDocument(windowId), third = store.newDocument(windowId);
    store.update(windowId, second, '排序不能丢掉我的内容', 1); store.activate(windowId, second);
    const other = store.newDocument(store.newWindow());
    for (const invalid of [[first, second], [first, second, second], [first, second, other]]) assert.throws(() => store.reorderDocuments(windowId, invalid));
    store.reorderDocuments(windowId, [third, first, second]); await store.flush();
    const restored = new DocumentStore(store.directory); await restored.initialize();
    try { const view = restored.view(windowId); assert.deepEqual(view.documents.map(doc => doc.id), [third, first, second]); assert.equal(view.activeId, second); assert.equal(view.documents[2].content, '排序不能丢掉我的内容'); } finally { restored.dispose(); }
  } finally { store.dispose(); }
});

test('未命名草稿和窗口标签顺序可以在新进程中恢复', async () => {
  const { directory, store, windowId } = await setup();
  try {
    const first = store.newDocument(windowId); const second = store.newDocument(windowId);
    store.update(windowId, first, '# 中文草稿\n\n还没有命名。', 1); store.activate(windowId, first); await store.flush();
    const restored = new DocumentStore(path.join(directory, 'recovery')); await restored.initialize();
    try { const view = restored.view(windowId); assert.deepEqual(view.documents.map(doc => doc.id), [first, second]); assert.equal(view.activeId, first); assert.equal(view.documents[0].content, '# 中文草稿\n\n还没有命名。'); assert.equal(view.documents[0].dirty, true); } finally { restored.dispose(); }
  } finally { store.dispose(); }
});
test('关闭未命名标签保留草稿，恢复时仍然包含完整内容', async () => {
  const { store, windowId } = await setup();
  try { const id = store.newDocument(windowId); store.update(windowId, id, '未保存的灵感', 1); await store.closeDocument(windowId, id); assert.equal(store.view(windowId).documents.length, 0); assert.equal(store.view(windowId).drafts[0].content, '未保存的灵感'); store.restore(windowId, id); assert.equal(store.view(windowId).documents[0].content, '未保存的灵感'); } finally { store.dispose(); }
});
test('自动保存写回 UTF-8 文件并保留 BOM 和 CRLF，同时保存原文件备份', async () => {
  const { directory, store, windowId } = await setup(); const file = path.join(directory, '中文.md'); await fs.writeFile(file, '\uFEFF# 原文\r\n\r\n正文\r\n');
  try { const { id } = await store.openFile(windowId, file); store.update(windowId, id, '# 新标题\n\n自动保存正文\n', 1); await delay(180); assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF# 新标题\r\n\r\n自动保存正文\r\n'); assert.equal(store.view(windowId).documents[0].dirty, false); assert.equal(await fs.readFile(path.join(store.directory, 'backups', `${id}.md`), 'utf8'), '\uFEFF# 原文\r\n\r\n正文\r\n'); } finally { store.dispose(); }
});
test('外部修改不会被自动保存覆盖，本地草稿仍可恢复', async () => {
  const { directory, store, windowId } = await setup(); const file = path.join(directory, '冲突.md'); await fs.writeFile(file, '原文');
  try { const { id } = await store.openFile(windowId, file); store.setPreferences({ autoSave: false }); store.update(windowId, id, 'Rypota 的修改', 1); await fs.writeFile(file, '其他程序的修改'); await assert.rejects(store.save(id), FileConflictError); await store.flush(); assert.equal(await fs.readFile(file, 'utf8'), '其他程序的修改'); const restored = new DocumentStore(store.directory); await restored.initialize(); try { assert.equal(restored.view(windowId).documents[0].content, 'Rypota 的修改'); assert.equal(restored.view(windowId).documents[0].status, 'conflict'); } finally { restored.dispose(); } } finally { store.dispose(); }
});
test('显式确认覆盖后保存成功，保存失败不会清除修改状态', async () => {
  const { directory, store, windowId } = await setup(); const file = path.join(directory, '文档.md'); await fs.writeFile(file, '旧');
  try { const { id } = await store.openFile(windowId, file); store.setPreferences({ autoSave: false }); store.update(windowId, id, '新内容', 1); await fs.writeFile(file, '外部'); await store.save(id, undefined, true); assert.equal(await fs.readFile(file, 'utf8'), '新内容'); store.update(windowId, id, '仍待保存', 2); await assert.rejects(store.save(id, path.join(directory, '不存在的目录', '文件.md'))); assert.equal(store.documents.get(id)!.content, '仍待保存'); assert.equal(store.documents.get(id)!.dirty, true); assert.equal(store.documents.get(id)!.path, file); } finally { store.dispose(); }
});
test('移动标签到新窗口不会复制内容或让其他窗口修改它', async () => {
  const { store, windowId } = await setup();
  try { const id = store.newDocument(windowId); store.update(windowId, id, '移动前的草稿', 1); const second = store.newWindow(); store.moveDocument(windowId, id, second); assert.equal(store.view(windowId).documents.length, 0); assert.equal(store.view(second).documents[0].content, '移动前的草稿'); assert.throws(() => store.update(windowId, id, '非法写入', 2)); } finally { store.dispose(); }
});
test('损坏的恢复记录可以从备份读取，损坏文件不覆盖有效备份', async () => {
  const { store, windowId } = await setup();
  try { const id = store.newDocument(windowId); store.update(windowId, id, '需要保留的草稿', 1); await store.flush(); await store.persist(); store.dispose(); await fs.writeFile(store.sessionPath, '{损坏的 JSON'); const restored = new DocumentStore(store.directory); await restored.initialize(); try { assert.equal(restored.view(windowId).documents[0].content, '需要保留的草稿'); await restored.persist(); assert.equal(JSON.parse(await fs.readFile(`${store.sessionPath}.bak`, 'utf8')).documents[0].content, '需要保留的草稿'); } finally { restored.dispose(); } } finally { store.dispose(); }
});
test('两个窗口打开同一路径会找到同一份文档，禁止另存为覆盖其他标签', async () => {
  const { directory, store, windowId } = await setup(); const file = path.join(directory, '唯一.md'); await fs.writeFile(file, '文档');
  try { const first = await store.openFile(windowId, file); const secondWindow = store.newWindow(); const second = await store.openFile(secondWindow, file); assert.deepEqual(second, first); const untitled = store.newDocument(secondWindow, '另一份内容'); await assert.rejects(store.save(untitled, file), /其他标签页/); assert.equal(await fs.readFile(file, 'utf8'), '文档'); } finally { store.dispose(); }
});
test('关闭自动保存后只保存草稿，较早的编辑消息不会回滚新内容', async () => {
  const { directory, store, windowId } = await setup(); const file = path.join(directory, '手动.md'); await fs.writeFile(file, '原文');
  try { const { id } = await store.openFile(windowId, file); store.setPreferences({ autoSave: false }); store.update(windowId, id, '最新', 2); store.update(windowId, id, '过期', 1); await store.flush(); assert.equal(await fs.readFile(file, 'utf8'), '原文'); assert.equal(store.documents.get(id)!.content, '最新'); } finally { store.dispose(); }
});
