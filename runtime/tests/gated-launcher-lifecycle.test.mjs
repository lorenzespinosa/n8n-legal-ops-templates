// Lifecycle and console-contract tests for the Phase 2 full-suite gated
// launcher (plan 02-04, Task 1).
//
//   1. Single writer: while one gated invocation owns the atomic lock, a
//      second invocation is rejected non-zero BEFORE it can start another
//      writer (overlap is rejected, never serialized).
//   2. Full-suite census ordering (behavioral): the no-argument
//      repository-root command snapshots the unrelated-container census
//      (IDs + running states, irrespective of count) BEFORE the first Docker
//      mutation, and an interrupted mid-run launcher never prints PASS.
//   3. Full-suite console/source contract: per-case PASS lines carry exact
//      `CRM ATTEMPTS=` / `CRM EFFECTS=` counts, the unrelated-container
//      census is re-verified before the final FULL-SUITE PASS line, the
//      static workflow/mock contracts run from the audit container, every
//      audit `compose run` disables TTY allocation with -T, and the
//      --tracer / --case / --manual-review diagnostics are preserved.
//   4. Census helper contract: snapshot/verify accepts an identical universe
//      and fails closed on added, removed, state-changed, malformed, or
//      unavailable container censuses.
//   5. Manual-review lifecycle (REAL pinned Docker runtime): the emitted
//      token-free in-network command works while the sandbox is live — this
//      suite issues it as explicitly labeled SIMULATED reviewer input, never
//      a human review — the raw one-time proof never enters console output,
//      the proof file is permission-restricted, and the natural-action path
//      tears down every owned resource while preserving unrelated containers.
//   6. Manual-review interruption (REAL pinned Docker runtime): TERM against
//      the held sandbox triggers ownership-guarded teardown, exits non-zero,
//      prints no action-observed/PASS line, and leaves no owned residue.
//
// Tests 1-4 control the Docker boundary with PATH shims and never contact
// the real daemon. Tests 5-6 REQUIRE the real Docker daemon and the cached
// pinned n8n image — the manual-review lifecycle is a real-runtime proof and
// fails closed when the prerequisites are missing (no simulation fallback,
// project D-07 posture).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LAUNCHER = path.join(ROOT, 'runtime', 'run-gated-demo.sh');
const GATED_GENERATED_DIR = path.join(ROOT, 'runtime', 'demo', '.generated');
const GATED_LOCK_DIR = path.join(GATED_GENERATED_DIR, 'launcher.lock');
const CENSUS_SNAPSHOT = path.join(GATED_GENERATED_DIR, 'unrelated-containers.snapshot');
const CENSUS_HELPER = path.join(ROOT, 'runtime', 'scripts', 'docker-container-census.mjs');
const COMPOSE_FILE = path.join(ROOT, 'runtime', 'demo', 'docker-compose.yml');
const COMPOSE_PROJECT = 'flagship-intake-gated-demo';

// Single-writer safety: the real-Docker lifecycle tests below take the same
// atomic lock the launcher uses. Refuse to reset ephemeral state (or run)
// while any live gated invocation owns it.
if (existsSync(GATED_LOCK_DIR)) {
  assert.fail(
    `a gated-demo run owns ${GATED_LOCK_DIR} — refusing to run the launcher lifecycle suite under a live invocation (single writer, sequential execution only); rerun after it completes`
  );
}

/** Wait for a condition, bounded — returns false on timeout. */
async function waitFor(predicate, timeoutMs, pollMs = 50) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return predicate();
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

function resetGatedEphemeralState() {
  rmSync(GATED_GENERATED_DIR, { recursive: true, force: true });
}

function spawnLauncher(args, extraEnv = {}) {
  const child = spawn('bash', [LAUNCHER, ...args], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  return child;
}

/**
 * Docker boundary shim for the CR-02 pre-clean fault injection: `info` and
 * `image inspect` succeed, every read-only listing succeeds with an empty
 * universe, and EVERY `compose ... down ...` FAILS — the injected fault. All
 * other compose verbs (up/run/exec) succeed instantly and are logged, so a
 * launcher that wrongly proceeds past the failed pre-clean is observed by the
 * calls log (and fails the no-startup assertions) instead of hanging.
 */
function makePrecleanFailShim(callsLog) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gated-preclean-shim-'));
  const shim = path.join(directory, 'docker');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# Test boundary shim for runtime/tests/gated-launcher-lifecycle.test.mjs.',
      '# Never contacts the real Docker daemon.',
      `printf '%s\\n' "$*" >> '${callsLog.replace(/'/g, "'\\''")}'`,
      'case "$1" in',
      '  info|image|ps|network|volume) exit 0 ;;',
      '  compose)',
      '    case " $* " in',
      '      *" down "*) exit 1 ;;',
      '      *) exit 0 ;;',
      '    esac',
      '    ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(shim, 0o755);
  return directory;
}

/** Docker boundary shim: `info` blocks, `compose` fast-passes, else fails. */
function makeOverlapShim() {
  const directory = mkdtempSync(path.join(tmpdir(), 'gated-launcher-shim-'));
  const shim = path.join(directory, 'docker');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# Test boundary shim for runtime/tests/gated-launcher-lifecycle.test.mjs.',
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
 * Docker boundary shim for the full-suite census-ordering test: `info` and
 * `image inspect` succeed, `ps -a` reports a fixed two-container universe,
 * `compose ... down ...` succeeds instantly, and `compose ... up ...` blocks
 * so the launcher stays mid-flight after its first mutation. Every
 * invocation is logged (space-joined argv) so the test can prove the census
 * ran before the first compose mutation.
 */
function makeOrderingShim(callsLog) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gated-ordering-shim-'));
  const shim = path.join(directory, 'docker');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# Test boundary shim for runtime/tests/gated-launcher-lifecycle.test.mjs.',
      '# Never contacts the real Docker daemon.',
      `printf '%s\\n' "$*" >> '${callsLog.replace(/'/g, "'\\''")}'`,
      'case "$1" in',
      '  info) exit 0 ;;',
      '  image) exit 0 ;;',
      '  network|volume) exit 0 ;;',
      '  ps) case "$*" in',
      '    *"label=com.docker.compose.project="*) ;;',
      "    *) printf 'aaaaaaaaaaaa running\\nbbbbbbbbbbbb exited\\n' ;;",
      '  esac ;;',
      '  compose)',
      '    case " $* " in',
      '      *" down "*) exit 0 ;;',
      '      *" up "*) sleep 600 ;;',
      '      *) exit 0 ;;',
      '    esac',
      '    ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(shim, 0o755);
  return directory;
}

/** Docker boundary shim whose `ps -a` output is steerable from a file. */
function makeCensusShim(fakePsFile) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gated-census-shim-'));
  const shim = path.join(directory, 'docker');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# Test boundary shim for runtime/tests/gated-launcher-lifecycle.test.mjs.',
      '# Never contacts the real Docker daemon.',
      'case "$1" in',
      `  ps) cat '${fakePsFile.replace(/'/g, "'\\''")}' ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(shim, 0o755);
  return directory;
}

/**
 * Docker boundary shim that models label filtering: an UNFILTERED `ps -a`
 * reports the whole universe from rawFile, while a `ps -a` carrying a
 * `label=com.docker.compose.project=` filter reports only the owned-project
 * containers from ownedFile — the split the real daemon enforces.
 */
function makeOwnedFilterCensusShim(rawFile, ownedFile) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gated-census-owned-shim-'));
  const shim = path.join(directory, 'docker');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# Test boundary shim for runtime/tests/gated-launcher-lifecycle.test.mjs.',
      '# Never contacts the real Docker daemon.',
      'case "$1" in',
      '  ps) case "$*" in',
      `    *"label=com.docker.compose.project="*) cat '${ownedFile.replace(/'/g, "'\\''")}' ;;`,
      `    *) cat '${rawFile.replace(/'/g, "'\\''")}' ;;`,
      '  esac ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(shim, 0o755);
  return directory;
}

