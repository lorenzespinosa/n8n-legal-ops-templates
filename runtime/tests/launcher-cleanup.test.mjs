import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

function watchdogsInGroup(pgid) {
  const lines = execFileSync('ps', ['-axo', 'pid=,pgid=,state=,command='], { encoding: 'utf8' }).split('\n');
  return lines.flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) !== pgid) return [];
    const command = match[4];
    if (!/^sleep 55\s*$/.test(command)
      && !/\bnode -e .*flagship-intake-deadline-guard/.test(command)
      && !/\bnode\s+\S*deadline-watchdog\.mjs\b/.test(command)) return [];
    return [{ pid: Number(match[1]), state: match[3] }];
  });
}

test('a rejected baseline invocation leaves no deadline watchdog process behind', async () => {
  // Isolate this launch in its own process group: other tests may run their
  // watchdogs concurrently, and a global ps before/after diff misattributes
  // those unrelated processes to this invocation.
  const child = spawn('bash', ['runtime/run-baseline.sh', '--invalid'], { stdio: 'ignore', detached: true });
  const [exitCode] = await once(child, 'exit');
  assert.notEqual(exitCode, 0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const leaked = watchdogsInGroup(child.pid).filter(({ state }) => state !== 'Z');
  for (const { pid } of leaked) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  assert.deepEqual(leaked, [], `orphaned watchdogs in group ${child.pid}: ${JSON.stringify(leaked)}`);
});
