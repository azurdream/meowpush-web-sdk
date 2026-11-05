import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyCdn } from './verify-app-connect-cdn.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'app-connect-cdn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = { 'connect.min.js': 'window.test = true;', 'styles.css': 'button {}' };
  const sri = Object.fromEntries(Object.entries(bytes).map(([name, value]) =>
    [name, 'sha384-' + createHash('sha384').update(value).digest('base64')]));
  bytes['integrity.json'] = JSON.stringify(sri, null, 2) + '\n';
  for (const [name, value] of Object.entries(bytes)) await writeFile(join(dir, name), value);
  return { dir, bytes };
}

function mockCdn(bytes, { change = () => {}, seen = [] } = {}) {
  return async (url, { headers: requestHeaders, redirect }) => {
    const { origin, pathname, search } = new URL(url);
    assert.equal(origin, 'https://dstatic.meowpush.com');
    assert.equal(search, '');
    assert.equal(requestHeaders.Origin, 'https://example.com');
    assert.equal(redirect, 'error');
    const [, prefix, folder, name] = pathname.split('/');
    assert.equal(prefix, 'meowpush-app-connect');
    const conditional = requestHeaders['If-None-Match'];
    seen.push({ folder, name, conditional });
    const etag = '"' + name + '"';
    const headers = new Headers({
      'content-type': { 'connect.min.js': 'text/javascript', 'styles.css': 'text/css', 'integrity.json': 'application/json' }[name],
      'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', etag,
      'cache-control': folder === 'latest' ? 'public, max-age=0, no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
    });
    const result = { headers, status: conditional === etag ? 304 : 200, body: bytes[name] };
    if (name === 'connect.min.js') change(result, folder, conditional);
    return new Response(result.status === 304 ? null : result.body, result);
  };
}

test('uses the public version URLs and conditionally revalidates every promoted alias', async t => {
  const { dir, bytes } = await fixture(t);
  for (const latest of [true, false]) {
    const seen = [];
    await verifyCdn({ dir, version: '1.2.3', latest }, { request: mockCdn(bytes, { seen }), retryDelays: [] });
    assert.equal(seen.filter(hit => hit.folder === '1.2.3' && !hit.conditional).length, 3);
    assert.equal(seen.filter(hit => hit.folder === 'latest').length, latest ? 6 : 0);
    assert.equal(seen.filter(hit => hit.conditional && hit.folder === 'latest').length, latest ? 3 : 0);
  }
});

test('detects edge overrides, stale payloads and a CDN ignoring conditional requests', async t => {
  const { dir, bytes } = await fixture(t);
  const cases = [
    [r => r.headers.set('cache-control', 'max-age=86400'), /Cache-Control/],
    [r => r.headers.set('cache-control', 'no-cache, max-age=3600'), /Cache-Control/],
    [r => r.headers.delete('etag'), /ETag/],
    [r => r.headers.delete('access-control-allow-origin'), /Access-Control-Allow-Origin/],
    [r => r.headers.delete('x-content-type-options'), /X-Content-Type-Options/],
    [r => r.headers.set('content-type', 'text/html'), /Content-Type/],
    [r => { r.body = 'previous revision'; }, /differs from the release/],
    [(r, conditional) => { if (conditional) r.status = 200; }, /expected 304/],
    [(r, conditional) => { if (conditional) r.headers.set('cache-control', 'max-age=604800'); }, /304 changed Cache-Control/],
  ];
  for (const [mutate, message] of cases) {
    const request = mockCdn(bytes, { change: (result, folder, conditional) => {
      if (folder === 'latest') mutate(result, conditional);
    } });
    await assert.rejects(verifyCdn({ dir, version: '1.2.3', latest: true }, { request, retryDelays: [] }), message);
  }
});
