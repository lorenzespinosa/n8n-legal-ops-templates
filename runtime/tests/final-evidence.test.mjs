// Task 1 (tracer) contract tests for the Phase 3 final evidence pipeline
// (PACK-01): one repository-root command runs the real pinned-runtime full
// suite, captures its genuine combined console output, and publishes a
// machine-verified evidence log at runtime/evidence/final-evidence-log.json.
//
// runtime/scripts/final-evidence.mjs must export:
//   parseLauncherCapture(text)     parse the launcher's exact success
//                                  vocabulary (CASE PASS i/N, STATIC
//                                  CONTRACTS PASS, FULL-SUITE PASS,
//                                  preservation, runtime version, evidence
//                                  sha256 lines) from captured console text
//   buildFinalEvidenceRecord(...)  assemble the canonical minimal record
//   verifyFinalEvidence(record)    fail-closed invariant check ({ok, errors})
//   publishFinalEvidence(record, destination)
//                                  verify -> temporary sibling -> atomic rename
//   serializeFinalEvidence(record) deterministic (key-order canonical) bytes
//   DISCLOSURE_PATTERNS            the 7 baseline disclosure patterns
//
// runtime/run-final-evidence.sh must exist as the one-command driver that
// executes the UNCHANGED launcher (never a duplicate), tees combined
// stdout+stderr to a driver-owned capture outside runtime/demo/.generated,
// and publishes only after the launcher exited 0 and the record verified.
//
// The module is loaded lazily so the TDD RED run fails on an explicit
// assertion for the missing feature instead of an import error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EVIDENCE_CLI = path.join(ROOT, 'runtime', 'scripts', 'final-evidence.mjs');
const DRIVER_SCRIPT = path.join(ROOT, 'runtime', 'run-final-evidence.sh');
const LAUNCHER_SCRIPT = path.join(ROOT, 'runtime', 'run-gated-demo.sh');
const COMMITTED_RECORD = path.join(ROOT, 'runtime', 'evidence', 'final-evidence-log.json');

async function loadEvidenceModule() {
  try {
    return await import('../scripts/final-evidence.mjs');
  } catch {
    return null;
  }
}

// The launcher's fixed five-group matrix order (run-gated-demo.sh FULL_CASES).
const EXPECTED_CASE_ORDER = [
  'tracer',
  'reviewer-gate',
  'approval-delivery',
  'intake-idempotency',
  'crm-recovery',
];

// The launcher-asserted closing counted states, in case order — the counted
// facts the published record must carry verbatim from the captured output.
const EXPECTED_OBSERVED = [
  { queue: 1, approval_actions: 0, crm_attempts: 0, crm_effects: 0 },
  { queue: 1, approval_actions: 0, crm_attempts: 0, crm_effects: 0 },
  { queue: 1, approval_actions: 1, crm_attempts: 1, crm_effects: 1 },
  { queue: 1, approval_actions: 0, crm_attempts: 0, crm_effects: 0 },
  { queue: 1, approval_actions: 1, crm_attempts: 2, crm_effects: 1 },
];

const FIXTURE_DIGEST_IMAGE =
  'n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec';

// Public-safe release boundary: the committed fictional baseline on this
// branch, not the private staging milestone or an arbitrary current HEAD.
const FROZEN_PHASE_BASE_SHA = '19ce7afcfa1470512c7675cc5b0661e0714646d2';

/**
 * A representative capture of the launcher's genuine combined console
 * output: the exact success vocabulary lines the parser must consume, in the
 * launcher's real emission order (teardown preservation line before the
 * final step-10 block), with realistic unrelated TAP noise interleaved.
 */
function fixtureCapture() {
  const lines = [
    '[gated] unrelated-container census captured: 14 containers (IDs + running states) — preservation is re-verified before any success line is printed',
    '[gated] egress enforcement machine-checked: flagship-intake-gated-demo_runtime-net Internal=true',
    '[gated] real n8n runtime version: 2.37.10 (exact pin asserted)',
    '[gated] live n8n database holds exactly the three expected active gated workflows (ids asserted)',
    '[gated] running static workflow/mock contracts inside the audit container (n8n 2.37.10)',
    'TAP version 13',
    'ok 1 - intake graph holds no HTTP node except the local staging route',
    '[gated] static workflow/mock contracts verified; results pending teardown and source checks',
    '[gated] running full-suite case 1/5: tracer',
    'ok 5 - tracer case closes pending with zero CRM activity',
    '[gated] running full-suite case 2/5: reviewer-gate',
    '[gated] running full-suite case 3/5: approval-delivery',
    '[gated] running full-suite case 4/5: intake-idempotency',
    '[gated] running full-suite case 5/5: crm-recovery',
    '[gated] n8n proof boundary verified: no issued proof appears in n8n logs, n8n state is tmpfs-backed, and no n8n-data volume exists; temporary 0600 host proof files remain until teardown',
    '[gated] unrelated containers preserved: 14/14 (ID + running state identical); owned teardown verified',
    '[gated] STATIC CONTRACTS PASS: fail-closed structural invariants and mock contracts green (audit container)',
    '[gated] CASE PASS (1/5) tracer: invalid, urgent-unapproved, and valid staging all hold zero CRM activity before any reviewer action — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
    '[gated] CASE PASS (2/5) reviewer-gate: missing/wrong/replayed reviewer proof and malformed/unknown decisions record nothing; the closing reject never reaches CRM — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
    '[gated] CASE PASS (3/5) approval-delivery: valid staged pending review plus simulated-reviewer approval commits exactly one CRM effect; committed replay changes nothing — queue=1 approval_actions=1 CRM ATTEMPTS=1 CRM EFFECTS=1',
    '[gated] CASE PASS (4/5) intake-idempotency: exact duplicate replay reuses the one review; a conflicting intake key fails closed with 409 — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
    '[gated] CASE PASS (5/5) crm-recovery: deterministic pre-commit CRM failure (1/0) plus one deliberate same-key retry (2/1) commits exactly one effect — queue=1 approval_actions=1 CRM ATTEMPTS=2 CRM EFFECTS=1',
    '[gated] FULL-SUITE PASS: 5/5 case groups green on real pinned n8n 2.37.10 — per-case lines above carry the exact CRM ATTEMPTS and CRM EFFECTS counts',
    '[gated] preservation: 14/14 unrelated containers identical (ID + running state); owned project containers/networks/volumes and the ephemeral tree (nonce, census, lock) fully removed',
    '[gated] evidence: n8n=2.37.10 (exact pin), intake id=greenfield-intake-gated-demo, reviewer id=greenfield-reviewer-decision-demo, delivery id=greenfield-approved-delivery-demo, historical source sha256=4559c8516533a1f2150215f5662f0f78e9ab5f5059da8f64d2940479d4a9b0bc, intake workflow sha256=1111111111111111111111111111111111111111111111111111111111111111, reviewer workflow sha256=2222222222222222222222222222222222222222222222222222222222222222, delivery workflow sha256=3333333333333333333333333333333333333333333333333333333333333333',
    '[gated] boundaries: every approval in the matrix was SIMULATED reviewer input (a separate recorded HTTP action by the test suite — not a human review); all services and data are local fictional mocks, no live outcome is claimed',
  ];
  return lines.join('\r\n');
}

/** Strip one vocabulary line family out of a capture (fail-closed fixtures). */
function captureWithout(match) {
  return fixtureCapture()
    .split(/\r?\n/)
    .filter((line) => !match.test(line))
    .join('\n');
}

/** The driver-supplied measurement inputs the full builder requires (Task 2). */
function fullBuildInput(parsed, extra = {}) {
  return {
    parsed,
    image_reference: FIXTURE_DIGEST_IMAGE,
    docker_client: '29.7.2',
    docker_compose: '5.4.0',
    head_commit: 'a'.repeat(40),
    ...extra,
  };
}

test('parseLauncherCapture parses the fixture capture into five distinct cases with exact counts, full-suite, preservation, version, and evidence hashes', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(
    evidence,
    'runtime/scripts/final-evidence.mjs must export the final evidence contract (parseLauncherCapture, buildFinalEvidenceRecord, verifyFinalEvidence, publishFinalEvidence, serializeFinalEvidence, DISCLOSURE_PATTERNS)'
  );

  const parsed = evidence.parseLauncherCapture(fixtureCapture());
  assert.equal(parsed.cases.length, 5, 'the fixture capture carries all five CASE PASS lines');
  assert.deepEqual(
    parsed.cases.map((entry) => entry.index),
    [1, 2, 3, 4, 5],
    'cases must keep the launcher fixed 1..5 order'
  );
  assert.deepEqual(
    parsed.cases.map((entry) => entry.name),
    EXPECTED_CASE_ORDER,
    'cases must keep the launcher fixed name order'
  );
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(
      parsed.cases[i].observed,
      EXPECTED_OBSERVED[i],
      `case ${EXPECTED_CASE_ORDER[i]} must carry its exact counted state`
    );
    assert.equal(parsed.cases[i].result, 'pass');
    assert.ok(
      typeof parsed.cases[i].summary === 'string' && parsed.cases[i].summary.length > 0,
      'each case must carry the launcher summary text'
    );
  }
  const names = new Set(parsed.cases.map((entry) => entry.name));
  assert.equal(names.size, 5, 'each of the five case groups is a distinct record entry');

  assert.equal(parsed.static_contracts, true, 'STATIC CONTRACTS PASS must be parsed');
  assert.deepEqual(parsed.full_suite, { passed: 5, total: 5, n8n_version: '2.37.10' });
  assert.deepEqual(parsed.preservation, { preserved: 14, total: 14 });
  assert.equal(parsed.n8n_version, '2.37.10', 'the exact-pin runtime version line must be parsed');
  assert.equal(parsed.evidence_hashes.historical_source, '4559c8516533a1f2150215f5662f0f78e9ab5f5059da8f64d2940479d4a9b0bc');
  assert.equal(parsed.evidence_hashes.intake_workflow, '1'.repeat(64));
  assert.equal(parsed.evidence_hashes.reviewer_workflow, '2'.repeat(64));
  assert.equal(parsed.evidence_hashes.delivery_workflow, '3'.repeat(64));
  assert.deepEqual(parsed.case_failures, [], 'a passing capture carries no CASE FAIL marker');
});

