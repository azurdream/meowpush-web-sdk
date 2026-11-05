import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareBundle, publishBundle, runCli } from './publish-app-connect-cos.mjs';

const location = { Bucket: 'test-bucket', Region: 'test-region' };
const quiet = () => {};
const root = 'meowpush-app-connect/';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'app-connect-cos-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = { 'index.js': 'omitted-esm-integrity' };
  for (const [name, text] of [['connect.min.js', 'globalThis.MeowPushConnect={}'], ['styles.css', '.mp-connect{}']]) {
    await writeFile(join(dir, name), text);
    manifest[name] = 'sha384-' + createHash('sha384').update(text).digest('base64');
  }
  await writeFile(join(dir, 'integrity.json'), JSON.stringify(manifest));
  return dir;
}

class MemoryCos {
  objects = new Map();
  puts = [];
  beforePut = () => {};

  async getObject({ Key }) {
    if (!this.objects.has(Key)) throw Object.assign(new Error(), { statusCode: 404, code: 'NoSuchKey' });
    return this.objects.get(Key);
  }

  async putObject(request) {
    const { Key, Body, ContentType, ContentMD5, CacheControl, Headers } = request;
    this.beforePut(request);
    assert.equal(ContentMD5, createHash('md5').update(Body).digest('base64'));
    if (Headers['x-cos-forbid-overwrite'] === 'true' && this.objects.has(Key)) {
      throw Object.assign(new Error(), { statusCode: 409, code: 'FileAlreadyExists' });
    }
    this.puts.push(Key);
    this.objects.set(Key, {
      Body: Buffer.from(Body),
      headers: { 'content-type': ContentType, 'cache-control': CacheControl, etag: '"mock"',
        'x-cos-meta-sdk-version': Headers['x-cos-meta-sdk-version'] },
    });
    return { ETag: '"mock"' };
  }
}

test('credential-free dry run checks integrity and only lists the three public assets', async (t) => {
  const dir = await fixture(t);
  const lines = [];
  const args = ['--dir', dir, '--version', '1.0.0', '--dry-run'];
  await runCli(args, {}, line => lines.push(line));
  assert.equal(lines.length, 6);
  assert(lines.every(line => line.startsWith(root)));
  assert(lines.some(line => line.includes('/latest/connect.min.js\ttext/javascript; charset=utf-8\tpublic, no-cache, max-age=0, must-revalidate')));
  assert(lines.some(line => line.includes('/1.0.0/styles.css\ttext/css; charset=utf-8\tpublic, max-age=31536000, immutable')));
  for (const bad of ['v1.0.0', 'latest', '../1.0.0', '1.0', '1.0.0 ']) {
    await assert.rejects(prepareBundle(dir, bad), /canonical SemVer/);
  }

  await writeFile(join(dir, 'connect.min.js'), 'tampered');
  await assert.rejects(runCli(args, {}, quiet), /SHA-384 mismatch/);
});

test('numbered objects precede latest; aliases carry identical bytes, a filtered SRI manifest and version metadata', async (t) => {
  const dir = await fixture(t);
  const release = await prepareBundle(dir, '1.2.3');
  const cos = new MemoryCos();
  assert.equal(await publishBundle(cos, location, release, quiet), true);
  const names = ['styles.css', 'integrity.json', 'connect.min.js'];
  assert.deepEqual(cos.puts, ['1.2.3', 'latest'].flatMap(v => names.map(name => root + v + '/' + name)));
  const sri = JSON.parse(cos.objects.get(root + '1.2.3/integrity.json').Body);
  assert.deepEqual(Object.keys(sri).sort(), ['connect.min.js', 'styles.css']);
  for (const name of names) {
    const pinned = cos.objects.get(root + '1.2.3/' + name);
    const latest = cos.objects.get(root + 'latest/' + name);
    assert.deepEqual(pinned.Body, latest.Body);
    assert.equal(latest.headers['x-cos-meta-sdk-version'], '1.2.3');
  }
  await publishBundle(cos, location, release, quiet);
  assert.equal(cos.puts.length, 6, 'identical retry performs no PUT');
});

test('conflicting immutable bytes or response metadata abort before any new write', async (t) => {
  const release = await prepareBundle(await fixture(t), '1.0.0');
  const cos = new MemoryCos();
  await publishBundle(cos, location, release, quiet);
  const key = root + '1.0.0/connect.min.js';
  const original = cos.objects.get(key);
  cos.objects.delete(root + '1.0.0/styles.css');
  cos.objects.set(key, { ...original, Body: Buffer.from('another release') });
  await assert.rejects(publishBundle(cos, location, release, quiet), /Immutable release object differs/);
  cos.objects.set(key, { ...original, headers: { ...original.headers, 'cache-control': 'no-store' } });
  await assert.rejects(publishBundle(cos, location, release, quiet), /Immutable release object differs/);
  assert.equal(cos.puts.length, 6);
});

test('partial latest failure cannot let an older rerun downgrade any aliases; same version can finish', async (t) => {
  const dir = await fixture(t);
  const older = await prepareBundle(dir, '1.9.0');
  const newer = await prepareBundle(dir, '1.10.0');
  const cos = new MemoryCos();
  await publishBundle(cos, location, older, quiet);
  cos.beforePut = ({ Key }) => {
    if (Key === root + 'latest/integrity.json') throw Object.assign(new Error('secret diagnostic'), { statusCode: 503 });
  };
  await assert.rejects(publishBundle(cos, location, newer, quiet), {
    message: 'COS PUT failed for ' + root + 'latest/integrity.json (HTTP 503)',
  });
  const priorCount = cos.puts.length;
  assert.equal(await publishBundle(cos, location, older, quiet), false);
  assert.equal(cos.puts.length, priorCount);
  cos.beforePut = () => {};
  assert.equal(await publishBundle(cos, location, newer, quiet), true);
  assert.equal(cos.objects.get(root + 'latest/connect.min.js').headers['x-cos-meta-sdk-version'], '1.10.0');
});

test('prereleases stay versioned; unrecognized alias metadata blocks promotion', async (t) => {
  const dir = await fixture(t);
  const cos = new MemoryCos();
  assert.equal(await publishBundle(cos, location, await prepareBundle(dir, '2.0.0-rc.1'), quiet), false);
  assert.equal(cos.puts.some(key => key.startsWith(root + 'latest/')), false);
  cos.objects.set(root + 'latest/connect.min.js', { Body: Buffer.from('previous'), headers: {} });
  await assert.rejects(publishBundle(cos, location, await prepareBundle(dir, '2.0.0'), quiet), /canonical SemVer/);
  assert.equal(cos.puts.some(key => key.startsWith(root + 'latest/')), false);
});

test('conditional create racing a different writer does not replace the other writer', async (t) => {
  const release = await prepareBundle(await fixture(t), '1.0.0');
  const cos = new MemoryCos();
  const collision = root + '1.0.0/connect.min.js';
  cos.beforePut = ({ Key }) => {
    if (Key === collision) cos.objects.set(Key, { Body: Buffer.from('other writer'), headers: {} });
  };
  await assert.rejects(publishBundle(cos, location, release, quiet), /Immutable release object differs/);
  assert.equal(cos.objects.get(collision).Body.toString(), 'other writer');
  assert.equal(cos.puts.some(key => key.startsWith(root + 'latest/')), false);
});
