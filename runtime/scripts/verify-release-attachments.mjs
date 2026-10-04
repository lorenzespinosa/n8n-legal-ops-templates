#!/usr/bin/env node
// Read-only, offline verification of the public release's comparison attachments.
// This proves that two committed record files have identical counted states and
// that the nine-file source manifest names actual committed Git bytes. It does
// NOT independently re-execute n8n or turn the older HTTP 400 observation into
// a new measurement. Run from the repository root; no network or Docker calls.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  FROZEN_PHASE_BASE_SHA,
  verifyFinalEvidence,
  bindProvenanceToGit,
  compareFinalEvidenceRecords,
} from './final-evidence.mjs';
import { verifyBaselineEvidence } from './baseline-evidence.mjs';
import { MANIFEST_ALLOWLIST } from './evidence-manifest.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FILES = Object.freeze({
  index: 'runtime/evidence/release-attachment-index.json',
  final_record: 'runtime/evidence/final-evidence-log.json',
  prior_record: 'runtime/evidence/prior-final-evidence-log.json',
  source_manifest: 'runtime/evidence/source-run-manifest.json',
  baseline_record: 'runtime/evidence/baseline.json',
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, args) => execFileSync('git', args, {
  cwd: root,
  timeout: 10_000,
  maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

export function verifyReleaseAttachments({
  root,
  readBytes = (relative) => readFileSync(path.join(root, relative)),
}) {
  const errors = [];
  const bad = (reason) => errors.push(reason);
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return { ok: false, errors: ['root must be an absolute repository path'] };
  }
  const bytes = {};
  const objects = {};
  for (const [key, relative] of Object.entries(FILES)) {
    try {
      bytes[key] = readBytes(relative);
      objects[key] = JSON.parse(bytes[key].toString('utf8'));
    } catch (error) {
      bad(`${relative}: unreadable or invalid JSON (${error.message})`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const index = objects.index;
  if (index.schema_version !== 1 || index.kind !== 'flagship-intake-release-attachments') {
    bad('index: unsupported schema or kind');
  }
  for (const key of ['final_record', 'prior_record', 'source_manifest', 'baseline_record']) {
    const expected = index.sha256?.[key];
    if (typeof expected !== 'string' || !HEX64.test(expected) || sha256(bytes[key]) !== expected) {
      bad(`${key}: bytes do not match the release index SHA-256`);
    }
  }
  const { final_record: final, prior_record: prior, source_manifest: manifest, baseline_record: baseline } = objects;
  for (const [label, record] of [['final', final], ['prior', prior]]) {
    const shape = verifyFinalEvidence(record);
    if (!shape.ok) bad(`${label}: ${shape.errors.join('; ')}`);
    const bound = bindProvenanceToGit(record, root);
    if (!bound.ok) bad(`${label}: Git-bound provenance failed (${bound.errors.join('; ')})`);
  }
  const baselineVerdict = verifyBaselineEvidence(baseline);
  if (!baselineVerdict.ok) bad(`baseline: ${baselineVerdict.errors.join('; ')}`);
  const compare = compareFinalEvidenceRecords(prior, final);
  if (!compare.ok) bad(`comparison: ${JSON.stringify(compare.errors ?? compare)}`);

  const sourceHead = index.source_run_commit;
  if (typeof sourceHead !== 'string' || !HEX40.test(sourceHead)) {
    bad('index: source_run_commit must be a full 40-hex Git commit');
  } else {
    try { git(root, ['merge-base', '--is-ancestor', sourceHead, 'HEAD']); }
    catch { bad('index: source-run commit is not reachable from this release branch'); }
  }
  if (index.phase_base !== FROZEN_PHASE_BASE_SHA || final.run?.rerun?.phase_base !== FROZEN_PHASE_BASE_SHA) {
    bad('phase_base: index and accepted record must name the frozen public release boundary');
  } else {
    try { git(root, ['merge-base', '--is-ancestor', FROZEN_PHASE_BASE_SHA, sourceHead]); }
    catch { bad('phase_base: boundary is not an ancestor of the source-run commit'); }
  }
  if (index.final_run_id !== final.run?.id || index.prior_run_id !== prior.run?.id ||
      final.run?.rerun?.compared_with !== prior.run?.id || final.run?.rerun?.per_case_identical !== true) {
    bad('comparison: run identities or per-case-identical assertion disagree with the index');
  }
  if (manifest.head !== sourceHead || final.provenance?.head !== sourceHead || prior.provenance?.head !== sourceHead) {
    bad('source_run_commit: manifest and both records must attribute the same source commit');
  }
  const listedPaths = manifest.files?.map((entry) => entry.path);
  if (JSON.stringify(listedPaths) !== JSON.stringify(MANIFEST_ALLOWLIST)) {
    bad('source_manifest: files must be the exact sorted nine-file allowlist');
  } else if (HEX40.test(sourceHead)) {
    for (const entry of manifest.files) {
      if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) {
        bad(`source_manifest: invalid SHA-256 for ${entry.path}`);
        continue;
      }
      try {
        const committed = sha256(git(root, ['show', `${sourceHead}:${entry.path}`]));
        const current = sha256(readBytes(entry.path));
        if (entry.sha256 !== committed || entry.sha256 !== current) {
          bad(`source_manifest: ${entry.path} differs from source-run Git bytes or current file`);
        }
      } catch (error) {
        bad(`source_manifest: could not verify committed or current bytes for ${entry.path} (${error.message})`);
      }
    }
  }
  const four = {
    historical_source: 'workflows/client-intake-pipeline.json',
    intake_workflow: 'runtime/demo/workflows/intake-stage.json',
    reviewer_workflow: 'runtime/demo/workflows/reviewer-decision.json',
    delivery_workflow: 'runtime/demo/workflows/approved-delivery.json',
  };
  for (const [key, relative] of Object.entries(four)) {
    const entry = manifest.files?.find((item) => item.path === relative);
    if (!entry || final.provenance?.evidence_sha256?.[key] !== entry.sha256) {
      bad(`source_manifest: ${key} must agree with the accepted record's Git-bound SHA-256`);
    }
  }
  const baselineCommit = baseline.provenance?.source_commit;
  if (typeof baselineCommit !== 'string' || !HEX40.test(baselineCommit)) {
    bad('baseline: missing source commit');
  } else {
    try { git(root, ['merge-base', '--is-ancestor', baselineCommit, sourceHead]); }
    catch { bad('baseline: source commit is not reachable from the source-run commit'); }
    for (const [entry, relative] of [
      [baseline.provenance?.source_workflow, 'workflows/client-intake-pipeline.json'],
      [baseline.provenance?.fixture, 'payloads/intake-new-lead.json'],
    ]) {
      if (entry?.path !== relative || !HEX64.test(entry?.sha256 ?? '')) {
        bad(`baseline: invalid provenance entry for ${relative}`);
        continue;
      }
      try {
        if (sha256(git(root, ['show', `${baselineCommit}:${relative}`])) !== entry.sha256) {
          bad(`baseline: ${relative} does not match its recorded Git commit`);
        }
      } catch { bad(`baseline: ${relative} is unavailable at its recorded Git commit`); }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    source_run_commit: sourceHead,
    final_run_id: final.run?.id,
    compared_with: prior.run?.id,
    manifest_files_verified: manifest.files?.length ?? 0,
  };
}

const invoked = (() => {
  try {
    const self = statSync(fileURLToPath(import.meta.url));
    const entry = statSync(realpathSync(process.argv[1]));
    return self.dev === entry.dev && self.ino === entry.ino;
  } catch { return false; }
})();
if (invoked) {
  let verdict;
  try {
    if (process.argv.length !== 2) throw new Error('usage: node runtime/scripts/verify-release-attachments.mjs');
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    verdict = verifyReleaseAttachments({ root });
  } catch (error) {
    verdict = { ok: false, errors: [error.message] };
  }
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.ok ? 0 : 1;
}