test('buildFinalEvidenceRecord produces the full PACK-01 record: exact commands, four exact versions, provenance head plus parsed sha256 values, per-case expected states with failure conditions, and limitations', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const parsed = evidence.parseLauncherCapture(fixtureCapture());
  const record = evidence.buildFinalEvidenceRecord(fullBuildInput(parsed));
  assert.equal(
    evidence.verifyFinalEvidence(record).ok,
    true,
    `the built full record must verify: ${JSON.stringify(evidence.verifyFinalEvidence(record).errors)}`
  );
  assert.equal(record.schema_version, 1);
  assert.equal(record.kind, 'flagship-intake-final-evidence');
  assert.equal(record.run.execution_mode, 'real-n8n');
  assert.equal(record.run.status, 'completed');
  assert.match(record.run.id, /^final-\d{8}T\d{6}Z$/, 'run.id must be final-<UTC timestamp>Z');

  // commands: the exact executed command strings (driver, launcher, verify,
  // and the two version-capture commands).
  assert.deepEqual(record.commands, [
    './runtime/run-final-evidence.sh',
    './runtime/run-gated-demo.sh',
    'node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json',
    'docker --version',
    'docker compose version',
  ]);

  // versions: four exact non-vague values.
  assert.deepEqual(record.versions, {
    docker_client: '29.7.2',
    docker_compose: '5.4.0',
    n8n_runtime: '2.37.10',
    image_reference: FIXTURE_DIGEST_IMAGE,
  });

  // provenance: the driver-captured head commit plus the sha256 values
  // machine-parsed from the launcher's evidence line.
  assert.equal(record.provenance.head, 'a'.repeat(40));
  assert.deepEqual(record.provenance.evidence_sha256, {
    historical_source: '4559c8516533a1f2150215f5662f0f78e9ab5f5059da8f64d2940479d4a9b0bc',
    intake_workflow: '1'.repeat(64),
    reviewer_workflow: '2'.repeat(64),
    delivery_workflow: '3'.repeat(64),
  });

  // cases: five entries, each with the launcher-asserted expected counted
  // state (observed == expected) and a failure_condition naming what
  // divergence would have failed the case.
  assert.equal(record.cases.length, 5);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(record.cases[i].expected, EXPECTED_OBSERVED[i], `case ${i + 1} must carry its expected counted state`);
    assert.deepEqual(record.cases[i].observed, record.cases[i].expected, 'observed must equal expected');
    assert.ok(
      typeof record.cases[i].failure_condition === 'string' && record.cases[i].failure_condition.length > 20,
      `case ${i + 1} must carry failure_condition prose`
    );
  }
  assert.deepEqual(record.preservation, { preserved: 14, total: 14 });

  // limitations: a non-empty array with at least the six required entries.
  assert.ok(Array.isArray(record.limitations), 'limitations must be an array');
  assert.ok(record.limitations.length >= 6, 'limitations must carry at least six entries');
});

test('buildFinalEvidenceRecord is fail-closed on empty, interrupted, partial, or contradictory captures', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const attempt = (text) =>
    evidence.buildFinalEvidenceRecord({
      parsed: evidence.parseLauncherCapture(text),
      image_reference: FIXTURE_DIGEST_IMAGE,
    });

  assert.throws(
    () => attempt(''),
    /CASE PASS|case/i,
    'a capture with zero CASE PASS lines must be rejected'
  );
  assert.throws(
    () => attempt('[gated] running full-suite case 1/5: tracer\nTAP version 13'),
    /CASE PASS|case/i,
    'unrelated launcher noise with no CASE PASS lines must be rejected'
  );
  assert.throws(
    () => attempt(captureWithout(/FULL-SUITE PASS/)),
    /FULL-SUITE/i,
    'a capture missing the FULL-SUITE PASS line must be rejected'
  );
  assert.throws(
    () => attempt(captureWithout(/STATIC CONTRACTS PASS/)),
    /STATIC CONTRACTS/i,
    'a capture missing the STATIC CONTRACTS PASS line must be rejected'
  );
  assert.throws(
    () =>
      attempt(
        `${fixtureCapture()}\n[gated] FAIL: CASE FAIL (2/5) reviewer-gate: expected CRM ATTEMPTS=0, got 1 — NOT a pass`
      ),
    /CASE FAIL/i,
    'a capture containing a CASE FAIL marker must be rejected even when five PASS lines also exist'
  );
  assert.throws(
    () => attempt(captureWithout(/unrelated containers preserved:|preservation: /)),
    /preserv/i,
    'a capture with no preservation line must be rejected'
  );
  assert.throws(
    () =>
      attempt(
        fixtureCapture()
          .replace('unrelated containers preserved: 14/14', 'unrelated containers preserved: 13/14')
          .replace('preservation: 14/14', 'preservation: 13/14')
      ),
    /preserv/i,
    'a preservation mismatch (13/14) must be rejected'
  );
  assert.throws(
    () =>
      attempt(
        fixtureCapture()
          .replace('CASE PASS (4/5) intake-idempotency', 'CASE PASS (4/5) duplicate-name')
          .replace('CASE PASS (2/5) reviewer-gate', 'CASE PASS (2/5) duplicate-name')
      ),
    /distinct|order|index/i,
    'duplicate case names must be rejected'
  );
  assert.throws(
    // IN-07: only the runtime-version line varies (2.37.11) — the FULL-SUITE
    // line keeps 2.37.10, so the two version observations must disagree.
    () => attempt(fixtureCapture().replace('real n8n runtime version: 2.37.10', 'real n8n runtime version: 2.37.11')),
    /version/i,
    'a runtime-version line disagreeing with the FULL-SUITE line must be rejected'
  );
});

test('verifyFinalEvidence rejects records with vague or empty versions, non-digest images, and tampered structure', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const record = evidence.buildFinalEvidenceRecord(
    fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()))
  );

  const bad = (mutation) => {
    const clone = structuredClone(record);
    mutation(clone);
    return evidence.verifyFinalEvidence(clone);
  };
  const mustReject = [
    ['empty n8n version', (r) => { r.versions.n8n_runtime = ''; }],
    ['vague n8n version', (r) => { r.versions.n8n_runtime = '1.x'; }],
    ['latest n8n version', (r) => { r.versions.n8n_runtime = 'latest'; }],
    ['tag image reference', (r) => { r.versions.image_reference = 'n8nio/n8n:latest'; }],
    ['short digest', (r) => { r.versions.image_reference = `n8nio/n8n@sha256:${'a'.repeat(63)}`; }],
    ['simulated execution mode', (r) => { r.run.execution_mode = 'simulated'; }],
    ['interrupted status', (r) => { r.run.status = 'interrupted'; }],
    ['wrong kind', (r) => { r.kind = 'flagship-intake-baseline'; }],
    ['wrong schema version', (r) => { r.schema_version = 2; }],
    ['dropped case', (r) => { r.cases.pop(); }],
    ['tampered case count', (r) => { r.cases[2].observed.crm_effects = 99; }],
    ['failed case result', (r) => { r.cases[0].result = 'fail'; }],
    ['out-of-order indexes', (r) => { r.cases[0].index = 6; }],
    ['preservation mismatch in record', (r) => { r.preservation.preserved = 13; }],
    ['full-suite failure in record', (r) => { r.full_suite.passed = 4; }],
    ['static contracts missing', (r) => { delete r.static_contracts; }],
  ];
  for (const [label, mutation] of mustReject) {
    const verdict = bad(mutation);
    assert.equal(verdict.ok, false, `${label} must be rejected`);
    assert.ok(verdict.errors.length > 0, `${label} must produce explicit errors`);
  }
  assert.equal(evidence.verifyFinalEvidence(record).ok, true, 'the untampered record still verifies');
});

test('publication is atomic and fail-closed — a rejected record writes nothing; an accepted record renames a temp sibling only after verify', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const record = evidence.buildFinalEvidenceRecord(
    fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()))
  );

  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-pub-'));
  const destination = path.join(directory, 'final-evidence-log.json');
  try {
    // Rejected record: throws, writes nothing, leaves no temp sibling.
    const rejected = structuredClone(record);
    rejected.versions.n8n_runtime = '2.x';
    assert.throws(() => evidence.publishFinalEvidence(rejected, destination), /n8n_runtime|vague|exact/i);
    assert.equal(existsSync(destination), false, 'a rejected record must not be published');
    assert.deepEqual(readdirSync(directory), [], 'a rejected record must leave no temporary sibling');

    // Accepted record: published atomically, readable, independently verifies.
    const published = evidence.publishFinalEvidence(record, destination);
    assert.equal(published.ok, true);
    assert.equal(published.destination, destination);
    const reread = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(evidence.verifyFinalEvidence(reread).ok, true, 'the published artifact must re-verify');
    assert.deepEqual(readdirSync(directory), ['final-evidence-log.json'], 'no temporary sibling may survive publication');
    assert.match(readFileSync(destination, 'utf8'), /\n$/, 'the published record ends with a newline');

    // Deterministic serialization: the same logical record serializes to
    // identical bytes (canonical key order), so re-publication is a no-op diff.
    const again = evidence.publishFinalEvidence(structuredClone(record), destination);
    assert.equal(again.sha256, published.sha256, 'identical logical records must serialize byte-identically');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A temp git repo containing exactly the four provenance evidence paths,
// committed, so the CLI verify path can be exercised end-to-end against a
// record whose provenance genuinely binds to that repo's git bytes (CR-01).
async function makeProvenanceRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'final-evidence-bind-'));
  const files = [
    'workflows/client-intake-pipeline.json',
    'runtime/demo/workflows/intake-stage.json',
    'runtime/demo/workflows/reviewer-decision.json',
    'runtime/demo/workflows/approved-delivery.json',
  ];
  for (const relative of files) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `fictional committed bytes for ${relative}\n`);
  }
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.name', 'Fictional Tester');
  git('config', 'user.email', 'tester@example.com'); // disclosure-waiver: synthetic temp-repo git identity (fictional), not real contact data
  git('add', ...files);
  git('commit', '-qm', 'fictional provenance fixture');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const hashes = {};
  for (const relative of files) {
    hashes[relative] = createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex');
  }
  return { root, head, hashes };
}

// Rewrite a fixture record's provenance to genuinely describe the temp repo,
// so binding must pass against it (and only against it).
function rebindProvenance(record, { head, hashes }) {
  const clone = structuredClone(record);
  clone.provenance.head = head;
  clone.provenance.evidence_sha256 = {
    historical_source: hashes['workflows/client-intake-pipeline.json'],
    intake_workflow: hashes['runtime/demo/workflows/intake-stage.json'],
    reviewer_workflow: hashes['runtime/demo/workflows/reviewer-decision.json'],
    delivery_workflow: hashes['runtime/demo/workflows/approved-delivery.json'],
  };
  return clone;
}