function runCensusHelper(args, pathPrepend) {
  return new Promise((resolve) => {
    const child = spawn('node', [CENSUS_HELPER, ...args], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${pathPrepend}:${process.env.PATH}` },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('exit', (code, signal) => resolve({ code, signal, stdout: stdout.join(''), stderr: stderr.join('') }));
  });
}

/** Real-daemon residue check: owned project containers/networks/volumes. */
function ownedResidue() {
  const containers = execFileSync(
    'docker',
    ['ps', '-a', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`, '--format', '{{.ID}}'],
    { encoding: 'utf8' }
  ).trim();
  const networks = execFileSync(
    'docker',
    ['network', 'ls', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`, '--format', '{{.Name}}'],
    { encoding: 'utf8' }
  ).trim();
  const volumes = execFileSync(
    'docker',
    ['volume', 'ls', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`, '--format', '{{.Name}}'],
    { encoding: 'utf8' }
  ).trim();
  return { containers, networks, volumes };
}

/** The real host container universe (ID + state), for preservation checks. */
function realContainerUniverse() {
  return execFileSync('docker', ['ps', '-a', '--format', '{{.ID}} {{.State}}'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function assertDockerDaemonAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    assert.fail(
      'the manual-review lifecycle tests require the real Docker daemon (and the cached pinned n8n image) — no simulation fallback exists for this proof'
    );
  }
}

test('a second gated invocation is rejected while the first owns the atomic lock — no competing writer may start', async () => {
  const shim = makeOverlapShim();
  const secondStderr = [];
  let first = null;
  let second = null;
  try {
    resetGatedEphemeralState();
    first = spawnLauncher(['--tracer'], { PATH: `${shim}:${process.env.PATH}` });
    first.stdout.resume();
    const lockAcquired = await waitFor(() => existsSync(GATED_LOCK_DIR), 10_000);
    assert.ok(lockAcquired, 'the launcher must create the atomic lock runtime/demo/.generated/launcher.lock before touching the runtime');

    second = spawnLauncher(['--tracer'], { PATH: `${shim}:${process.env.PATH}` });
    second.stderr.on('data', (chunk) => secondStderr.push(String(chunk)));
    second.stdout.resume();
    const [secondExit] = await Promise.race([
      once(second, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 15_000)),
    ]);
    assert.notEqual(secondExit, null, 'the overlapping invocation must exit promptly instead of proceeding (or hanging on the daemon)');
    assert.notEqual(secondExit, 0, 'an overlapping invocation must be rejected with a non-zero exit');
    const message = secondStderr.join('');
    assert.match(
      message,
      /another gated-demo invocation|lock/i,
      `the rejection must explain the overlap before any Docker mutation (stderr: ${message.trim()})`
    );

    assert.ok(existsSync(GATED_LOCK_DIR), "the rejected invocation must leave the owner's lock in place");
    assert.equal(first.exitCode, null, 'the owning invocation must still be running');
  } finally {
    if (second?.exitCode === null) killGroup(second);
    if (first?.exitCode === null) killGroup(first);
    rmSync(shim, { recursive: true, force: true });
    resetGatedEphemeralState();
  }
});

test('a rejected overlapping invocation mutates nothing in the ephemeral tree before the lock check', async () => {
  try {
    resetGatedEphemeralState();
    // A live foreign owner: the lock records THIS test process's PID, so the
    // launcher must take the "another invocation owns it" rejection — which
    // happens before any Docker contact.
    mkdirSync(GATED_LOCK_DIR, { recursive: true });
    writeFileSync(path.join(GATED_LOCK_DIR, 'owner'), `pid=${process.pid}\nhost=${hostname()}\n`);
    assert.ok(!existsSync(path.join(GATED_GENERATED_DIR, 'import')), 'precondition: no import directory before the rejected invocation');

    const rejected = spawnSync('bash', [LAUNCHER, '--tracer'], { encoding: 'utf8', cwd: ROOT, timeout: 60_000 });
    assert.notEqual(rejected.status, 0, 'the invocation must be rejected non-zero while a live owner holds the lock');
    assert.match(
      rejected.stderr,
      /another gated-demo invocation owns/i,
      `the rejection must name the live owner (stderr: ${rejected.stderr.trim().slice(0, 300)})`
    );
    assert.ok(
      !existsSync(path.join(GATED_GENERATED_DIR, 'import')),
      'the rejected invocation must not create runtime/demo/.generated/import — a rejected writer touches nothing'
    );
    assert.ok(existsSync(GATED_LOCK_DIR), 'the rejected invocation must leave the real owner\'s lock in place');
  } finally {
    resetGatedEphemeralState();
  }
});

test('full-suite no-argument run snapshots the unrelated-container census before any Docker mutation and never prints PASS when interrupted', async () => {
  const callsLog = path.join(mkdtempSync(path.join(tmpdir(), 'gated-calls-')), 'calls.log');
  const shim = makeOrderingShim(callsLog);
  const output = [];
  let child = null;
  try {
    resetGatedEphemeralState();
    child = spawnLauncher([], { PATH: `${shim}:${process.env.PATH}` });
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));

    const snapshotted = await waitFor(() => existsSync(CENSUS_SNAPSHOT), 20_000);
    assert.ok(
      snapshotted,
      'the no-argument invocation must be the full-suite acceptance path: it must snapshot the unrelated-container census at runtime/demo/.generated/unrelated-containers.snapshot before any Docker mutation (a usage rejection proves the full-suite mode is missing)'
    );

    const recorded = JSON.parse(readFileSync(CENSUS_SNAPSHOT, 'utf8'));
    assert.deepEqual(
      [...recorded.entries].sort(),
      [
        ['aaaaaaaaaaaa', 'running'],
        ['bbbbbbbbbbbb', 'exited'],
      ],
      'the census snapshot must record every unrelated container ID and running state present at run start, irrespective of count'
    );

    // Wait until the fake `compose up` boundary is actually entered (it sleeps),
    // so the launcher is definitively mid-flight past its first mutations.
    const readCalls = () =>
      readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter(Boolean);
    const mutationStarted = await waitFor(
      () => readCalls().some((line) => line.startsWith('compose') && line.includes(' up ')),
      15_000
    );
    assert.ok(mutationStarted, 'the full-suite launcher must proceed into its Compose mutations after the census');
    assert.equal(child.exitCode, null, 'the launcher must still be mid-flight (blocked on the fake compose up), not exited early');

    const calls = readCalls();
    const psIndex = calls.findIndex((line) => line.startsWith('ps -a'));
    const composeIndex = calls.findIndex((line) => line.startsWith('compose'));
    assert.ok(psIndex !== -1, 'the census (docker ps -a) must have run');
    assert.ok(composeIndex !== -1, 'a compose mutation must have started while the launcher is mid-flight');
    assert.ok(psIndex < composeIndex, 'the unrelated-container census must be captured BEFORE the first compose mutation');

    termGroup(child);
    const [exitCode] = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 30_000)),
    ]);
    assert.notEqual(exitCode, null, 'an interrupted full-suite launcher must exit promptly, not hang');
    assert.notEqual(exitCode, 0, 'an interrupted full-suite launcher must exit non-zero');

    const text = output.join('');
    // An interrupted run must never emit a success-claim line. The claim
    // vocabulary is the launcher's own PASS/action-observed markers — prose
    // that merely mentions verification is not a claim.
    const claimPatterns = [
      /\bCASE PASS\b/,
      /\bTRACER PASS\b/,
      /\bREVIEWER-GATE PASS\b/,
      /\bAPPROVAL-DELIVERY PASS\b/,
      /\bINTAKE-IDEMPOTENCY PASS\b/,
      /\bCRM-RECOVERY PASS\b/,
      /\bSTATIC CONTRACTS PASS\b/,
      /\bFULL-SUITE PASS\b/,
      /MANUAL REVIEW ACTION OBSERVED/,
    ];
    for (const pattern of claimPatterns) {
      assert.ok(
        !pattern.test(text),
        `an interrupted full-suite run must never print a success claim (matched ${pattern}; output: ${text.trim().slice(0, 400)})`
      );
    }
    assert.equal(existsSync(GATED_GENERATED_DIR), false, 'interruption must clean the ephemeral directory (lock, census snapshot, and nonce included)');
  } finally {
    if (child?.exitCode === null) killGroup(child);
    rmSync(shim, { recursive: true, force: true });
    rmSync(path.dirname(callsLog), { recursive: true, force: true });
    resetGatedEphemeralState();
  }
});

