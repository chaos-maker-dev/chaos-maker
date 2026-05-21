// Minimal Server-Sent Events server for chaos-maker E2E tests.
// Streams `data: tick N` lines every 200 ms on /sse and a mix of named
// events (`event: tick`, `event: heartbeat`) every 200 ms on /sse-named.
// Kept as plain JS so Playwright `webServer` can `node` it directly.

const http = require('node:http');

const PORT = Number(process.env.SSE_PORT || 8082);

function writeCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function startStream(res, makeFrame, intervalMs = 200) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  // Initial flush so the client transitions to OPEN promptly.
  res.write(': stream-open\n\n');

  let i = 0;
  const interval = setInterval(() => {
    i += 1;
    try {
      res.write(makeFrame(i));
    } catch {
      clearInterval(interval);
    }
  }, intervalMs);

  res.on('close', () => clearInterval(interval));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    writeCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse the URL once so query-string-aware routes can read `?topic=`.
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (parsedUrl.pathname === '/sse' && req.method === 'GET') {
    startStream(res, (i) => `data: tick ${i}\n\n`);
    return;
  }

  if (parsedUrl.pathname === '/sse-named' && req.method === 'GET') {
    startStream(res, (i) => {
      // Alternate between a named `tick` event and the default unnamed event.
      if (i % 2 === 1) return `event: tick\ndata: ${i}\n\n`;
      return `data: heartbeat ${i}\n\n`;
    });
    return;
  }

  // Same stream contract as /sse but echoes the `?topic=` query value in each
  // frame so cross-transport matcher specs can target one topic and verify
  // another keeps flowing. Defaults to "default" when omitted.
  if (parsedUrl.pathname === '/sse-topics' && req.method === 'GET') {
    const topic = parsedUrl.searchParams.get('topic') || 'default';
    startStream(res, (i) => `data: ${topic}-${i}\n\n`);
    return;
  }

  if (parsedUrl.pathname === '/healthz') {
    writeCorsHeaders(res);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  writeCorsHeaders(res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sse] listening on http://127.0.0.1:${PORT}`);
});

const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
