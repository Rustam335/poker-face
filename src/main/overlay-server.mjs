// Local-only HTTP server for the OBS browser source: static overlay files + a
// server-sent-events stream of game snapshots. Bound to 127.0.0.1.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OVERLAY_DIR = new URL('../overlay/', import.meta.url);
const FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/overlay.css': { file: 'overlay.css', type: 'text/css; charset=utf-8' },
  '/overlay.js': { file: 'overlay.js', type: 'text/javascript; charset=utf-8' },
};
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const HEARTBEAT_MS = 15000;

export function startOverlayServer(port) {
  const clients = new Set();
  let latest = null;

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (path === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (latest) response.write(`data: ${latest}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    const entry = FILES[path];
    if (!entry) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(fileURLToPath(new URL(entry.file, OVERLAY_DIR)));
      response.writeHead(200, {
        'Content-Type': entry.type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500).end('Overlay file missing');
      process.stderr.write(`[overlay] ${error.message}\n`);
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}/`));
  });

  return {
    ready,
    publish(snapshot) {
      latest = JSON.stringify(snapshot);
      for (const client of clients) client.write(`data: ${latest}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      server.close();
    },
  };
}