test('CR-02: a failed pre-run Compose teardown fails closed before startup — non-zero exit, no success claim, no sandbox mutation, no import', () => {
  const callsLog = path.join(mkdtempSync(path.join(tmpdir(), 'gated-preclean-')), 'calls.log');
  const shim = makePrecleanFailShim(callsLog);
  try {
    resetGatedEphemeralState();
    const run = spawnSync('bash', [LAUNCHER], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 90_000,
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
    });
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const calls = readFileSync(callsLog, 'utf8').split('\n').filter(Boolean);

    assert.ok(
      calls.some((line) => line.startsWith('compose') && line.includes(' down ')),
      `the fault-injected pre-run compose down must have been attempted (calls: ${calls.join(' | ')})`
    );
    assert.notEqual(
      run.status,
      0,
      'a failed pre-run Compose teardown must exit non-zero — the launcher may never proceed to import/startup over state it failed to clean (no success may be claimed over residue)'
    );
    for (const pattern of [
      /\bCASE PASS\b/,
      /\bTRACER PASS\b/,
      /\bREVIEWER-GATE PASS\b/,
      /\bAPPROVAL-DELIVERY PASS\b/,
      /\bINTAKE-IDEMPOTENCY PASS\b/,
      /\bCRM-RECOVERY PASS\b/,
      /\bSTATIC CONTRACTS PASS\b/,
      /\bFULL-SUITE PASS\b/,
      /MANUAL REVIEW ACTION OBSERVED/,
    ]) {
      assert.ok(
        !pattern.test(text),
        `no success claim may be printed after a failed pre-clean (matched ${pattern}; output: ${text.trim().slice(0, 400)})`
      );
    }
    assert.ok(
      !calls.some((line) => line.startsWith('compose') && / (up|run|exec|create|start) /.test(line)),
      `the launcher must not create, start, import into, or exec against the sandbox after a failed pre-clean (calls: ${calls.join(' | ')})`
    );
    assert.match(
      text,
      /pre-run Compose teardown failed/i,
      `the failure must name the failed pre-run teardown itself (the first fail-closed gate), not a later symptom (output: ${text.trim().slice(0, 400)})`
    );
    assert.equal(
      existsSync(path.join(GATED_GENERATED_DIR, 'import')),
      false,
      'no import files may be generated after a failed pre-clean'
    );
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(path.dirname(callsLog), { recursive: true, force: true });
    resetGatedEphemeralState();
  }
});

/**
 * WR-08: a Compose teardown that returns success while leaving a STOPPED
 * owned container behind must refuse the teardown's success. The single
 * shared teardown_runtime() is extracted verbatim from the launcher source
 * and executed under a Docker boundary shim whose running-only `ps` view
 * hides the stopped container (the original defect) while `ps -a` reveals
 * it — exactly the split the real daemon enforces.
 */
test('WR-08: a stopped owned container left behind by a "successful" teardown refuses the teardown claim', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  const definition = /^teardown_runtime\(\) \{[\s\S]*?^\}/m.exec(source);
  assert.ok(definition, 'the launcher must define the single shared teardown_runtime()');

  // The final teardown must inspect ALL owned containers including stopped
  // ones (docker ps -a, exact project label), and must keep the network,
  // volume, and unrelated-census checks.
  assert.match(
    definition[0],
    /docker ps -a --filter "label=com\.docker\.compose\.project=\$COMPOSE_PROJECT"/,
    'the final container teardown check must use docker ps -a (stopped owned containers are residue too)'
  );
  assert.match(definition[0], /docker network ls --filter "label=com\.docker\.compose\.project=\$COMPOSE_PROJECT"/, 'the network teardown check must be retained');
  assert.match(definition[0], /docker volume ls --filter "label=com\.docker\.compose\.project=\$COMPOSE_PROJECT"/, 'the volume teardown check must be retained');
  assert.match(definition[0], /docker-container-census\.mjs verify "\$CENSUS_FILE" "\$COMPOSE_PROJECT"/, 'the unrelated-container census verification must be retained');

  const runExtractedTeardown = (stoppedOwnedVisibleToPsA) => {
    const shimDir = mkdtempSync(path.join(tmpdir(), 'gated-wr08-shim-'));
    const docker = path.join(shimDir, 'docker');
    writeFileSync(
      docker,
      [
        '#!/bin/sh',
        '# Test boundary shim for runtime/tests/gated-launcher-lifecycle.test.mjs.',
        '# Never contacts the real Docker daemon.',
        'case "$1" in',
        '  ps)',
        '    case " $* " in',
        `      *" -a "*) case "$*" in *label=com.docker.compose.project=*) ${stoppedOwnedVisibleToPsA ? "printf 'cccccccccccc\\n'" : ':'} ;; esac ;;`,
        '    esac',
        '    ;;',
        '  ps) ;;', // running-only view: the stopped owned container is invisible (the defect)
        '  network|volume) ;;',
        '  *) exit 1 ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n')
    );
    chmodSync(docker, 0o755);
    // Fake `node`: the census verify/count calls succeed without touching Docker.
    const nodeShim = path.join(shimDir, 'node');
    writeFileSync(nodeShim, '#!/bin/sh\nexit 0\n');
    chmodSync(nodeShim, 0o755);

    const scratch = mkdtempSync(path.join(tmpdir(), 'gated-wr08-scratch-'));
    const script = [
      'set -u',
      `COMPOSE_PROJECT=${JSON.stringify(COMPOSE_PROJECT)}`,
      `GENERATED_DIR=${JSON.stringify(scratch)}`,
      `CENSUS_FILE=${JSON.stringify(path.join(scratch, 'census'))}`,
      'UNRELATED_COUNT=1',
      'CENSUS_VERIFY_FAILED=0',
      'TEARDOWN_DONE=0',
      'OWNS_LOCK=1',
      'compose() { return 0; }',
      // WR-07's persistence check is stubbed out: this test targets the
      // owned-container teardown check specifically (it has its own contract).
      'assert_no_proof_persisted() { :; }',
      'fail() { printf "TEARDOWN-FAIL: %s\\n" "$*" >&2; exit 1; }',
      'log() { printf "[gated] %s\\n" "$*"; }',
      definition[0],
      'teardown_runtime',
      'echo "TEARDOWN-COMPLETED-OK"',
      '',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    return result;
  };

  // Residue present: the stopped owned container must refuse the teardown.
  const residue = runExtractedTeardown(true);
  assert.notEqual(
    residue.status,
    0,
    `a stopped owned container surviving a "successful" compose down must refuse the teardown claim (output: ${residue.stdout} ${residue.stderr})`
  );
  assert.match(
    residue.stderr,
    /project containers, networks, or volumes remain/i,
    `the refusal must name the remaining owned project resources (stderr: ${residue.stderr})`
  );

  // Clean control: with no owned residue of any kind, the same teardown
  // completes — the check is not a vacuous failure.
  const clean = runExtractedTeardown(false);
  assert.equal(clean.status, 0, `a fully clean owned teardown must complete (stderr: ${clean.stderr})`);
  assert.match(clean.stdout, /unrelated containers preserved/, 'the clean control must still run the census preservation reporting');
});

test('WR-08: a failed final teardown cannot leave full-suite PASS lines in output', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  const finalTeardown = source.indexOf('\nteardown_runtime\n', source.indexOf('fi # end of the single-case/tracer branch'));
  const finalProof = source.indexOf('# --- 10. final proof', finalTeardown);
  assert.ok(finalTeardown > 0 && finalProof > finalTeardown, 'the full launcher needs a teardown and post-teardown proof gate');
  assert.doesNotMatch(
    source.slice(0, finalProof),
    /^\s*log "(?:STATIC CONTRACTS PASS|CASE PASS)/m,
    'a stopped owned container must abort teardown before ANY static or per-case PASS line is printed'
  );
  assert.match(source.slice(finalProof), /STATIC CONTRACTS PASS/, 'a successful teardown must still publish the static contract result');
  assert.match(source.slice(finalProof), /CASE_PASS_LINES/, 'a successful teardown must still publish all five counted case results');
});

