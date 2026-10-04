import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = 'workflows/client-intake-pipeline.json';
const FIXTURE = 'payloads/intake-new-lead.json';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

test('source and fixture hashes must match the recorded commit at both run boundaries', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'baseline-provenance-'));
  try {
    mkdirSync(path.join(root, 'workflows'));
    mkdirSync(path.join(root, 'payloads'));
    const sourceBytes = '{"demo":"unchanged source"}\n';
    const fixtureBytes = '{"firm":"Greenfield & Associates"}\n';
    writeFileSync(path.join(root, SOURCE), sourceBytes);
    writeFileSync(path.join(root, FIXTURE), fixtureBytes);
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Fictional Tester');
    git(root, 'config', 'user.email', 'tester@example.com');
    git(root, 'add', SOURCE, FIXTURE);
    git(root, 'commit', '-qm', 'fictional provenance fixture');
    const commit = git(root, 'rev-parse', 'HEAD');
    const expected = { root, commit, sourcePath: SOURCE, sourceSha256: sha(sourceBytes),
      fixturePath: FIXTURE, fixtureSha256: sha(fixtureBytes) };
    const module = await import('../scripts/provenance.mjs').catch(() => null);
    assert.ok(module?.verifySourceProvenance, 'the launcher needs a reusable commit/bytes provenance gate');
    assert.doesNotThrow(() => module.verifySourceProvenance(expected));

    writeFileSync(path.join(root, SOURCE), '{"demo":"changed source"}\n');
    assert.throws(() => module.verifySourceProvenance(expected), /source|sha|commit/i,
      'dirty source bytes cannot be attributed to the recorded commit');
    writeFileSync(path.join(root, SOURCE), sourceBytes);
    writeFileSync(path.join(root, FIXTURE), '{"firm":"Other"}\n');
    assert.throws(() => module.verifySourceProvenance(expected), /fixture|sha|commit/i,
      'a fixture modified after the first check must fail before publication');
    writeFileSync(path.join(root, FIXTURE), fixtureBytes);
    git(root, 'commit', '--allow-empty', '-qm', 'head moved mid-run');
    assert.throws(() => module.verifySourceProvenance(expected), /HEAD|commit/i,
      'a moving HEAD cannot be labeled as the original source commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launcher checks provenance before runtime and again after teardown but before publication', () => {
  const script = readFileSync(path.join(ROOT, 'runtime', 'run-baseline.sh'), 'utf8');
  const call = 'node runtime/scripts/provenance.mjs verify';
  const first = script.indexOf(call);
  const second = script.indexOf(call, first + call.length);
  const runtimeStart = script.indexOf('compose up -d mock-api');
  const teardownBeforePublish = script.lastIndexOf('teardown_runtime\n');
  const publish = script.indexOf('node runtime/scripts/baseline-evidence.mjs publish');
  assert.ok(first >= 0 && second > first, 'provenance gate must run twice, not merely document a check');
  assert.ok(first < runtimeStart, 'first guard must precede the real n8n run');
  assert.ok(second > teardownBeforePublish && second < publish,
    'final guard must rehash immediately after teardown and before atomic publication');
});
