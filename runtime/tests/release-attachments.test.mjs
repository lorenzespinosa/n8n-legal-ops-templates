import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseAttachments } from '../scripts/verify-release-attachments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'runtime', 'scripts', 'verify-release-attachments.mjs');
const read = (relative) => readFileSync(path.join(ROOT, relative));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const INDEX = 'runtime/evidence/release-attachment-index.json';
const PRIOR = 'runtime/evidence/prior-final-evidence-log.json';
const MANIFEST = 'runtime/evidence/source-run-manifest.json';

function withOverrides(overrides) {
  return verifyReleaseAttachments({
    root: ROOT,
    readBytes: (relative) => overrides[relative] ?? read(relative),
  });
}

test('public attachment bundle independently binds both counted records and nine committed source files', () => {
  const result = verifyReleaseAttachments({ root: ROOT });
  assert.deepEqual(result.errors, [], result.errors.join('; '));
  assert.equal(result.ok, true);
  assert.equal(result.manifest_files_verified, 9);
  const cli = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.equal(JSON.parse(cli.stdout).ok, true);
});

test('prior record byte tampering fails the indexed SHA-256 gate', () => {
  const tampered = Buffer.concat([read(PRIOR), Buffer.from(' ')]);
  const result = withOverrides({ [PRIOR]: tampered });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /prior_record: bytes do not match/);
});

test('a self-consistent forged manifest and index still fail the source-run Git-byte check', () => {
  const manifest = JSON.parse(read(MANIFEST));
  manifest.files[0].sha256 = 'a'.repeat(64);
  const forgedManifest = json(manifest);
  const index = JSON.parse(read(INDEX));
  index.sha256.source_manifest = digest(forgedManifest);
  const result = withOverrides({ [MANIFEST]: forgedManifest, [INDEX]: json(index) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /source_manifest: .* differs from source-run Git bytes/);
});

test('a forged source-run commit in the index fails even if the artifact hashes remain correct', () => {
  const index = JSON.parse(read(INDEX));
  index.source_run_commit = 'f'.repeat(40);
  const result = withOverrides({ [INDEX]: json(index) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /source-run commit is not reachable|manifest and both records must attribute/);
});

test('the currently executed allowlisted file bytes cannot drift from the published source-run manifest', () => {
  const source = 'workflows/client-intake-pipeline.json';
  const result = withOverrides({ [source]: Buffer.concat([read(source), Buffer.from(' ')] ) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /source_manifest: workflows\/client-intake-pipeline\.json differs/);
});

test('the standalone CLI rejects extra arguments instead of silently doing a narrower check', () => {
  const cli = spawnSync(process.execPath, [CLI, '--skip-prior'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.equal(JSON.parse(cli.stdout).ok, false);
});