test('WR-06: each outer demo-state reset is followed by a freshly generated proof for that case', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  const readme = readFileSync(path.join(ROOT, 'runtime', 'README.md'), 'utf8');
  assert.match(readme, /same raw proof can be re-registered after an admin reset/i,
    'operator docs must disclose per-window one-time scope rather than claim durable uniqueness');

  const definitions = source.match(/^issue_reviewer_proof\(\) \{$/gm) ?? [];
  assert.equal(definitions.length, 1, 'the launcher must define issue_reviewer_proof exactly once');

  const resetDefinitions = source.match(/^reset_demo_state\(\) \{$/gm) ?? [];
  assert.equal(resetDefinitions.length, 1, 'the launcher must define the shared reset_demo_state exactly once');

  // The issuance must generate a fresh cryptographically random proof and
  // register it hash-only over stdin (never a command-line value).
  const issueDefinition = /issue_reviewer_proof\(\) \{[\s\S]*?^\}/m.exec(source)?.[0] ?? '';
  assert.match(issueDefinition, /randomBytes\(32\)/, 'each issuance must generate a fresh cryptographically random proof');
  assert.match(issueDefinition, /printf '%s' "\$proof" \| compose exec -T mock-api/, 'the raw proof must reach the mock over stdin, never a command line');
  assert.match(issueDefinition, /chmod 600 "\$GENERATED_DIR\/reviewer-proof"/, 'the staged proof file must stay permission-restricted');

  // Every mode branch resets through the shared helper, and every reset call
  // site is immediately followed by a fresh issuance (a reset invalidates the
  // previous registration).
  const lines = source.split('\n');
  const callSites = [];
  lines.forEach((line, index) => {
    if (/^\s*reset_demo_state( \|\|)?$/.test(line)) callSites.push(index);
  });
  assert.equal(
    callSites.length,
    3,
    `all three mode paths (manual-review hold, full matrix per case, single-case) must reset through reset_demo_state (found ${callSites.length} call sites)`
  );
  for (const index of callSites) {
    const following = lines.slice(index + 1, index + 6).join('\n');
    assert.match(
      following,
      /^\s*issue_reviewer_proof$/m,
      `each reset (line ${index + 1}) must be immediately followed by a fresh issue_reviewer_proof call — a reset invalidates the previous proof registration`
    );
  }
});

test('WR-09: internal mock storage is not misdescribed as memory-only', () => {
  const mock = readFileSync(path.join(ROOT, 'runtime', 'demo', 'mocks', 'server.mjs'), 'utf8');
  const buyer = readFileSync(path.join(ROOT, 'docs', 'case-study.md'), 'utf8');
  const contract = readFileSync(path.join(ROOT, 'runtime', 'tests', 'gated-mock-contracts.test.mjs'), 'utf8');
  assert.match(mock, /demo-state volume contains raw fictional intake payloads/,
    'the internal persisted mock state must be disclosed separately from the sanitized admin response');
  assert.doesNotMatch(mock, /raw keys live only in the\s+in-memory state|payload remain solely in the in-memory state/i);
  assert.match(buyer, /demo-state volume holds raw fictional intake payloads/,
    'the public case study must disclose disk-backed fictional mock state without relying on private planning notes');
  assert.doesNotMatch(buyer, /raw keys remain ONLY in the in-memory|payload only in the isolated in-memory/i);
  assert.match(contract, /this in-process, no-state-file test instance/,
    'the in-memory-only contract comment must be scoped to its non-persistent in-process fixture');
  assert.doesNotMatch(contract, /full\s+fictional payload lives ONLY in the isolated in-memory delivery store/i);
});

test('public docs scope the accepted reset-proof and disk-backed mock risks without private planning files', () => {
  const readme = readFileSync(path.join(ROOT, 'runtime', 'README.md'), 'utf8');
  const buyer = readFileSync(path.join(ROOT, 'docs', 'case-study.md'), 'utf8');
  assert.match(readme, /same raw proof can be re-registered after an admin reset/i,
    'the public runtime guide must disclose the accepted across-reset replay limitation');
  assert.match(buyer, /demo-state volume holds raw fictional intake payloads/i,
    'the public case study must disclose the mock volume contents, distinct from sanitized admin output');
  assert.match(buyer, /host proof files are disk-backed until normal teardown/i,
    'the public case study must distinguish disk-backed host files from tmpfs-backed n8n state');
  assert.doesNotMatch(buyer, /No accepted risks\.|A failed run NEVER emits PASS|ephemeral runtime-only/,
    'public buyer copy must not make broader claims than the measured local sandbox permits');
});

test('WR-07: n8n execution state is memory-backed and saving is disabled — no n8n disk copy of the proof', () => {
  const compose = readFileSync(COMPOSE_FILE, 'utf8');

  // The whole n8n state directory is a tmpfs mount: the SQLite database, WAL
  // sidecars, and every other n8n file live in memory and die with the
  // container. (Measured on pinned 2.37.10: the token DOES reach the live
  // database via the unconditional in-flight execution write — memory-backing
  // is what keeps it off disk.)
  assert.match(compose, /type: tmpfs/, 'the n8n state directory must be tmpfs-mounted — in-flight execution data containing the proof must never touch disk');
  assert.match(compose, /target: \/home\/node\/\.n8n/, 'the tmpfs mount must cover the whole n8n state directory');
  assert.ok(!/\bn8n-data\b/.test(compose), 'no n8n-data volume may exist — disk persistence for n8n state must be structurally impossible');

  // Execution-data saving stays disabled as defense in depth (finalization
  // semantics), exactly as the finding prescribed.
  for (const pin of [
    'EXECUTIONS_DATA_SAVE_ON_SUCCESS: "none"',
    'EXECUTIONS_DATA_SAVE_ON_ERROR: "none"',
    'EXECUTIONS_DATA_SAVE_ON_PROGRESS: "false"',
    'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: "false"',
  ]) {
    assert.ok(compose.includes(pin), `runtime/demo/docker-compose.yml must pin ${pin} on the n8n service — saved execution payloads would retain the one-time reviewer proof`);
  }

  // The service entrypoint must import and activate the gated workflows
  // before the server boots (the tmpfs state is per-container, so the old
  // shared-volume one-off setup container pattern can no longer be used).
  assert.match(compose, /n8n import:workflow --input=\/import\/intake-stage\.import\.json/, 'the n8n entrypoint must import the gated intake workflow');
  assert.match(compose, /n8n import:workflow --input=\/import\/reviewer-decision\.import\.json/, 'the n8n entrypoint must import the reviewer workflow');
  assert.match(compose, /n8n import:workflow --input=\/import\/approved-delivery\.import\.json/, 'the n8n entrypoint must import the delivery workflow');
  assert.match(compose, /n8n update:workflow .*--active=true/, 'the n8n entrypoint must activate the gated workflows before the server starts');
  assert.match(compose, /exec n8n start/, 'the entrypoint must hand over to the stock n8n start so signal handling is preserved');

  const source = readFileSync(LAUNCHER, 'utf8');
  const definitions = source.match(/^assert_no_proof_persisted\(\) \{$/gm) ?? [];
  assert.equal(definitions.length, 1, 'the launcher must define assert_no_proof_persisted exactly once');

  const teardownDefinition = /^teardown_runtime\(\) \{[\s\S]*?^\}/m.exec(source)?.[0] ?? '';
  assert.match(
    teardownDefinition,
    /^\s*assert_no_proof_persisted$/m,
    'the shared teardown must run the proof-persistence assertion BEFORE anything else — the compose down below destroys the evidence'
  );
  const assertIndex = teardownDefinition.indexOf('assert_no_proof_persisted\n');
  const downIndex = teardownDefinition.indexOf('compose down -v --remove-orphans');
  assert.ok(assertIndex !== -1 && downIndex !== -1 && assertIndex < downIndex, 'the persistence check must precede the teardown compose down');

  // The check body is the source between its definition and the teardown
  // definition that follows it. It must: byte-search the captured container
  // logs for every issued token via the 0600 issued-proofs log (file
  // transport only), assert the tmpfs backing from inside the container, and
  // assert no n8n-data volume exists — never interpolating a raw token.
  const checkStart = source.indexOf('assert_no_proof_persisted() {');
  const teardownStart = source.indexOf('teardown_runtime() {');
  assert.ok(checkStart !== -1 && teardownStart !== -1 && checkStart < teardownStart, 'assert_no_proof_persisted must be defined before teardown_runtime');
  const checkDefinition = source.slice(checkStart, teardownStart);
  assert.match(checkDefinition, /node - "\$GENERATED_DIR\/issued-proofs" "\$GENERATED_DIR\/n8n-container\.log"/, 'the log search must read the issued proofs from the 0600 log file, never from a command line');
  assert.match(checkDefinition, /logs\.includes\(Buffer\.from\(token/, 'the log search must byte-search for every issued token');
  assert.match(checkDefinition, /statfsSync\("\/home\/node\/\.n8n"\)/, 'the check must assert the n8n state directory is memory-backed via statfs from inside the container');
  assert.match(checkDefinition, /TMPFS_MAGIC/, 'the statfs type must be compared against the tmpfs magic constant');
  assert.match(checkDefinition, /docker volume ls --filter "label=com\.docker\.compose\.project=\$COMPOSE_PROJECT"/, 'the check must assert no owned n8n-data volume exists');
  assert.doesNotMatch(
    checkDefinition,
    /\$\{?proof\}?|\$\{?REVIEWER_PROOF\}?/,
    'the check body must never interpolate a raw proof value into a command line'
  );

  // The live-server assertions that replaced the one-off setup container must
  // keep the exact version pin and the imported-id guarantees.
  assert.match(source, /require\("\/usr\/local\/lib\/node_modules\/n8n\/package\.json"\)/, 'the launcher must assert the exact n8n version from the live server');
  assert.match(source, /SELECT id, active FROM workflow_entity/, 'the launcher must assert the imported ACTIVE workflow ids against the live server database');
});

test('WR-07 claim scope distinguishes disk-backed host proofs from memory-backed n8n state', () => {
  const readme = readFileSync(path.join(ROOT, 'runtime', 'README.md'), 'utf8');
  const compose = readFileSync(COMPOSE_FILE, 'utf8');
  const launcher = readFileSync(LAUNCHER, 'utf8');
  assert.match(readme, /disk-backed 0600 host proof files/, 'the operator docs must disclose where the raw proof actually lives during a run');
  assert.match(readme, /hard kill can leave those files/, 'the operator docs must disclose the stale-proof recovery boundary');
  assert.match(compose, /demo-state volume contains raw fictional intake payloads/, 'the Compose description must not claim the mock volume is PII-free');
  assert.match(launcher, /disk-backed 0600 host proof files/, 'the launcher must distinguish host proof storage from the n8n tmpfs guarantee');
  assert.doesNotMatch(readme, /one-time reviewer proof never persists to disk/i, 'the host proof file makes a global never-on-disk claim false');
  assert.doesNotMatch(launcher, /NO issued token persists to DISK|nothing can survive the sandbox on disk/, 'the launcher must not make a global never-on-disk claim');
});

test('full-suite console contract: per-case PASS lines with exact CRM counts, census verify before final PASS, static contracts, -T, preserved diagnostics', () => {
  const source = readFileSync(LAUNCHER, 'utf8');

  assert.match(source, /MODE="full"/, 'the no-argument invocation must select a distinct full-suite mode');
  assert.match(source, /"\$#" -eq 0/, 'the argument parser must accept the bare no-argument repository-root command as the complete acceptance path');
  assert.match(
    source,
    /FULL_CASES="tracer reviewer-gate approval-delivery intake-idempotency crm-recovery"/,
    'the full-suite matrix must run all five case groups (covering valid staged→simulated-reviewer approval, invalid, duplicate/replay, rejected, CRM failure→retry, urgent-unapproved, conflicting key, and missing/wrong/replayed reviewer proof)'
  );

  const casePassIndex = source.indexOf('CASE PASS');
  assert.ok(casePassIndex !== -1, 'the full-suite launcher must print one unambiguous per-case PASS/FAIL line for every case group');
  const casePassRegion = source.slice(casePassIndex, casePassIndex + 800);
  assert.match(casePassRegion, /CRM ATTEMPTS=/, 'each per-case PASS line must carry the exact CRM ATTEMPTS count');
  assert.match(casePassRegion, /CRM EFFECTS=/, 'each per-case PASS line must carry the exact CRM EFFECTS count');

  assert.match(
    source,
    /gated-workflows\.test\.mjs/,
    'the full suite must run the static workflow structural contracts from the audit container'
  );
  assert.match(
    source,
    /gated-mock-contracts\.test\.mjs/,
    'the full suite must run the static mock contracts from the audit container'
  );

  const verifyIndex = source.indexOf('docker-container-census.mjs verify');
  const fullPassIndex = source.indexOf('log "FULL-SUITE PASS');
  assert.ok(verifyIndex !== -1, 'the launcher must re-verify the unrelated-container census through the census helper');
  assert.ok(fullPassIndex !== -1, 'the launcher must print a single final FULL-SUITE PASS line');
  assert.ok(
    verifyIndex < fullPassIndex,
    'the unrelated-container census must be re-verified BEFORE the final FULL-SUITE PASS line can print'
  );

  const snapshotIndex = source.indexOf('docker-container-census.mjs snapshot');
  const firstTeardownMutation = source.indexOf('pre-run Compose teardown failed');
  const firstCreateMutation = source.indexOf('compose up -d mock-api');
  assert.ok(snapshotIndex !== -1, 'the launcher must snapshot the unrelated-container census through the census helper');
  assert.ok(firstTeardownMutation !== -1 && snapshotIndex < firstTeardownMutation, 'the census snapshot must be captured before the pre-run Compose teardown mutation');
  assert.ok(firstCreateMutation !== -1 && snapshotIndex < firstCreateMutation, 'the census snapshot must be captured before the first Compose creation mutation');
  assert.doesNotMatch(
    source,
    /compose down[^\n]*\|\| true/,
    'no Compose teardown result may ever be swallowed with `|| true` — a failed pre-clean or final teardown must fail closed (CR-02)'
  );

  assert.doesNotMatch(
    source,
    /compose run --rm(?! -T)/,
    'every audit-container compose run must disable TTY allocation with -T so counted output cannot be CRLF-corrupted'
  );

  assert.match(source, /--manual-review/, 'the foreground manual-review lifecycle must be preserved');
  assert.match(source, /--tracer/, 'the tracer diagnostic mode must be preserved');
  assert.match(source, /--case/, 'the single-case diagnostic modes must be preserved');
});

test('manual-review completion gate: only an explicit approved/rejected decision may complete the hold — missing or corrupted states fail closed', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  const definition = /^assert_manual_decision_state\(\) \{[\s\S]*?^\}/m.exec(source);
  assert.ok(
    definition,
    'the launcher must define assert_manual_decision_state() — the manual-review wait loop may complete ONLY on an explicit reviewer decision state (never "not pending")'
  );
  assert.match(
    source,
    /assert_manual_decision_state "\$MANUAL_DECISION_STATE"/,
    'the manual-review path must gate its completion through assert_manual_decision_state'
  );

  const runGate = (state) =>
    spawnSync(
      'bash',
      [
        '-c',
        `fail() { printf 'GATE-FAIL: %s\\n' "$*" >&2; exit 1; };\n${definition[0]}\nassert_manual_decision_state "$1"\n`,
        'gate',
        state,
      ],
      { encoding: 'utf8' }
    );

  for (const decision of ['approved', 'rejected']) {
    const result = runGate(decision);
    assert.equal(result.status, 0, `a genuine ${decision} decision must complete the hold (stderr: ${result.stderr})`);
  }
  for (const nonDecision of ['missing', 'corrupted-malformed', 'waiting', 'pending', 'poll-error', '']) {
    const result = runGate(nonDecision);
    assert.notEqual(
      result.status,
      0,
      `a non-decision state (${nonDecision || 'empty'}) must fail closed — the launcher must never claim a human action was observed for it`
    );
    assert.match(
      result.stderr,
      /no reviewer action was observed/,
      `the failure must state that no reviewer action was observed (state: ${nonDecision || 'empty'}, stderr: ${result.stderr})`
    );
  }
});

test('census helper: snapshot/verify accepts an identical universe and fails closed on added, removed, state-changed, malformed, or unavailable censuses', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gated-census-helper-'));
  const fakePs = path.join(scratch, 'ps.txt');
  const snapshotFile = path.join(scratch, 'snapshot.json');
  const writeUniverse = (lines) => writeFileSync(fakePs, `${lines.join('\n')}\n`);
  try {
    writeUniverse(['cccccccccccc running', 'dddddddddddd exited']);
    const snap = await runCensusHelper(['snapshot', snapshotFile], makeCensusShim(fakePs));
    assert.equal(snap.code, 0, `snapshot must succeed against a well-formed container universe (stderr: ${snap.stderr})`);
    assert.equal(snap.stdout.trim(), '2', 'snapshot must report the captured container count');

    // Identical universe: verify passes.
    const identical = await runCensusHelper(['verify', snapshotFile], makeCensusShim(fakePs));
    assert.equal(identical.code, 0, `an identical universe must verify (stderr: ${identical.stderr})`);

    // Added container: fail closed.
    writeUniverse(['cccccccccccc running', 'dddddddddddd exited', 'eeeeeeeeeeee running']);
    const added = await runCensusHelper(['verify', snapshotFile], makeCensusShim(fakePs));
    assert.notEqual(added.code, 0, 'a container that appeared after run start must fail the census verification');
    assert.match(added.stderr, /eeeeeeeeeeee/, 'the mismatch report must name the added container');

    // Removed container: fail closed.
    writeUniverse(['cccccccccccc running']);
    const removed = await runCensusHelper(['verify', snapshotFile], makeCensusShim(fakePs));
    assert.notEqual(removed.code, 0, 'a container that disappeared after run start must fail the census verification');
    assert.match(removed.stderr, /dddddddddddd/, 'the mismatch report must name the removed container');

    // State change on an existing container: fail closed.
    writeUniverse(['cccccccccccc running', 'dddddddddddd running']);
    const changed = await runCensusHelper(['verify', snapshotFile], makeCensusShim(fakePs));
    assert.notEqual(changed.code, 0, 'a container whose running state changed after run start must fail the census verification');
    assert.match(changed.stderr, /dddddddddddd/, 'the mismatch report must name the state-changed container');

    // Malformed census output: fail closed, never a silent pass.
    writeUniverse(['this is not a container census line']);
    const malformed = await runCensusHelper(['verify', snapshotFile], makeCensusShim(fakePs));
    assert.notEqual(malformed.code, 0, 'malformed docker ps output must fail closed, never verify by exception');

    // Unavailable docker boundary: fail closed.
    const failingDir = mkdtempSync(path.join(tmpdir(), 'gated-census-fail-'));
    const failingDocker = path.join(failingDir, 'docker');
    writeFileSync(failingDocker, '#!/bin/sh\nexit 1\n');
    chmodSync(failingDocker, 0o755);
    const unavailable = await runCensusHelper(['verify', snapshotFile], failingDir);
    assert.notEqual(unavailable.code, 0, 'an unavailable Docker boundary must fail the census verification (uncertainty blocks)');

    const counted = await runCensusHelper(['count', snapshotFile], makeCensusShim(fakePs));
    assert.equal(counted.code, 0, `count must read the recorded census without contacting Docker (stderr: ${counted.stderr})`);
    assert.equal(counted.stdout.trim(), '2', 'count must report the number of unrelated containers captured at run start');
    rmSync(failingDir, { recursive: true, force: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('reviewer proof transport: automated audit runs read the one-time proof from the ephemeral file, never a compose-run command line', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  assert.doesNotMatch(
    source,
    /-e "GATED_REVIEWER_PROOF=\$REVIEWER_PROOF"/,
    'the raw one-time proof must never travel as a docker compose run argv element (visible in host ps and docker inspect env) — stdin/file only'
  );
  const fileEnv = source.match(/GATED_REVIEWER_PROOF_FILE=\/ephemeral\/reviewer-proof/g) ?? [];
  assert.equal(
    fileEnv.length,
    2,
    'both the full-matrix and the single-case audit runs must pass GATED_REVIEWER_PROOF_FILE pointing at the read-only ephemeral mount'
  );
  const rootedAuditRuns = source.match(/compose run --rm -T -u 0:0 \\\n\s*-e N8N_BASE_URL=http:\/\/n8n:5678/g) ?? [];
  assert.equal(
    rootedAuditRuns.length,
    2,
    'both e2e audit compose runs must execute as 0:0 so the 0600 host-owned proof file is readable through the bind mount on strict-permission hosts'
  );
});

test('failed census verification preserves forensic evidence instead of destroying it in cleanup', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  const flaggedVerify =
    /if ! node runtime\/scripts\/docker-container-census\.mjs verify "\$CENSUS_FILE" "\$COMPOSE_PROJECT"; then\n\s*CENSUS_VERIFY_FAILED=1/g;
  const flagCount = source.match(flaggedVerify)?.length ?? 0;
  assert.equal(
    flagCount,
    1,
    'the single shared teardown path must record census verification failure (CENSUS_VERIFY_FAILED=1) before failing closed'
  );
  const preserveIndex = source.indexOf('census verification failed — preserving forensic evidence');
  const cleanupRmIndex = source.indexOf('if ! rm -rf "$GENERATED_DIR"; then rc=1; fi');
  assert.ok(preserveIndex !== -1, 'cleanup must preserve the census snapshot as forensic evidence when verification failed');
  assert.ok(
    cleanupRmIndex !== -1 && preserveIndex < cleanupRmIndex,
    'the forensic preservation must run BEFORE the ephemeral tree (including the recorded snapshot) is removed'
  );
});

test('teardown_runtime is defined exactly once, above both mode branches, so the manual-review path cannot fork the teardown guarantee', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  const definitions = source.match(/^[ \t]*teardown_runtime\(\) \{$/gm) ?? [];
  assert.equal(
    definitions.length,
    1,
    `the launcher must define teardown_runtime exactly once — a duplicated teardown forks the guarantee for the manual-review path (found ${definitions.length})`
  );
  const definitionIndex = source.indexOf('teardown_runtime() {');
  const manualBranchIndex = source.indexOf('# --- manual-review mode: stage, print the command, hold the sandbox live');
  const finalCallIndex = source.lastIndexOf('teardown_runtime\n');
  assert.ok(
    definitionIndex !== -1 && manualBranchIndex !== -1 && definitionIndex < manualBranchIndex,
    'the single teardown_runtime definition must sit above the manual-review branch so both mode branches call the SAME teardown'
  );
  assert.ok(
    finalCallIndex !== -1 && finalCallIndex > definitionIndex,
    'the automated path must still call the shared teardown after its assertions'
  );
});

test('census helper excludes the owned compose project so crashed-run residue cannot fail a clean rerun', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gated-census-owned-'));
  const rawPs = path.join(scratch, 'raw.txt');
  const ownedPs = path.join(scratch, 'owned.txt');
  const snapshotFile = path.join(scratch, 'snapshot.json');
  const PROJECT = 'flagship-intake-gated-demo';
  try {
    // A prior hard-killed run left owned-project containers behind next to
    // the unrelated universe at snapshot time (the WR-01 scenario).
    writeFileSync(rawPs, 'aaaaaaaaaaaa running\nbbbbbbbbbbbb running\ncccccccccccc exited\n');
    writeFileSync(ownedPs, 'bbbbbbbbbbbb running\ncccccccccccc exited\n');
    const snap = await runCensusHelper(['snapshot', snapshotFile, PROJECT], makeOwnedFilterCensusShim(rawPs, ownedPs));
    assert.equal(snap.code, 0, `snapshot with an owned compose project must succeed (stderr: ${snap.stderr})`);
    assert.equal(snap.stdout.trim(), '1', 'the census must record only UNRELATED containers — owned-project containers are this run\'s own lifecycle to manage');
    const recorded = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    assert.deepEqual(
      recorded.entries,
      [['aaaaaaaaaaaa', 'running']],
      'owned-project residue present at run start must be excluded from the recorded census'
    );

    // The pre-run `compose down -v` removes the residue; the unrelated
    // universe is untouched — the end-of-run verification must PASS.
    writeFileSync(rawPs, 'aaaaaaaaaaaa running\n');
    writeFileSync(ownedPs, '');
    const verify = await runCensusHelper(['verify', snapshotFile, PROJECT], makeOwnedFilterCensusShim(rawPs, ownedPs));
    assert.equal(
      verify.code,
      0,
      `owned-project residue removed by the pre-run teardown must not fail the rerun's census verification (stderr: ${verify.stderr})`
    );

    // An unrelated container change must still fail closed.
    writeFileSync(rawPs, 'aaaaaaaaaaaa exited\n');
    const changed = await runCensusHelper(['verify', snapshotFile, PROJECT], makeOwnedFilterCensusShim(rawPs, ownedPs));
    assert.notEqual(changed.code, 0, 'an unrelated container state change must still fail the census verification');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // The launcher must actually pass its owned compose project to every
  // census helper invocation (snapshot + both teardown verify paths).
  const source = readFileSync(LAUNCHER, 'utf8');
  assert.match(
    source,
    /docker-container-census\.mjs snapshot "\$CENSUS_FILE" "\$COMPOSE_PROJECT"/,
    'the pre-run census snapshot must exclude the owned compose project'
  );
  const verifyCalls = source.match(/docker-container-census\.mjs verify "\$CENSUS_FILE" "\$COMPOSE_PROJECT"/g) ?? [];
  assert.equal(verifyCalls.length, 1, 'the single shared teardown path must verify the census with the owned compose project excluded');
});

/**
 * Graceful teardown for a possibly-live real-runtime launcher child: TERM the
 * process group first (the launcher's ownership-guarded cleanup path), wait
 * bounded, SIGKILL only as a fallback, then run a safety-net `compose down`
 * so no owned residue (or a deleted-lock-with-live-containers state) ever
 * leaks into the next test — regardless of how the child dies.
 */
async function teardownLauncherChild(child) {
  if (child?.exitCode === null) {
    termGroup(child);
    const exited = await waitFor(() => child.exitCode !== null, 30_000);
    if (!exited) killGroup(child);
    await waitFor(() => child.exitCode !== null, 10_000);
  }
  try {
    execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v', '--remove-orphans'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    /* best-effort safety net only */
  }
  resetGatedEphemeralState();
}

test('manual-review lifecycle (real runtime): emitted command works while the sandbox is live as SIMULATED reviewer input, the raw proof never enters console output, and natural-action teardown leaves no owned residue', async () => {
  assertDockerDaemonAvailable();
  const output = [];
  let child = null;
  const universeBefore = realContainerUniverse();
  try {
    resetGatedEphemeralState();
    child = spawnLauncher(['--manual-review']);
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));

    const live = await waitFor(() => output.join('').includes('sandbox is LIVE'), 180_000);
    assert.ok(live, `the manual-review sandbox must reach its LIVE readiness line (output so far: ${output.join('').trim().slice(0, 600)})`);

    // The proof must exist, be invocation-owned, and be permission-restricted.
    const proofFile = path.join(GATED_GENERATED_DIR, 'reviewer-proof');
    assert.ok(existsSync(proofFile), 'the fresh unconsumed one-time proof must live in the invocation-owned ephemeral tree while the sandbox is held');
    assert.equal(
      statSync(proofFile).mode & 0o777,
      0o600,
      'the one-time proof file must be permission-restricted (0600) while it waits unconsumed'
    );
    const proofValue = readFileSync(proofFile, 'utf8').trim();
    assert.ok(proofValue.length >= 32, 'the staged proof must be a substantial one-time value');

    // T-02-15: the raw proof must never enter the launcher console output.
    assert.ok(
      !output.join('').includes(proofValue),
      'the raw one-time reviewer proof must never appear in the launcher console output'
    );

    // The emitted command must target the CURRENT live review, be token-free,
    // and be executable in-network through the ephemeral proof file. The
    // readiness line and the command lines can arrive in separate stdout
    // chunks, so wait for the command itself (bounded).
    const liveLine = output.join('').split('\n').find((line) => line.includes('sandbox is LIVE')) ?? '';
    const liveReview = /one pending review (rev_\w+)/.exec(liveLine)?.[1];
    assert.ok(liveReview, `the readiness line must name the live pending review (got: ${liveLine.trim()})`);
    const findApproveCommand = () =>
      output
        .join('')
        .split('\n')
        .map((line) => line.replace(/^\[gated\]\s*/, '').trim())
        .find((line) => line.includes('DECISION=approve') && line.includes('reviewer-action.mjs'));
    const approveCommandFound = await waitFor(() => Boolean(findApproveCommand()), 15_000);
    const approveCommand = findApproveCommand();
    assert.ok(
      approveCommandFound && approveCommand,
      'the launcher must print the exact token-free in-network approve command while the sandbox is live'
    );
    assert.match(approveCommand, new RegExp(`REVIEW_ID=${liveReview}\\b`), 'the printed command must use the current live review id');
    assert.match(approveCommand, /REVIEWER_PROOF_FILE=\/ephemeral\/reviewer-proof/, 'the printed command must read the proof from the invocation-owned ephemeral file, never a command-line token');
    assert.ok(!approveCommand.includes(proofValue), 'the printed command must be token-free (no raw proof value)');

    // The live review must be pending in the real demo state right now.
    const pendingState = execFileSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'mock-api',
        'node',
        '-e',
        `fetch("http://127.0.0.1:9090/admin/state").then((r)=>r.json()).then((s)=>{const review=(s.reviews||[]).find((c)=>c.review_id==="${liveReview}");console.log(review?review.state:"missing")}).catch(()=>{console.log("error");process.exit(1)})`,
      ],
      { encoding: 'utf8', cwd: ROOT }
    ).trim();
    assert.equal(pendingState, 'pending', 'the emitted command must target a review that is pending in the live sandbox');

    // SIMULATED reviewer input (explicitly labeled — never a human review):
    // execute the launcher-printed command exactly as printed.
    console.log('[lifecycle-test] SIMULATED reviewer input: executing the launcher-printed approve command (this is not a human review)');
    const action = spawn('bash', ['-c', approveCommand], { cwd: ROOT });
    const actionOutput = [];
    action.stdout.on('data', (chunk) => actionOutput.push(String(chunk)));
    action.stderr.on('data', (chunk) => actionOutput.push(String(chunk)));
    const [actionExit] = await Promise.race([
      once(action, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 60_000)),
    ]);
    assert.notEqual(actionExit, null, 'the printed reviewer command must complete while the sandbox is live');
    assert.equal(actionExit, 0, `the printed reviewer command must succeed against the live sandbox (output: ${actionOutput.join('').trim().slice(0, 400)})`);

    const [exitCode] = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 120_000)),
    ]);
    assert.notEqual(exitCode, null, 'the launcher must observe the action and finish (never tear down before the action)');
    assert.equal(exitCode, 0, `the natural-action manual-review run must succeed end-to-end (output tail: ${output.join('').trim().slice(-400)})`);

    const text = output.join('');
    assert.ok(text.includes('MANUAL REVIEW ACTION OBSERVED'), 'the natural-action path must report the observed decision');
    assert.ok(!text.includes(proofValue), 'the raw proof must never appear in the console output, including after the action');

    // No owned residue: containers, networks, volumes, ephemeral tree.
    const residue = await waitFor(() => {
      const current = ownedResidue();
      return current.containers === '' && current.networks === '' && current.volumes === '';
    }, 30_000);
    assert.ok(residue, `natural-action teardown must remove every owned container/network/volume (residue: ${JSON.stringify(ownedResidue())})`);
    assert.equal(existsSync(GATED_GENERATED_DIR), false, 'natural-action teardown must remove the invocation-owned ephemeral tree (proof and lock included)');

    // Every unrelated container present at run start must be preserved with
    // identical ID and running state.
    const universeAfter = realContainerUniverse();
    assert.deepEqual(
      universeAfter,
      universeBefore,
      `every unrelated container captured at run start must be preserved with identical ID/running state (before: ${universeBefore.length}, after: ${universeAfter.length})`
    );
  } finally {
    await teardownLauncherChild(child);
  }
});

