import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('an accepted POST with a lost response is ambiguous and must never be replayed', async () => {
  let posts = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/webhook/intake-webhook') {
      posts += 1;
      request.on('data', () => {});
      request.on('end', () => request.socket.destroy()); // accepted, but no response
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ counters: {} }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const childEnv = { ...process.env, N8N_BASE_URL: `http://127.0.0.1:${address.port}`,
    MOCK_BASE_URL: `http://127.0.0.1:${address.port}`,
    BASELINE_IMPORTED_WORKFLOW_ID: 'fictional-ambiguity-probe',
    BASELINE_SOURCE_SHA256: '0'.repeat(64) };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST_')) delete childEnv[key];
  }
  const child = spawn(process.execPath, ['--test', 'runtime/tests/baseline.e2e.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let timer;
  try {
    const result = await Promise.race([
      once(child, 'exit').then(([code, signal]) => ({ code, signal, timeout: false })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 15_000); }),
    ]);
    assert.equal(result.timeout, false, `ambiguity test timed out: ${output.slice(-500)}`);
    assert.ok(result.signal || result.code !== 0,
      `lost response must fail (code=${result.code}, signal=${result.signal}, posts=${posts}, output=${output.slice(-600)})`);
    assert.equal(posts, 1, `ambiguous delivery was replayed ${posts} times after the server accepted it`);
  } finally {
    clearTimeout(timer);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    server.close();
  }
});
