import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, extname, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.QQJ_PREVIEW_PORT || 4173);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = pathname === '/' ? 'mockups/recall-preview.html' : pathname.slice(1);
    const file = resolve(root, path);
    const local = relative(root, file);
    const allowed = ['src', 'mockups'].some(dir => local.startsWith(dir + sep));
    if (!allowed || !mime[extname(file)]) { response.writeHead(404).end('Not found'); return; }
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type':mime[extname(file)], 'Cache-Control':'no-store' });
    response.end(content);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Recall preview: http://127.0.0.1:${port}/mockups/recall-preview.html`));