test('runtime/README.md documentation contract: Phase 2 commands, manual-review wording, lifecycle, limitations, case list, isolation, and PII/token absence', () => {
  const readme = readFileSync(path.join(ROOT, 'runtime', 'README.md'), 'utf8');
  const phase2Index = readme.indexOf('# Phase 2 — Gated Demo');
  assert.ok(phase2Index !== -1, 'runtime/README.md must carry a distinct Phase 2 gated-demo section');
  const phase1 = readme.slice(0, phase2Index);
  const phase2 = readme.slice(phase2Index);

  // The complete Phase 1 baseline section must remain intact.
  for (const marker of [
    './runtime/run-baseline.sh',
    'BASELINE PASS: crm_writes=1 queue_writes=1 approval_actions=0',
    'runtime/.generated/launcher.lock',
    'node runtime/scripts/baseline-evidence.mjs verify runtime/evidence/baseline.json',
  ]) {
    assert.ok(phase1.includes(marker), `the Phase 1 baseline section must keep documenting ${marker}`);
  }

  // Command names: the one default command plus every diagnostic mode.
  assert.match(phase2, /\.\/runtime\/run-gated-demo\.sh\b/, 'the Phase 2 section must document the single default full-suite command');
  assert.match(phase2, /--manual-review/, 'the manual-review command must be documented');
  for (const mode of ['--tracer', '--case reviewer-gate', '--case approval-delivery', '--case intake-idempotency', '--case crm-recovery']) {
    assert.ok(phase2.includes(mode), `the diagnostic mode ${mode} must be documented`);
  }

  // Exact case list (all five groups named).
  for (const name of ['tracer', 'reviewer-gate', 'approval-delivery', 'intake-idempotency', 'crm-recovery']) {
    assert.ok(phase2.includes(`\`${name}\``), `the case list must name the ${name} case group exactly`);
  }

  // Manual-action wording: the two-terminal flow, the token-free command shape,
  // and the simulated-vs-human distinction.
  assert.match(phase2, /Terminal 1/, 'the manual flow must describe the first terminal');
  assert.match(phase2, /Terminal 2/, 'the manual flow must describe the second terminal');
  assert.match(phase2, /sandbox is LIVE/, 'the readiness line the operator waits for must be documented');
  assert.match(phase2, /REVIEWER_PROOF_FILE=\/ephemeral\/reviewer-proof/, 'the documented reviewer command must read the proof from the ephemeral file');
  assert.match(phase2, /-e DECISION=approve/, 'the documented approve command shape must be exact');
  assert.match(phase2, /-e DECISION=reject/, 'the documented reject command shape must be exact');
  assert.match(phase2, /simulated reviewer input/i, 'the automated suite\\u2019s reviewer action must be labeled simulated input');
  assert.match(phase2, /not an actual human\s+reviewing a client/, 'the docs must deny that the automated action is a human review');
  assert.match(phase2, /token-free/, 'the printed manual command must be described as token-free');

  // Hold/teardown lifecycle wording.
  assert.match(phase2, /stays live/, 'the held sandbox behavior must be documented (no teardown before action)');
  assert.match(phase2, /Ctrl-C/, 'explicit interruption teardown must be documented');
  assert.match(phase2, /MANUAL REVIEW ACTION OBSERVED/, 'the natural-action completion signal must be documented');
  assert.match(phase2, /0600/, 'the permission-restricted ephemeral proof file must be documented');
  assert.match(phase2, /Each isolated case group \(and the manual hold\) begins with a freshly generated\s+cryptographically random proof/, 'the proof must be fresh per outer case or manual hold');
  assert.match(phase2, /can re-register that same case proof/, 'the manual docs must disclose sub-scenario reuse after privileged reset');

  // Limitations and truthfulness boundaries.
  assert.match(phase2, /Response-loss-after-commit/, 'the response-loss-after-commit boundary must be disclosed');
  assert.match(phase2, /exactly-once/, 'the no-universal-exactly-once boundary must be disclosed');
  assert.match(phase2, /NOT implemented and NOT proven/, 'the unproven semantics must be stated as not implemented and not proven');
  assert.match(phase2, /not a live\s+business outcome/, 'mock-vs-live framing must be explicit');
  assert.match(phase2, /simulated reviewer input[\s\S]*?human decision|human decision[\s\S]*?simulated reviewer input/i, 'the manual flow must be tied to demonstrating a human decision');

  // Isolation prerequisites: no pull, internal network, exact pin.
  assert.match(phase2, /No image pull ever happens/, 'the no-pull rule must be documented for the gated command');
  assert.match(phase2, /internal: true/, 'the internal-only network must be documented');
  assert.match(phase2, /2\.37\.10/, 'the exact pinned n8n version must be documented');

  // Counter semantics definitions.
  for (const counter of ['review_queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
    assert.ok(phase2.includes(`\`${counter}\``), `the ${counter} counter must be defined in the Phase 2 section`);
  }
  assert.match(phase2, /An attempt is not a success/, 'the attempt-vs-effect distinction must be spelled out');

  // The documented success signal must match what the launcher actually prints.
  const launcherSource = readFileSync(LAUNCHER, 'utf8');
  assert.ok(launcherSource.includes('log "FULL-SUITE PASS'), 'the launcher must print the documented FULL-SUITE PASS signal');
  assert.ok(phase2.includes('FULL-SUITE PASS'), 'the docs must cite the FULL-SUITE PASS signal');

  // Stale-lock recovery (Phase 2) must cover BOTH residue classes and agree
  // with the launcher's own hint: the whole ephemeral tree AND owned-project
  // containers a dead run left behind.
  assert.match(
    phase2,
    /rm -rf runtime\/demo\/\.generated/,
    'the Phase 2 recovery steps must remove the whole ephemeral tree (import files, census snapshot, stale proof), not only the lock'
  );
  assert.match(
    phase2,
    /docker compose -f runtime\/demo\/docker-compose\.yml down -v --remove-orphans/,
    'the Phase 2 recovery steps must tear down owned-project residue a dead run left running'
  );
  assert.match(
    launcherSource,
    /Recover manually with: rm -rf \$GENERATED_DIR \&\& docker compose -f \$COMPOSE_FILE down -v --remove-orphans/,
    'the launcher stale-lock hint must print the same whole-tree plus owned-teardown recovery command the README documents'
  );

  // PII/token/live-URL absence across the ENTIRE file (Phase 1 + Phase 2).
  const fixture = JSON.parse(readFileSync(path.join(ROOT, 'payloads', 'intake-new-lead.json'), 'utf8'));
  for (const raw of [fixture.contact.email, fixture.contact.phone]) {
    assert.ok(!readme.includes(raw), `the README must never contain raw contact material (${raw.slice(0, 6)}...)`);
  }
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(readme), 'the README must contain no credential-looking token material');
  assert.ok(!/https:\/\/api\./.test(readme), 'the README must contain no live service URLs');
  assert.ok(!/x-reviewer-proof:\s*[^\s<]/i.test(readme), 'the README must contain no reviewer proof header values');
});

