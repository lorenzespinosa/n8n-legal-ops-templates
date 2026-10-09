// flagship-intake-deadline-guard (WR-01)
//
// Hard-deadline watchdog for runtime/run-baseline.sh:
//
//   node runtime/scripts/deadline-watchdog.mjs <launcherPid> <deadlineSeconds>
//
// The original inline guard signaled only the launcher shell's PID. Bash
// defers a trapped TERM until the current foreground child exits, so a hung
// `docker compose run/exec` was never interrupted — the 55-second deadline
// only held when commands finished on their own. This watchdog actually
// interrupts the blocked run:
//
//   1. When the launcher leads its own process group (interactive terminal
//      launch, or a detached spawn as used by the lifecycle tests), it
//      delivers SIGTERM to the WHOLE group via kill(-pid) — the blocked
//      foreground docker/node child receives TERM directly and dies, which
//      unblocks the shell's trap and lets the ownership-guarded cleanup run.
//   2. When the launcher does NOT lead its group (bash -c, CI steps), a
//      group kill would signal an unrelated parent shell. Instead the
//      watchdog walks the launcher's live descendants (ps pid/ppid) and
//      TERMs each one, then the launcher itself.
//   3. Escalation: anything still alive 5 seconds after the deadline is
//      SIGKILLed — "no result may be reported after the deadline" is a hard
//      property, not a polite request. (A KILLed cleanup can leave a stale
//      lock; see the stale-lock recovery note in runtime/README.md.)
//
// The watchdog ignores SIGTERM itself so the escalation timer survives a
// group kill; the launcher's cleanup reaps it with SIGKILL on normal exits.
//
// Zero dependencies: Node standard library only (T-01-SC).

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const launcherPid = Number(process.argv[2]);
const deadlineSeconds = Number(process.argv[3]);
if (!Number.isInteger(launcherPid) || launcherPid <= 0 || !Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) {
  process.stderr.write('deadline-watchdog: usage: node deadline-watchdog.mjs <launcherPid> <deadlineSeconds>\n');
  process.exit(2);
}

/** Run ps and return its stdout rows, or [] when ps is unavailable. */
function psRows(args) {
  try {
    const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** True when the launcher PID is also its own process-group leader. */
function launcherLeadsGroup() {
  const rows = psRows(['-o', 'pgid=', '-p', String(launcherPid)]);
  return rows.length === 1 && Number(rows[0]) === launcherPid;
}

/** Every live process whose parent chain reaches the launcher (self included). */
function launcherDescendants() {
  const byParent = new Map();
  for (const row of psRows(['-axo', 'pid=,ppid='])) {
    const fields = row.split(/\s+/);
    if (fields.length < 2) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const descendants = [];
  const walk = (parent) => {
    for (const child of byParent.get(parent) ?? []) {
      descendants.push(child);
      walk(child);
    }
  };
  walk(launcherPid);
  return descendants;
}

const signalPid = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
};

const deliver = (signal) => {
  if (launcherLeadsGroup()) {
    // Fast path: one group signal takes the shell and its blocked children.
    signalPid(-launcherPid, signal);
    return;
  }
  // Fallback: never signal a group the launcher does not own. The watchdog
  // is itself a launcher descendant: leave it alive until AFTER every other
  // descendant and the launcher have received the escalation signal.
  for (const pid of launcherDescendants()) {
    if (pid !== process.pid) signalPid(pid, signal);
  }
  signalPid(launcherPid, signal);
  if (signal === 'SIGKILL') signalPid(process.pid, signal);
};

// Survive the group TERM we deliver ourselves so escalation can still fire.
process.on('SIGTERM', () => {});

setTimeout(() => {
  process.stderr.write('[baseline] FAIL: deadline exceeded — no result can be reported\n');
  deliver('SIGTERM');
  // Stays referenced: the watchdog must outlive the TERM it delivered so
  // the escalation below actually fires (the launcher's cleanup reaps this
  // process with SIGKILL on normal exits).
  setTimeout(() => {
    deliver('SIGKILL');
    process.exit(0);
  }, 5_000);
}, deadlineSeconds * 1000);
