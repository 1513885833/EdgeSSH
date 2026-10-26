import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_PATH_STORAGE_PREFIX,
  filePathStorageKey,
  isAbsoluteRemotePath,
  isRememberableHostId,
  readRememberedPath,
  writeRememberedPath,
  type StorageLike,
} from '../frontend/src/file-paths.ts';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('按主机写入并读回目录与文件，键名带主机 id', () => {
  const storage = new MemoryStorage();
  const written = writeRememberedPath(storage, 'alpha', { directory: '/root/deploy', file: '/root/deploy/app.conf' }, 1_790_100_000_000);
  assert.deepEqual(written, { directory: '/root/deploy', file: '/root/deploy/app.conf', updatedAt: 1_790_100_000_000 });
  assert.equal(filePathStorageKey('alpha'), `${FILE_PATH_STORAGE_PREFIX}alpha`);
  assert.deepEqual(readRememberedPath(storage, 'alpha'), written);
});

test('主机之间互相隔离：同一 storage 里各存各的', () => {
  const storage = new MemoryStorage();
  writeRememberedPath(storage, 'alpha', { directory: '/srv/alpha', file: '/srv/alpha/one.txt' });
  writeRememberedPath(storage, 'beta', { directory: '/srv/beta', file: null });

  assert.equal(readRememberedPath(storage, 'alpha')?.directory, '/srv/alpha');
  assert.equal(readRememberedPath(storage, 'alpha')?.file, '/srv/alpha/one.txt');
  assert.equal(readRememberedPath(storage, 'beta')?.directory, '/srv/beta');
  assert.equal(readRememberedPath(storage, 'beta')?.file, null);
  assert.equal(readRememberedPath(storage, 'gamma'), null);
  assert.equal(storage.values.size, 2);
});

test('合并写入：只更新目录不会丢掉已记录的文件，反之亦然', () => {
  const storage = new MemoryStorage();
  writeRememberedPath(storage, 'alpha', { directory: '/root', file: '/root/README.md' });
  writeRememberedPath(storage, 'alpha', { directory: '/root/backups' }, 10);
  let record = readRememberedPath(storage, 'alpha');
  assert.equal(record?.directory, '/root/backups');
  assert.equal(record?.file, '/root/README.md');

  writeRememberedPath(storage, 'alpha', { file: '/root/nginx.conf' }, 20);
  record = readRememberedPath(storage, 'alpha');
  assert.equal(record?.directory, '/root/backups');
  assert.equal(record?.file, '/root/nginx.conf');
  assert.equal(record?.updatedAt, 20);
});

test('只保存主机 id、路径和时间戳，不碰凭据', () => {
  const storage = new MemoryStorage();
  writeRememberedPath(storage, 'alpha', { directory: '/root', file: '/root/a.txt' });
  const key = filePathStorageKey('alpha')!;
  const raw = storage.values.get(key)!;
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['directory', 'file', 'updatedAt']);
  assert.ok(!raw.includes('password'));
  assert.ok(!raw.includes('privateKey'));
  assert.ok(key.includes('alpha'));
});

test('非法主机 id 不进 localStorage', () => {
  const storage = new MemoryStorage();
  for (const id of ['', '../alpha', 'alpha/beta', 'a b', 'x'.repeat(65), '日本語']) {
    assert.equal(isRememberableHostId(id), false, id);
    assert.equal(filePathStorageKey(id), null, id);
    assert.equal(writeRememberedPath(storage, id, { directory: '/root' }), null, id);
  }
  assert.equal(storage.values.size, 0);
});

test('非法路径被拒绝：必须是绝对路径且不含控制字符', () => {
  assert.equal(isAbsoluteRemotePath('/root'), true);
  assert.equal(isAbsoluteRemotePath('relative/path'), false);
  assert.equal(isAbsoluteRemotePath(''), false);
  assert.equal(isAbsoluteRemotePath('/root\u0000evil'), false);
  assert.equal(isAbsoluteRemotePath('/' + 'x'.repeat(4_096)), false);

  const storage = new MemoryStorage();
  assert.equal(writeRememberedPath(storage, 'alpha', { directory: 'relative' }), null);
  writeRememberedPath(storage, 'alpha', { directory: '/root', file: 'relative.txt' });
  assert.equal(readRememberedPath(storage, 'alpha')?.file, null);
});

test('损坏或伪造的存储内容被忽略，不让脏数据影响导航', () => {
  const storage = new MemoryStorage();
  const key = filePathStorageKey('alpha')!;
  storage.setItem(key, '{not json');
  assert.equal(readRememberedPath(storage, 'alpha'), null);

  storage.setItem(key, JSON.stringify(['array']));
  assert.equal(readRememberedPath(storage, 'alpha'), null);

  storage.setItem(key, JSON.stringify({ directory: 'relative', file: '/ok', updatedAt: 1 }));
  assert.equal(readRememberedPath(storage, 'alpha'), null);

  storage.setItem(key, JSON.stringify({ directory: '/ok', file: '/also-ok', updatedAt: -5 }));
  assert.deepEqual(readRememberedPath(storage, 'alpha'), { directory: '/ok', file: '/also-ok', updatedAt: 0 });
});

test('localStorage 抛错时静默降级，不中断文件管理', () => {
  const throwing: StorageLike = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(readRememberedPath(throwing, 'alpha'), null);
  assert.equal(writeRememberedPath(throwing, 'alpha', { directory: '/root' }), null);
});