test('the CLI verify verb re-checks a published record from disk alone and exits non-zero on corruption', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-cli-'));
  const repo = await makeProvenanceRepo();
  try {
    const record = rebindProvenance(
      evidence.buildFinalEvidenceRecord(fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()))),
      repo
    );
    const good = path.join(directory, 'good.json');
    evidence.publishFinalEvidence(record, good);
    const accepted = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', good], {
      encoding: 'utf8',
      cwd: repo.root,
    });
    assert.equal(accepted.status, 0, `a verified record must pass the CLI (stderr: ${accepted.stderr})`);
    const report = JSON.parse(accepted.stdout);
    assert.equal(report.ok, true);

    const tampered = structuredClone(record);
    tampered.cases[4].observed.crm_attempts = 1; // hand-edit breaks observed==matrix
    const badFile = path.join(directory, 'bad.json');
    writeFileSync(badFile, `${JSON.stringify(tampered, null, 2)}\n`);
    const rejected = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', badFile], {
      encoding: 'utf8',
      cwd: repo.root,
    });
    assert.notEqual(rejected.status, 0, 'a hand-edited record must fail the CLI');
    assert.equal(JSON.parse(rejected.stdout).ok, false);

    const missing = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', path.join(directory, 'absent.json')], {
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0, 'a missing record must fail the CLI');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('bindProvenanceToGit binds the recorded head and all four evidence hashes to actual git bytes; forged heads/hashes fail', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');
  assert.equal(
    typeof evidence.bindProvenanceToGit,
    'function',
    'runtime/scripts/final-evidence.mjs must export bindProvenanceToGit (CR-01: verify must bind provenance to git bytes, not just check shapes)'
  );
  assert.deepEqual(Object.keys(evidence.EVIDENCE_PATH_MAP ?? {}).sort(), [
    'delivery_workflow',
    'historical_source',
    'intake_workflow',
    'reviewer_workflow',
  ], 'EVIDENCE_PATH_MAP must name the four provenance-bound repo paths');

  // The committed accepted record binds against THIS repository's git bytes.
  const committed = JSON.parse(readFileSync(COMMITTED_RECORD, 'utf8'));
  const bound = evidence.bindProvenanceToGit(committed, ROOT);
  assert.equal(bound.ok, true, `the committed record must bind to this repository: ${JSON.stringify(bound.errors)}`);

  // A forged head (shape-valid but absent from git) must not bind.
  const forgedHead = structuredClone(committed);
  forgedHead.provenance.head = 'f'.repeat(40);
  const headVerdict = evidence.bindProvenanceToGit(forgedHead, ROOT);
  assert.equal(headVerdict.ok, false, 'a forged provenance.head must fail git binding');

  // Fabricated hashes (head real) must not bind.
  const forgedHashes = structuredClone(committed);
  forgedHashes.provenance.evidence_sha256 = {
    historical_source: '0'.repeat(64),
    intake_workflow: '0'.repeat(64),
    reviewer_workflow: '0'.repeat(64),
    delivery_workflow: '0'.repeat(64),
  };
  const hashVerdict = evidence.bindProvenanceToGit(forgedHashes, ROOT);
  assert.equal(hashVerdict.ok, false, 'fabricated evidence_sha256 values must fail git binding');
  assert.ok(
    hashVerdict.errors.length >= 4,
    'every fabricated hash must be named (one error per bound path)'
  );

  // A record describing a DIFFERENT repository's bytes must not bind here.
  const repo = await makeProvenanceRepo();
  try {
    const foreign = rebindProvenance(
      evidence.buildFinalEvidenceRecord(fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()))),
      repo
    );
    assert.equal(evidence.bindProvenanceToGit(foreign, ROOT).ok, false, 'a record bound to another repo must not bind here');
    assert.equal(evidence.bindProvenanceToGit(foreign, repo.root).ok, true, 'the same record must bind inside its own repo');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('the CLI verify verb never skips provenance binding: the committed record passes; a forged record exits non-zero with no ok:true', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  // The committed record, verified from the real repo root: shape + git binding.
  const accepted = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', COMMITTED_RECORD], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(accepted.status, 0, `the committed record must pass the bound CLI verify (stderr: ${accepted.stderr})`);
  assert.equal(JSON.parse(accepted.stdout).ok, true);

  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-forged-'));
  try {
    // Forged head + fabricated hashes: shape-valid, attribution fake. The CLI
    // must exit non-zero and must never print ok:true.
    const committed = JSON.parse(readFileSync(COMMITTED_RECORD, 'utf8'));
    const forged = structuredClone(committed);
    forged.provenance.head = 'f'.repeat(40);
    forged.provenance.evidence_sha256 = {
      historical_source: '0'.repeat(64),
      intake_workflow: '1'.repeat(64),
      reviewer_workflow: '2'.repeat(64),
      delivery_workflow: '3'.repeat(64),
    };
    const forgedFile = path.join(directory, 'forged.json');
    writeFileSync(forgedFile, `${JSON.stringify(forged, null, 2)}\n`);
    const rejected = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', forgedFile], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.notEqual(rejected.status, 0, 'a forged-head record must fail the CLI verify');
    assert.doesNotMatch(rejected.stdout, /"ok":\s*true/, 'the CLI must never print ok:true for a forged record');

    // A real head with ONE fabricated hash must also fail (no partial binding).
    const oneBad = structuredClone(committed);
    oneBad.provenance.evidence_sha256.intake_workflow = '0'.repeat(64);
    const oneBadFile = path.join(directory, 'one-bad-hash.json');
    writeFileSync(oneBadFile, `${JSON.stringify(oneBad, null, 2)}\n`);
    const partial = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', oneBadFile], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.notEqual(partial.status, 0, 'a single fabricated hash must fail the CLI verify');
    assert.doesNotMatch(partial.stdout, /"ok":\s*true/, 'no ok:true may appear for a partially-forged record');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verifyFinalEvidence is fail-closed on every PACK-01 proof family: commands, docker versions, provenance, expected states, failure conditions, and limitation themes', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const build = () =>
    evidence.buildFinalEvidenceRecord(fullBuildInput(evidence.parseLauncherCapture(fixtureCapture())));

  const verifyCommand = 'node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json';
  const mustReject = [
    ...[
      ['missing commands', (r) => { delete r.commands; }],
      ['empty commands', (r) => { r.commands = []; }],
      ['missing driver command', (r) => { r.commands = r.commands.filter((c) => c !== './runtime/run-final-evidence.sh'); }],
      ['missing launcher command', (r) => { r.commands = r.commands.filter((c) => c !== './runtime/run-gated-demo.sh'); }],
      ['missing verify command', (r) => { r.commands = r.commands.filter((c) => c !== verifyCommand); }],
      ['vague docker client version', (r) => { r.versions.docker_client = 'latest'; }],
      ['empty docker compose version', (r) => { r.versions.docker_compose = ''; }],
      ['missing docker client version', (r) => { delete r.versions.docker_client; }],
      ['missing provenance head', (r) => { delete r.provenance.head; }],
      ['short provenance head', (r) => { r.provenance.head = 'abc123'; }],
      ['missing sha256 family member', (r) => { delete r.provenance.evidence_sha256.delivery_workflow; }],
      ['too few sha256 values', (r) => { r.provenance.evidence_sha256 = { historical_source: '4'.repeat(64) }; }],
      ['malformed sha256 value', (r) => { r.provenance.evidence_sha256.intake_workflow = 'not-a-hash'; }],
      ['case missing expected block', (r) => { delete r.cases[0].expected; }],
      ['observed diverges from expected', (r) => { r.cases[2].expected.crm_effects = 2; }],
      [
        'expected disagrees with the launcher-asserted matrix',
        (r) => {
          r.cases[4].expected.crm_attempts = 3;
          r.cases[4].observed.crm_attempts = 3;
        },
      ],
      ['case missing failure condition', (r) => { r.cases[1].failure_condition = ''; }],
      ['missing limitations', (r) => { delete r.limitations; }],
      ['empty limitations', (r) => { r.limitations = []; }],
      ['too few limitations', (r) => { r.limitations = r.limitations.slice(0, 5); }],
      ['limitations missing egress attribution theme', (r) => { r.limitations = r.limitations.filter((l) => !/allowlist/i.test(l)); }],
      ['limitations missing simulated-reviewer theme', (r) => { r.limitations = r.limitations.filter((l) => !/simulated/i.test(l)); }],
      ['limitations missing registration-window theme', (r) => { r.limitations = r.limitations.filter((l) => !/registration window/.test(l)); }],
      ['limitations missing not-implemented recovery theme', (r) => { r.limitations = r.limitations.filter((l) => !/response-loss-after-commit/i.test(l)); }],
      ['limitations missing tmpfs/disk boundary theme', (r) => { r.limitations = r.limitations.filter((l) => !/tmpfs/.test(l)); }],
      ['limitations missing demo-state volume theme', (r) => { r.limitations = r.limitations.filter((l) => !/demo-state/.test(l)); }],
    ],
  ];
  for (const [label, mutation] of mustReject) {
    const clone = structuredClone(build());
    mutation(clone);
    const verdict = evidence.verifyFinalEvidence(clone);
    assert.equal(verdict.ok, false, `${label} must be rejected (fail-closed PACK-01 proof completeness)`);
    assert.ok(verdict.errors.length > 0, `${label} must produce explicit errors`);
  }
  assert.equal(evidence.verifyFinalEvidence(build()).ok, true, 'the untampered full record still verifies');
});

test('the disclosure scan inside verify rejects a record whose serialization carries a URL or raw email anywhere', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const build = () =>
    evidence.buildFinalEvidenceRecord(fullBuildInput(evidence.parseLauncherCapture(fixtureCapture())));

  const withUrl = build();
  withUrl.commands = [...(withUrl.commands ?? []), 'run against https://api.example.invalid/verify']; // disclosure-waiver: intentional negative-test fixture for the disclosure scan
  const urlVerdict = evidence.verifyFinalEvidence(withUrl);
  assert.equal(urlVerdict.ok, false, 'an embedded http(s) URL must fail the disclosure scan');
  assert.ok(urlVerdict.errors.some((error) => /URL/i.test(error)), 'the rejection must name the URL rule');

  const withEmail = build();
  withEmail.notes = ['contact was maria.r@example.com']; // disclosure-waiver: intentional negative-test fixture (fictional fixture email) for the disclosure scan
  const emailVerdict = evidence.verifyFinalEvidence(withEmail);
  assert.equal(emailVerdict.ok, false, 'an embedded raw email must fail the disclosure scan');
  assert.ok(emailVerdict.errors.some((error) => /email/i.test(error)), 'the rejection must name the email rule');

  assert.equal(evidence.verifyFinalEvidence(build()).ok, true, 'the clean record still verifies');
});

