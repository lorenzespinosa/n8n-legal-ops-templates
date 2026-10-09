// Bind baseline evidence to the exact committed source/fixture bytes.
// Run once before Docker execution and again immediately before publishing.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
}

export function verifySourceProvenance({ root, commit, sourcePath, sourceSha256,
  fixturePath, fixtureSha256 }) {
  if (!path.isAbsolute(root) || !HEX40.test(commit)) {
    throw new Error('source provenance requires an absolute repository root and exact 40-hex commit');
  }
  const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (head !== commit) throw new Error(`HEAD moved during the run: expected commit ${commit}, got ${head}`);
  const files = [
    ['source', sourcePath, sourceSha256, 'workflows/client-intake-pipeline.json'],
    ['fixture', fixturePath, fixtureSha256, 'payloads/intake-new-lead.json'],
  ];
  for (const [label, relative, expected, allowed] of files) {
    if (relative !== allowed || !HEX64.test(expected)) {
      throw new Error(`${label} provenance path or SHA-256 is invalid`);
    }
    const committed = sha256(git(root, ['show', `${commit}:${relative}`]));
    if (committed !== expected) {
      throw new Error(`${label} SHA-256 does not match the recorded commit ${commit}`);
    }
    const current = sha256(readFileSync(path.join(root, relative)));
    if (current !== expected) {
      throw new Error(`${label} bytes changed relative to the recorded commit or beginning of the run`);
    }
  }
  return { ok: true, commit, sourceSha256, fixtureSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [verb, root, commit, sourcePath, sourceSha256, fixturePath, fixtureSha256] = process.argv.slice(2);
    if (verb !== 'verify' || process.argv.length !== 9) {
      throw new Error('usage: provenance.mjs verify <root> <commit> <sourcePath> <sourceSha256> <fixturePath> <fixtureSha256>');
    }
    console.log(JSON.stringify(verifySourceProvenance({ root, commit, sourcePath, sourceSha256,
      fixturePath, fixtureSha256 })));
  } catch (error) {
    console.error(`provenance: ${error.message}`);
    process.exitCode = 1;
  }
}
