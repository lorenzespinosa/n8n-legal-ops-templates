// Deterministic evidence-contract tests for the Phase 1 baseline record
// (BASE-01/BASE-02/RUNT-03 proof fields, D-01/D-02/D-06/D-08 through D-10,
// T-01-05..T-01-09).
//
// runtime/scripts/baseline-evidence.mjs must export the canonical evidence
// contract:
//   buildBaselineEvidence(input)      assemble a canonical record from measurements
//   verifyBaselineEvidence(record)    fail-closed invariant check ({ok, errors})
//   publishBaselineEvidence(record, destination)
//                                     verify -> temporary sibling -> atomic rename
// The verifier rejects EVERY missing proof field, vague versions, simulated
// runs, queue-writes-as-approval conflation, missing/drifted body-bridge
// disclosure, misattributed CRM writes, and any PII/credential/URL leakage —
// a failed or partial run can never publish accepted evidence.
//
// The module is loaded lazily so the TDD RED run fails on an explicit
// assertion for the missing feature instead of an import error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EVIDENCE_CLI = path.join(ROOT, 'runtime', 'scripts', 'baseline-evidence.mjs');
const COMMITTED_EVIDENCE = path.join(ROOT, 'runtime', 'evidence', 'baseline.json');
const RUNTIME_README = path.join(ROOT, 'runtime', 'README.md');
const LAUNCHER_SCRIPT = path.join(ROOT, 'runtime', 'run-baseline.sh');

async function loadEvidenceModule() {
  try {
    return await import('../scripts/baseline-evidence.mjs');
  } catch {
    return null;
  }
}

// The exact one-line body-bridge disclosure the evidence must carry — the
// same strings the mapper applies and the verifier enforces (D-06 extended).
const BODY_BRIDGE = Object.freeze({
  node: 'Validate Fields',
  from: 'const input = $input.first().json;',
  to: 'const raw = $input.first().json; const input = raw.body ?? raw;',
});

const HEX64 = /^[0-9a-f]{64}$/;

/** Set a nested path (`'run.status'`) on a deep-cloned record. */
function withPaths(record, mutations) {
  const clone = structuredClone(record);
  for (const [pathString, value] of Object.entries(mutations)) {
    const keys = pathString.split('.');
    let cursor = clone;
    while (keys.length > 1) {
      cursor = cursor[keys.shift()];
    }
    cursor[keys[0]] = value;
  }
  return clone;
}

/** Delete nested paths (`'versions.n8n_runtime'`) on a deep-cloned record. */
function withoutPaths(record, deletions) {
  const clone = structuredClone(record);
  for (const pathString of deletions) {
    const keys = pathString.split('.');
    let cursor = clone;
    while (keys.length > 1) {
      cursor = cursor[keys.shift()];
    }
    delete cursor[keys[0]];
  }
  return clone;
}

/** A complete, truthful, real-run record — every proof field present. */
function validRecord() {
  return {
    schema_version: 1,
    kind: 'flagship-intake-baseline',
    run: {
      id: 'baseline-contractfixture-0001',
      started_at: '2026-10-03T16:20:00.000Z',
      completed_at: '2026-10-03T16:20:41.000Z',
      execution_mode: 'real-n8n',
      status: 'completed',
    },
    provenance: {
      source_commit: 'a'.repeat(40),
      fixture: { path: 'payloads/intake-new-lead.json', sha256: 'b'.repeat(64) },
      source_workflow: {
        path: 'workflows/client-intake-pipeline.json',
        sha256: 'c'.repeat(64),
        modified_during_run: false,
      },
      derived_workflow: {
        kind: 'runtime-adapted-copy',
        sha256: 'd'.repeat(64),
        graph_equivalence: { ok: true, allowed_differences: 12 },
        adaptations: {
          url_mappings: 6,
          credential_references: 5,
          body_bridge: { ...BODY_BRIDGE, scope: 'derived runtime copy only' },
        },
      },
    },
    versions: {
      docker_client: '28.3.0',
      docker_server: '29.7.2',
      docker_compose: '2.39.2',
      n8n_runtime: '2.37.10',
      image_reference: `n8nio/n8n@sha256:${'e'.repeat(64)}`,
    },
    measurements: {
      lawmatics_contact_writes: 1,
      review_queue_writes: 1,
      approval_actions: 0,
      counters: {
        airtable_contacts_get: 1,
        airtable_contacts_patch: 0,
        airtable_queue_post: 1,
        openai_chat_completions_post: 1,
        slack_webhook_post: 0,
        lawmatics_contacts_post: 1,
        approval_actions: 0,
      },
      webhook_status_source: 'asserted by runtime/tests/baseline.e2e.test.mjs',
    },
    approval_semantics: {
      approval_source: 'dedicated admin counter incremented by no workflow route',
      queue_writes_are_approvals: false,
    },
    egress: {
      denied: true,
      network_internal: true,
      probe_outcome: 'timeout',
      method: 'in-network RFC 5737 TEST-NET-1 TCP connect denied within 500 ms',
    },
    diagnostics: {
      prior_original_template: {
        scope: 'unmodified-tracked-source',
        observed: 'prior-diagnostic',
        http_status: 400,
      },
      adapted_run: {
        scope: 'derived-runtime-copy',
        observed: 'this-run',
        http_status: 202,
      },
    },
    notes:
      'Local mock-runtime measurements on the body-adapted runtime copy; not a live business outcome.',
  };
}

