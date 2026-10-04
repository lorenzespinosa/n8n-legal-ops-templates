import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EVIDENCE = path.join(ROOT, 'runtime', 'evidence', 'baseline.json');
const GENERATED = path.join(ROOT, 'runtime', '.generated');
const COMPOSE_FILE = path.join(ROOT, 'runtime', 'docker-compose.yml');
const realDocker = execFileSync('/bin/sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sandboxContainers() {
  return execFileSync(realDocker, ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
    .split('\n').filter((name) => name.startsWith('flagship-intake-baseline-'));
}

test('a failed final Docker teardown cannot publish evidence or BASELINE PASS', async () => {
  assert.deepEqual(sandboxContainers(), [], 'refuse to interfere with a live baseline project');
  assert.ok(!existsSync(path.join(GENERATED, 'launcher.lock')), 'refuse to race a live baseline owner');
  const previous = readFileSync(EVIDENCE);
  const previousStat = statSync(EVIDENCE);
  const directory = mkdtempSync(path.join(tmpdir(), 'baseline-down-fault-'));
  const countFile = path.join(directory, 'down-count');
  const marker = path.join(directory, 'failed-final-down');
  const shim = path.join(directory, 'docker');
  writeFileSync(shim, [
    '#!/bin/sh',
    'case " $* " in',
    '  *" down "*)',
    '    n=0',
    '    if [ -f "$SHIM_DOWN_COUNT" ]; then IFS= read -r n < "$SHIM_DOWN_COUNT"; fi',
    '    n=$((n + 1))',
    '    printf "%s\\n" "$n" > "$SHIM_DOWN_COUNT"',
    '    if [ "$n" -eq 2 ]; then printf "fault" > "$SHIM_FAULT_MARKER"; exit 17; fi',
    '    ;;',
    'esac',
    'exec "$REAL_DOCKER" "$@"',
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  const child = spawn('bash', ['runtime/run-baseline.sh'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, REAL_DOCKER: realDocker,
      SHIM_DOWN_COUNT: countFile, SHIM_FAULT_MARKER: marker },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, timedOut: false }));
  let timeoutId;
  try {
    const result = await Promise.race([
      exited,
      new Promise((resolve) => { timeoutId = setTimeout(() => resolve({ timedOut: true }), 60_000); }),
    ]);
    assert.ok(existsSync(marker), 'the injected failure must reach the FINAL compose down, not an earlier stage');
    assert.equal(result.timedOut, false, 'launcher must remain within its 55-second bound');
    assert.ok(result.signal || result.code !== 0, 'failed teardown must exit nonzero');
    assert.equal(digest(readFileSync(EVIDENCE)), digest(previous),
      'a run whose final teardown failed must not replace the previously accepted evidence');
    assert.ok(!output.includes('BASELINE PASS'), 'failed teardown must not print a successful final verdict');
  } finally {
    clearTimeout(timeoutId);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
    // Cleanup is restricted to the unique project this test started. It never
    // touches any preexisting containers or other Compose projects.
    execFileSync(realDocker, ['compose', '-p', 'flagship-intake-baseline', '-f', COMPOSE_FILE,
      'down', '-v', '--remove-orphans'], { timeout: 30_000, stdio: 'ignore' });
    if (!readFileSync(EVIDENCE).equals(previous)) {
      writeFileSync(EVIDENCE, previous);
      utimesSync(EVIDENCE, previousStat.atime, previousStat.mtime);
    }
    if (existsSync(GENERATED)) {
      const ownerFile = path.join(GENERATED, 'launcher.lock', 'owner');
      if (existsSync(ownerFile) && readFileSync(ownerFile, 'utf8').includes(`pid=${child.pid}\n`)) {
        rmSync(GENERATED, { recursive: true, force: true });
      }
    }
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(sandboxContainers(), [], 'the isolated fault run must leave no sandbox container');
  }
});