test('serialization is deterministic: two structurally identical records serialize byte-identically, a forced run id is honored, and the published artifact is already canonical', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const forced = 'final-20260101T000000Z';
  const a = evidence.buildFinalEvidenceRecord(
    fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()), { run_id: forced })
  );
  assert.equal(a.run.id, forced, 'a forced run id must be honored so separately-built records are comparable');

  const b = evidence.buildFinalEvidenceRecord(
    fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()), { run_id: forced })
  );
  assert.equal(
    evidence.serializeFinalEvidence(a),
    evidence.serializeFinalEvidence(b),
    'two structurally identical logical records must serialize to identical bytes'
  );
  assert.equal(
    evidence.serializeFinalEvidence(structuredClone(a)),
    evidence.serializeFinalEvidence(a),
    'serialization must not depend on key-insertion order'
  );

  // The published artifact is already canonical: re-serializing the parsed
  // file reproduces its exact bytes.
  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-det-'));
  try {
    const destination = path.join(directory, 'final-evidence-log.json');
    evidence.publishFinalEvidence(a, destination);
    const raw = readFileSync(destination, 'utf8');
    assert.equal(
      evidence.serializeFinalEvidence(JSON.parse(raw)),
      raw,
      'the published artifact must already be in canonical serialization'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime/run-final-evidence.sh exists as the one-command driver contract: executes the unchanged launcher, captures outside the launcher tree, never pulls, prints exactly one FINAL-EVIDENCE PASS line', async () => {
  assert.ok(existsSync(DRIVER_SCRIPT), 'runtime/run-final-evidence.sh must exist (one repository-root command)');
  assert.ok(existsSync(LAUNCHER_SCRIPT), 'runtime/run-gated-demo.sh must exist unchanged');

  const driver = readFileSync(DRIVER_SCRIPT, 'utf8');
  const driverStat = statSync(DRIVER_SCRIPT);

  assert.equal(driverStat.mode & 0o111, 0o111, 'the driver must be executable');
  assert.match(driver, /set -Eeuo pipefail/, 'the driver must run under strict mode');
  assert.match(
    driver,
    /\.\/runtime\/run-gated-demo\.sh/,
    'the driver must EXECUTE the unchanged launcher (not duplicate it)'
  );
  assert.match(driver, /mktemp -d/, 'the driver must own a mktemp capture directory outside the repo tree');
  assert.doesNotMatch(
    driver,
    /runtime\/demo\/\.generated[^\n]*CAPTURE|CAPTURE[^\n]*runtime\/demo\/\.generated/,
    'the capture file must live OUTSIDE the launcher ephemeral tree runtime/demo/.generated'
  );
  assert.match(driver, /docker info/, 'the driver must fail closed when the Docker daemon is unavailable');
  assert.match(driver, /docker image inspect/, 'the driver must assert the pinned image is cached');
  assert.doesNotMatch(driver, /docker pull/, 'the driver must never pull an image');
  assert.match(
    driver,
    /FINAL-EVIDENCE PASS: \$\{?[A-Z_]*CASE_COUNT/,
    'the driver must print exactly one FINAL-EVIDENCE PASS terminal line whose case count comes from the built record, not a hardcode'
  );
  assert.match(
    driver,
    /FINAL-EVIDENCE PASS: [^"'\n]*; record verified and published/,
    'the terminal success line must follow the exact documented shape'
  );
  assert.match(
    driver,
    /final-evidence\.mjs build --capture/,
    'the driver must invoke the builder with the captured output'
  );
  assert.match(
    driver,
    /final-evidence\.mjs verify/,
    'the driver must re-verify the published record before any success line'
  );
  // Task 2: the driver captures the version strings and the head commit and
  // passes them to the builder via flags — the builder stays free of Docker
  // and git side effects.
  assert.match(driver, /docker --version/, 'the driver must capture the docker client version with the exact recorded command');
  assert.match(driver, /docker compose version/, 'the driver must capture the docker compose version with the exact recorded command');
  assert.match(driver, /git rev-parse HEAD/, 'the driver must capture the head commit for provenance');
  assert.match(driver, /--docker-client/, 'the driver must pass the captured client version to the builder');
  assert.match(driver, /--docker-compose/, 'the driver must pass the captured compose version to the builder');
  assert.match(driver, /--head-commit/, 'the driver must pass the captured head commit to the builder');
  assert.match(driver, /--image-reference/, 'the driver must pass the digest-pinned image reference to the builder');

  // CR-02: the driver must refuse a dirty tracked tree BEFORE any Docker
  // contact, re-check HEAD after the launcher run (before attributing the
  // evidence to the pre-run commit), and verify the evidence manifest around
  // publication.
  const dockerIdx = driver.indexOf('docker info');
  const dirtyGateIdx = driver.indexOf('git status --porcelain --untracked-files=no');
  assert.notEqual(dirtyGateIdx, -1, 'the driver must gate on a clean tracked tree (git status --porcelain --untracked-files=no)');
  assert.ok(dirtyGateIdx !== -1 && dirtyGateIdx < dockerIdx, 'the tracked-clean gate must run BEFORE any Docker contact');
  assert.match(driver, /tracked tree is dirty/, 'the dirty-tree failure must carry an explicit reason');
  const launcherIdx = driver.indexOf('./runtime/run-gated-demo.sh 2>&1');
  const buildIdx = driver.indexOf('final-evidence.mjs build', launcherIdx);
  const headRecheckIdx = driver.indexOf('git rev-parse HEAD', launcherIdx);
  assert.ok(
    headRecheckIdx !== -1 && buildIdx !== -1 && headRecheckIdx < buildIdx,
    'the driver must re-check HEAD between the launcher run and the build — evidence may not bind a commit that moved mid-run'
  );
  assert.match(driver, /HEAD moved during the run/, 'the HEAD-recheck failure must carry an explicit reason');
  assert.match(driver, /evidence-manifest\.mjs bind/, 'the driver must bind the evidence manifest before building');
  assert.match(driver, /evidence-manifest\.mjs verify/, 'the driver must verify the evidence manifest after publication');
});

test('the committed runtime/evidence/final-evidence-log.json exists, carries the full PACK-01 contract, and verifies from disk alone', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  assert.ok(
    existsSync(COMMITTED_RECORD),
    'the PACK-01 evidence record must be committed at runtime/evidence/final-evidence-log.json — produced by ./runtime/run-final-evidence.sh from a REAL run, never hand-written'
  );
  const committed = JSON.parse(readFileSync(COMMITTED_RECORD, 'utf8'));
  const verdict = evidence.verifyFinalEvidence(committed);
  assert.equal(verdict.ok, true, `the committed record must independently verify: ${JSON.stringify(verdict.errors)}`);

  // The full PACK-01 shape, re-checked against the committed bytes.
  assert.ok(Array.isArray(committed.commands) && committed.commands.length >= 3, 'the committed record must carry the exact executed commands');
  assert.ok(
    committed.commands.includes('./runtime/run-final-evidence.sh') &&
      committed.commands.includes('./runtime/run-gated-demo.sh') &&
      committed.commands.includes('node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json'),
    'the committed commands must include the driver, the launcher, and the verify command'
  );
  for (const field of ['docker_client', 'docker_compose', 'n8n_runtime', 'image_reference']) {
    assert.ok(typeof committed.versions[field] === 'string' && committed.versions[field].length > 0, `versions.${field} must be an exact captured value`);
  }
  assert.match(committed.provenance.head, /^[0-9a-f]{40}$/, 'provenance.head must be the full head commit');
  const shaKeys = Object.keys(committed.provenance.evidence_sha256 ?? {});
  assert.ok(shaKeys.length >= 4, 'provenance must carry at least four parsed sha256 values');
  for (const key of shaKeys) {
    assert.match(committed.provenance.evidence_sha256[key], /^[0-9a-f]{64}$/, `evidence_sha256.${key} must be a 64-hex sha256`);
  }
  for (const entry of committed.cases) {
    assert.ok(entry.expected, `case ${entry.name} must carry its expected counted state`);
    assert.deepEqual(entry.observed, entry.expected, `case ${entry.name} observed must equal expected`);
    assert.ok(typeof entry.failure_condition === 'string' && entry.failure_condition.length > 20, `case ${entry.name} must carry failure_condition prose`);
  }
  assert.ok(Array.isArray(committed.limitations) && committed.limitations.length >= 6, 'the committed record must carry at least six limitations');

  const cli = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', COMMITTED_RECORD], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(cli.status, 0, `the committed record must pass the CLI verifier (stderr: ${cli.stderr})`);

  // The committed JSON survives the repo's CI credential grep patterns.
  const raw = readFileSync(COMMITTED_RECORD, 'utf8');
  assert.doesNotMatch(raw, /"apiKey"|"Authorization"|"Bearer |"token"|meta\.instanceId/, 'no CI-grep key names may appear in the committed record');
});

// --- 03-02 Task 1: record-to-record comparison + verified rerun section --------

test('compareFinalEvidenceRecords: identical counted states pass; divergence names the case; missing case, non-completed status, and observed!=expected fail', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');
  assert.equal(
    typeof evidence.compareFinalEvidenceRecords,
    'function',
    'runtime/scripts/final-evidence.mjs must export compareFinalEvidenceRecords (run-vs-run matrix equality)'
  );

  const build = (runId) =>
    evidence.buildFinalEvidenceRecord(
      fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()), { run_id: runId })
    );
  const a = build('final-20260101T000001Z');
  const b = build('final-20260101T000002Z');

  const verdict = evidence.compareFinalEvidenceRecords(a, b);
  assert.equal(verdict.ok, true, 'two records with identical five-case counted states must compare equal');
  assert.equal(verdict.per_case_identical, true);
  assert.equal(verdict.run_a, 'final-20260101T000001Z');
  assert.equal(verdict.run_b, 'final-20260101T000002Z');

  // One divergent count (kept internally observed==expected so the failure is
  // attributed to run-vs-run divergence) must fail naming the case.
  const divergent = structuredClone(b);
  divergent.cases[4].observed.crm_attempts = 3;
  divergent.cases[4].expected.crm_attempts = 3;
  assert.throws(
    () => evidence.compareFinalEvidenceRecords(a, divergent),
    /crm-recovery.*crm_attempts|crm_attempts.*crm-recovery/,
    'a divergent counted state must fail the comparison naming the case and field'
  );

  // A record with a missing case must fail.
  const missing = structuredClone(b);
  missing.cases.pop();
  assert.throws(() => evidence.compareFinalEvidenceRecords(a, missing), /case/i, 'a missing case must fail');

  // A record with a non-completed status must fail.
  const interrupted = structuredClone(b);
  interrupted.run.status = 'interrupted';
  assert.throws(
    () => evidence.compareFinalEvidenceRecords(a, interrupted),
    /completed|status/i,
    'a non-completed record is not comparable evidence'
  );

  // observed != expected inside one record must fail inside compare.
  const tampered = structuredClone(b);
  tampered.cases[2].observed.crm_effects = 0;
  assert.throws(
    () => evidence.compareFinalEvidenceRecords(a, tampered),
    /observed|expected/i,
    'compare must enforce observed==expected inside each record (the accepted matrix, no second hardcoded copy)'
  );
});

