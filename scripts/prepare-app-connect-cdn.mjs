import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVersion } from './publish-app-connect-cos.mjs';

const packageName = '@azurdream/meowpush-app-connect';
const packageManifest = 'packages/app-connect/package.json';
const { RELEASE_TAG: requestedTag, EXPECTED_COMMIT: expectedCommit, PACK_DIRECTORY: packDirectory,
  CDN_DIRECTORY: directory, GITHUB_OUTPUT: output } = process.env;
if (!directory || !output) throw new Error('Missing CDN_DIRECTORY or GITHUB_OUTPUT');
const tag = requestedTag || (packDirectory && packageName + '@' + JSON.parse(await readFile(packageManifest, 'utf8')).version);
const version = tag?.slice(packageName.length + 1);
if (!version || !tag.startsWith(packageName + '@')) {
  throw new Error('Expected a package release tag such as @azurdream/meowpush-app-connect@1.2.3');
}

parseVersion(version);

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function checkPackage(manifest) {
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error('Package name/version differs from the release tag');
  }
}

const commit = git('rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}');
if (expectedCommit && commit !== git('rev-parse', '--verify', expectedCommit + '^{commit}')) {
  throw new Error('The package tag points to a different commit');
}
checkPackage(JSON.parse(git('show', commit + ':' + packageManifest)));

const archiveName = 'azurdream-meowpush-app-connect-' + version + '.tgz';
let archive;
if (packDirectory) {
  // Read the exact Changesets artifact already used by the npm publication.
  const plan = JSON.parse(await readFile(join(packDirectory, 'publish-plan.json'), 'utf8'));
  const releases = plan.plan.flat().filter((item) =>
    item.kind === 'publish' && item.name === packageName && item.version === version);
  const expectedPath = 'packages/' + archiveName;
  if (plan.version !== 1 || releases.length !== 1 || releases[0].tarball?.path !== expectedPath) {
    throw new Error('App Connect tarball is missing or ambiguous in the publish plan');
  }
  archive = join(packDirectory, expectedPath);
  const digest = createHash('sha256').update(await readFile(archive)).digest('base64');
  if (releases[0].tarball.integrity !== 'sha256-' + digest) throw new Error('Release tarball checksum mismatch');
} else {
  // Manual tag pushes and repairs can run after the Actions artifact has expired.
  const temporary = await mkdtemp(join(tmpdir(), 'app-connect-registry-'));
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts',
    '--registry=https://registry.npmjs.org/', '--pack-destination', temporary, tag],
    { encoding: 'utf8', cwd: temporary }));
  checkPackage(packed);
  if (packed.filename !== archiveName) throw new Error('Unexpected registry tarball name');
  archive = join(temporary, archiveName);
}

const extract = (member) => execFileSync('tar', ['-xOzf', archive, 'package/' + member]);
checkPackage(JSON.parse(extract('package.json')));
await mkdir(directory, { recursive: true });
for (const file of ['connect.min.js', 'styles.css', 'integrity.json']) {
  await writeFile(join(directory, file), extract('dist/' + file));
}
await appendFile(output, 'version=' + version + '\n');
console.log('Prepared ' + tag + ' from ' + commit);