// Every nested field whose absence must fail verification (BASE-01/BASE-02/
// RUNT-03 proof completeness — a record missing any of these is not evidence).
const REQUIRED_PATHS = [
  'run.id',
  'run.started_at',
  'run.completed_at',
  'run.execution_mode',
  'run.status',
  'provenance.source_commit',
  'provenance.fixture.path',
  'provenance.fixture.sha256',
  'provenance.source_workflow.path',
  'provenance.source_workflow.sha256',
  'provenance.source_workflow.modified_during_run',
  'provenance.derived_workflow.kind',
  'provenance.derived_workflow.sha256',
  'provenance.derived_workflow.graph_equivalence.ok',
  'provenance.derived_workflow.graph_equivalence.allowed_differences',
  'provenance.derived_workflow.adaptations.url_mappings',
  'provenance.derived_workflow.adaptations.credential_references',
  'provenance.derived_workflow.adaptations.body_bridge.node',
  'provenance.derived_workflow.adaptations.body_bridge.from',
  'provenance.derived_workflow.adaptations.body_bridge.to',
  'versions.docker_client',
  'versions.docker_server',
  'versions.docker_compose',
  'versions.n8n_runtime',
  'versions.image_reference',
  'measurements.lawmatics_contact_writes',
  'measurements.review_queue_writes',
  'measurements.approval_actions',
  'measurements.counters',
  'approval_semantics.approval_source',
  'approval_semantics.queue_writes_are_approvals',
  'egress.denied',
  'egress.network_internal',
  'egress.probe_outcome',
  'egress.method',
  'diagnostics.prior_original_template.http_status',
  'diagnostics.prior_original_template.observed',
  'diagnostics.adapted_run.http_status',
  'diagnostics.adapted_run.observed',
];

test('verifyBaselineEvidence accepts a complete real-run record and rejects every missing BASE-01/BASE-02/RUNT-03 proof field', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(
    evidence,
    'runtime/scripts/baseline-evidence.mjs must export the evidence contract (buildBaselineEvidence, verifyBaselineEvidence, publishBaselineEvidence)'
  );

  const accepted = evidence.verifyBaselineEvidence(validRecord());
  assert.equal(accepted.ok, true, `a complete real-run record must verify: ${JSON.stringify(accepted.errors)}`);
  assert.deepEqual(accepted.errors, []);

  for (const required of REQUIRED_PATHS) {
    const rejected = evidence.verifyBaselineEvidence(withoutPaths(validRecord(), [required]));
    assert.equal(
      rejected.ok,
      false,
      `a record missing ${required} must be rejected (fail-closed proof completeness)`
    );
    assert.ok(
      rejected.errors.some((error) => error.includes(required)),
      `the rejection for ${required} must name the missing field (got ${JSON.stringify(rejected.errors)})`
    );
  }
});

test('verification is fail-closed on simulated or degraded runs, unproven equivalence, unproven egress, missing CRM write, and any approval action', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const mustReject = [
    ['simulated execution mode', withPaths(validRecord(), { 'run.execution_mode': 'simulated' })],
    ['dry-run execution mode', withPaths(validRecord(), { 'run.execution_mode': 'dry-run' })],
    ['simulated status', withPaths(validRecord(), { 'run.status': 'simulated' })],
    ['interrupted status', withPaths(validRecord(), { 'run.status': 'interrupted' })],
    ['partial status', withPaths(validRecord(), { 'run.status': 'partial' })],
    ['unproven graph equivalence', withPaths(validRecord(), { 'provenance.derived_workflow.graph_equivalence.ok': false })],
    ['allowed-differences count drift', withPaths(validRecord(), { 'provenance.derived_workflow.graph_equivalence.allowed_differences': 11 })],
    ['unproven egress denial', withPaths(validRecord(), { 'egress.denied': false })],
    ['zero CRM writes', withPaths(validRecord(), { 'measurements.lawmatics_contact_writes': 0 })],
    ['source modified during run', withPaths(validRecord(), { 'provenance.source_workflow.modified_during_run': true })],
    ['malformed source hash', withPaths(validRecord(), { 'provenance.source_workflow.sha256': 'not-a-hash' })],
    ['malformed derived hash', withPaths(validRecord(), { 'provenance.derived_workflow.sha256': 42 })],
    ['malformed fixture hash', withPaths(validRecord(), { 'provenance.fixture.sha256': 'deadbeef' })],
    ['non-fixture data source', withPaths(validRecord(), { 'provenance.fixture.path': 'payloads/some-other-lead.json' })],
    ['non-integer approval count', withPaths(validRecord(), { 'measurements.approval_actions': '0' })],
    ['negative CRM count', withPaths(validRecord(), { 'measurements.lawmatics_contact_writes': -1 })],
    ['non-integer CRM count', withPaths(validRecord(), { 'measurements.lawmatics_contact_writes': 1.5 })],
    ['completed_at before started_at', withPaths(validRecord(), { 'run.completed_at': '2026-10-03T16:19:00.000Z' })],
    ['unparseable started_at', withPaths(validRecord(), { 'run.started_at': 'yesterday-ish' })],
    ['empty run id', withPaths(validRecord(), { 'run.id': '' })],
    ['short source commit', withPaths(validRecord(), { 'provenance.source_commit': 'abc123' })],
  ];
  for (const [label, record] of mustReject) {
    const result = evidence.verifyBaselineEvidence(record);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(result.errors.length > 0, `${label} must produce explicit errors`);
  }

  // Counter consistency: the admin counters and the headline counts are the
  // same measurement — divergence is tampering, not evidence.
  const divergentCounters = validRecord();
  divergentCounters.measurements.counters.lawmatics_contacts_post = 7;
  assert.equal(evidence.verifyBaselineEvidence(divergentCounters).ok, false, 'counter/headline divergence must be rejected');
});

