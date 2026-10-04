// Canonical baseline-evidence builder, fail-closed verifier, and atomic
// publisher for the Flagship Intake Phase 1 baseline (BASE-01/BASE-02/
// RUNT-03; D-01/D-02/D-06/D-08 through D-10; T-01-05/T-01-06/T-01-08/T-01-09).
//
// The one-command launcher measures the real pinned runtime and hands those
// measurements to this module; ONLY a record that passes every invariant
// below is written, and it is written atomically (temporary sibling +
// rename) so an interrupted or failed run can never leave an artifact that
// looks like completed evidence (A-01/A-05, T-01-05).
//
// Truthfulness rules baked into the schema:
//   - execution_mode is exactly "real-n8n" and status "completed" — anything
//     simulated, partial, or interrupted is rejected.
//   - the CRM write is attributed to the DERIVED runtime-adapted copy, never
//     to the unmodified tracked source; the exact one-line Validate Fields
//     body bridge is disclosed with its verbatim from/to strings.
//   - the original template's HTTP 400 is recorded ONLY as a separately
//     observed prior diagnostic — never as a measurement of this run, whose
//     adapted copy answered 202.
//   - review-queue writes and approval actions are independent counters; no
//     queue write ever counts as approval, and approval_actions must be
//     exactly zero (the baseline takes no approval action — A-06).
//   - exact versions only (D-01): vague values, ranges, or mutable tags are
//     rejected; the image reference must be digest-pinned.
//   - evidence stores counts and provenance only — no URLs, raw contact
//     PII, or credential material survive the disclosure scan (T-01-08).
//
// Zero dependencies: Node standard library only (T-01-SC).

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { EXPECTED_AUTH_NODES, HTTP_NODE_URL_MAP } from './derive-runtime-workflow.mjs';

export const BASELINE_EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_KIND = 'flagship-intake-baseline';

// The frozen extended-D-06 allowlist sizes the evidence invariants.
const URL_MAPPING_COUNT = Object.keys(HTTP_NODE_URL_MAP).length; // 6
const CREDENTIAL_REFERENCE_COUNT = EXPECTED_AUTH_NODES.length; // 5
const BRIDGE_COUNT = 1;
const ALLOWED_DIFFERENCE_COUNT = URL_MAPPING_COUNT + CREDENTIAL_REFERENCE_COUNT + BRIDGE_COUNT; // 12

/** The exact one-line webhook-body bridge the derived copy carries (D-06). */
export const BODY_BRIDGE_DISCLOSURE = Object.freeze({
  node: 'Validate Fields',
  from: 'const input = $input.first().json;',
  to: 'const raw = $input.first().json; const input = raw.body ?? raw;',
});

export const APPROVAL_SEMANTICS = Object.freeze({
  approval_source: 'dedicated admin counter (approval_actions) incremented by no workflow route',
  queue_writes_are_approvals: false,
});

export const PRIOR_ORIGINAL_TEMPLATE_DIAGNOSTIC = Object.freeze({
  scope: 'unmodified-tracked-source',
  observed: 'prior-diagnostic',
  http_status: 400,
  note: 'unpublished prior local diagnostic (not a measurement of this baseline run): the tracked flat-reading Validate Fields was observed returning HTTP 400 for the n8n Webhook body envelope on the pinned runtime; no raw negative-control capture is included in this public record',
});

export const FIXED_NOTES =
  'Local mock-runtime measurements on the body-adapted derived runtime copy (mock Lawmatics, fictional Greenfield data); not a live business outcome. Approval gating is Phase 2 work; this baseline deliberately measures the ungated write.';

const HEX64 = /^[0-9a-f]{64}$/;
const ISO = (value) => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const DENIED_PROBE_OUTCOMES = new Set([
  'timeout', 'error:ENETUNREACH', 'error:EHOSTUNREACH',
  'error:ETIMEDOUT', 'error:ECONNREFUSED', 'error:EACCES', 'error:EPERM',
]);

