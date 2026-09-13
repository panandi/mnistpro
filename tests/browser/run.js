// Serve docs/ and run every browser suite against it.
//
// Exits non-zero if any suite fails, so this works as a CI gate. The server is
// Node's own rather than `python -m http.server`: a Node test project should
// not need a second runtime just to open a port.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const SUITES = ['verify_mnistpro.js', 'verify_static.js', 'verify_ai_lane.js'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Strip the query and refuse anything climbing out of docs/.
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const target = path.normalize(path.join(DOCS, rel === '/' ? 'index.html' : rel));
      if (!target.startsWith(DOCS)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      fs.readFile(target, (err, body) => {
        if (err) {
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream' });
        res.end(body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runSuite(name, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, name)], {
      env: { ...process.env, BASE: base },
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

(async () => {
  if (!fs.existsSync(path.join(DOCS, 'index.html'))) {
    console.error(`docs/ not found at ${DOCS}`);
    process.exit(1);
  }

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`serving ${DOCS} at ${base}\n`);

  const failed = [];
  for (const name of SUITES) {
    console.log(`\n${'='.repeat(60)}\n${name}\n${'='.repeat(60)}`);
    const ok = await runSuite(name, base);
    if (!ok) failed.push(name);
  }

  server.close();
  console.log(`\n${'='.repeat(60)}`);
  if (failed.length === 0) {
    console.log(`all ${SUITES.length} suites passed`);
    process.exit(0);
  }
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
})().catch((err) => {
  console.error('runner failed:', err.message);
  process.exit(1);
});