test('the CLI compare verb prints the RERUN COMPARISON PASS line naming both run ids and exits 0', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-compare-'));
  try {
    const build = (runId) =>
      evidence.buildFinalEvidenceRecord(
        fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()), { run_id: runId })
      );
    const fileA = path.join(directory, 'a.json');
    const fileB = path.join(directory, 'b.json');
    evidence.publishFinalEvidence(build('final-20260101T000001Z'), fileA);
    evidence.publishFinalEvidence(build('final-20260101T000002Z'), fileB);

    const compared = spawnSync(process.execPath, [EVIDENCE_CLI, 'compare', fileA, fileB], { encoding: 'utf8' });
    assert.equal(compared.status, 0, `compare must exit 0 on identical records (stderr: ${compared.stderr})`);
    assert.match(
      compared.stdout,
      /RERUN COMPARISON PASS: per-case counted states identical \(final-20260101T000001Z vs final-20260101T000002Z\)/,
      'the success line must follow the exact documented shape'
    );

    // A divergent pair must exit non-zero with no PASS line.
    const divergent = structuredClone(build('final-20260101T000003Z'));
    divergent.cases[4].observed.crm_attempts = 3;
    divergent.cases[4].expected.crm_attempts = 3;
    const fileC = path.join(directory, 'c.json');
    writeFileSync(fileC, `${JSON.stringify(divergent, null, 2)}\n`);
    const failed = spawnSync(process.execPath, [EVIDENCE_CLI, 'compare', fileA, fileC], { encoding: 'utf8' });
    assert.notEqual(failed.status, 0, 'a divergent pair must exit non-zero');
    assert.doesNotMatch(failed.stdout, /RERUN COMPARISON PASS/, 'no success line may appear on divergence');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('build --compare-with verifies and compares BEFORE publication: success adds a verified run.rerun section; a bad prior fails closed leaving the destination byte-unchanged', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-rerun-'));
  const repo = await makeProvenanceRepo();
  try {
    // The capture's evidence sha256 line carries the temp repo's REAL hashes
    // and --head-commit its real head, so the built record's provenance
    // genuinely binds to the temp repo (CR-01) and the CLI verify below must
    // pass from inside it.
    const captureText = fixtureCapture()
      .replace(/historical source sha256=[0-9a-f]{64}/, `historical source sha256=${repo.hashes['workflows/client-intake-pipeline.json']}`)
      .replace(/intake workflow sha256=[0-9a-f]{64}/, `intake workflow sha256=${repo.hashes['runtime/demo/workflows/intake-stage.json']}`)
      .replace(/reviewer workflow sha256=[0-9a-f]{64}/, `reviewer workflow sha256=${repo.hashes['runtime/demo/workflows/reviewer-decision.json']}`)
      .replace(/delivery workflow sha256=[0-9a-f]{64}/, `delivery workflow sha256=${repo.hashes['runtime/demo/workflows/approved-delivery.json']}`);
    const captureFile = path.join(directory, 'capture.log');
    writeFileSync(captureFile, captureText);

    const priorPath = path.join(directory, 'prior.json');
    evidence.publishFinalEvidence(
      evidence.buildFinalEvidenceRecord(
        fullBuildInput(evidence.parseLauncherCapture(captureText), { run_id: 'final-20260101T000001Z' })
      ),
      priorPath
    );

    const destination = path.join(directory, 'destination.json');
    const buildArgs = (extra = []) => [
      EVIDENCE_CLI,
      'build',
      '--capture',
      captureFile,
      '--output',
      destination,
      '--image-reference',
      FIXTURE_DIGEST_IMAGE,
      '--docker-client',
      '29.7.2',
      '--docker-compose',
      '5.4.0',
      '--head-commit',
      repo.head,
      ...extra,
    ];

    // A bad prior (hand-edited until it no longer verifies) must abort the
    // build BEFORE publication, leaving a previously published destination
    // byte-unchanged, with no success marker.
    const badPriorPath = path.join(directory, 'prior-bad.json');
    const badPrior = JSON.parse(readFileSync(priorPath, 'utf8'));
    badPrior.cases[4].observed.crm_attempts = 3;
    writeFileSync(badPriorPath, `${JSON.stringify(badPrior, null, 2)}\n`);
    evidence.publishFinalEvidence(
      evidence.buildFinalEvidenceRecord(
        fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()), { run_id: 'final-20260101T000009Z' })
      ),
      destination
    );
    const bytesBefore = readFileSync(destination);
    const rejected = spawnSync(
      process.execPath,
      buildArgs(['--compare-with', badPriorPath, '--clean-sandbox-checks', 'a,b', '--phase-base', FROZEN_PHASE_BASE_SHA]),
      { encoding: 'utf8' }
    );
    assert.notEqual(rejected.status, 0, 'a prior that fails verification must abort the build');
    assert.deepEqual(readFileSync(destination), bytesBefore, 'the destination must remain byte-unchanged');
    assert.doesNotMatch(rejected.stdout, /CLEAN-RERUN PASS/, 'no rerun success marker may be emitted');

    // A successful --compare-with build publishes a record carrying the
    // verified rerun section and re-verifies from disk alone.
    const published = spawnSync(
      process.execPath,
      buildArgs([
        '--compare-with',
        priorPath,
        '--clean-sandbox-checks',
        'no-owned-containers,no-owned-networks,no-owned-volumes,generated-tree-absent,launcher-lock-absent',
        '--phase-base',
        FROZEN_PHASE_BASE_SHA,
      ]),
      { encoding: 'utf8' }
    );
    assert.equal(published.status, 0, `the rerun build must succeed (stderr: ${published.stderr})`);
    const record = JSON.parse(readFileSync(destination, 'utf8'));
    assert.deepEqual(record.run.rerun, {
      compared_with: 'final-20260101T000001Z',
      per_case_identical: true,
      clean_sandbox_checks: [
        'no-owned-containers',
        'no-owned-networks',
        'no-owned-volumes',
        'generated-tree-absent',
        'launcher-lock-absent',
      ],
      phase_base: FROZEN_PHASE_BASE_SHA,
    }, 'only a successful comparison adds run.rerun with the prior run id, identity flag, checks, and phase base');
    assert.equal(evidence.verifyFinalEvidence(record).ok, true, 'the rerun record must verify');
    const verified = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', destination], {
      encoding: 'utf8',
      cwd: repo.root,
    });
    assert.equal(verified.status, 0, 'the CLI must re-verify the rerun record from disk alone');

    // --clean-sandbox-checks without --compare-with is a usage error.
    const stray = spawnSync(process.execPath, buildArgs(['--clean-sandbox-checks', 'a']), { encoding: 'utf8' });
    assert.notEqual(stray.status, 0, 'rerun-section flags without --compare-with must be rejected');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('compareFinalEvidenceRecords enforces the launcher matrix and the full counter shape; the compare CLI verifies both inputs (WR-01)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const build = (runId) =>
    evidence.buildFinalEvidenceRecord(
      fullBuildInput(evidence.parseLauncherCapture(fixtureCapture()), { run_id: runId })
    );

  // False-pass (a): two records agreeing on the SAME WRONG counts (99/99 in
  // both observed and expected of every case) must throw — expected must
  // equal the launcher-asserted matrix, not merely match the other record.
  const wrongA = build('final-20260101T000001Z');
  const wrongB = build('final-20260101T000002Z');
  for (const record of [wrongA, wrongB]) {
    for (const entry of record.cases) {
      entry.observed.crm_attempts = 99;
      entry.expected.crm_attempts = 99;
    }
  }
  assert.throws(
    () => evidence.compareFinalEvidenceRecords(wrongA, wrongB),
    /matrix|expected\.crm_attempts/,
    'a 99/99 pair (both records internally consistent but off-matrix) must fail the comparison'
  );

  // False-pass (b): records whose counters are missing entirely (only queue
  // present in both observed and expected) must throw a named rejection —
  // undefined === undefined is not equality of counted states.
  const strip = (record) => {
    for (const entry of record.cases) {
      entry.observed = { queue: entry.observed.queue };
      entry.expected = { queue: entry.expected.queue };
    }
    return record;
  };
  assert.throws(
    () => evidence.compareFinalEvidenceRecords(strip(build('final-20260101T000003Z')), strip(build('final-20260101T000004Z'))),
    /observed\.(approval_actions|crm_attempts|crm_effects)|non-negative integer/,
    'a queue-only pair (safety counters absent from both records) must fail the comparison'
  );

  // False-pass (c): a case whose observed block is absent entirely must be a
  // named rejection, never an uncontrolled TypeError.
  const noObserved = build('final-20260101T000005Z');
  delete noObserved.cases[2].observed;
  assert.throws(
    () => evidence.compareFinalEvidenceRecords(build('final-20260101T000006Z'), noObserved),
    /observed/,
    'a missing observed block must fail with a named rejection'
  );

  // The compare CLI must verify BOTH inputs before comparing: a pair of
  // unverified records (the 99/99 pair above — each fails verification on
  // its own) must exit non-zero with no PASS line.
  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-compare-wrong-'));
  try {
    const wrongFileA = path.join(directory, 'wrong-a.json');
    const wrongFileB = path.join(directory, 'wrong-b.json');
    writeFileSync(wrongFileA, `${JSON.stringify(wrongA, null, 2)}\n`);
    writeFileSync(wrongFileB, `${JSON.stringify(wrongB, null, 2)}\n`);
    const failed = spawnSync(process.execPath, [EVIDENCE_CLI, 'compare', wrongFileA, wrongFileB], {
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0, 'the compare CLI must refuse unverified inputs');
    assert.doesNotMatch(failed.stdout, /RERUN COMPARISON PASS/, 'no success line may appear for unverified inputs');
    assert.match(failed.stderr, /failed verification/, 'the CLI must attribute the failure to input verification');

    // Same for the queue-only pair.
    const queueOnlyA = path.join(directory, 'queue-a.json');
    const queueOnlyB = path.join(directory, 'queue-b.json');
    writeFileSync(queueOnlyA, `${JSON.stringify(strip(build('final-20260101T000007Z')), null, 2)}\n`);
    writeFileSync(queueOnlyB, `${JSON.stringify(strip(build('final-20260101T000008Z')), null, 2)}\n`);
    const queueFailed = spawnSync(process.execPath, [EVIDENCE_CLI, 'compare', queueOnlyA, queueOnlyB], {
      encoding: 'utf8',
    });
    assert.notEqual(queueFailed.status, 0, 'the compare CLI must refuse records with missing safety counters');
    assert.doesNotMatch(queueFailed.stdout, /RERUN COMPARISON PASS/, 'no success line may appear for counter-less records');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  // Sanity: two genuine records still compare equal.
  const verdict = evidence.compareFinalEvidenceRecords(build('final-20260101T000009Z'), build('final-20260101T000010Z'));
  assert.equal(verdict.ok, true, 'two genuine on-matrix records must still compare equal');
});

test('the rerun phase base is pinned to the frozen commit (WR-02): HEAD, branch names, and off-freeze SHAs are rejected; the committed record still verifies', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  assert.equal(
    typeof evidence.FROZEN_PHASE_BASE_SHA,
    'string',
    'runtime/scripts/final-evidence.mjs must export FROZEN_PHASE_BASE_SHA (the pinned phase-boundary commit)'
  );
  assert.equal(evidence.FROZEN_PHASE_BASE_SHA, FROZEN_PHASE_BASE_SHA);

  const build = () =>
    evidence.buildFinalEvidenceRecord(fullBuildInput(evidence.parseLauncherCapture(fixtureCapture())));
  const withBase = (base) => {
    const record = build();
    record.run.rerun = {
      compared_with: 'final-20260101T000001Z',
      per_case_identical: true,
      clean_sandbox_checks: ['no-owned-containers'],
      phase_base: base,
    };
    return record;
  };

  assert.equal(evidence.verifyFinalEvidence(withBase('HEAD')).ok, false, 'phase_base "HEAD" must be rejected — it vacates the disclosure scan and byte-identity gates');
  assert.equal(evidence.verifyFinalEvidence(withBase('main')).ok, false, 'a branch-name phase_base must be rejected');
  assert.equal(
    evidence.verifyFinalEvidence(withBase('c'.repeat(40))).ok,
    false,
    'an arbitrary 40-hex phase_base must be rejected — only the frozen phase boundary verifies'
  );
  assert.equal(
    evidence.verifyFinalEvidence(withBase(FROZEN_PHASE_BASE_SHA)).ok,
    true,
    'the frozen full SHA must verify as the phase base'
  );

  // The old staging-only boundary (short and full) must NOT verify in a
  // sanitized public checkout with a different, reachable phase base.
  assert.equal(
    evidence.verifyFinalEvidence(withBase('8d0b7c7')).ok,
    false,
    'the private staging short-form phase base must not verify in this release'
  );
  assert.equal(
    evidence.verifyFinalEvidence(withBase('8d0b7c74c1173f838280d28ee76a0d59ff0b0a5a')).ok,
    false,
    'the private staging full phase base must not verify in this release'
  );

  // The committed accepted record — republished by the successful clean
  // rerun — carries the full frozen SHA.
  const committed = JSON.parse(readFileSync(COMMITTED_RECORD, 'utf8'));
  assert.equal(
    committed.run.rerun.phase_base,
    FROZEN_PHASE_BASE_SHA,
    'the committed record carries the full frozen phase-base SHA'
  );
  assert.equal(
    evidence.verifyFinalEvidence(committed).ok,
    true,
    'the committed record must still verify after the phase-base tightening'
  );

  // The rerun driver pins the frozen base and refuses HEAD/short forms before
  // any Docker mutation.
  const rerunScript = readFileSync(path.join(ROOT, 'runtime', 'run-clean-rerun.sh'), 'utf8');
  assert.match(rerunScript, /19ce7afcfa1470512c7675cc5b0661e0714646d2/, 'the driver default must be the public-safe frozen full SHA');
  const argLoopEnd = rerunScript.indexOf('done', rerunScript.indexOf('while [ "$#" -gt 0 ]'));
  const dockerContact = rerunScript.indexOf('docker info');
  const baseValidation = rerunScript.indexOf('PHASE_BASE_SHA=');
  assert.ok(
    baseValidation !== -1 && baseValidation > argLoopEnd && baseValidation < dockerContact,
    'the driver must validate and resolve the phase base after argument parsing and BEFORE any Docker contact'
  );
  assert.match(rerunScript, /--phase-base HEAD is not a phase boundary/, 'the HEAD rejection must carry an explicit message');
  assert.match(rerunScript, /frozen phase boundary/, 'an off-freeze base must be rejected naming the frozen boundary');
});

