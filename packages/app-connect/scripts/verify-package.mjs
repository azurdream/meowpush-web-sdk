import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const temporary = await mkdtemp(join(tmpdir(), 'meowpush-app-connect-package-'));
const npmEnvironment = { ...process.env, npm_config_cache: join(temporary, 'npm-cache') };
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], { env: npmEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  const paths = packed[0].files.map(({ path }) => path);
  if (paths.some((path) => !/^(dist\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(path)))
    throw new Error('Unexpected file in published package');
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/ui.js', 'dist/ui.d.ts', 'dist/connect.min.js', 'dist/styles.css', 'dist/integrity.json', 'README.md', 'LICENSE', 'package.json'])
    if (!paths.includes(required)) throw new Error(`Missing published file: ${required}`);
  const tarball = join(temporary, packed[0].filename);
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball], { env: npmEnvironment, cwd: consumer, stdio: 'inherit' });
  await writeFile(join(consumer, 'verify.mjs'), `
import { connect } from '@azurdream/meowpush-app-connect';
import { mountButton } from '@azurdream/meowpush-app-connect/ui';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
if (typeof connect !== 'function' || typeof mountButton !== 'function') throw new Error('Missing public exports');
try { await connect({ application: { name: 'SSR import check' } }); throw new Error('Expected browser requirement'); } catch (e) { if (e.code !== 'browser_required') throw e; }
try { await import('@azurdream/meowpush-app-connect/dist/internal/connector.js'); throw new Error('Internal path exposed'); } catch (e) { if (e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e; }
const prefix = './node_modules/@azurdream/meowpush-app-connect/dist/';
const context = {};
runInNewContext(await readFile(prefix + 'connect.min.js', 'utf8'), context);
if (typeof context.MeowPushConnect.connect !== 'function' || typeof context.MeowPushConnect.mountButton !== 'function') throw new Error('Missing IIFE public API');
const manifest = JSON.parse(await readFile(prefix + 'integrity.json', 'utf8'));
for (const [file, hash] of Object.entries(manifest)) {
  if ('sha384-' + createHash('sha384').update(await readFile(prefix + file)).digest('base64') !== hash) throw new Error('Integrity mismatch');
}
console.log('Installed package: public exports, SSR, private-path denial, IIFE and SRI passed');
`);
  execFileSync(process.execPath, ['verify.mjs'], { cwd: consumer, stdio: 'inherit' });
  await writeFile(join(consumer, 'types.ts'), `
import { connect, type ConnectOptions } from '@azurdream/meowpush-app-connect';
import { mountButton, type ButtonPresentationUpdate } from '@azurdream/meowpush-app-connect/ui';
const normal: ConnectOptions = { application: { name: 'Example' }, authorization: { mode: 'popup', position: 'center' } };
const defaultPlacement: ConnectOptions = { application: { name: 'Example' }, authorization: { mode: 'popup', position: 'browser-default' } };
// @ts-expect-error Position must be one of the supported placement modes.
const invalidPosition: ConnectOptions = { application: { name: 'Example' }, authorization: { position: 'screen-center' } };
void defaultPlacement; void invalidPosition;
const manual: ConnectOptions = { application: { name: 'Example' }, authorization: { mode: 'manual' }, onAuthorizationRequired({ url }) { void url; } };
// @ts-expect-error Manual mode requires an explicit authorization callback.
const invalid: ConnectOptions = { application: { name: 'Example' }, authorization: { mode: 'manual' } };
// @ts-expect-error API endpoints cannot be overridden.
const endpoint: ConnectOptions = { application: { name: 'Example' }, apiBaseUrl: 'https://other.example' };
void connect(normal); void connect(manual); void invalid; void endpoint;
const button = mountButton(document.createElement('div'), { application: { name: 'Example' }, authorization: { mode: 'manual', position: 'browser-default' }, onSuccess({ pushKey }) { const value: string = pushKey; void value; } });
const presentation: ButtonPresentationUpdate = { locale: 'en', theme: 'dark', size: 'sm', label: 'Connect' };
button.update(presentation);
button.update({ locale: undefined, theme: undefined, size: undefined, label: undefined });
// @ts-expect-error Presentation updates cannot change the current authorization or application.
button.update({ application: { name: 'Other' } });
`);
  const tsc = new URL('../node_modules/typescript/bin/tsc', import.meta.url).pathname;
  execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--exactOptionalPropertyTypes', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM,DOM.Iterable', join(consumer, 'types.ts')], { cwd: consumer, stdio: 'inherit' });
  console.log('Installed package TypeScript declarations passed');
} finally { await rm(temporary, { recursive: true, force: true }); }
