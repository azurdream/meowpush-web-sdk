import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import semver from 'semver';

const PREFIX = 'meowpush-app-connect';
const VERSION_HEADER = 'x-cos-meta-sdk-version';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, no-cache, max-age=0, must-revalidate';

export function parseVersion(value) {
  const parsed = semver.parse(value);
  if (parsed) {
    const canonical = parsed.version + (parsed.build.length ? '+' + parsed.build.join('.') : '');
    if (value === canonical) return parsed;
  }
  throw new Error('Expected a canonical SemVer package version.');
}

export async function prepareBundle(directory, version) {
  const parsed = parseVersion(version);
  const manifest = JSON.parse(await readFile(join(directory, 'integrity.json'), 'utf8'));
  const integrity = {};
  const assets = [];
  for (const [name, type] of [['connect.min.js', 'text/javascript'], ['styles.css', 'text/css']]) {
    const body = await readFile(join(directory, name));
    const digest = 'sha384-' + createHash('sha384').update(body).digest('base64');
    if (!body.length || manifest?.[name] !== digest) throw new Error('SHA-384 mismatch: ' + name);
    integrity[name] = digest;
    assets.push({ name, body, type: type + '; charset=utf-8' });
  }
  const manifestFile = {
    name: 'integrity.json', type: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(integrity, null, 2) + '\n'),
  };
  const [script, css] = assets;
  // Consumers using the moving script URL get the entry point after its matching stylesheet.
  return { version, stable: parsed.prerelease.length === 0, files: [css, manifestFile, script] };
}

function cosFailure(action, key, error) {
  const status = Number.isInteger(error?.statusCode) ? ' (HTTP ' + error.statusCode + ')' : '';
  return new Error('COS ' + action + ' failed for ' + key + status);
}

async function getExisting(cos, address) {
  try {
    return await cos.getObject(address);
  } catch (error) {
    if (error.statusCode === 404 && error.code === 'NoSuchKey') return null;
    throw cosFailure('GET', address.Key, error);
  }
}

function matches(stored, file, cache) {
  return Buffer.isBuffer(stored?.Body) && stored.Body.equals(file.body)
    && stored.headers['content-type'] === file.type && stored.headers['cache-control'] === cache
    && Boolean(stored.headers.etag);
}

async function put(cos, address, file, version, cache) {
  const headers = { [VERSION_HEADER]: version };
  if (cache === IMMUTABLE) headers['x-cos-forbid-overwrite'] = 'true';
  let response;
  try {
    response = await cos.putObject({
      ...address, Body: file.body, ContentType: file.type, CacheControl: cache, Headers: headers,
      ContentMD5: createHash('md5').update(file.body).digest('base64'),
    });
  } catch (error) {
    if (cache === IMMUTABLE && error.statusCode === 409 && error.code === 'FileAlreadyExists') {
      if (matches(await getExisting(cos, address), file, cache)) return;
      throw new Error('Immutable release object differs: ' + address.Key);
    }
    throw cosFailure('PUT', address.Key, error);
  }
  if (!response.ETag?.trim()) throw new Error('COS returned no ETag: ' + address.Key);
}

export async function publishBundle(cos, location, bundle, log = console.log) {
  const { files, version } = bundle;
  async function existingDirectory(directory) {
    return Promise.all(files.map(async (file) => {
      const address = { ...location, Key: [PREFIX, directory, file.name].join('/') };
      return { file, address, stored: await getExisting(cos, address) };
    }));
  }

  const pinned = await existingDirectory(version);
  for (const { file, address, stored } of pinned) {
    if (stored && !matches(stored, file, IMMUTABLE)) {
      throw new Error('Immutable release object differs: ' + address.Key);
    }
  }
  for (const { file, address, stored } of pinned) {
    if (!stored) await put(cos, address, file, version, IMMUTABLE);
    log('Verified ' + address.Key);
  }
  if (!bundle.stable) return false;

  // CI serializes publishers. Checking every alias also detects a newer, partially uploaded release.
  const aliases = await existingDirectory('latest');
  for (const { address, stored } of aliases) {
    if (!stored) continue;
    const previous = stored.headers[VERSION_HEADER];
    const parsed = parseVersion(previous);
    if (parsed.prerelease.length || (semver.eq(previous, version) && previous !== version)) {
      throw new Error('Ambiguous latest version on ' + address.Key);
    }
    if (semver.gt(previous, version)) {
      log('Keeping newer latest release ' + previous);
      return false;
    }
  }
  for (const { address, stored, file } of aliases) {
    if (stored?.headers[VERSION_HEADER] !== version || !matches(stored, file, REVALIDATE)) {
      await put(cos, address, file, version, REVALIDATE);
    }
    log('Verified ' + address.Key);
  }
  return true;
}

export async function runCli(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const { values } = parseArgs({ args: argv, options: {
    dir: { type: 'string' }, version: { type: 'string' }, 'dry-run': { type: 'boolean' },
  } });
  if (!values.dir || !values.version) throw new Error('Usage: --dir <dist> --version <semver> [--dry-run]');
  const bundle = await prepareBundle(values.dir, values.version);
  if (values['dry-run']) {
    for (const directory of bundle.stable ? [bundle.version, 'latest'] : [bundle.version]) {
      for (const file of bundle.files) {
        log([PREFIX, directory, file.name].join('/') + '\t' + file.type + '\t' +
          (directory === 'latest' ? REVALIDATE : IMMUTABLE));
      }
    }
    return;
  }

  for (const name of ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION']) {
    if (!env[name]?.trim()) throw new Error('Missing required environment variable: ' + name);
  }
  const { default: COS } = await import('cos-nodejs-sdk-v5');
  const cos = new COS({
    SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY,
    ...(env.COS_DOMAIN ? { Domain: env.COS_DOMAIN } : {}),
  });
  const latest = await publishBundle(cos, { Bucket: env.COS_BUCKET, Region: env.COS_REGION }, bundle, log);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'latest_published=' + latest + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