test('the rerun is verification-only: stages candidate evidence outside the canonical log, gates on canonical byte-identity, and NEVER publishes (RR-03-A/RR-03-C)', async () => {
  const driver = readFileSync(DRIVER_SCRIPT, 'utf8');
  const rerunScript = readFileSync(path.join(ROOT, 'runtime', 'run-clean-rerun.sh'), 'utf8');

  // The evidence driver accepts a directed output path (candidate staging)
  // and itself verifies-then-promotes atomically.
  assert.match(driver, /--output\)/, 'run-final-evidence.sh must support --output <path> for candidate staging');
  assert.match(driver, /OUTPUT="runtime\/evidence\/final-evidence-log\.json"/, 'the standalone default must still publish directly to the canonical log');

  // The rerun driver stages a candidate INSIDE runtime/evidence/ (same
  // filesystem as the canonical log) and directs the evidence driver at it.
  assert.match(rerunScript, /CANDIDATE="runtime\/evidence\/\.clean-rerun-candidate\.json"/, 'the rerun must stage its candidate evidence at a fixed path inside runtime/evidence/');
  assert.match(rerunScript, /--output\s+"\$CANDIDATE"/, 'the rerun must direct run-final-evidence.sh at the candidate path');
  assert.match(rerunScript, /stale candidate/, 'a leftover candidate from an interrupted run must fail closed before Docker');
  const candidateCheckIdx = rerunScript.indexOf('[ ! -e "$CANDIDATE" ]');
  const dockerContactIdx = rerunScript.indexOf('docker info');
  assert.ok(
    candidateCheckIdx !== -1 && candidateCheckIdx < dockerContactIdx,
    'the stale-candidate pre-check must run before any Docker contact'
  );

  // The compare gate compares the PRIOR record against the CANDIDATE (the
  // canonical log is still byte-identical to the accepted record at that
  // point).
  const compareGateIdx = rerunScript.indexOf('final-evidence.mjs compare');
  assert.ok(compareGateIdx !== -1, 'the rerun must run the explicit comparison gate');
  assert.ok(
    /final-evidence\.mjs compare "\$PRIOR_RECORD" "\$CANDIDATE"/.test(rerunScript),
    'the comparison gate must compare the prior record with the candidate, not the canonical log'
  );

  // RR-03-A/RR-03-C: an ordinary rerun NEVER publishes — there is no
  // mv/cp/redirect of the candidate (or anything else) over the canonical
  // log. Republishing accepted evidence is an explicit standalone
  // run-final-evidence.sh action, never a rerun side effect.
  assert.doesNotMatch(
    rerunScript,
    /mv "\$CANDIDATE" "\$EVIDENCE_LOG"|cp "\$CANDIDATE" "\$EVIDENCE_LOG"|> ?"\$EVIDENCE_LOG"/,
    'a verification-only rerun must never write the canonical evidence log'
  );

  // The canonical record's byte-identity is itself a gate: after every
  // regression gate and before the terminal PASS, the canonical log must
  // still be byte-identical to the preserved prior record.
  const byteGateIdx = rerunScript.indexOf('cmp -s "$PRIOR_RECORD" "$EVIDENCE_LOG"');
  const lastGateIdx = rerunScript.indexOf('historical artifacts drifted');
  const passIdx = rerunScript.indexOf('log "CLEAN-RERUN PASS:');
  assert.ok(byteGateIdx !== -1, 'the rerun must gate on canonical byte-identity (cmp prior vs canonical) before PASS');
  assert.ok(
    lastGateIdx !== -1 && byteGateIdx > lastGateIdx,
    'the canonical byte-identity gate must run after every regression gate (including historical byte-identity)'
  );
  assert.ok(
    passIdx !== -1 && byteGateIdx < passIdx,
    'the canonical byte-identity gate must run before the terminal CLEAN-RERUN PASS line'
  );

  // The candidate is consumed before the end-state tree check: an explicit
  // rm beyond the cleanup trap, so the end-state untracked baseline holds.
  const endStateIdx = rerunScript.indexOf('end-state tree check');
  const consumeIdx = rerunScript.indexOf('rm -f "$CANDIDATE"', rerunScript.indexOf('cmp -s "$PRIOR_RECORD" "$EVIDENCE_LOG"'));
  assert.ok(
    consumeIdx !== -1 && endStateIdx !== -1 && consumeIdx < endStateIdx,
    'the verified candidate must be discarded (rm) after the byte-identity gate and before the end-state tree check'
  );

  // End-state: the tracked delta must be EMPTY — an ordinary rerun leaves
  // the committed record and the buyer-docs contract untouched (RR-03-C).
  assert.match(
    rerunScript,
    /\[ -z "\$END_TRACKED_DRIFT" \]/,
    'the end-state check must require an empty tracked delta — the canonical log stays byte-identical to the accepted record'
  );

  // The cleanup trap removes a never-consumed candidate on every exit path.
  const trapIdx = rerunScript.indexOf('trap cleanup EXIT');
  const cleanupIdx = rerunScript.indexOf('cleanup()');
  assert.ok(
    cleanupIdx !== -1 && rerunScript.indexOf('rm -f "$CANDIDATE"', cleanupIdx) !== -1,
    'the cleanup trap must remove a leftover candidate on failure exits'
  );
  assert.ok(trapIdx !== -1, 'the cleanup trap must be registered');

  // No exit-trap restore of the canonical log is needed or present: the
  // canonical file is simply never written by a rerun.
  assert.doesNotMatch(
    rerunScript,
    /cp "\$CANONICAL_SNAPSHOT"|restore.*canonical|git checkout -- .*EVIDENCE_LOG/,
    'verification-only semantics rely on never writing the canonical log, never on restoring it after the fact'
  );
});

test('every clean-rerun gate exits with an explicit FAIL reason — no silent aborts (WR-05)', async () => {
  const rerunScript = readFileSync(path.join(ROOT, 'runtime', 'run-clean-rerun.sh'), 'utf8');

  // The run-vs-run comparison gate must end in || fail with a reason.
  const compareIdx = rerunScript.indexOf('final-evidence.mjs compare "$PRIOR_RECORD" "$CANDIDATE"');
  assert.notEqual(compareIdx, -1, 'the compare gate must exist');
  const compareSegment = rerunScript.slice(compareIdx, compareIdx + 400);
  assert.match(
    compareSegment,
    /\|\|\s*fail "/,
    'the compare gate must append an explicit || fail clause — a bare pipeline aborts with no [rerun] FAIL diagnostic'
  );
  assert.match(compareSegment, /comparison exited non-zero/, 'the compare failure must name the gate');

  // The baseline tracer regression gate must end in || fail with a reason.
  const tracerIdx = rerunScript.indexOf('./runtime/run-baseline.sh --tracer');
  assert.notEqual(tracerIdx, -1, 'the baseline tracer gate must exist');
  const tracerSegment = rerunScript.slice(tracerIdx, tracerIdx + 300);
  assert.match(
    tracerSegment,
    /\|\|\s*fail "/,
    'the baseline tracer gate must append an explicit || fail clause — a bare pipeline aborts with no [rerun] FAIL diagnostic'
  );
  assert.match(tracerSegment, /baseline tracer exited non-zero/, 'the tracer failure must name the gate');
});