test('versions must be exact values — vague, missing, or unpinned versions are rejected (D-01)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const vagueValues = ['', 'unknown', 'n/a', 'latest', 'placeholder', 'tbd', 'unpinned', '1.x', 'v1.x.x', '2.37.x', 'x'];
  for (const field of ['versions.docker_client', 'versions.docker_server', 'versions.docker_compose']) {
    for (const vague of vagueValues) {
      const result = evidence.verifyBaselineEvidence(withPaths(validRecord(), { [field]: vague }));
      assert.equal(result.ok, false, `${field}="${vague}" must be rejected as vague`);
    }
  }

  // n8n runtime must be a full exact triple (the pin), not a range.
  for (const bad of ['2.37', '2', 'v2.37.10', '2.x', 'latest']) {
    const result = evidence.verifyBaselineEvidence(withPaths(validRecord(), { 'versions.n8n_runtime': bad }));
    assert.equal(result.ok, false, `n8n_runtime="${bad}" must be rejected — the pin must be exact`);
  }

  // The image must be the digest-pinned reference, not a mutable tag.
  for (const bad of ['n8nio/n8n:latest', 'n8nio/n8n', 'n8nio/n8n:1.x', `n8nio/n8n@sha256:${'f'.repeat(63)}`]) {
    const result = evidence.verifyBaselineEvidence(withPaths(validRecord(), { 'versions.image_reference': bad }));
    assert.equal(result.ok, false, `image_reference="${bad}" must be rejected — digest pin required`);
  }

  // Exact values verify.
  assert.equal(evidence.verifyBaselineEvidence(validRecord()).ok, true);
});

test('review-queue writes are never approval actions — a dedicated zero counter is the only approval proof (A-06/T-01-09)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  // A queue write reclassified as an approval is the core spoof: rejected.
  const queueAsApproval = validRecord();
  queueAsApproval.measurements.approval_actions = 1; // "the queue write counts as approval"
  assert.equal(
    evidence.verifyBaselineEvidence(queueAsApproval).ok,
    false,
    'approval_actions > 0 must be rejected — the baseline run takes no approval action'
  );

  // Omitting the dedicated counter while queue writes exist must not pass:
  // absence of an approval counter is not proof of zero approvals.
  const missingApproval = withoutPaths(validRecord(), ['measurements.approval_actions']);
  assert.equal(
    evidence.verifyBaselineEvidence(missingApproval).ok,
    false,
    'a record without the dedicated approval_actions counter must be rejected even though queue writes >= 1'
  );

  // Declaring queue-as-approval semantics is rejected regardless of counts.
  const conflation = withPaths(validRecord(), { 'approval_semantics.queue_writes_are_approvals': true });
  assert.equal(
    evidence.verifyBaselineEvidence(conflation).ok,
    false,
    'queue_writes_are_approvals=true must be rejected — queueing is not approval'
  );

  // Counter-level spoof: the counters object claiming a nonzero approval.
  const counterSpoof = validRecord();
  counterSpoof.measurements.counters.approval_actions = 1;
  assert.equal(evidence.verifyBaselineEvidence(counterSpoof).ok, false, 'nonzero approval counter must be rejected');

  // Headline/counter divergence on approvals is rejected.
  const divergent = validRecord();
  divergent.measurements.counters.approval_actions = 0;
  divergent.measurements.approval_actions = 0;
  divergent.approval_semantics.approval_source = 'airtable_queue_post counter';
  assert.equal(
    evidence.verifyBaselineEvidence(divergent).ok,
    false,
    'approval_source pointing at the queue counter must be rejected'
  );

  // The truthful shape — queue >= 1 AND approval exactly 0, independently
  // counted — is the only accepted form.
  assert.equal(evidence.verifyBaselineEvidence(validRecord()).ok, true);
});

