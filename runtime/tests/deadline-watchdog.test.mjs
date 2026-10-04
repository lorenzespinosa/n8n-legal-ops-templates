import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';

function psField(pid, field) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const launcherScript = String.raw`
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {}); // stubborn launcher forces watchdog escalation
const guard = spawn(process.execPath, ['runtime/scripts/deadline-watchdog.mjs', String(process.pid), '0.2'], { stdio: 'ignore' });
const stubborn = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
console.log(JSON.stringify({ launcher: process.pid, guard: guard.pid, stubborn: stubborn.pid }));
setInterval(() => {}, 1000);
`;
const supervisorScript = String.raw`
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', process.argv[1]], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.pipe(process.stdout);
setInterval(() => {}, 1000);
`;

test('non-leader watchdog escalation kills stubborn descendants before itself', async () => {
  // A detached *supervisor* owns this isolated process group; the launcher is
  // deliberately NOT the group leader, so the watchdog must use its ps-tree
  // fallback. The supervisor/test runner are never descendants of launcher.
  const supervisor = spawn(process.execPath, ['-e', supervisorScript, launcherScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    const frame = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('launcher did not report child PIDs')), 3_000);
      supervisor.stdout.on('data', (part) => {
        text += part.toString();
        if (text.includes('\n')) {
          clearTimeout(timer);
          resolve(JSON.parse(text.split('\n')[0]));
        }
      });
      supervisor.once('error', reject);
    });
    assert.equal(Number(psField(frame.launcher, 'pgid')), supervisor.pid);
    assert.notEqual(frame.launcher, supervisor.pid);
    assert.ok(frame.guard < frame.stubborn, 'watchdog must be visited before stubborn child to expose self-kill ordering');
    await new Promise((resolve) => setTimeout(resolve, 6_200));
    const state = psField(frame.stubborn, 'state');
    const guardState = psField(frame.guard, 'state');
    const launcherState = psField(frame.launcher, 'state');
    assert.ok(state === null || state === 'Z',
      `stubborn descendant survived the 0.2s deadline plus 5s escalation (stubborn=${state}, guard=${guardState}, launcher=${launcherState})`);
    assert.ok(launcherState === null || launcherState === 'Z', `launcher survived escalation (state=${launcherState})`);
    assert.ok(guardState === null || guardState === 'Z', `watchdog survived its own escalation (state=${guardState})`);
  } finally {
    // Kill only the process group we created; never signal Hermes's group.
    if (Number(psField(supervisor.pid, 'pgid')) === supervisor.pid) {
      try { process.kill(-supervisor.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});
