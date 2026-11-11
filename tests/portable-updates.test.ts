import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PortableUpdates, updateAsset } from '../electron/portable-updates';

const bytes = Buffer.from('test archive');
const asset = {
  name: 'Moye-0.9.10-windows-x64.zip', state: 'uploaded', size: bytes.length,
  browser_download_url: 'https://github.com/qqbb111/Moye/releases/download/v0.9.10/Moye-0.9.10-windows-x64.zip',
  digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
};
const release = { tag_name: 'v0.9.10', assets: [asset] };

test('更新仅接受更高的正式版本与指定仓库的已校验 Windows ZIP', () => {
  assert.equal(updateAsset(release, '0.9.9')?.version, '0.9.10');
  assert.equal(updateAsset(release, '0.9.10'), undefined);
  assert.equal(updateAsset(release, '1.0.0'), undefined);
  assert.throws(() => updateAsset({ ...release, prerelease: true }, '0.9.9'), /无法识别/);
  for (const change of [{ state: 'starter' }, { digest: '' }, { size: -1 }, { browser_download_url: 'https://example.org/update.zip' }]) {
    assert.throws(() => updateAsset({ ...release, assets: [{ ...asset, ...change }] }, '0.9.9'), /未提供可校验/);
  }
});

test('被篡改的下载会清理暂存，无法进入安装', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-update-test-'));
  try {
    const updates = new PortableUpdates({
      version: '0.9.9', executable: path.join(root, 'Moye.exe'), userData: root, supported: true,
      request: async url => url.startsWith('https://api.github.com/') ? Response.json(release) : new Response(Buffer.alloc(bytes.length)), changed() {},
    });
    await updates.check();
    assert.equal(updates.state.phase, 'available');
    await updates.download();
    assert.equal(updates.state.phase, 'error');
    assert.match(updates.state.message ?? '', /校验失败/);
    assert.equal(await updates.install(async () => { throw new Error('must not save or quit'); }), false);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