test('the body-bridge disclosure is mandatory and the CRM write is attributed to the adapted copy — the original 400 stays a separate prior diagnostic (D-06)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  // Missing bridge disclosure: the adaptation is concealed — rejected.
  const noBridge = withoutPaths(validRecord(), ['provenance.derived_workflow.adaptations.body_bridge']);
  assert.equal(evidence.verifyBaselineEvidence(noBridge).ok, false, 'a record omitting the body bridge must be rejected');

  // Drifted bridge strings: an undisclosed different adaptation — rejected.
  const driftedFrom = validRecord();
  driftedFrom.provenance.derived_workflow.adaptations.body_bridge.from = 'const input = $json;';
  assert.equal(evidence.verifyBaselineEvidence(driftedFrom).ok, false, 'a drifted body-bridge from-string must be rejected');
  const driftedTo = validRecord();
  driftedTo.provenance.derived_workflow.adaptations.body_bridge.to = 'const input = $json.body;';
  assert.equal(evidence.verifyBaselineEvidence(driftedTo).ok, false, 'a drifted body-bridge to-string must be rejected');

  // Falsely attributing the CRM write to the unmodified tracked source.
  const unmodified = withPaths(validRecord(), { 'provenance.derived_workflow.kind': 'unmodified-source' });
  assert.equal(
    evidence.verifyBaselineEvidence(unmodified).ok,
    false,
    'a record attributing the run to the unmodified source must be rejected — the CRM write occurred on the adapted copy'
  );

  // Conflating the original 400 with this run: the prior diagnostic must be
  // recorded as separately observed, and the measured run must be the 202.
  const conflated400 = withPaths(validRecord(), { 'diagnostics.adapted_run.http_status': 400 });
  assert.equal(
    evidence.verifyBaselineEvidence(conflated400).ok,
    false,
    'the adapted run must report the measured 202, not the prior 400'
  );
  const missingPrior = withoutPaths(validRecord(), ['diagnostics.prior_original_template']);
  assert.equal(
    evidence.verifyBaselineEvidence(missingPrior).ok,
    false,
    'the separately observed original-template 400 diagnostic must be disclosed'
  );
  const priorAsThisRun = withPaths(validRecord(), { 'diagnostics.prior_original_template.observed': 'this-run' });
  assert.equal(
    evidence.verifyBaselineEvidence(priorAsThisRun).ok,
    false,
    'the 400 must be labeled a prior separately observed diagnostic, not a measurement of this run'
  );

  // The truthful dual disclosure verifies.
  assert.equal(evidence.verifyBaselineEvidence(validRecord()).ok, true);
});

test('evidence leaks no URLs, raw contact PII, or credential material (T-01-08/D-11/D-16)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const leaks = [
    ['live service URL', withPaths(validRecord(), { notes: 'CRM at https://api.lawmatics.com/v1/contacts' })],
    ['raw contact email', withPaths(validRecord(), { notes: 'contact was maria.r@example.com' })],
    ['raw contact phone', withPaths(validRecord(), { notes: 'called +15555551234' })],
    ['credential material', withPaths(validRecord(), { 'egress.method': 'probe token sk-abcdefghij0123456789' })],
    ['slack token', withPaths(validRecord(), { notes: 'xoxb-1234567890abcdefghij' })],
    ['bearer secret', withPaths(validRecord(), { notes: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' })],
  ];
  for (const [label, record] of leaks) {
    const result = evidence.verifyBaselineEvidence(record);
    assert.equal(result.ok, false, `${label} must be rejected from evidence`);
  }

  // The clean record carries none of those and verifies.
  assert.equal(evidence.verifyBaselineEvidence(validRecord()).ok, true);
});

test('buildBaselineEvidence assembles the canonical truthful record and refuses simulated or unapproved inputs', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const input = {
    run_id: 'baseline-buildfixture-0002',
    started_at: '2026-10-03T17:00:00.000Z',
    completed_at: '2026-10-03T17:00:39.000Z',
    source_commit: 'b'.repeat(40),
    fixture: { path: 'payloads/intake-new-lead.json', sha256: 'c'.repeat(64) },
    source_workflow: { path: 'workflows/client-intake-pipeline.json', sha256: 'd'.repeat(64) },
    derived_workflow: { kind: 'runtime-adapted-copy', sha256: '0'.repeat(64) },
    graph_equivalence: { ok: true, allowed_differences: 12, urls_checked: 6 },
    versions: {
      docker_client: '28.3.0',
      docker_server: '29.7.2',
      docker_compose: '2.39.2',
      n8n_runtime: '2.37.10',
      image_reference: `n8nio/n8n@sha256:${'1'.repeat(64)}`,
    },
    counters: {
      airtable_contacts_get: 1,
      airtable_queue_post: 1,
      openai_chat_completions_post: 1,
      lawmatics_contacts_post: 1,
      approval_actions: 0,
    },
    egress: { denied: true, network_internal: true, probe_outcome: 'timeout',
      method: 'in-network RFC 5737 TEST-NET-1 TCP connect denied within 500 ms' },
  };

  const record = evidence.buildBaselineEvidence(input);
  assert.equal(evidence.verifyBaselineEvidence(record).ok, true, 'the built record must verify');
  assert.equal(record.run.execution_mode, 'real-n8n');
  assert.equal(record.run.status, 'completed');
  assert.equal(record.schema_version, 1);
  assert.deepEqual(
    {
      node: record.provenance.derived_workflow.adaptations.body_bridge.node,
      from: record.provenance.derived_workflow.adaptations.body_bridge.from,
      to: record.provenance.derived_workflow.adaptations.body_bridge.to,
    },
    BODY_BRIDGE,
    'the builder must embed the exact one-line bridge disclosure'
  );
  assert.equal(record.diagnostics.prior_original_template.http_status, 400);
  assert.equal(record.diagnostics.prior_original_template.observed, 'prior-diagnostic');
  assert.equal(record.diagnostics.adapted_run.http_status, 202);
  assert.equal(record.measurements.approval_actions, 0);
  assert.equal(record.egress.network_internal, true, 'the host-inspected Docker network property must survive publication');
  assert.equal(record.egress.probe_outcome, 'timeout', 'the normalized raw probe result must survive publication');

  assert.throws(
    () => evidence.buildBaselineEvidence({ ...input, execution_mode: 'simulated' }),
    /real-n8n|simulated|execution/i,
    'the builder must refuse to build simulated-mode evidence'
  );
  assert.throws(
    () => evidence.buildBaselineEvidence({ ...input, counters: { ...input.counters, approval_actions: 1 } }),
    /approval/i,
    'the builder must refuse evidence with approval actions'
  );
  assert.throws(
    () => evidence.buildBaselineEvidence({ ...input, counters: { ...input.counters, lawmatics_contacts_post: 0 } }),
    /lawmatics|crm/i,
    'the builder must refuse evidence with no CRM write'
  );
});

