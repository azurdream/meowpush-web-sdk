import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Playwright's WebKit screenshotter inserts this exact empty rule to sync animations.
const screenshotStyle = "'sha256-YjaKGiklmzC6wjXA513HAMmzus8VE61XCOT+SmwNZWA='";
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1:4176').pathname);
    if (path === '/healthz' || path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    // Test-only page for direct, real cross-origin CORS validation against a
    // random-port loopback Biz fixture. Production SDK origins remain fixed.
    if (path === '/__test__/cors.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          `default-src 'none'; style-src ${screenshotStyle}; connect-src http://127.0.0.1:*; frame-ancestors 'none'`,
      });
      response.end(
        '<!doctype html><html lang="en"><title>Direct CORS fixture</title><h1>Direct CORS fixture</h1></html>',
      );
      return;
    }

    if (!/^\/packages\/app-connect\/(examples|dist)\//.test(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = resolve(root, `.${path.endsWith('/') ? `${path}index.html` : path}`);
    const allowed = ['examples', 'dist'].some((directory) =>
      file.startsWith(resolve(root, 'packages/app-connect', directory) + sep),
    );
    if (!allowed) {
      response.writeHead(404);
      response.end();
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        `default-src 'self'; script-src 'self'; style-src 'self' ${screenshotStyle}; connect-src https://accounts.meowpush.com; img-src 'self' data: https://meowpush.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
server.listen(4176, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