test('the CLI detects direct runs portably (pathToFileURL) and exits 2 with usage on an unrecognized verb — never a silent no-op (IN-01)', async () => {
  // An unrecognized verb must print usage and exit 2 (a chained && script
  // must not mistake a silent verifier no-op for PASS).
  const bad = spawnSync(process.execPath, [EVIDENCE_CLI, 'frobnicate'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(bad.status, 2, 'an unrecognized verb must exit 2 with usage');
  assert.match(bad.stderr, /usage:/i, 'usage must be printed on stderr');

  // No verb at all is the same usage condition.
  const none = spawnSync(process.execPath, [EVIDENCE_CLI], { encoding: 'utf8', cwd: ROOT });
  assert.equal(none.status, 2, 'a missing verb must exit 2 with usage');

  // A module path containing a space must still be recognized as a direct
  // run (pathToFileURL, not string concatenation) — the old naive
  // file://<argv[1]> comparison silently exited 0 without running any verb.
  const spacedRoot = mkdtempSync(path.join(tmpdir(), 'final-evidence spaced-'));
  try {
    const spacedModule = path.join(spacedRoot, 'final-evidence.mjs');
    writeFileSync(spacedModule, readFileSync(EVIDENCE_CLI));
    const spaced = spawnSync(process.execPath, [spacedModule, 'verify'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(spaced.status, 2, 'a spaced module path must still run the CLI (usage exit 2), not silently exit 0');
    assert.match(spaced.stderr, /usage:/i);
  } finally {
    rmSync(spacedRoot, { recursive: true, force: true });
  }
});

test('the host-suite regression gate runs on node, not an undocumented python3 dependency (IN-04)', async () => {
  const rerunScript = readFileSync(path.join(ROOT, 'runtime', 'run-clean-rerun.sh'), 'utf8');
  assert.doesNotMatch(
    rerunScript,
    /python3/,
    'the regression gate must not shell out to python3 — it is not a documented prerequisite and misreports as a suite regression on hosts without it'
  );
  assert.match(
    rerunScript,
    /--test-concurrency=1/,
    'the gate must run the host suite through node --test with concurrency 1 (the only documented runtime)'
  );
});

test('verify rejects any present rerun section without per_case_identical true and a non-empty clean_sandbox_checks array', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const directory = mkdtempSync(path.join(tmpdir(), 'final-evidence-rerun-verify-'));
  try {
    const captureFile = path.join(directory, 'capture.log');
    writeFileSync(captureFile, fixtureCapture());
    const base = evidence.buildFinalEvidenceRecord(fullBuildInput(evidence.parseLauncherCapture(fixtureCapture())));
    const withRerun = structuredClone(base);
    withRerun.run.rerun = {
      compared_with: 'final-20260101T000001Z',
      per_case_identical: true,
      clean_sandbox_checks: ['no-owned-containers'],
      phase_base: FROZEN_PHASE_BASE_SHA,
    };
    assert.equal(evidence.verifyFinalEvidence(withRerun).ok, true, 'a well-formed rerun section verifies');

    const mustReject = [
      ['missing per_case_identical', (r) => { delete r.run.rerun.per_case_identical; }],
      ['per_case_identical false', (r) => { r.run.rerun.per_case_identical = false; }],
      ['empty clean_sandbox_checks', (r) => { r.run.rerun.clean_sandbox_checks = []; }],
      ['blank check name', (r) => { r.run.rerun.clean_sandbox_checks = ['']; }],
      ['missing phase_base', (r) => { delete r.run.rerun.phase_base; }],
      ['malformed compared_with', (r) => { r.run.rerun.compared_with = 'yesterday'; }],
      ['self-referential compared_with', (r) => { r.run.rerun.compared_with = r.run.id; }],
    ];
    for (const [label, mutation] of mustReject) {
      const clone = structuredClone(withRerun);
      mutation(clone);
      const verdict = evidence.verifyFinalEvidence(clone);
      assert.equal(verdict.ok, false, `${label} must be rejected`);
      assert.ok(verdict.errors.some((error) => /rerun/i.test(error)), `${label} must be attributed to the rerun section`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// RR-03-A (standalone driver half): run-final-evidence.sh must build into a
// SIBLING candidate of the requested output, run EVERY check (evidence
// manifest verify, git-bound record verify) against the candidate, and only
// then atomically promote it to the requested output — with nothing fallible
// between the promotion and the FINAL-EVIDENCE PASS line. The behavioral
// proof below runs the REAL driver script against a stub launcher and a stub
// docker shim (no Docker daemon, no network, no repository mutation): an
// injected post-build verifier failure must leave the destination
// byte-unchanged and stage no residue.
test('run-final-evidence.sh promotes only after every check — the destination is byte-unchanged on an injected verifier failure (RR-03-A)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const work = mkdtempSync(path.join(tmpdir(), 'final-evidence-driver-'));
  try {
    const repo = path.join(work, 'repo');
    mkdirSync(repo, { recursive: true });
    const scriptsDir = path.join(repo, 'runtime', 'scripts');
    const runtimeDir = path.join(repo, 'runtime');
    mkdirSync(scriptsDir, { recursive: true });

    // Real driver + real builder + real manifest tool (working-tree bytes).
    writeFileSync(path.join(runtimeDir, 'run-final-evidence.sh'), readFileSync(DRIVER_SCRIPT));
    writeFileSync(path.join(scriptsDir, 'final-evidence.mjs'), readFileSync(EVIDENCE_CLI));
    writeFileSync(
      path.join(scriptsDir, 'evidence-manifest.mjs'),
      readFileSync(path.join(ROOT, 'runtime', 'scripts', 'evidence-manifest.mjs'))
    );

    // The four provenance-bound workflow files (real bytes) + the rest of the
    // manifest allowlist (placeholder bytes are fine — only run-gated-demo.sh
    // must be the stub launcher).
    const provenanceFiles = {
      'workflows/client-intake-pipeline.json': path.join(ROOT, 'workflows', 'client-intake-pipeline.json'),
      'runtime/demo/workflows/intake-stage.json': path.join(ROOT, 'runtime', 'demo', 'workflows', 'intake-stage.json'),
      'runtime/demo/workflows/reviewer-decision.json': path.join(ROOT, 'runtime', 'demo', 'workflows', 'reviewer-decision.json'),
      'runtime/demo/workflows/approved-delivery.json': path.join(ROOT, 'runtime', 'demo', 'workflows', 'approved-delivery.json'),
      'payloads/intake-new-lead.json': path.join(ROOT, 'payloads', 'intake-new-lead.json'),
      'runtime/evidence/baseline.json': path.join(ROOT, 'runtime', 'evidence', 'baseline.json'),
    };
    for (const [relative, absolute] of Object.entries(provenanceFiles)) {
      const target = path.join(repo, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(absolute));
    }
    for (const relative of ['runtime/demo/docker-compose.yml', 'runtime/demo/mocks/server.mjs']) {
      const target = path.join(repo, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `# fictional bytes for ${relative}\n`);
    }

    // A stub docker on PATH: the driver's preflight and version captures
    // succeed without any Docker daemon (fail-closed on anything unexpected).
    const shimDir = path.join(work, 'shim');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      path.join(shimDir, 'docker'),
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        '  info) exit 0 ;;',
        '  image) [ "$2" = "inspect" ] && exit 0 || exit 1 ;;',
        '  --version) echo "Docker version 99.9.9, build stub" ;;',
        '  compose) [ "$2" = "version" ] && echo "Docker Compose version v99.9.0" || exit 1 ;;',
        '  *) echo "docker-shim: unexpected invocation: $*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n')
    );
    const { chmodSync } = await import('node:fs');
    chmodSync(path.join(shimDir, 'docker'), 0o755);

    const sha256hex = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const launcherPath = path.join(repo, 'runtime', 'run-gated-demo.sh');

    /** Write the stub launcher printing a valid capture; optionally self-modify afterwards. */
    const writeStubLauncher = (selfModify) => {
      const capture = [
        'stub census noise — fictional',
        'real n8n runtime version: 2.37.10',
        'STATIC CONTRACTS PASS: stub contracts green',
        'CASE PASS (1/5) tracer: stub summary — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
        'CASE PASS (2/5) reviewer-gate: stub summary — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
        'CASE PASS (3/5) approval-delivery: stub summary — queue=1 approval_actions=1 CRM ATTEMPTS=1 CRM EFFECTS=1',
        'CASE PASS (4/5) intake-idempotency: stub summary — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
        'CASE PASS (5/5) crm-recovery: stub summary — queue=1 approval_actions=1 CRM ATTEMPTS=2 CRM EFFECTS=1',
        'FULL-SUITE PASS: 5/5 case groups green on real pinned n8n 2.37.10',
        'unrelated containers preserved: 14/14',
        'preservation: 14/14 unrelated containers identical',
        `evidence: historical source sha256=${sha256hex(path.join(repo, 'workflows', 'client-intake-pipeline.json'))}, intake workflow sha256=${sha256hex(path.join(repo, 'runtime', 'demo', 'workflows', 'intake-stage.json'))}, reviewer workflow sha256=${sha256hex(path.join(repo, 'runtime', 'demo', 'workflows', 'reviewer-decision.json'))}, delivery workflow sha256=${sha256hex(path.join(repo, 'runtime', 'demo', 'workflows', 'approved-delivery.json'))}, n8n=2.37.10`,
      ].join('\n');
      const lines = ['#!/usr/bin/env bash', "cat <<'STUB_CAPTURE'", capture, 'STUB_CAPTURE'];
      if (selfModify) {
        lines.push('# RR-03-A injection: mutate an allowlisted file AFTER the capture so the');
        lines.push('# post-build evidence-manifest verify fails against the committed bytes.');
        lines.push('printf \'# drifted after the run\\n\' >> "$0"');
      }
      writeFileSync(launcherPath, `${lines.join('\n')}\n`);
      chmodSync(launcherPath, 0o755);
    };

    const gitIn = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const commitRepo = () => {
      gitIn(['init', '-q']);
      gitIn(['config', 'user.name', 'Fictional Tester']);
      gitIn(['config', 'user.email', 'tester@example.com']); // disclosure-waiver: synthetic temp-repo git identity (fictional), not real contact data
      gitIn(['add', '.']);
      gitIn(['commit', '-qm', 'fictional driver fixture']);
    };

    const destination = path.join(repo, 'runtime', 'evidence', 'final-evidence-log.json');
    const SENTINEL = 'PRIOR ACCEPTED BYTES — the canonical record must never be overwritten by a failed run\n';
    const driverEnv = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` };
    const runDriver = () =>
      spawnSync('bash', [path.join(repo, 'runtime', 'run-final-evidence.sh'), '--output', destination], {
        cwd: repo,
        encoding: 'utf8',
        env: driverEnv,
      });

    // --- Scenario 1: injected post-build verifier failure ------------------
    writeStubLauncher(true);
    commitRepo();
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, SENTINEL);
    const failed = runDriver();
    assert.notEqual(failed.status, 0, 'the driver must fail when a post-build verifier fails');
    assert.equal(
      readFileSync(destination, 'utf8'),
      SENTINEL,
      'the destination must be byte-unchanged when a post-build verifier fails — no overwritten evidence on a FAIL'
    );
    assert.match(failed.stderr + failed.stdout, /manifest|drift/i, 'the failure must name the manifest drift');
    const stagedResidue = readdirSync(path.dirname(destination)).filter((entry) => entry.startsWith('.'));
    assert.deepEqual(
      stagedResidue.filter((entry) => entry.includes('candidate')),
      [],
      'no staged candidate residue may remain next to the destination after a failed run'
    );

    // --- Scenario 2: clean run — promotion happens, record is real ---------
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(path.join(runtimeDir, 'run-final-evidence.sh'), readFileSync(DRIVER_SCRIPT));
    writeFileSync(path.join(scriptsDir, 'final-evidence.mjs'), readFileSync(EVIDENCE_CLI));
    writeFileSync(
      path.join(scriptsDir, 'evidence-manifest.mjs'),
      readFileSync(path.join(ROOT, 'runtime', 'scripts', 'evidence-manifest.mjs'))
    );
    for (const [relative, absolute] of Object.entries(provenanceFiles)) {
      const target = path.join(repo, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(absolute));
    }
    for (const relative of ['runtime/demo/docker-compose.yml', 'runtime/demo/mocks/server.mjs']) {
      const target = path.join(repo, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `# fictional bytes for ${relative}\n`);
    }
    writeStubLauncher(false);
    commitRepo();
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, SENTINEL);
    const clean = runDriver();
    assert.equal(clean.status, 0, `the clean run must pass end-to-end (stdout tail: …${(clean.stdout + clean.stderr).slice(-400)})`);
    const promoted = readFileSync(destination, 'utf8');
    assert.notEqual(promoted, SENTINEL, 'a passing run must promote the candidate over the destination');
    const promotedRecord = JSON.parse(promoted);
    assert.equal(promotedRecord.run.status, 'completed', 'the promoted destination must carry a real record');
    const boundVerify = spawnSync(
      process.execPath,
      [path.join(repo, 'runtime', 'scripts', 'final-evidence.mjs'), 'verify', destination],
      { cwd: repo, encoding: 'utf8' }
    );
    assert.equal(boundVerify.status, 0, `the promoted record must re-verify git-bound from the temp repo alone (stderr: ${boundVerify.stderr})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// FD-03-A: the staging candidate must be owned EXCLUSIVELY by the invocation.
// The old driver derived a FIXED sibling path (.${OUTPUT_BASE}.candidate) with
// no ownership or existence check, so a run could build over a preexisting
// file at that path and the EXIT trap's rm -f could DELETE it even on an early
// failure — destroying bytes the invocation never created. The proof below
// (Docker-free, same stub-shape as the RR-03-A test) pre-places a sentinel at
// the exact fixed sibling path, injects a verifier failure, and requires BOTH
// the destination and the sentinel to survive byte-for-byte — plus no residue
// of the invocation-owned candidate.
test('run-final-evidence.sh stages into an invocation-owned mktemp candidate — a preexisting fixed-sibling sentinel and the destination both survive a failed run (FD-03-A)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/final-evidence.mjs must export the final evidence contract');

  const work = mkdtempSync(path.join(tmpdir(), 'final-evidence-candidate-'));
  try {
    const repo = path.join(work, 'repo');
    const scriptsDir = path.join(repo, 'runtime', 'scripts');
    const runtimeDir = path.join(repo, 'runtime');
    mkdirSync(scriptsDir, { recursive: true });

    // Real driver + real builder + real manifest tool (working-tree bytes).
    writeFileSync(path.join(runtimeDir, 'run-final-evidence.sh'), readFileSync(DRIVER_SCRIPT));
    writeFileSync(path.join(scriptsDir, 'final-evidence.mjs'), readFileSync(EVIDENCE_CLI));
    writeFileSync(
      path.join(scriptsDir, 'evidence-manifest.mjs'),
      readFileSync(path.join(ROOT, 'runtime', 'scripts', 'evidence-manifest.mjs'))
    );

    // The four provenance-bound workflow files (real bytes) + placeholder
    // bytes for the remaining allowlist entries (only run-gated-demo.sh must
    // be the stub launcher).
    const provenanceFiles = {
      'workflows/client-intake-pipeline.json': path.join(ROOT, 'workflows', 'client-intake-pipeline.json'),
      'runtime/demo/workflows/intake-stage.json': path.join(ROOT, 'runtime', 'demo', 'workflows', 'intake-stage.json'),
      'runtime/demo/workflows/reviewer-decision.json': path.join(ROOT, 'runtime', 'demo', 'workflows', 'reviewer-decision.json'),
      'runtime/demo/workflows/approved-delivery.json': path.join(ROOT, 'runtime', 'demo', 'workflows', 'approved-delivery.json'),
      'payloads/intake-new-lead.json': path.join(ROOT, 'payloads', 'intake-new-lead.json'),
      'runtime/evidence/baseline.json': path.join(ROOT, 'runtime', 'evidence', 'baseline.json'),
    };
    for (const [relative, absolute] of Object.entries(provenanceFiles)) {
      const target = path.join(repo, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(absolute));
    }
    for (const relative of ['runtime/demo/docker-compose.yml', 'runtime/demo/mocks/server.mjs']) {
      const target = path.join(repo, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `# fictional bytes for ${relative}\n`);
    }

    // Stub docker on PATH: preflight and version captures succeed with no
    // Docker daemon (fail-closed on anything unexpected).
    const shimDir = path.join(work, 'shim');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      path.join(shimDir, 'docker'),
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        '  info) exit 0 ;;',
        '  image) [ "$2" = "inspect" ] && exit 0 || exit 1 ;;',
        '  --version) echo "Docker version 99.9.9, build stub" ;;',
        '  compose) [ "$2" = "version" ] && echo "Docker Compose version v99.9.0" || exit 1 ;;',
        '  *) echo "docker-shim: unexpected invocation: $*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n')
    );
    const { chmodSync } = await import('node:fs');
    chmodSync(path.join(shimDir, 'docker'), 0o755);

    const sha256hex = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const launcherPath = path.join(repo, 'runtime', 'run-gated-demo.sh');

    // Stub launcher printing a valid capture, then mutating an allowlisted
    // file AFTER the capture so the post-build evidence-manifest verify fails
    // (the injected verifier failure of FD-03-A).
    const capture = [
      'stub census noise — fictional',
      'real n8n runtime version: 2.37.10',
      'STATIC CONTRACTS PASS: stub contracts green',
      'CASE PASS (1/5) tracer: stub summary — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
      'CASE PASS (2/5) reviewer-gate: stub summary — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
      'CASE PASS (3/5) approval-delivery: stub summary — queue=1 approval_actions=1 CRM ATTEMPTS=1 CRM EFFECTS=1',
      'CASE PASS (4/5) intake-idempotency: stub summary — queue=1 approval_actions=0 CRM ATTEMPTS=0 CRM EFFECTS=0',
      'CASE PASS (5/5) crm-recovery: stub summary — queue=1 approval_actions=1 CRM ATTEMPTS=2 CRM EFFECTS=1',
      'FULL-SUITE PASS: 5/5 case groups green on real pinned n8n 2.37.10',
      'unrelated containers preserved: 14/14',
      'preservation: 14/14 unrelated containers identical',
      `evidence: historical source sha256=${sha256hex(path.join(repo, 'workflows', 'client-intake-pipeline.json'))}, intake workflow sha256=${sha256hex(path.join(repo, 'runtime', 'demo', 'workflows', 'intake-stage.json'))}, reviewer workflow sha256=${sha256hex(path.join(repo, 'runtime', 'demo', 'workflows', 'reviewer-decision.json'))}, delivery workflow sha256=${sha256hex(path.join(repo, 'runtime', 'demo', 'workflows', 'approved-delivery.json'))}, n8n=2.37.10`,
    ].join('\n');
    writeFileSync(
      launcherPath,
      [
        '#!/usr/bin/env bash',
        "cat <<'STUB_CAPTURE'",
        capture,
        'STUB_CAPTURE',
        '# FD-03-A injection: mutate an allowlisted file AFTER the capture so the',
        '# post-build evidence-manifest verify fails against the committed bytes.',
        'printf \'# drifted after the run\\n\' >> "$0"',
        '',
      ].join('\n')
    );
    chmodSync(launcherPath, 0o755);

    const gitIn = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    gitIn(['init', '-q']);
    gitIn(['config', 'user.name', 'Fictional Tester']);
    gitIn(['config', 'user.email', 'tester@example.com']); // disclosure-waiver: synthetic temp-repo git identity (fictional), not real contact data
    gitIn(['add', '.']);
    gitIn(['commit', '-qm', 'fictional driver fixture']);

    // A preexisting destination AND a preexisting file at the exact FIXED
    // sibling path the old driver derived (.${OUTPUT_BASE}.candidate) — bytes
    // this invocation never created and must never touch.
    const destination = path.join(repo, 'runtime', 'evidence', 'final-evidence-log.json');
    const fixedSibling = path.join(repo, 'runtime', 'evidence', '.final-evidence-log.json.candidate');
    const DEST_SENTINEL = 'PRIOR ACCEPTED BYTES — the canonical record must never be overwritten by a failed run\n';
    const SIBLING_SENTINEL = 'PREEXISTING SIBLING SENTINEL — bytes a driver invocation never owns\n';
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, DEST_SENTINEL);
    writeFileSync(fixedSibling, SIBLING_SENTINEL);

    const failed = spawnSync(
      'bash',
      [path.join(repo, 'runtime', 'run-final-evidence.sh'), '--output', destination],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` } }
    );
    assert.notEqual(failed.status, 0, 'the driver must fail when a post-build verifier fails');

    // BOTH the destination and the preexisting sibling sentinel survive
    // byte-for-byte: the candidate must be a fresh invocation-owned
    // allocation (mktemp), never a fixed path this run does not own.
    assert.equal(
      readFileSync(destination, 'utf8'),
      DEST_SENTINEL,
      'the destination must be byte-unchanged when a post-build verifier fails'
    );
    assert.ok(existsSync(fixedSibling), 'the preexisting fixed-sibling file must still exist after the failed run — the EXIT trap must never delete a file the invocation did not own');
    assert.equal(
      readFileSync(fixedSibling, 'utf8'),
      SIBLING_SENTINEL,
      'the preexisting fixed-sibling file must be byte-unchanged — no build into, and no rm -f of, an unowned fixed path'
    );

    // No invocation-owned candidate residue may remain (the preexisting
    // sentinel itself is not residue).
    const residue = readdirSync(path.dirname(destination)).filter(
      (entry) => entry.startsWith('.') && entry.includes('candidate') && entry !== path.basename(fixedSibling)
    );
    assert.deepEqual(residue, [], 'no invocation-owned candidate residue may remain next to the destination after a failed run');

    // Contract shape: the candidate is allocated exclusively via mktemp in
    // the output's own directory (unique, 0600, same filesystem) — never a
    // fixed sibling assignment.
    const driver = readFileSync(DRIVER_SCRIPT, 'utf8');
    assert.match(
      driver,
      /mktemp "\$\{?OUTPUT_DIR\}?\/\.\$\{OUTPUT_BASE\}\.candidate\.XXXXXX"/,
      'the staging candidate must be an invocation-owned mktemp allocation in the output directory'
    );
    assert.ok(
      !/CANDIDATE="\$\{?OUTPUT_DIR\}?\/\.\$\{OUTPUT_BASE\}\.candidate"\s*$/m.test(driver),
      'the driver must not assign a FIXED unowned sibling path as the candidate'
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
