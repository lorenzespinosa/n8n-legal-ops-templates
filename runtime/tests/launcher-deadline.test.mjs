import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const GENERATED = path.join(ROOT, 'runtime', '.generated');
const LOCK = path.join(GENERATED, 'launcher.lock');
const EVIDENCE = path.join(ROOT, 'runtime', 'evidence', 'baseline.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function evidenceSnapshot() {
  if (!existsSync(EVIDENCE)) return null;
  return { sha: digest(readFileSync(EVIDENCE)), mtime: statSync(EVIDENCE).mtimeMs };
}

test('a blocked failure cleanup stays under the hard deadline and publishes no success', async () => {
  assert.ok(!existsSync(LOCK), 'a real baseline owns the lock; refuse concurrent deadline test');
  const prior = evidenceSnapshot();
  const directory = mkdtempSync(path.join(tmpdir(), 'baseline-deadline-shim-'));
  const marker = path.join(directory, 'cleanup-started');
  const watchdogMarker = path.join(directory, 'watchdog-started');
  const shim = path.join(directory, 'docker');
  writeFileSync(shim, [
    '#!/bin/sh',
    'if [ "$1" = "info" ]; then sleep 0.5; exit 1; fi',
    'case " $* " in',
    '  *" down "*)',
    '    printf "down" > "$SHIM_MARKER"',
    '    exec node -e "process.on(\x27SIGTERM\x27,()=>{});setInterval(()=>{},1000)"',
    '    ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  // Speed up only the watchdog child, without changing the launcher's public
  // 55-second contract. The RED implementation cancels it in EXIT cleanup
  // before the blocked fake `docker compose down` can be interrupted.
  const nodeShim = path.join(directory, 'node');
  const realNode = JSON.stringify(process.execPath);
  writeFileSync(nodeShim, [
    '#!/bin/sh',
    'if [ "$1" = "runtime/scripts/deadline-watchdog.mjs" ]; then',
    '  printf "watchdog" > "$SHIM_WATCHDOG_MARKER"',
    `  exec ${realNode} "$1" "$2" 1`,
    'fi',
    `exec ${realNode} "$@"`,
    '',
  ].join('\n'));
  chmodSync(nodeShim, 0o755);
  const child = spawn('bash', ['runtime/run-baseline.sh'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SHIM_MARKER: marker,
      SHIM_WATCHDOG_MARKER: watchdogMarker },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, timedOut: false }));
  let result;
  try {
    result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 8_000)),
    ]);
    assert.ok(existsSync(marker), 'fake Docker must prove the launcher reached blocked cleanup');
    assert.ok(existsSync(watchdogMarker), 'one-second watchdog must have started before the blocked cleanup');
    assert.equal(result.timedOut, false, 'watchdog was canceled before a blocked compose down could finish');
    assert.ok(result.signal || result.code !== 0, 'failing Docker precondition must never exit 0');
    assert.ok(!output.includes('BASELINE PASS'), 'failed teardown must never claim baseline success');
    assert.deepEqual(evidenceSnapshot(), prior, 'failed run must not overwrite accepted evidence');
  } finally {
    // The process group was created only for this test. Kill it if the RED
    // implementation leaves a stubborn fake Docker process behind.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
    if (existsSync(LOCK)) {
      const owner = readFileSync(path.join(LOCK, 'owner'), 'utf8');
      if (owner.includes(`pid=${child.pid}\n`)) rmSync(GENERATED, { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