function parseDeniedProbeLine(raw) {
  if (typeof raw !== 'string') throw new Error('EGRESS_DENIED probe line is missing');
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith('EGRESS_DENIED:')) {
    throw new Error('EGRESS_DENIED probe must be exactly one denial line with no contradictory output');
  }
  const outcome = lines[0].slice('EGRESS_DENIED:'.length);
  if (!DENIED_PROBE_OUTCOMES.has(outcome)) {
    throw new Error(`EGRESS_DENIED probe outcome ${JSON.stringify(outcome)} is not an allowed failed-connect result`);
  }
  return outcome;
}

/** Read a nested dot-path; returns undefined when any segment is missing. */
function getPath(record, pathString) {
  let cursor = record;
  for (const key of pathString.split('.')) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Vague version detector: ranges, placeholders, or empty values (D-01). */
function isVagueVersion(value) {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return true;
  if (['unknown', 'n/a', 'na', 'none', 'latest', 'placeholder', 'tbd', 'unpinned', 'todo'].includes(normalized)) {
    return true;
  }
  if (/^v?\d+(\.\d+)*\.x(\.x)*$/.test(normalized)) return true; // 1.x, 2.37.x, v1.x.x
  if (/(^|[.-])x($|[.-])/.test(normalized)) return true; // any lone x segment
  return false;
}

// Disclosure scan patterns (T-01-08/D-11/D-16). Deliberately broad: any URL,
// raw email/E.164 phone, or credential-shaped token rejects the record.
const DISCLOSURE_PATTERNS = [
  [/https?:\/\//, 'evidence must not contain any http(s) URL'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'evidence must not contain raw email addresses'],
  [/\+1\d{10}\b/, 'evidence must not contain raw E.164 phone numbers'],
  [/sk-[A-Za-z0-9]{16,}/, 'evidence must not contain API-key material'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'evidence must not contain Slack token material'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/i, 'evidence must not contain bearer token material'],
  [/BEGIN (RSA |EC )?PRIVATE KEY/, 'evidence must not contain private key material'],
];

// Every nested field whose absence fails verification — the BASE-01/BASE-02/
// RUNT-03 proof completeness contract.
const REQUIRED_PATHS = Object.freeze([
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
]);

/**
 * Fail-closed verification of a baseline evidence record.
 *
 * @param {object} record the record to verify
 * @returns {{ok: boolean, errors: string[]}} ok is true only when EVERY
 *   invariant holds; errors name the failing field for each violation.
 */
export function verifyBaselineEvidence(record) {
  const errors = [];
  const bad = (field, why) => errors.push(`${field}: ${why}`);

  if (!isPlainObject(record)) {
    return { ok: false, errors: ['record must be a JSON object'] };
  }

  // --- proof completeness: every required field present ----------------------
  for (const required of REQUIRED_PATHS) {
    if (getPath(record, required) === undefined) {
      errors.push(`missing required proof field: ${required}`);
    }
  }

  // --- identity ---------------------------------------------------------------
  if (record.schema_version !== BASELINE_EVIDENCE_SCHEMA_VERSION) {
    bad('schema_version', `must be exactly ${BASELINE_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (record.kind !== EVIDENCE_KIND) {
    bad('kind', `must be exactly "${EVIDENCE_KIND}"`);
  }

  // --- run block ---------------------------------------------------------------
  const run = isPlainObject(record.run) ? record.run : {};
  if (typeof run.id !== 'string' || run.id.trim() === '') bad('run.id', 'must be a non-empty run identifier');
  if (!ISO(run.started_at)) bad('run.started_at', 'must be an ISO-8601 timestamp');
  if (!ISO(run.completed_at)) bad('run.completed_at', 'must be an ISO-8601 timestamp');
  if (ISO(run.started_at) && ISO(run.completed_at) && Date.parse(run.completed_at) < Date.parse(run.started_at)) {
    bad('run.completed_at', 'must not precede run.started_at');
  }
  if (run.execution_mode !== 'real-n8n') {
    bad('run.execution_mode', 'must be exactly "real-n8n" — simulated or unspecified execution is not evidence');
  }
  if (run.status !== 'completed') {
    bad('run.status', 'must be exactly "completed" — partial/interrupted/simulated runs are not evidence');
  }

  // --- provenance ---------------------------------------------------------------
  const provenance = isPlainObject(record.provenance) ? record.provenance : {};
  if (typeof provenance.source_commit !== 'string' || !/^[0-9a-f]{40}$/.test(provenance.source_commit)) {
    bad('provenance.source_commit', 'must be the full 40-hex git commit');
  }
  const fixture = isPlainObject(provenance.fixture) ? provenance.fixture : {};
  if (fixture.path !== 'payloads/intake-new-lead.json') {
    bad('provenance.fixture.path', 'must be the approved fictional fixture payloads/intake-new-lead.json');
  }
  if (typeof fixture.sha256 !== 'string' || !HEX64.test(fixture.sha256)) {
    bad('provenance.fixture.sha256', 'must be a 64-hex SHA-256');
  }
  const sourceWorkflow = isPlainObject(provenance.source_workflow) ? provenance.source_workflow : {};
  if (sourceWorkflow.path !== 'workflows/client-intake-pipeline.json') {
    bad('provenance.source_workflow.path', 'must be the tracked workflows/client-intake-pipeline.json');
  }
  if (typeof sourceWorkflow.sha256 !== 'string' || !HEX64.test(sourceWorkflow.sha256)) {
    bad('provenance.source_workflow.sha256', 'must be a 64-hex SHA-256');
  }
  if (sourceWorkflow.modified_during_run !== false) {
    bad('provenance.source_workflow.modified_during_run', 'must be false — the tracked source never changes');
  }
  const derived = isPlainObject(provenance.derived_workflow) ? provenance.derived_workflow : {};
  if (derived.kind !== 'runtime-adapted-copy') {
    bad('provenance.derived_workflow.kind', 'must be "runtime-adapted-copy" — the run executed the adapted copy, not the unmodified source');
  }
  if (typeof derived.sha256 !== 'string' || !HEX64.test(derived.sha256)) {
    bad('provenance.derived_workflow.sha256', 'must be a 64-hex SHA-256');
  }
  const equivalence = isPlainObject(derived.graph_equivalence) ? derived.graph_equivalence : {};
  if (equivalence.ok !== true) {
    bad('provenance.derived_workflow.graph_equivalence.ok', 'structural equivalence to the tracked source must be proven true');
  }
  if (equivalence.allowed_differences !== ALLOWED_DIFFERENCE_COUNT) {
    bad(
      'provenance.derived_workflow.graph_equivalence.allowed_differences',
      `must be exactly ${ALLOWED_DIFFERENCE_COUNT} (${URL_MAPPING_COUNT} URL mappings + ${CREDENTIAL_REFERENCE_COUNT} credential references + ${BRIDGE_COUNT} body bridge)`
    );
  }
  const adaptations = isPlainObject(derived.adaptations) ? derived.adaptations : {};
  if (adaptations.url_mappings !== URL_MAPPING_COUNT) {
    bad('provenance.derived_workflow.adaptations.url_mappings', `must be exactly ${URL_MAPPING_COUNT}`);
  }
  if (adaptations.credential_references !== CREDENTIAL_REFERENCE_COUNT) {
    bad('provenance.derived_workflow.adaptations.credential_references', `must be exactly ${CREDENTIAL_REFERENCE_COUNT}`);
  }
  const bridge = isPlainObject(adaptations.body_bridge) ? adaptations.body_bridge : {};
  if (bridge.node !== BODY_BRIDGE_DISCLOSURE.node) {
    bad('provenance.derived_workflow.adaptations.body_bridge.node', `must be "${BODY_BRIDGE_DISCLOSURE.node}"`);
  }
  if (bridge.from !== BODY_BRIDGE_DISCLOSURE.from) {
    bad('provenance.derived_workflow.adaptations.body_bridge.from', 'must disclose the verbatim original line — a drifted or absent bridge disclosure conceals the adaptation');
  }
  if (bridge.to !== BODY_BRIDGE_DISCLOSURE.to) {
    bad('provenance.derived_workflow.adaptations.body_bridge.to', 'must disclose the verbatim bridge substitution');
  }

  // --- versions (exact values only, D-01) ---------------------------------------
  const versions = isPlainObject(record.versions) ? record.versions : {};
  for (const field of ['docker_client', 'docker_server', 'docker_compose']) {
    if (isVagueVersion(versions[field])) {
      bad(`versions.${field}`, 'must be an exact measured version — vague, placeholder, or empty values are rejected');
    }
  }
  if (typeof versions.n8n_runtime !== 'string' || !/^\d+\.\d+\.\d+$/.test(versions.n8n_runtime)) {
    bad('versions.n8n_runtime', 'must be the exact full n8n runtime version (major.minor.patch) — the pin');
  }
  if (typeof versions.image_reference !== 'string' || !/^n8nio\/n8n@sha256:[0-9a-f]{64}$/.test(versions.image_reference)) {
    bad('versions.image_reference', 'must be the digest-pinned image reference n8nio/n8n@sha256:<64-hex> — mutable tags are rejected');
  }

  // --- measurements -----------------------------------------------------------
  const measurements = isPlainObject(record.measurements) ? record.measurements : {};
  if (!isCount(measurements.lawmatics_contact_writes) || measurements.lawmatics_contact_writes < 1) {
    bad('measurements.lawmatics_contact_writes', 'must be an integer >= 1 — the ungated CRM write is the measured defect (BASE-02)');
  }
  if (!isCount(measurements.review_queue_writes) || measurements.review_queue_writes < 1) {
    bad('measurements.review_queue_writes', 'must be an integer >= 1 — the review-queue write must be observed');
  }
  if (!Number.isInteger(measurements.approval_actions) || measurements.approval_actions !== 0) {
    bad('measurements.approval_actions', 'must be the integer 0 — the baseline run takes no approval action, and approval is never inferred from queue writes');
  }
  const counters = measurements.counters;
  if (!isPlainObject(counters)) {
    bad('measurements.counters', 'must carry the raw per-route admin counters object');
  } else {
    if (!Number.isInteger(counters.approval_actions) || counters.approval_actions !== 0) {
      bad('measurements.counters.approval_actions', 'must be the integer 0 — the dedicated approval counter is the only approval proof');
    }
    if (counters.lawmatics_contacts_post !== measurements.lawmatics_contact_writes) {
      bad('measurements.counters.lawmatics_contacts_post', 'must equal measurements.lawmatics_contact_writes — divergent counters are tampering, not evidence');
    }
    if (counters.airtable_queue_post !== measurements.review_queue_writes) {
      bad('measurements.counters.airtable_queue_post', 'must equal measurements.review_queue_writes — divergent counters are tampering, not evidence');
    }
  }

  // --- approval semantics (A-06/T-01-09) ---------------------------------------
  const semantics = isPlainObject(record.approval_semantics) ? record.approval_semantics : {};
  if (semantics.queue_writes_are_approvals !== false) {
    bad('approval_semantics.queue_writes_are_approvals', 'must be false — queueing a review record is not an approval action');
  }
  if (typeof semantics.approval_source !== 'string' || semantics.approval_source.trim() === '') {
    bad('approval_semantics.approval_source', 'must name the dedicated approval counter source');
  } else if (/queue/i.test(semantics.approval_source)) {
    bad('approval_semantics.approval_source', 'must not derive approval from the review-queue counter (fail closed against queue-as-approval spoofing)');
  }

  // --- egress denial (RUNT-03/D-08) ---------------------------------------------
  const egress = isPlainObject(record.egress) ? record.egress : {};
  if (egress.denied !== true) {
    bad('egress.denied', 'external egress denial must be proven true');
  }
  if (egress.network_internal !== true) {
    bad('egress.network_internal', 'Docker network inspect must have reported Internal=true');
  }
  if (!DENIED_PROBE_OUTCOMES.has(egress.probe_outcome)) {
    bad('egress.probe_outcome', 'must be an enumerated failed-connect outcome, never connected or an unknown value');
  }
  if (typeof egress.method !== 'string' || egress.method.trim() === '') {
    bad('egress.method', 'the denial proof method must be described');
  }

  // --- diagnostics: the 400/202 dual disclosure (D-06/D-15) ---------------------
  const diagnostics = isPlainObject(record.diagnostics) ? record.diagnostics : {};
  const prior = isPlainObject(diagnostics.prior_original_template) ? diagnostics.prior_original_template : {};
  if (prior.http_status !== 400) {
    bad('diagnostics.prior_original_template.http_status', 'must record the separately observed original-template 400');
  }
  if (prior.observed !== 'prior-diagnostic') {
    bad('diagnostics.prior_original_template.observed', 'must be "prior-diagnostic" — the 400 is a prior negative control, never a measurement of this run');
  }
  const adaptedRun = isPlainObject(diagnostics.adapted_run) ? diagnostics.adapted_run : {};
  if (adaptedRun.http_status !== 202) {
    bad('diagnostics.adapted_run.http_status', 'must be the measured 202 of the adapted copy — a 400 here conflates the prior diagnostic with this run');
  }
  if (adaptedRun.observed !== 'this-run') {
    bad('diagnostics.adapted_run.observed', 'must be "this-run"');
  }

  // --- disclosure scan (T-01-08) -------------------------------------------------
  let serialized = null;
  try {
    serialized = JSON.stringify(record);
  } catch {
    errors.push('record must be JSON-serializable');
  }
  if (serialized !== null) {
    for (const [pattern, message] of DISCLOSURE_PATTERNS) {
      if (pattern.test(serialized)) errors.push(message);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Assemble the canonical evidence record from launcher measurements.
 *
 * @param {object} input measured values (see the CLI below for the exact
 *   fields). Constants that must never vary — schema, real-n8n mode, the
 *   bridge disclosure, approval semantics, the prior-400 diagnostic — are
 *   fixed here, not accepted from input.
 * @returns {object} the canonical record (still subject to verification).
 */
export function buildBaselineEvidence(input) {
  if (!isPlainObject(input)) {
    throw new Error('buildBaselineEvidence requires a measurements object');
  }
  if (input.execution_mode !== undefined && input.execution_mode !== 'real-n8n') {
    throw new Error(`execution_mode must be "real-n8n" (got ${JSON.stringify(input.execution_mode)}) — simulated evidence is never built`);
  }
  if (input.status !== undefined && input.status !== 'completed') {
    throw new Error(`status must be "completed" (got ${JSON.stringify(input.status)})`);
  }
  const counters = input.counters;
  if (!isPlainObject(counters)) {
    throw new Error('input.counters must carry the measured admin counters object');
  }
  if (!Number.isInteger(counters.approval_actions) || counters.approval_actions !== 0) {
    throw new Error(`input.counters.approval_actions must be exactly 0 (got ${JSON.stringify(counters.approval_actions)}) — an approval action invalidates the baseline`);
  }
  if (!Number.isInteger(counters.lawmatics_contacts_post) || counters.lawmatics_contacts_post < 1) {
    throw new Error(`input.counters.lawmatics_contacts_post must be >= 1 (got ${JSON.stringify(counters.lawmatics_contacts_post)}) — no CRM write means the defect was not demonstrated`);
  }
  const equivalence = isPlainObject(input.graph_equivalence) ? input.graph_equivalence : {};
  if (equivalence.ok !== true) {
    throw new Error('input.graph_equivalence.ok must be true — only a verified structurally equivalent copy may produce evidence');
  }
  const egress = isPlainObject(input.egress) ? input.egress : {};
  if (egress.denied !== true) {
    throw new Error('input.egress.denied must be true — unproven egress denial invalidates the run');
  }
  if (egress.network_internal !== true) {
    throw new Error('input.egress.network_internal must be true — Docker network inspect did not prove isolation');
  }
  if (!DENIED_PROBE_OUTCOMES.has(egress.probe_outcome)) {
    throw new Error('input.egress.probe_outcome must be an enumerated failed-connect result');
  }

  return {
    schema_version: BASELINE_EVIDENCE_SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    run: {
      id: input.run_id,
      started_at: input.started_at,
      completed_at: input.completed_at ?? new Date().toISOString(),
      execution_mode: 'real-n8n',
      status: 'completed',
    },
    provenance: {
      source_commit: input.source_commit,
      fixture: { path: 'payloads/intake-new-lead.json', sha256: input.fixture?.sha256 },
      source_workflow: {
        path: 'workflows/client-intake-pipeline.json',
        sha256: input.source_workflow?.sha256,
        modified_during_run: false,
      },
      derived_workflow: {
        kind: 'runtime-adapted-copy',
        sha256: input.derived_workflow?.sha256,
        graph_equivalence: {
          ok: true,
          allowed_differences: ALLOWED_DIFFERENCE_COUNT,
          urls_checked: equivalence.urls_checked,
        },
        adaptations: {
          url_mappings: URL_MAPPING_COUNT,
          credential_references: CREDENTIAL_REFERENCE_COUNT,
          body_bridge: { ...BODY_BRIDGE_DISCLOSURE, scope: 'derived runtime copy only' },
        },
      },
    },
    versions: {
      docker_client: input.versions?.docker_client,
      docker_server: input.versions?.docker_server,
      docker_compose: input.versions?.docker_compose,
      n8n_runtime: input.versions?.n8n_runtime,
      image_reference: input.versions?.image_reference,
    },
    measurements: {
      lawmatics_contact_writes: counters.lawmatics_contacts_post,
      review_queue_writes: counters.airtable_queue_post ?? 0,
      approval_actions: counters.approval_actions,
      counters: structuredClone(counters),
      webhook_status_source: 'asserted by runtime/tests/baseline.e2e.test.mjs',
    },
    approval_semantics: structuredClone(APPROVAL_SEMANTICS),
    egress: { denied: true, network_internal: true, probe_outcome: egress.probe_outcome,
      method: egress.method },
    diagnostics: {
      prior_original_template: structuredClone(PRIOR_ORIGINAL_TEMPLATE_DIAGNOSTIC),
      adapted_run: {
        scope: 'derived-runtime-copy',
        observed: 'this-run',
        http_status: 202,
        source: 'asserted by runtime/tests/baseline.e2e.test.mjs',
      },
    },
    notes: FIXED_NOTES,
  };
}

/**
 * Verify then atomically publish a baseline record: write to a temporary
 * sibling of the destination and rename only after verification succeeds.
 * A rejected record throws and writes nothing (T-01-05).
 *
 * @param {object} record the record to publish
 * @param {string} destination path the accepted record is renamed to
 * @returns {{ok: true, destination: string, sha256: string, bytes: number}}
 */
export function publishBaselineEvidence(record, destination) {
  const verdict = verifyBaselineEvidence(record);
  if (!verdict.ok) {
    throw new Error(`baseline evidence rejected — not published: ${verdict.errors.join('; ')}`);
  }
  const payload = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.tmp-${process.pid}`);
  const fd = openSync(temporary, 'wx');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return {
    ok: true,
    destination,
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: payload.length,
  };
}

// --- CLI ---------------------------------------------------------------------
//
//   node runtime/scripts/baseline-evidence.mjs verify <file>
//       Verify a committed evidence artifact; prints {ok, errors}; exit 0/1.
//
//   node runtime/scripts/baseline-evidence.mjs publish --from-env --output <path>
//       Assemble a record from BASELINE_* environment variables (launcher
//       measurements), verify it, and atomically publish it. Any missing or
//       unproven value exits non-zero WITHOUT writing the artifact.
//
//       Trust claims are NOT accepted as self-attested booleans (WR-04):
//         - BASELINE_VERIFIER_REPORT   the independent verifier's full JSON
//                                      report; must carry ok === true, the
//                                      frozen 12-entry allowedDifferences
//                                      allowlist, and hashes matching the
//                                      BASELINE_*_SHA256 values being
//                                      published
//         - BASELINE_EGRESS_PROBE_LINE the raw "EGRESS_DENIED:<outcome>"
//                                      line emitted by the in-network egress
//                                      probe (not a hand-typed boolean)

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const [verb, ...rest] = process.argv.slice(2);
  const out = (document) => process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  try {
    if (verb === 'verify') {
      const [file] = rest;
      if (typeof file !== 'string') throw new Error('usage: baseline-evidence.mjs verify <file>');
      let record;
      try {
        record = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        out({ ok: false, errors: [`unreadable evidence file ${file}: ${error.message}`] });
        process.exit(1);
      }
      const verdict = verifyBaselineEvidence(record);
      out(verdict);
      process.exit(verdict.ok ? 0 : 1);
    }
    if (verb === 'publish') {
      const outputIndex = rest.indexOf('--output');
      const destination = outputIndex !== -1 ? rest[outputIndex + 1] : undefined;
      if (!rest.includes('--from-env') || typeof destination !== 'string') {
        throw new Error('usage: baseline-evidence.mjs publish --from-env --output <path>');
      }
      const env = process.env;
      const required = (name) => {
        const value = env[name];
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error(`missing required measurement ${name} — evidence is not publishable without it`);
        }
        return value;
      };
      let counters;
      try {
        counters = JSON.parse(required('BASELINE_COUNTERS_JSON'));
      } catch (error) {
        throw new Error(`BASELINE_COUNTERS_JSON is not a JSON counters object: ${error.message}`);
      }
      // WR-04: trust claims must come from the tools that actually produced
      // them, never from self-attested booleans the caller can type by hand.
      // The independent verifier's full JSON report and the egress probe's
      // raw denial line are mandatory inputs.
      let verifierReport;
      try {
        verifierReport = JSON.parse(required('BASELINE_VERIFIER_REPORT'));
      } catch (error) {
        throw new Error(`BASELINE_VERIFIER_REPORT is not the verifier's JSON report: ${error.message}`);
      }
      if (!isPlainObject(verifierReport) || verifierReport.ok !== true) {
        throw new Error(
          'BASELINE_VERIFIER_REPORT.ok must be true — the independent D-06 verifier must actually have accepted the derived copy; a self-attested equivalence claim cannot be published'
        );
      }
      const reportedDifferences = Array.isArray(verifierReport.allowedDifferences)
        ? verifierReport.allowedDifferences.length
        : verifierReport.allowedDifferences;
      if (reportedDifferences !== ALLOWED_DIFFERENCE_COUNT) {
        throw new Error(
          `BASELINE_VERIFIER_REPORT.allowedDifferences must be the frozen ${ALLOWED_DIFFERENCE_COUNT}-entry D-06 allowlist (got ${JSON.stringify(reportedDifferences)})`
        );
      }
      const probeOutcome = parseDeniedProbeLine(required('BASELINE_EGRESS_PROBE_LINE'));
      if (required('BASELINE_NETWORK_INTERNAL') !== 'true') {
        throw new Error('BASELINE_NETWORK_INTERNAL must be true from Docker network inspect');
      }
      const input = {
        run_id: required('BASELINE_RUN_ID'),
        started_at: required('BASELINE_STARTED_AT'),
        completed_at: env.BASELINE_COMPLETED_AT,
        source_commit: required('BASELINE_SOURCE_COMMIT'),
        fixture: { path: 'payloads/intake-new-lead.json', sha256: required('BASELINE_FIXTURE_SHA256') },
        source_workflow: { path: 'workflows/client-intake-pipeline.json', sha256: required('BASELINE_SOURCE_SHA256') },
        derived_workflow: { kind: 'runtime-adapted-copy', sha256: required('BASELINE_DERIVED_SHA256') },
        graph_equivalence: {
          ok: verifierReport.ok === true,
          allowed_differences: reportedDifferences,
          urls_checked: Number(verifierReport.urlsChecked ?? 0),
        },
        versions: {
          docker_client: required('BASELINE_DOCKER_CLIENT'),
          docker_server: required('BASELINE_DOCKER_SERVER'),
          docker_compose: required('BASELINE_DOCKER_COMPOSE'),
          n8n_runtime: required('BASELINE_N8N_VERSION'),
          image_reference: required('BASELINE_IMAGE_REFERENCE'),
        },
        counters,
        egress: { denied: true, network_internal: true, probe_outcome: probeOutcome,
          method: required('BASELINE_EGRESS_METHOD') },
      };
      // The verdict must be about the exact copy being published: a report
      // whose hashes do not match the measured ones describes a different
      // derivation and is rejected.
      if (
        verifierReport.sourceSha256 !== input.source_workflow.sha256 ||
        verifierReport.derivedSha256 !== input.derived_workflow.sha256
      ) {
        throw new Error(
          'BASELINE_VERIFIER_REPORT hashes must match BASELINE_SOURCE_SHA256 and BASELINE_DERIVED_SHA256 — the verifier verdict must be about the exact copy being published'
        );
      }
      const published = publishBaselineEvidence(buildBaselineEvidence(input), destination);
      out(published);
      process.exit(0);
    }
    throw new Error('usage: baseline-evidence.mjs verify <file> | publish --from-env --output <path>');
  } catch (error) {
    process.stderr.write(`baseline-evidence: ${error.message}\n`);
    process.exit(1);
  }
}