test('publication is atomic and fail-closed — an invalid record never reaches the destination and no temp sibling survives', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const directory = mkdtempSync(path.join(tmpdir(), 'baseline-evidence-pub-'));
  const destination = path.join(directory, 'baseline.json');
  try {
    // Invalid record: throws, writes nothing, leaves no temp sibling.
    const invalid = withPaths(validRecord(), { 'measurements.approval_actions': 1 });
    assert.throws(() => evidence.publishBaselineEvidence(invalid, destination), /approval/i);
    assert.equal(existsSync(destination), false, 'a rejected record must not be published');
    assert.deepEqual(readdirSync(directory), [], 'a rejected record must leave no temporary sibling');

    // Valid record: published atomically, readable, and independently verifies.
    const published = evidence.publishBaselineEvidence(validRecord(), destination);
    assert.equal(published.ok, true);
    assert.equal(published.destination, destination);
    const reread = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(evidence.verifyBaselineEvidence(reread).ok, true, 'the published artifact must re-verify');
    assert.deepEqual(readdirSync(directory), ['baseline.json'], 'no temporary sibling may survive publication');

    // Re-publication overwrites atomically with no residue.
    evidence.publishBaselineEvidence(validRecord(), destination);
    assert.deepEqual(readdirSync(directory), ['baseline.json'], 're-publication must leave no temp residue');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI verifies committed artifacts and exits non-zero on invalid or missing ones', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const directory = mkdtempSync(path.join(tmpdir(), 'baseline-evidence-cli-'));
  try {
    const good = path.join(directory, 'good.json');
    writeFileSync(good, `${JSON.stringify(validRecord(), null, 2)}\n`);
    const accepted = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', good], { encoding: 'utf8' });
    assert.equal(accepted.status, 0, `valid artifact must verify via CLI (stderr: ${accepted.stderr})`);
    const report = JSON.parse(accepted.stdout);
    assert.equal(report.ok, true);

    const bad = path.join(directory, 'bad.json');
    const tampered = withPaths(validRecord(), { 'versions.n8n_runtime': '1.x' });
    writeFileSync(bad, `${JSON.stringify(tampered, null, 2)}\n`);
    const rejected = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', bad], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0, 'an invalid artifact must fail the CLI');
    assert.equal(JSON.parse(rejected.stdout).ok, false);

    const missing = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', path.join(directory, 'absent.json')], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0, 'a missing artifact must fail the CLI');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('publish --from-env requires the verifier verdict and the raw egress denial line — self-attested trust claims are rejected (WR-04)', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const directory = mkdtempSync(path.join(tmpdir(), 'baseline-evidence-pubenv-'));
  const destination = path.join(directory, 'baseline.json');
  try {
    const baseEnv = {
      BASELINE_RUN_ID: 'baseline-pubenvfixture-0003',
      BASELINE_STARTED_AT: '2026-10-03T18:00:00.000Z',
      BASELINE_COMPLETED_AT: '2026-10-03T18:00:39.000Z',
      BASELINE_SOURCE_COMMIT: 'c'.repeat(40),
      BASELINE_FIXTURE_SHA256: 'd'.repeat(64),
      BASELINE_SOURCE_SHA256: 'e'.repeat(64),
      BASELINE_DERIVED_SHA256: 'f'.repeat(64),
      BASELINE_DOCKER_CLIENT: '28.3.0',
      BASELINE_DOCKER_SERVER: '29.7.2',
      BASELINE_DOCKER_COMPOSE: '2.39.2',
      BASELINE_N8N_VERSION: '2.37.10',
      BASELINE_IMAGE_REFERENCE: `n8nio/n8n@sha256:${'a'.repeat(64)}`,
      BASELINE_COUNTERS_JSON: JSON.stringify({
        airtable_contacts_get: 1,
        airtable_queue_post: 1,
        openai_chat_completions_post: 1,
        lawmatics_contacts_post: 1,
        approval_actions: 0,
      }),
      BASELINE_EGRESS_METHOD: 'runtime-net internal=true asserted via docker network inspect; supplementary in-network probe denied',
      BASELINE_NETWORK_INTERNAL: 'true',
    };
    // The independent verifier's actual report shape: ok, the frozen
    // 12-entry allowlist, and hashes consistent with the values published.
    const goodReport = {
      ok: true,
      errors: [],
      allowedDifferences: Array.from({ length: 12 }, (_, index) => `allowed-${index}`),
      sourceSha256: 'e'.repeat(64),
      derivedSha256: 'f'.repeat(64),
      urlsChecked: 6,
    };
    const run = (extraEnv) =>
      spawnSync(process.execPath, [EVIDENCE_CLI, 'publish', '--from-env', '--output', destination], {
        encoding: 'utf8',
        env: { ...process.env, ...baseEnv, ...extraEnv },
      });

    // No verifier report and no probe line at all: rejected, nothing written.
    const missing = run({});
    assert.notEqual(missing.status, 0, 'publish without BASELINE_VERIFIER_REPORT must fail');
    assert.match(missing.stderr, /VERIFIER_REPORT/, `rejection must name the missing report (stderr: ${missing.stderr})`);
    assert.equal(existsSync(destination), false, 'a rejected publish must write nothing');

    // A verifier verdict that is not ok:true: rejected.
    const notOk = run({
      BASELINE_VERIFIER_REPORT: JSON.stringify({ ...goodReport, ok: false }),
      BASELINE_EGRESS_PROBE_LINE: 'EGRESS_DENIED:timeout',
    });
    assert.notEqual(notOk.status, 0, 'a failed verifier verdict must not be publishable');

    // The wrong allowlist size: rejected.
    const wrongCount = run({
      BASELINE_VERIFIER_REPORT: JSON.stringify({ ...goodReport, allowedDifferences: [] }),
      BASELINE_EGRESS_PROBE_LINE: 'EGRESS_DENIED:timeout',
    });
    assert.notEqual(wrongCount.status, 0, 'a non-12-entry allowlist must not be publishable');
    assert.match(wrongCount.stderr, /allowedDifferences/);

    // A report about different hashes than the ones being published: rejected.
    const mismatched = run({
      BASELINE_VERIFIER_REPORT: JSON.stringify({ ...goodReport, derivedSha256: '9'.repeat(64) }),
      BASELINE_EGRESS_PROBE_LINE: 'EGRESS_DENIED:timeout',
    });
    assert.notEqual(mismatched.status, 0, 'a verifier report for different hashes must not be publishable');

    // A typed boolean instead of the probe's raw denial line: rejected.
    const typed = run({
      BASELINE_VERIFIER_REPORT: JSON.stringify(goodReport),
      BASELINE_EGRESS_PROBE_LINE: 'true',
    });
    assert.notEqual(typed.status, 0, 'a self-attested egress boolean must not be publishable');
    assert.match(typed.stderr, /EGRESS_DENIED/);
    assert.equal(existsSync(destination), false, 'still nothing written after every rejection');

    for (const invalidLine of ['EGRESS_DENIED:connected', 'EGRESS_DENIED:false',
      'EGRESS_DENIED:unknown', 'EGRESS_DENIED:timeout\nEGRESS_CONNECTED']) {
      const invalid = run({ BASELINE_VERIFIER_REPORT: JSON.stringify(goodReport),
        BASELINE_EGRESS_PROBE_LINE: invalidLine });
      assert.notEqual(invalid.status, 0, `${JSON.stringify(invalidLine)} cannot prove denied egress`);
      assert.equal(existsSync(destination), false, 'an invalid probe must never publish evidence');
    }
    const nonInternal = run({ BASELINE_VERIFIER_REPORT: JSON.stringify(goodReport),
      BASELINE_EGRESS_PROBE_LINE: 'EGRESS_DENIED:timeout', BASELINE_NETWORK_INTERNAL: 'false' });
    assert.notEqual(nonInternal.status, 0, 'a non-internal Docker network cannot be asserted as egress-denied');
    assert.equal(existsSync(destination), false, 'network-inspect mismatch must not publish');

    // The honest shape — the verifier's real report plus the raw denial
    // line — publishes and independently re-verifies.
    const honest = run({
      BASELINE_VERIFIER_REPORT: JSON.stringify(goodReport),
      BASELINE_EGRESS_PROBE_LINE: 'EGRESS_DENIED:timeout',
    });
    assert.equal(honest.status, 0, `an honest env publish must succeed (stderr: ${honest.stderr})`);
    const published = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(evidence.verifyBaselineEvidence(published).ok, true, 'the published record must re-verify');
    assert.equal(published.egress.network_internal, true);
    assert.equal(published.egress.probe_outcome, 'timeout');
    assert.equal(
      published.provenance.derived_workflow.graph_equivalence.urls_checked,
      6,
      'urls_checked must flow from the verifier report, not from a separate self-set variable'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the mock admin state carries a dedicated approval_actions counter that no workflow-facing route can increment (A-06)', async () => {
  const { createMockServer } = await import('../mocks/server.mjs');
  const readFixture = JSON.parse(readFileSync(path.join(ROOT, 'payloads', 'intake-new-lead.json'), 'utf8'));
  const merged = {
    records: [],
    valid: true,
    errors: [],
    contact: { ...readFixture.contact },
    case_info: { ...readFixture.case_info },
    source: readFixture.source,
    referral_source: readFixture.referral_source,
    timestamp: readFixture.timestamp,
    firm: readFixture.firm,
    ai_classification: { case_type: 'personal_injury', confidence: 0.87, urgency: 'standard', summary: 's' },
    requires_human_review: true,
    review_status: 'pending',
    review_reason: 'standard_gate',
  };

  const { server, state } = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      state.counters.approval_actions,
      0,
      'fresh mock counters must include approval_actions initialized to zero'
    );

    // Drive the entire executed happy path: duplicate lookup, AI classify,
    // review-queue write, and the ungated Lawmatics CRM write.
    const steps = [
      ['GET', '/airtable/v0/YOUR_BASE_ID/Contacts', undefined],
      ['POST', '/openai/v1/chat/completions', { model: 'gpt-4o-mini' }],
      [
        'POST',
        '/airtable/v0/YOUR_BASE_ID/HumanReviewQueue',
        { fields: { RawData: JSON.stringify(merged), Status: 'pending_review' } },
      ],
      ['POST', '/lawmatics/v1/contacts', {
        first_name: readFixture.contact.first_name,
        last_name: readFixture.contact.last_name,
        email: readFixture.contact.email,
        phone: readFixture.contact.phone,
        case_type: 'personal_injury',
        source: 'web_form',
      }],
    ];
    for (const [method, routePath, body] of steps) {
      const response = await fetch(base + routePath, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      assert.ok(response.ok, `${method} ${routePath} must succeed (${response.status})`);
    }

    assert.equal(state.counters.airtable_queue_post, 1, 'the queue write must be counted');
    assert.equal(state.counters.lawmatics_contacts_post, 1, 'the CRM write must be counted');
    assert.equal(
      state.counters.approval_actions,
      0,
      'no workflow-facing route may increment approval_actions — approval is not implemented and must measure zero'
    );

    const resetResponse = await fetch(`${base}/admin/reset`, { method: 'POST', signal: AbortSignal.timeout(5_000) });
    assert.ok(resetResponse.ok);
    assert.equal(state.counters.approval_actions, 0, 'reset must leave approval_actions at zero');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Task 2: the committed baseline artifact and the operator documentation.
// ---------------------------------------------------------------------------

function readCommittedEvidence() {
  assert.ok(
    existsSync(COMMITTED_EVIDENCE),
    `the real pinned-runtime baseline record must be committed at runtime/evidence/baseline.json (produced by ./runtime/run-baseline.sh — a simulated or hand-written record is never acceptable)`
  );
  return JSON.parse(readFileSync(COMMITTED_EVIDENCE, 'utf8'));
}

test('the committed baseline artifact passes the same schema and invariants as generated evidence and rejects placeholder, simulated, or incomplete variants of itself', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');

  const committed = readCommittedEvidence();
  const verdict = evidence.verifyBaselineEvidence(committed);
  assert.equal(
    verdict.ok,
    true,
    `the committed real-runtime baseline must independently verify: ${JSON.stringify(verdict.errors)}`
  );

  // Placeholder: a vague version is not exact provenance.
  const placeholder = structuredClone(committed);
  placeholder.versions.n8n_runtime = '1.x';
  assert.equal(evidence.verifyBaselineEvidence(placeholder).ok, false, 'a placeholder version must be rejected');

  // Simulated: the record claims a mode/status it must never carry.
  const simulated = structuredClone(committed);
  simulated.run.execution_mode = 'simulated';
  assert.equal(evidence.verifyBaselineEvidence(simulated).ok, false, 'a simulated record must be rejected');

  // Incomplete: dropping any measurement family invalidates the artifact.
  const incomplete = structuredClone(committed);
  delete incomplete.measurements;
  assert.equal(evidence.verifyBaselineEvidence(incomplete).ok, false, 'an incomplete record must be rejected');

  // The artifact also verifies through the independent CLI.
  const cli = spawnSync(process.execPath, [EVIDENCE_CLI, 'verify', COMMITTED_EVIDENCE], { encoding: 'utf8' });
  assert.equal(cli.status, 0, `the committed artifact must pass the CLI verifier (stderr: ${cli.stderr})`);
});

test('every data-bearing reference in the committed evidence is the approved fictional fixture — no raw contact PII, credential material, or live service URL', async () => {
  const evidence = await loadEvidenceModule();
  assert.ok(evidence, 'runtime/scripts/baseline-evidence.mjs must export the evidence contract');
  const { createHash } = await import('node:crypto');

  const committed = readCommittedEvidence();

  // The referenced fixture is the committed fictional payload, byte-exact.
  const fixturePath = path.join(ROOT, ...committed.provenance.fixture.path.split('/'));
  assert.ok(existsSync(fixturePath), 'the referenced fixture must exist in the repository');
  const fixtureHash = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
  assert.equal(
    committed.provenance.fixture.sha256,
    fixtureHash,
    'the evidence fixture hash must match the committed fictional fixture bytes'
  );

  // The source workflow hash is the tracked template's actual bytes.
  const sourcePath = path.join(ROOT, ...committed.provenance.source_workflow.path.split('/'));
  assert.ok(existsSync(sourcePath), 'the referenced source workflow must exist in the repository');
  const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  assert.equal(
    committed.provenance.source_workflow.sha256,
    sourceHash,
    'the evidence source hash must match the tracked workflow bytes'
  );

  // Disclosure scan over the committed artifact: counts and provenance only.
  const serialized = JSON.stringify(committed);
  assert.doesNotMatch(serialized, /https?:\/\//, 'no URLs in committed evidence');
  assert.doesNotMatch(serialized, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'no raw email in committed evidence');
  assert.doesNotMatch(serialized, /\+1\d{10}\b/, 'no raw E.164 phone in committed evidence');
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{16,}|xox[baprs]-|Bearer\s+[A-Za-z0-9._-]{20,}/, 'no credential material in committed evidence');
  // The mocked external services appear only as path fragments, never hosts.
  assert.doesNotMatch(serialized, /api\.(lawmatics|airtable|openai)\.com|hooks\.slack\.com/, 'no live service URLs in committed evidence');
});

test('runtime/README.md documents exactly the audited one-command reproduction path and matches the launcher it describes', async () => {
  assert.ok(
    existsSync(RUNTIME_README),
    'runtime/README.md must exist with the one-command operator instructions'
  );
  const readme = readFileSync(RUNTIME_README, 'utf8');
  const launcher = readFileSync(LAUNCHER_SCRIPT, 'utf8');

  // The sole documented command, run from repository root.
  assert.match(readme, /\.\/runtime\/run-baseline\.sh/, 'the documented command must be ./runtime/run-baseline.sh from repository root');

  // Read-only prerequisites (Docker engine + cached pinned image; no pull).
  assert.match(readme, /[Dd]ocker/, 'prerequisites must state the Docker requirement');
  assert.match(readme, /cached|pull/i, 'prerequisites must explain the no-pull cached-image rule');

  // The success signal is the launcher's literal BASELINE PASS line.
  assert.match(readme, /BASELINE PASS: crm_writes=/, 'the README must document the exact success signal');
  assert.match(launcher, /BASELINE PASS: crm_writes=/, 'the launcher must emit that same success signal');

  // Generated artifact locations.
  assert.match(readme, /runtime\/evidence\/baseline\.json/, 'the README must point at the generated evidence artifact');
  assert.match(launcher, /EVIDENCE_FILE="runtime\/evidence\/baseline\.json"/, 'the launcher must publish exactly that path');

  // Stop-on-blocker semantics: an import/runtime failure is a blocker, never
  // permission to simulate.
  assert.match(readme, /blocker/i, 'the README must document stop-on-blocker behavior');
  assert.match(readme, /simulat/i, 'the README must forbid simulation as a fallback');
  assert.match(launcher, /real-runtime blocker/, 'the launcher must fail with an explicit blocker reason');

  // Truthfulness boundaries (D-15): mock evidence, no live outcome, Phase 2/3
  // scope explicitly deferred, no certification claims.
  assert.match(readme, /not a live/i, 'the README must state this is not a live business outcome');
  assert.match(readme, /Phase 2/i, 'the README must defer the approval gate to Phase 2');
  assert.match(readme, /Phase 3/i, 'the README must defer clean-sandbox certification and packaging to Phase 3');
  assert.doesNotMatch(readme, /clean-sandbox certifi|certified clean sandbox/i, 'no clean-sandbox certification claim may be made');
  assert.doesNotMatch(readme, /\b(saves|saved|savings|ROI)\b/i, 'no savings or ROI claims may be made');
});
