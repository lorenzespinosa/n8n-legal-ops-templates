// Single-writer lifecycle tests for the one-command baseline launcher
// (D-17, A-01/A-05, T-01-07).
//
//   1. While one launcher invocation owns the atomic repository-local lock,
//      a second invocation is rejected with a non-zero exit and an explicit
//      overlap message — BEFORE it can start another writer.
//   2. A TERM or INT interruption of a mid-flight launcher leaves neither a
//      completed evidence artifact nor a stale lock.
//
// These tests never run a second n8n writer and never contact the real
// Docker daemon: the launcher's `docker` boundary is controlled by a shim
// directory prepended to PATH. `docker info` blocks (simulating a mid-flight
// daemon query), `docker compose ...` succeeds instantly (so cleanup teardown
// never hangs), and anything else fails fast. Signals are delivered to the
// launcher's whole process group so the blocked boundary call dies with it —
// exactly the mechanism runtime/scripts/deadline-watchdog.mjs ships: it
// group-TERMs the launcher whenever the launcher leads its own process group
// (a detached spawn, as here, makes it one) and otherwise TERMs each live
// descendant before signaling the shell.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LAUNCHER = path.join(ROOT, 'runtime', 'run-baseline.sh');
const GENERATED_DIR = path.join(ROOT, 'runtime', '.generated');
const LOCK_DIR = path.join(GENERATED_DIR, 'launcher.lock');
const EVIDENCE_DIR = path.join(ROOT, 'runtime', 'evidence');

// Single-writer safety (WR-03/D-17): resetEphemeralState() below removes
// runtime/.generated wholesale — including a live launcher's lock and
// derived workflow. Deleting an owner's lock would allow a third writer to
// start, exactly the competing-writer scenario this project forbids, so the
// suite refuses to run while any baseline invocation owns the lock.
if (existsSync(LOCK_DIR)) {
  assert.fail(
    `a baseline run owns ${LOCK_DIR} — refusing to reset ephemeral state under a live launcher invocation (D-17 single writer, sequential execution only); rerun after the baseline completes`
  );
}

/** A `docker` boundary shim: block on `info`, fast-pass `compose`, fail else. */
function makeDockerShim() {
  const directory = mkdtempSync(path.join(tmpdir(), 'baseline-launcher-shim-'));
  const shim = path.join(directory, 'docker');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# Test boundary shim for runtime/tests/launcher-lifecycle.test.mjs.',
      '# Never contacts the real Docker daemon.',
      'case "$1" in',
      '  info) sleep 300 ;;',
      '  compose) exit 0 ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(shim, 0o755);
  return directory;
}

/**
 * Spawn the launcher with the shimmed docker boundary. The child leads its
 * own process group (detached) so a signal can take down the launcher AND
 * its blocked boundary call together — the same group-kill path the deadline
 * watchdog takes when the launcher is a process-group leader.
 */
function spawnShimmed(shim, args) {
  const child = spawn('bash', [LAUNCHER, ...args], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
  });
  child.stdout.resume();
  return child;
}

const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
};

const termGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
};

/** Wait for a condition, bounded — returns false on timeout. */
async function waitFor(predicate, timeoutMs, pollMs = 50) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return predicate();
}

function resetEphemeralState() {
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  // Never touch runtime/evidence content beyond temp siblings a launcher may
  // have half-written; committed artifacts belong to the publisher.
  if (existsSync(EVIDENCE_DIR)) {
    for (const entry of readdirSync(EVIDENCE_DIR)) {
      if (entry.startsWith('.baseline.json.tmp-')) {
        rmSync(path.join(EVIDENCE_DIR, entry), { force: true });
      }
    }
  }
}

function noStaleTempEvidence() {
  return (
    !existsSync(EVIDENCE_DIR) ||
    readdirSync(EVIDENCE_DIR).every((entry) => !entry.startsWith('.baseline.json.tmp-'))
  );
}

/**
 * Snapshot the published evidence artifact (existence, mtime, bytes). An
 * interrupted run must leave an already-published artifact exactly as it was
 * — it may neither create nor rewrite it.
 */
function snapshotEvidence() {
  const file = path.join(EVIDENCE_DIR, 'baseline.json');
  if (!existsSync(file)) return null;
  const stats = statSync(file);
  return {
    mtimeMs: stats.mtimeMs,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  };
}

const evidenceUnchanged = (before, after) =>
  (before === null && after === null) ||
  (before !== null && after !== null && before.mtimeMs === after.mtimeMs && before.sha256 === after.sha256);

