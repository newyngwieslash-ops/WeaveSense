// Test-only Node adapter for the already-built Vercel Web handler. No business routes.
import http from 'node:http';
import handler from './index.mjs';

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await handler.fetch(new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500); res.end('test_adapter_failed');
  }
}).listen(8080, '0.0.0.0');
