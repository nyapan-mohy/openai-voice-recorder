import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const files = new Set(['index.html', 'app.js', 'audio-utils.js', 'capture-worklet.js', 'style.css']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export function createServer() {
  return http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { res.writeHead(403).end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"voice-prep-studio"}'); return; }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!files.has(name)) { res.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(path.join(root, name));
      res.writeHead(200, {
        'Content-Type': mime[path.extname(name)],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        'Permissions-Policy': 'microphone=(self), camera=()'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500).end('Unable to read application file'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  const server = createServer();
  server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Open http://127.0.0.1:${port} or choose another PORT.` : err.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Voice Recorder for OpenAI: http://127.0.0.1:${port}\nPress Ctrl+C to stop.`));
}