test('a second launcher invocation is rejected while the first owns the atomic lock — no competing writer may start', async () => {
  const shim = makeDockerShim();
  const secondStderr = [];
  let first = null;
  let second = null;
  try {
    resetEphemeralState();
    first = spawnShimmed(shim, ['--tracer']);
    const lockAcquired = await waitFor(() => existsSync(LOCK_DIR), 10_000);
    assert.ok(
      lockAcquired,
      'the launcher must create the atomic lock runtime/.generated/launcher.lock before touching the runtime'
    );

    second = spawnShimmed(shim, ['--tracer']);
    second.stderr.on('data', (chunk) => secondStderr.push(String(chunk)));
    const [secondExit] = await Promise.race([
      once(second, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 15_000)),
    ]);
    assert.notEqual(
      secondExit,
      null,
      'the overlapping invocation must exit promptly instead of proceeding (or hanging on the daemon)'
    );
    assert.notEqual(secondExit, 0, 'an overlapping invocation must be rejected with a non-zero exit');
    const message = secondStderr.join('');
    assert.match(
      message,
      /another baseline invocation|lock/i,
      `the rejection must explain the overlap (stderr: ${message.trim()})`
    );

    // The rejected invocation must not have torn down the owner's state.
    assert.ok(existsSync(LOCK_DIR), "the rejected invocation must leave the owner's lock in place");
    assert.equal(first.exitCode, null, 'the owning invocation must still be running');
  } finally {
    if (second?.exitCode === null) killGroup(second);
    if (first?.exitCode === null) killGroup(first);
    rmSync(shim, { recursive: true, force: true });
    resetEphemeralState();
  }
});

test('a SIGTERM interruption leaves neither a completed evidence artifact nor a stale lock', async () => {
  const shim = makeDockerShim();
  let child = null;
  try {
    resetEphemeralState();
    const evidenceBefore = snapshotEvidence();
    child = spawnShimmed(shim, ['--tracer']);
    const lockAcquired = await waitFor(() => existsSync(LOCK_DIR), 10_000);
    assert.ok(lockAcquired, 'the launcher must be mid-flight holding the lock before the interruption');

    termGroup(child);
    const [exitCode] = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 15_000)),
    ]);
    assert.notEqual(exitCode, null, 'an interrupted launcher must exit promptly, not hang');
    assert.notEqual(exitCode, 0, 'an interrupted launcher must exit non-zero');

    assert.equal(existsSync(LOCK_DIR), false, 'interruption must not leave a stale lock');
    assert.ok(
      evidenceUnchanged(evidenceBefore, snapshotEvidence()),
      'an interrupted run must leave the published evidence artifact exactly as it was (created by no interrupted run, rewritten by none)'
    );
    assert.ok(noStaleTempEvidence(), 'an interrupted run must leave no temporary evidence sibling');
    assert.equal(existsSync(GENERATED_DIR), false, 'an interrupted run must clean its ephemeral directory');
  } finally {
    if (child?.exitCode === null) killGroup(child);
    rmSync(shim, { recursive: true, force: true });
    resetEphemeralState();
  }
});

test('a SIGINT interruption leaves neither a completed evidence artifact nor a stale lock', async () => {
  const shim = makeDockerShim();
  let child = null;
  try {
    resetEphemeralState();
    const evidenceBefore = snapshotEvidence();
    child = spawnShimmed(shim, ['--tracer']);
    const lockAcquired = await waitFor(() => existsSync(LOCK_DIR), 10_000);
    assert.ok(lockAcquired, 'the launcher must be mid-flight holding the lock before the interruption');

    try {
      process.kill(-child.pid, 'SIGINT');
    } catch {
      /* already gone */
    }
    const [exitCode] = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 15_000)),
    ]);
    assert.notEqual(exitCode, null, 'an interrupted launcher must exit promptly, not hang');
    assert.notEqual(exitCode, 0, 'an interrupted launcher must exit non-zero');

    assert.equal(existsSync(LOCK_DIR), false, 'interruption must not leave a stale lock');
    assert.ok(
      evidenceUnchanged(evidenceBefore, snapshotEvidence()),
      'an interrupted run must leave the published evidence artifact exactly as it was (created by no interrupted run, rewritten by none)'
    );
    assert.ok(noStaleTempEvidence(), 'an interrupted run must leave no temporary evidence sibling');
    assert.equal(existsSync(GENERATED_DIR), false, 'an interrupted run must clean its ephemeral directory');
  } finally {
    if (child?.exitCode === null) killGroup(child);
    rmSync(shim, { recursive: true, force: true });
    resetEphemeralState();
  }
});
