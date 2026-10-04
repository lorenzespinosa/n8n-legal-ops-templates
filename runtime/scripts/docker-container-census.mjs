#!/usr/bin/env node
// Unrelated-container census helper for the Phase 2 gated launcher
// (plan 02-04, Task 1 — T-02-14 mitigation).
//
//   node runtime/scripts/docker-container-census.mjs snapshot <file> [compose-project]
//     Capture the current unrelated-container universe (`docker ps -a`,
//     ID + running state — every container present at run start, irrespective
//     of count) into a launcher-owned ephemeral JSON file, EXCLUDING every
//     container of the optional owned compose project (its lifecycle is this
//     run's to manage — pre-run teardown of crashed-run residue must never
//     read back as a vanished "unrelated" container). Prints the captured
//     count.
//
//   node runtime/scripts/docker-container-census.mjs verify <file> [compose-project]
//     Re-capture the universe (same owned-project exclusion) and compare it
//     against the snapshot: exit 0 only when every recorded container still
//     exists with the identical running state and no unrecorded container
//     appeared. Any difference — or any uncertainty (docker unavailable,
//     unparseable output) — exits non-zero with the offending container IDs
//     named on stderr. This is the preservation proof the launcher runs
//     BEFORE printing any PASS.
//
//   node runtime/scripts/docker-container-census.mjs count <file>
//     Print the count recorded in the snapshot (for the final PASS line;
//     never contacts Docker).
//
// The helper is deliberately dumb and fail-closed: it parses nothing but
// `docker ps -a --format` output, performs no mutation, and refuses to
// verify through an error. Node standard library only (T-02-SC).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const USAGE = 'usage: docker-container-census.mjs snapshot|verify|count <file> [compose-project]';

const [action, file, ownedProject] = process.argv.slice(2);

if (!action || !file) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

/** Run one read-only docker query; any failure is census uncertainty and blocks. */
function runDocker(args) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    process.stderr.write(`docker-container-census: '${args.join(' ')}' failed — census uncertainty blocks: ${error.message}\n`);
    return process.exit(2);
  }
}

/** Parse `ps -a --format '{{.ID}} {{.State}}'` lines; anything else blocks. */
function parseCensusEntries(output) {
  const entries = [];
  for (const line of String(output).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-f]{12,64}) ([a-z]+)$/.exec(trimmed);
    if (!match) {
      process.stderr.write(`docker-container-census: unrecognized census line — census uncertainty blocks: ${trimmed}\n`);
      process.exit(2);
    }
    entries.push([match[1], match[2]]);
  }
  return entries;
}

/**
 * Capture the unrelated-container universe as sorted [id, state] pairs.
 * When an owned compose project is given, every container carrying that
 * project label is excluded (queried separately and subtracted) so the
 * launcher's own pre-run teardown of crashed-run residue can never count
 * as a vanished unrelated container. Exits non-zero on any uncertainty.
 */
function captureUniverse(owned) {
  const entries = parseCensusEntries(runDocker(['ps', '-a', '--format', '{{.ID}} {{.State}}']));
  let ownedIds = new Set();
  if (owned) {
    const ownedEntries = parseCensusEntries(
      runDocker(['ps', '-a', '--filter', `label=com.docker.compose.project=${owned}`, '--format', '{{.ID}} {{.State}}'])
    );
    ownedIds = new Set(ownedEntries.map(([id]) => id));
  }
  const unrelated = entries.filter(([id]) => !ownedIds.has(id));
  unrelated.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return unrelated;
}

function readSnapshot(snapshotPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`docker-container-census: could not read the census snapshot ${snapshotPath}: ${error.message}\n`);
    process.exit(2);
  }
  if (parsed?.schema !== 1 || !Array.isArray(parsed.entries) || parsed.entries.some((e) => !Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string')) {
    process.stderr.write(`docker-container-census: malformed census snapshot ${snapshotPath} — failing closed\n`);
    process.exit(2);
  }
  return parsed;
}

if (action === 'snapshot') {
  const entries = captureUniverse(ownedProject);
  writeFileSync(file, `${JSON.stringify({ schema: 1, entries })}\n`, { mode: 0o600 });
  process.stdout.write(`${entries.length}\n`);
  process.exit(0);
}

if (action === 'verify') {
  if (!existsSync(file)) {
    process.stderr.write(`docker-container-census: census snapshot ${file} does not exist — preservation is unproven, failing closed\n`);
    process.exit(1);
  }
  const recorded = readSnapshot(file);
  const recordedMap = new Map(recorded.entries);
  const current = captureUniverse(ownedProject);
  const currentMap = new Map(current);

  const added = current.filter(([id]) => !recordedMap.has(id));
  const removed = recorded.entries.filter(([id]) => !currentMap.has(id));
  const changed = current.filter(([id, state]) => recordedMap.has(id) && recordedMap.get(id) !== state);

  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    for (const [id] of added) process.stderr.write(`docker-container-census: container ${id} appeared after run start\n`);
    for (const [id] of removed) process.stderr.write(`docker-container-census: container ${id} present at run start is gone\n`);
    for (const [id, state] of changed) process.stderr.write(`docker-container-census: container ${id} changed running state (was ${recordedMap.get(id)}, now ${state})\n`);
    process.stderr.write('docker-container-census: unrelated-container preservation is NOT proven — no PASS may be printed\n');
    process.exit(1);
  }
  process.exit(0);
}

if (action === 'count') {
  if (!existsSync(file)) {
    process.stderr.write(`docker-container-census: census snapshot ${file} does not exist\n`);
    process.exit(1);
  }
  process.stdout.write(`${readSnapshot(file).entries.length}\n`);
  process.exit(0);
}

process.stderr.write(`${USAGE}\n`);
process.exit(2);
