import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { migrateUserData, profilePaths } from '../electron/user-data';

async function fixture(t: TestContext) {
  const temp = await fs.realpath(os.tmpdir());
  const appData = await fs.mkdtemp(path.join(temp, 'moye-profile-'));
  t.after(async () => {
    assert.equal(path.dirname(appData), temp);
    assert.equal(await fs.realpath(appData), appData);
    await fs.rm(appData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const initial = profilePaths(appData);
  assert.equal(initial.lock, initial.userData);
  assert.equal(await migrateUserData(initial), undefined);
  await fs.mkdir(initial.legacyRecovery!, { recursive: true });
  await fs.writeFile(path.join(initial.legacyRecovery!, 'workspace.json'), '旧草稿');
  return { appData, paths: profilePaths(appData) };
}

test('迁移遇到独立的新资料时保留两份资料并报告冲突', async t => {
  const { appData, paths } = await fixture(t);
  assert.equal(paths.lock, paths.legacyUserData);
  await fs.mkdir(paths.recovery, { recursive: true });
  await fs.writeFile(path.join(paths.recovery, 'workspace.json'), '新草稿');
  const existing = profilePaths(appData);
  assert.equal(existing.lock, existing.userData);
  assert.match((await migrateUserData(existing))!.notice!, /两份独立的恢复数据/);
  assert.equal(await fs.readFile(path.join(existing.recovery, 'workspace.json'), 'utf8'), '新草稿');
  assert.equal(await fs.readFile(path.join(existing.legacyRecovery!, 'workspace.json'), 'utf8'), '旧草稿');
});

test('迁移失败没有发布部分数据，来源可以修复并重试', async t => {
  const { appData, paths } = await fixture(t);
  const external = path.join(appData, 'other');
  await fs.mkdir(external);
  const link = path.join(paths.legacyRecovery!, 'linked-directory');
  await fs.symlink(external, link, 'junction');

  await assert.rejects(migrateUserData(paths), /无法迁移旧草稿、图片和设置.*原数据保留/);
  assert.deepEqual(await fs.readdir(paths.userData), []);
  assert.equal(await fs.readFile(path.join(paths.legacyRecovery!, 'workspace.json'), 'utf8'), '旧草稿');

  await fs.unlink(link);
  assert.deepEqual(await migrateUserData(paths), { migratedFrom: paths.legacyUserData });
  assert.equal(await fs.readFile(path.join(paths.recovery, 'workspace.json'), 'utf8'), '旧草稿');
  const migrated = profilePaths(appData);
  assert.equal(migrated.lock, paths.legacyUserData);
  assert.equal(await migrateUserData(migrated), undefined);

  const override = profilePaths(appData, path.join(appData, 'isolated'));
  assert.equal(override.lock, override.userData);
  assert.equal(override.legacyRecovery, undefined);
  assert.equal(await migrateUserData(override), undefined);
  await assert.rejects(fs.stat(override.userData), { code: 'ENOENT' });
});
