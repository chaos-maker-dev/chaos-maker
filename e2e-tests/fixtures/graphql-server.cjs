// Minimal GraphQL-shaped HTTP server for chaos-maker E2E tests.
//
// Not a real GraphQL implementation  -  just enough to round-trip the protocol
// shape Apollo / urql / relay clients use:
//   - POST /graphql   → JSON body { query, variables, operationName }
//   - GET  /graphql?query=…&operationName=… → persisted-query path
//
// The response body is a canned shape keyed by `operationName` so tests can
// assert which operation actually went through (or got chaos-failed).
// Kept as plain JS so other adapter configs can spawn it directly with `node`.

const http = require('node:http');

const PORT = Number(process.env.GRAPHQL_PORT || 8083);

const CANNED = {
  GetUser: { data: { user: { id: '1', name: 'Ada Lovelace' } } },
  GetProducts: { data: { products: [{ id: 'p1', title: 'Widget' }] } },
  SearchProducts: { data: { search: [{ id: 'p2', title: 'Gizmo' }] } },
  CreatePost: { data: { createPost: { id: 'new', ok: true } } },
};

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function respond(res, status, body) {
  corsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

// Lightweight name parser for `query Foo { … }` / `mutation Bar { … }`.
function parseOperationFromQuery(query) {
  if (typeof query !== 'string') return null;
  const m = /\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return m ? m[1] : null;
}

function pickResponse(operationName) {
  if (operationName && Object.prototype.hasOwnProperty.call(CANNED, operationName)) {
    return CANNED[operationName];
  }
  return { data: { echo: { operationName: operationName || null } } };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    corsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (url.pathname === '/healthz') {
    corsHeaders(res);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname !== '/graphql') {
    corsHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  if (req.method === 'GET') {
    // Persisted-query GET: ?operationName=…&query=…
    const opFromUrl = url.searchParams.get('operationName')
      || parseOperationFromQuery(url.searchParams.get('query'));
    respond(res, 200, pickResponse(opFromUrl));
    return;
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      respond(res, 400, { errors: [{ message: 'failed to read body' }] });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      respond(res, 400, { errors: [{ message: 'invalid JSON body' }] });
      return;
    }
    // GraphQL-over-HTTP allows batched arrays  -  first entry drives the response
    // shape so the fixture can back batched-body E2E coverage.
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const op = first && (first.operationName || parseOperationFromQuery(first.query));
    respond(res, 200, pickResponse(op));
    return;
  }

  corsHeaders(res);
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[graphql] listening on http://127.0.0.1:${PORT}`);
});

const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