test('manual-review interruption (real runtime): TERM triggers ownership-guarded teardown, exits non-zero, prints no PASS, and leaves no owned residue', async () => {
  assertDockerDaemonAvailable();
  const output = [];
  let child = null;
  try {
    resetGatedEphemeralState();
    child = spawnLauncher(['--manual-review']);
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));

    const live = await waitFor(() => output.join('').includes('sandbox is LIVE'), 180_000);
    assert.ok(live, `the manual-review sandbox must reach its LIVE readiness line before interruption (output so far: ${output.join('').trim().slice(0, 600)})`);

    termGroup(child);
    const [exitCode] = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve([null]), 60_000)),
    ]);
    assert.notEqual(exitCode, null, 'an interrupted manual-review launcher must exit promptly, not hang');
    assert.notEqual(exitCode, 0, 'an interrupted manual-review launcher must exit non-zero');

    const text = output.join('');
    assert.ok(!text.includes('MANUAL REVIEW ACTION OBSERVED'), 'an interrupted hold must not claim an observed action');
    assert.ok(
      !/\bPASS\b/.test(text),
      `an interrupted hold must never print a PASS claim (output: ${text.trim().slice(0, 400)})`
    );

    const residue = await waitFor(() => {
      const current = ownedResidue();
      return current.containers === '' && current.networks === '' && current.volumes === '';
    }, 30_000);
    assert.ok(residue, `interruption teardown must remove every owned container/network/volume (residue: ${JSON.stringify(ownedResidue())})`);
    assert.equal(existsSync(GATED_GENERATED_DIR), false, 'interruption teardown must remove the invocation-owned ephemeral tree (no stale lock, no proof residue)');
  } finally {
    await teardownLauncherChild(child);
  }
});
