import { build } from 'esbuild';
import { mkdir, rm, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/index.ts', 'src/ui.ts'], outdir: 'dist', bundle: true, splitting: true, format: 'esm', target: 'es2022', minify: true, sourcemap: false });
await build({ entryPoints: ['src/browser.ts'], outfile: 'dist/connect.min.js', bundle: true, format: 'iife', globalName: 'MeowPushConnect', target: 'es2022', minify: true, sourcemap: false });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--emitDeclarationOnly'], { stdio: 'inherit' });
await copyFile('src/styles.css', 'dist/styles.css');
const integrity = {};
for (const file of (await readdir('dist')).filter((name) => /\.(js|css)$/.test(name)).sort()) {
  integrity[file] = 'sha384-' + createHash('sha384').update(await readFile(`dist/${file}`)).digest('base64');
}
await writeFile('dist/integrity.json', JSON.stringify(integrity, null, 2) + '\n');
