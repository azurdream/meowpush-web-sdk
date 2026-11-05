import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareBundle } from './publish-app-connect-cos.mjs';

const CDN_BASE = 'https://dstatic.meowpush.com/meowpush-app-connect/';
const TEST_ORIGIN = 'https://example.com';

function checkCacheControl(header, latest) {
  const directives = (header || '').toLowerCase().split(',').map(directive => directive.trim());
  if (latest) {
    const ages = directives.filter(d => /^(?:s-maxage|max-age)\b/.test(d));
    return directives.includes('no-cache') &&
      !directives.includes('no-store') && !directives.includes('immutable') &&
      ages.every(d => /^(?:s-maxage|max-age)\s*=\s*(?:0+|"0+")$/.test(d));
  }
  return directives.includes('immutable') && directives.includes('max-age=31536000') &&
    !directives.includes('no-cache') && !directives.includes('no-store');
}

async function verifyObject(url, expected, latest, request) {
  const headers = { Origin: TEST_ORIGIN };
  const get = extraHeaders => request(url, {
    headers: { ...headers, ...extraHeaders }, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  const response = await get();
  const fail = reason => { throw new Error(reason); };
  if (response.status !== 200) fail('expected 200, received ' + response.status);
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mime !== expected.type.split(';')[0]) fail('unexpected Content-Type: ' + mime);
  if (response.headers.get('access-control-allow-origin') !== '*') fail('expected Access-Control-Allow-Origin: *');
  if (response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') fail('expected X-Content-Type-Options: nosniff');
  const policy = response.headers.get('cross-origin-resource-policy');
  if (policy && policy.toLowerCase() !== 'cross-origin') fail('restrictive Cross-Origin-Resource-Policy');
  if (!checkCacheControl(response.headers.get('cache-control'), latest)) fail('unexpected Cache-Control');
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.equals(expected.body)) fail('content differs from the release');
  if (latest) {
    const etag = response.headers.get('etag');
    if (!etag || !/^(?:W\/)?"[^"]*"$/.test(etag)) fail('missing or invalid ETag');
    const conditional = await get({ 'If-None-Match': etag });
    if (conditional.status !== 304) {
      await conditional.body?.cancel();
      fail('If-None-Match returned ' + conditional.status + ', expected 304');
    }
    // A browser applies any new headers from the 304 to its stored response.
    const refreshedPolicy = conditional.headers.get('cache-control');
    if (refreshedPolicy !== null && !checkCacheControl(refreshedPolicy, true)) fail('304 changed Cache-Control');
    const refreshedOrigin = conditional.headers.get('access-control-allow-origin');
    if (refreshedOrigin !== null && refreshedOrigin !== '*') fail('304 changed Access-Control-Allow-Origin');
  }
}

export async function verifyCdn({ dir, version, latest = false }, { request = fetch, retryDelays = [2500, 5000, 10000, 15000] } = {}) {
  if (!dir || !version) throw new Error('Usage: --dir <dist> --version <semver> [--latest]');
  const { files } = await prepareBundle(dir, version);
  const paths = latest ? [version, 'latest'] : [version];
  await Promise.all(paths.flatMap(folder => files.map(async file => {
    const url = CDN_BASE + encodeURIComponent(folder) + '/' + file.name;
    for (let attempt = 0; ; attempt++) {
      try {
        await verifyObject(url, file, folder === 'latest', request);
        return;
      } catch (error) {
        if (attempt === retryDelays.length) throw new Error(url + ': ' + error.message, { cause: error });
        await delay(retryDelays[attempt]);
      }
    }
  })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      dir: { type: 'string' }, version: { type: 'string' }, latest: { type: 'boolean' },
    } });
    await verifyCdn(values);
    console.log('Verified public CDN assets at ' + CDN_BASE + values.version + '/' +
      (values.latest ? ' and latest/ (If-None-Match returned 304).' : '.'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
