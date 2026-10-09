// Canonical final-evidence capture parser, record builder, fail-closed
// verifier, and atomic publisher for the Flagship Intake Phase 3 PACK-01
// evidence log.
//
// The one-command driver (runtime/run-final-evidence.sh) executes the REAL
// pinned-runtime full suite (the unchanged ./runtime/run-gated-demo.sh),
// tees its genuine combined console output to a driver-owned capture file,
// and hands that capture to this module. ONLY a capture that parses into the
// launcher's exact success vocabulary — five CASE PASS lines in the fixed
// order, STATIC CONTRACTS PASS, FULL-SUITE PASS, a preservation line, the
// exact-pin runtime version, and the evidence sha256 line — can produce a
// record, and ONLY a record that passes every invariant below is written,
// atomically (temporary sibling + rename), so a failed, interrupted, or
// partial run can never leave an artifact that looks like completed
// evidence (CONTEXT gate 1; T-03-01/T-03-02/T-03-03).
//
// Truthfulness rules baked into the schema:
//   - execution_mode is exactly "real-n8n" and status "completed" — anything
//     simulated, partial, or interrupted is rejected before publication.
//   - every count is MACHINE-PARSED from the captured console output of a
//     real run; nothing in the record is typed by hand or reconstructed
//     from an earlier run's memory.
//   - the per-case counted states are the launcher's own fixed closing-state
//     assertions (queue/approval_actions/crm_attempts/crm_effects per case
//     group) — a case whose observed counts diverge is not evidence.
//   - exact versions only: the n8n pin must be a full major.minor.patch and
//     the image reference digest-pinned (vague values are rejected).
//   - the record stores counts, versions, commands, and hashes only — the
//     disclosure scan inside verify rejects any URL, raw contact PII, or
//     credential material before publication (T-03-01).
//   - serialization is canonical (recursively sorted keys): the same logical
//     record always produces identical bytes, so post-hoc edits are visible
//     in git diff and separately executed runs differ only by their own
//     run id and measured values (deterministic serialization).
//
// Zero dependencies: Node standard library only (T-03-SC).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const FINAL_EVIDENCE_SCHEMA_VERSION = 1;
export const FINAL_EVIDENCE_KIND = 'flagship-intake-final-evidence';

// The launcher's fixed five-group matrix order (run-gated-demo.sh FULL_CASES)
// with its fixed closing-state assertions — the counted facts any publishable
// record must reproduce, per case, from the captured output.
export const EXPECTED_CASE_STATES = Object.freeze([
  Object.freeze({ name: 'tracer', queue: 1, approval_actions: 0, crm_attempts: 0, crm_effects: 0 }),
  Object.freeze({ name: 'reviewer-gate', queue: 1, approval_actions: 0, crm_attempts: 0, crm_effects: 0 }),
  Object.freeze({ name: 'approval-delivery', queue: 1, approval_actions: 1, crm_attempts: 1, crm_effects: 1 }),
  Object.freeze({ name: 'intake-idempotency', queue: 1, approval_actions: 0, crm_attempts: 0, crm_effects: 0 }),
  Object.freeze({ name: 'crm-recovery', queue: 1, approval_actions: 1, crm_attempts: 2, crm_effects: 1 }),
]);

// Disclosure scan patterns (T-03-01/D-11/D-16) — the exact baseline-evidence
// pattern set (runtime/scripts/baseline-evidence.mjs). Deliberately broad:
// any URL, raw email/E.164 phone, or credential-shaped token rejects the
// record. The scan runs INSIDE verify, over the serialized record.
export const DISCLOSURE_PATTERNS = [
  [/https?:\/\//, 'evidence must not contain any http(s) URL'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'evidence must not contain raw email addresses'],
  [/\+1\d{10}\b/, 'evidence must not contain raw E.164 phone numbers'],
  [/sk-[A-Za-z0-9]{16,}/, 'evidence must not contain API-key material'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'evidence must not contain Slack token material'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/i, 'evidence must not contain bearer token material'],
  [/BEGIN (RSA |EC )?PRIVATE KEY/, 'evidence must not contain private key material'],
];

const EXACT_TRIPLE = /^\d+\.\d+\.\d+$/;
const DIGEST_IMAGE = /^n8nio\/n8n@sha256:[0-9a-f]{64}$/;
const RUN_ID = /^final-\d{8}T\d{6}Z$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// WR-02: the FROZEN release boundary is the committed fictional baseline on
// this sanitized branch. A rerun record must name this exact full 40-hex SHA;
// the private staging milestone and all short/ref forms are rejected.
export const FROZEN_PHASE_BASE_SHA = '2515498259a1e47ecb5088b2cb0ea22b3c63393b';
const isFrozenPhaseBase = (value) => value === FROZEN_PHASE_BASE_SHA;

// The exact executed command strings the record must carry (PACK-01): the
// one-command driver, the unchanged launcher it executes, the standalone
// re-verification command, and the two version-capture commands the driver
// runs. Fixed constants — the driver runs exactly these.
const FIXED_COMMANDS = Object.freeze([
  './runtime/run-final-evidence.sh',
  './runtime/run-gated-demo.sh',
  'node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json',
  'docker --version',
  'docker compose version',
]);
const REQUIRED_COMMANDS = Object.freeze([
  './runtime/run-final-evidence.sh',
  './runtime/run-gated-demo.sh',
  'node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json',
]);

// Per-case failure_condition prose: names what divergence would have failed
// the case group — the launcher's own closing-state assertions.
const CASE_FAILURE_CONDITIONS = Object.freeze({
  tracer:
    'the launcher fails this case group unless the counted admin state is exactly queue=1 approval_actions=0 crm_attempts=0 crm_effects=0 — any CRM attempt or effect before a reviewer action, any recorded approval, or a missing staged review would have printed CASE FAIL and aborted the suite',
  'reviewer-gate':
    'the launcher fails this case group unless the counted admin state is exactly queue=1 approval_actions=0 crm_attempts=0 crm_effects=0 — a missing, wrong, or replayed one-time proof that reached CRM, a malformed or unknown decision that recorded anything, an unearned approval increment, or the closing reject reaching CRM would have printed CASE FAIL',
  'approval-delivery':
    'the launcher fails this case group unless the counted admin state is exactly queue=1 approval_actions=1 crm_attempts=1 crm_effects=1 — any effect without exactly one authorized approval and exactly one attempt, a second committed effect, or a committed replay writing again would have printed CASE FAIL',
  'intake-idempotency':
    'the launcher fails this case group unless the counted admin state is exactly queue=1 approval_actions=0 crm_attempts=0 crm_effects=0 — an exact duplicate replay creating a second review, any CRM write, or a conflicting intake key not failing closed with 409 would have printed CASE FAIL',
  'crm-recovery':
    'the launcher fails this case group unless the counted admin state is exactly queue=1 approval_actions=1 crm_attempts=2 crm_effects=1 — any effect count other than exactly one after exactly two attempts (the deterministic pre-commit failure at 1/0 plus one deliberate same-key retry at 2/1), or an extra write on committed replay, would have printed CASE FAIL',
});

// The structured limitations section (PACK-01): every claim boundary the
// record must disclose, per 03-CONTEXT gates and STATE WR-02.
const FIXED_LIMITATIONS = Object.freeze([
  'External egress denial is attributed to the verified internal-only Docker network topology (network inspect reports Internal=true) plus the fail-closed URL allowlist enforced by the static workflow contracts; the RFC 5737 TEST-NET-1 probe is supplementary defense-in-depth only and is never cited as the sole denial proof (STATE WR-02).',
  'Every approval in the automated matrix is SIMULATED reviewer input performed by the test suite through the separate recorded reviewer HTTP action; no person is claimed to have exercised the manual two-terminal review path in this run.',
  'The one-time reviewer proof is consumed at most once per registration window; a privileged admin reset may invalidate a registration and re-register the same raw proof value — this is a per-window consumption semantic, not a durable one-use guarantee.',
  'Response-loss-after-commit handling, process-restart recovery, and universal exactly-once delivery are NOT implemented and NOT claimed; the only recovery proven is the crm-recovery case group\'s pre-commit application failure plus one deliberate state-observed same-key retry (attempts 2, effects 1).',
  'n8n runtime state is tmpfs-backed (memory-only, statfs-verified before teardown) while the invocation-owned 0600 host proof file and issued-proofs log are disk-backed until normal teardown; a hard kill may leave them for owner-verified stale-lock recovery, and no disk-freedom claim is made for them.',
  'The demo-state volume holds raw fictional intake payloads (Greenfield & Associates fixture data) on disk while the sandbox is live — it is NOT PII-free by construction; it is destroyed at verified teardown and no real client or firm data was used.',
]);

// Each matcher must hit at least one limitations entry — the machine-checked
// disclosure of the six required themes.
const REQUIRED_LIMITATION_MATCHERS = Object.freeze([
  [
    /internal/i,
    /allowlist/i,
    'egress denial must be attributed to the internal network topology plus the fail-closed URL allowlist, not the TEST-NET-1 probe alone (STATE WR-02)',
  ],
  [/simulated/i, /reviewer/i, 'automated approvals must be labeled simulated reviewer input with no claim a person exercised the manual path'],
  [/registration window/, /reset/i, 'the one-time reviewer proof semantics must be stated as per-registration-window with privileged admin reset'],
  [
    /response-loss-after-commit/i,
    /process-restart/i,
    /exactly-once/i,
    'response-loss-after-commit, process-restart recovery, and universal exactly-once delivery must be disclosed as NOT implemented and NOT claimed',
  ],
  [/tmpfs/, /disk/i, 'the tmpfs-backed n8n state vs disk-backed 0600 host proof files boundary must be disclosed'],
  [/demo-state/, /fictional/i, 'the demo-state volume holding raw fictional intake payloads (not PII-free) must be disclosed'],
]);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

/** Vague version detector — the same rule the baseline evidence enforces. */
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

// --- capture parsing -----------------------------------------------------------
//
// The parser consumes ONLY the launcher's exact success vocabulary — every
// other line (docker compose noise, audit TAP output) is ignored:

const CASE_PASS_RE =
  /^CASE PASS \((\d+)\/(\d+)\) (\S+): (.*?) \u2014 queue=(\d+) approval_actions=(\d+) CRM ATTEMPTS=(\d+) CRM EFFECTS=(\d+)[ \t]*$/;
const CASE_FAIL_RE = /CASE FAIL \(/;
const STATIC_CONTRACTS_RE = /^STATIC CONTRACTS PASS:/;
const FULL_SUITE_RE = /^FULL-SUITE PASS: (\d+)\/(\d+) case groups green on real pinned n8n (\d+\.\d+\.\d+)/;
const PRESERVATION_TEARDOWN_RE = /^unrelated containers preserved: (\d+)\/(\d+)/;
const PRESERVATION_FINAL_RE = /^preservation: (\d+)\/(\d+) unrelated containers identical/;
const RUNTIME_VERSION_RE = /^real n8n runtime version: (\d+\.\d+\.\d+)/;
const EVIDENCE_LINE_RE = /^evidence: /;
const EVIDENCE_HASH_RES = [
  ['historical_source', /historical source sha256=([0-9a-f]{64})/],
  ['intake_workflow', /intake workflow sha256=([0-9a-f]{64})/],
  ['reviewer_workflow', /reviewer workflow sha256=([0-9a-f]{64})/],
  ['delivery_workflow', /delivery workflow sha256=([0-9a-f]{64})/],
];
const EVIDENCE_N8N_RE = /\bn8n=(\d+\.\d+\.\d+)/;

/**
 * Parse the launcher's captured combined console output into structured
 * measurements. Pure text analysis: no filesystem, no Docker.
 *
 * @param {string} text the captured stdout+stderr of a full-suite run
 * @returns {{cases: object[], case_failures: string[], static_contracts: boolean,
 *            full_suite: object|null, preservation: object|null,
 *            n8n_version: string|null, evidence_hashes: object|null}}
 */
export function parseLauncherCapture(text) {
  if (typeof text !== 'string') {
    throw new Error('parseLauncherCapture requires the captured console text');
  }
  const cases = [];
  const caseFailures = [];
  let staticContracts = false;
  let fullSuite = null;
  let fullSuiteLines = 0;
  const preservationObservations = [];
  const versionObservations = [];
  let evidenceHashes = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '').replace(/^\[gated\] /, '');
    let match;

    if ((match = CASE_PASS_RE.exec(line))) {
      cases.push({
        index: Number(match[1]),
        name: match[3],
        summary: match[4],
        observed: {
          queue: Number(match[5]),
          approval_actions: Number(match[6]),
          crm_attempts: Number(match[7]),
          crm_effects: Number(match[8]),
        },
        result: 'pass',
      });
      continue;
    }
    if (CASE_FAIL_RE.test(line)) {
      caseFailures.push(line);
      continue;
    }
    if (STATIC_CONTRACTS_RE.test(line)) {
      staticContracts = true;
      continue;
    }
    if ((match = FULL_SUITE_RE.exec(line))) {
      fullSuiteLines += 1;
      fullSuite = { passed: Number(match[1]), total: Number(match[2]), n8n_version: match[3] };
      versionObservations.push(match[3]);
      continue;
    }
    if ((match = PRESERVATION_TEARDOWN_RE.exec(line))) {
      preservationObservations.push({ preserved: Number(match[1]), total: Number(match[2]) });
      continue;
    }
    if ((match = PRESERVATION_FINAL_RE.exec(line))) {
      preservationObservations.push({ preserved: Number(match[1]), total: Number(match[2]) });
      continue;
    }
    if ((match = RUNTIME_VERSION_RE.exec(line))) {
      versionObservations.push(match[1]);
      continue;
    }
    if (EVIDENCE_LINE_RE.test(line)) {
      const hashes = {};
      for (const [key, pattern] of EVIDENCE_HASH_RES) {
        const hashMatch = pattern.exec(line);
        if (hashMatch) hashes[key] = hashMatch[1];
      }
      if (Object.keys(hashes).length > 0) evidenceHashes = hashes;
      const versionMatch = EVIDENCE_N8N_RE.exec(line);
      if (versionMatch) versionObservations.push(versionMatch[1]);
      continue;
    }
  }

  // Preservation: every observation in one capture must agree, and the run
  // must carry at least one (teardown + final lines normally both appear).
  let preservation = null;
  if (preservationObservations.length > 0) {
    const first = preservationObservations[0];
    const agree = preservationObservations.every(
      (obs) => obs.preserved === first.preserved && obs.total === first.total
    );
    if (agree) preservation = { preserved: first.preserved, total: first.total };
  }

  // Version: every in-capture version observation (runtime-version line,
  // FULL-SUITE line, evidence line) must agree; a disagreement means the
  // capture is not one coherent run.
  let n8nVersion = null;
  if (versionObservations.length > 0) {
    const first = versionObservations[0];
    if (versionObservations.every((obs) => obs === first)) n8nVersion = first;
  }

  return {
    cases,
    case_failures: caseFailures,
    static_contracts: staticContracts,
    full_suite: fullSuite,
    full_suite_lines: fullSuiteLines,
    preservation,
    preservation_observations: preservationObservations,
    n8n_version: n8nVersion,
    version_observations: versionObservations,
    evidence_hashes: evidenceHashes,
  };
}

/** A `final-<UTC timestamp>Z` run identifier (compact ISO-8601 basic format). */
function newRunId(at = new Date()) {
  return `final-${at.toISOString().replace(/-/g, '').replace(/:/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

/**
 * Assemble the canonical PACK-01 evidence record from a PARSED capture plus
 * the driver-supplied measurements (image pin, captured docker version
 * strings, head commit). Fail-closed: any missing, contradictory, or partial
 * measurement throws instead of producing a record. The builder itself is
 * free of Docker and git side effects — every value arrives as input.
 *
 * @param {object} input { parsed, image_reference, docker_client,
 *                         docker_compose, head_commit, run_id? }
 * @returns {object} the canonical record (still subject to verification)
 */
export function buildFinalEvidenceRecord(input) {
  if (!isPlainObject(input)) {
    throw new Error('buildFinalEvidenceRecord requires { parsed, image_reference, docker_client, docker_compose, head_commit }');
  }
  const parsed = input.parsed;
  if (!isPlainObject(parsed)) {
    throw new Error('input.parsed must come from parseLauncherCapture over a real run capture');
  }
  if (parsed.case_failures?.length > 0) {
    throw new Error(
      `capture contains a CASE FAIL marker — a failed case group is not evidence: ${parsed.case_failures[0]}`
    );
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length !== EXPECTED_CASE_STATES.length) {
    throw new Error(
      `capture must carry exactly ${EXPECTED_CASE_STATES.length} CASE PASS lines — zero, partial, or concatenated captures are not evidence (got ${Array.isArray(parsed.cases) ? parsed.cases.length : 0})`
    );
  }
  const expectedOrder = EXPECTED_CASE_STATES.map((state) => state.name).join(', ');
  const actualOrder = parsed.cases.map((entry) => entry.name).join(', ');
  if (actualOrder !== expectedOrder) {
    throw new Error(
      `case names must be the launcher fixed distinct order ${expectedOrder} (got ${actualOrder})`
    );
  }
  parsed.cases.forEach((entry, i) => {
    if (entry.index !== i + 1) {
      throw new Error(`case indexes must be the launcher fixed 1..5 order (case ${i + 1} carries index ${entry.index})`);
    }
    if (entry.result !== 'pass') {
      throw new Error(`case ${entry.name} must carry result pass (got ${entry.result})`);
    }
  });
  if (parsed.static_contracts !== true) {
    throw new Error('capture is missing the STATIC CONTRACTS PASS line — structural uncertainty is a blocker, not evidence');
  }
  if (parsed.full_suite_lines !== 1 || !parsed.full_suite) {
    throw new Error(
      'capture must carry exactly one FULL-SUITE PASS line — a missing or duplicated line means the run is not one completed full suite'
    );
  }
  if (parsed.full_suite.passed !== parsed.full_suite.total || parsed.full_suite.total !== parsed.cases.length) {
    throw new Error(
      `FULL-SUITE PASS must report ${parsed.cases.length}/${parsed.cases.length} (got ${parsed.full_suite.passed}/${parsed.full_suite.total})`
    );
  }
  if (!parsed.preservation) {
    if (parsed.preservation_observations?.length > 0) {
      throw new Error('preservation observations within one capture disagree — the capture is not one coherent run');
    }
    throw new Error('capture carries no preservation line — unrelated-container preservation is unproven');
  }
  if (parsed.preservation.preserved !== parsed.preservation.total) {
    throw new Error(
      `preservation mismatch: ${parsed.preservation.preserved}/${parsed.preservation.total} unrelated containers preserved — preservation is not proven`
    );
  }
  if (!parsed.n8n_version || !EXACT_TRIPLE.test(parsed.n8n_version)) {
    if (parsed.version_observations?.length > 1) {
      throw new Error(
        `runtime version observations disagree within one capture: ${parsed.version_observations.join(' vs ')}`
      );
    }
    throw new Error('capture carries no exact-pin runtime version — an unpinned runtime is not evidence');
  }
  if (typeof input.image_reference !== 'string' || !DIGEST_IMAGE.test(input.image_reference)) {
    throw new Error(
      'image_reference must be the digest-pinned n8nio/n8n@sha256:<64-hex> reference — mutable tags are rejected'
    );
  }
  for (const field of ['docker_client', 'docker_compose']) {
    if (isVagueVersion(input[field])) {
      throw new Error(
        `input.${field} must be the exact captured version string (driver runs the recorded command and parses it) — vague, placeholder, or empty values are rejected`
      );
    }
  }
  if (typeof input.head_commit !== 'string' || !HEX40.test(input.head_commit)) {
    throw new Error('input.head_commit must be the full 40-hex git commit captured by the driver');
  }
  const evidenceHashes = parsed.evidence_hashes;
  if (!isPlainObject(evidenceHashes)) {
    throw new Error('capture carries no evidence sha256 line — provenance binding to the executed workflow bytes is unproven');
  }
  for (const key of ['historical_source', 'intake_workflow', 'reviewer_workflow', 'delivery_workflow']) {
    if (typeof evidenceHashes[key] !== 'string' || !HEX64.test(evidenceHashes[key])) {
      throw new Error(`parsed evidence sha256 values must include a 64-hex ${key} (got ${JSON.stringify(evidenceHashes[key])})`);
    }
  }
  let runId = newRunId();
  if (input.run_id !== undefined) {
    if (typeof input.run_id !== 'string' || !RUN_ID.test(input.run_id)) {
      throw new Error(`input.run_id must match final-<UTC timestamp>Z (got ${JSON.stringify(input.run_id)})`);
    }
    runId = input.run_id;
  }

  return {
    schema_version: FINAL_EVIDENCE_SCHEMA_VERSION,
    kind: FINAL_EVIDENCE_KIND,
    run: {
      id: runId,
      execution_mode: 'real-n8n',
      status: 'completed',
    },
    commands: [...FIXED_COMMANDS],
    versions: {
      docker_client: input.docker_client,
      docker_compose: input.docker_compose,
      n8n_runtime: parsed.n8n_version,
      image_reference: input.image_reference,
    },
    provenance: {
      head: input.head_commit,
      evidence_sha256: {
        historical_source: evidenceHashes.historical_source,
        intake_workflow: evidenceHashes.intake_workflow,
        reviewer_workflow: evidenceHashes.reviewer_workflow,
        delivery_workflow: evidenceHashes.delivery_workflow,
      },
    },
    cases: parsed.cases.map((entry, i) => ({
      index: entry.index,
      name: entry.name,
      summary: entry.summary,
      observed: { ...entry.observed },
      expected: {
        queue: EXPECTED_CASE_STATES[i].queue,
        approval_actions: EXPECTED_CASE_STATES[i].approval_actions,
        crm_attempts: EXPECTED_CASE_STATES[i].crm_attempts,
        crm_effects: EXPECTED_CASE_STATES[i].crm_effects,
      },
      failure_condition: CASE_FAILURE_CONDITIONS[entry.name],
      result: entry.result,
    })),
    static_contracts: true,
    full_suite: { passed: parsed.full_suite.passed, total: parsed.full_suite.total },
    preservation: { ...parsed.preservation },
    limitations: [...FIXED_LIMITATIONS],
    notes: [],
  };
}

/** Read a nested dot-path; undefined when any segment is missing. */
function getPath(record, pathString) {
  let cursor = record;
  for (const key of pathString.split('.')) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Canonical serialization: recursively sorted keys, stable arrays, 2-space indent. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * Deterministic serialization of a final-evidence record: the SAME logical
 * record always produces identical bytes, regardless of key-construction
 * order (recursively sorted keys). Separately executed runs remain distinct
 * through their own run ids and measured values, never byte noise.
 */
export function serializeFinalEvidence(record) {
  return `${JSON.stringify(canonicalize(record), null, 2)}\n`;
}

/**
 * Fail-closed verification of a final-evidence record — the same invariants
 * the builder enforces, re-checked from the record alone so the standalone
 * `verify` verb can re-check any published artifact from disk (T-03-02).
 *
 * @param {object} record the record to verify
 * @returns {{ok: boolean, errors: string[]}}
 */
export function verifyFinalEvidence(record) {
  const errors = [];
  const bad = (field, why) => errors.push(`${field}: ${why}`);

  if (!isPlainObject(record)) {
    return { ok: false, errors: ['record must be a JSON object'] };
  }

  // --- identity ---------------------------------------------------------------
  if (record.schema_version !== FINAL_EVIDENCE_SCHEMA_VERSION) {
    bad('schema_version', `must be exactly ${FINAL_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (record.kind !== FINAL_EVIDENCE_KIND) {
    bad('kind', `must be exactly "${FINAL_EVIDENCE_KIND}"`);
  }

  // --- run block ---------------------------------------------------------------
  const run = isPlainObject(record.run) ? record.run : {};
  if (typeof run.id !== 'string' || !RUN_ID.test(run.id)) {
    bad('run.id', 'must be final-<UTC timestamp>Z (e.g. final-20261004T041500Z)');
  }
  if (run.execution_mode !== 'real-n8n') {
    bad('run.execution_mode', 'must be exactly "real-n8n" — simulated or unspecified execution is not evidence');
  }
  if (run.status !== 'completed') {
    bad('run.status', 'must be exactly "completed" — partial/interrupted/simulated runs are not evidence');
  }

  // --- run.rerun (03-02): the verified rerun-comparison section ------------------
  // A present rerun section is a positive identity claim — PACK-02 requires it
  // to carry the prior run id, the identity flag, the clean-sandbox checks it
  // was gated on, and the phase base (T-03-06: repudiation).
  if (run.rerun !== undefined) {
    const rerun = isPlainObject(run.rerun) ? run.rerun : null;
    if (!rerun) {
      bad('run.rerun', 'must be an object when present');
    } else {
      if (typeof rerun.compared_with !== 'string' || !RUN_ID.test(rerun.compared_with)) {
        bad('run.rerun.compared_with', 'must be the prior run id final-<UTC timestamp>Z the rerun was compared against');
      }
      // IN-02: a rerun cannot be compared with itself — a self-referential
      // identity claim is meaningless as rerun evidence.
      if (typeof rerun.compared_with === 'string' && rerun.compared_with === run.id) {
        bad('run.rerun.compared_with', 'must differ from run.id — a rerun cannot be compared with itself');
      }
      if (rerun.per_case_identical !== true) {
        bad('run.rerun.per_case_identical', 'must be exactly true — a present rerun section asserts per-case identity');
      }
      if (
        !Array.isArray(rerun.clean_sandbox_checks) ||
        rerun.clean_sandbox_checks.length === 0 ||
        rerun.clean_sandbox_checks.some((entry) => typeof entry !== 'string' || entry.trim() === '')
      ) {
        bad('run.rerun.clean_sandbox_checks', 'must be a non-empty array of non-empty clean-sandbox check names');
      }
      if (
        typeof rerun.phase_base !== 'string' ||
        !isFrozenPhaseBase(rerun.phase_base)
      ) {
        bad(
          'run.rerun.phase_base',
          `must be the frozen public-safe baseline commit ${FROZEN_PHASE_BASE_SHA} (full 40-hex) — a short form, branch name, HEAD, or any other ref is not the release boundary`
        );
      }
    }
  }

  // --- versions (exact values only) ---------------------------------------------
  const versions = isPlainObject(record.versions) ? record.versions : {};
  for (const field of ['docker_client', 'docker_compose']) {
    if (isVagueVersion(versions[field])) {
      bad(`versions.${field}`, 'must be the exact captured version string — vague, placeholder, or empty values are rejected');
    }
  }
  if (typeof versions.n8n_runtime !== 'string' || !EXACT_TRIPLE.test(versions.n8n_runtime) || isVagueVersion(versions.n8n_runtime)) {
    bad('versions.n8n_runtime', 'must be the exact full n8n runtime version (major.minor.patch) — the pin');
  }
  if (typeof versions.image_reference !== 'string' || !DIGEST_IMAGE.test(versions.image_reference)) {
    bad('versions.image_reference', 'must be the digest-pinned image reference n8nio/n8n@sha256:<64-hex> — mutable tags are rejected');
  }

  // --- commands (PACK-01: the exact executed command strings) ---------------------
  const commands = Array.isArray(record.commands) ? record.commands : null;
  if (!commands || commands.length < REQUIRED_COMMANDS.length) {
    bad('commands', `must be an array of at least ${REQUIRED_COMMANDS.length} exact executed command strings`);
  } else {
    if (commands.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      bad('commands', 'every entry must be a non-empty command string');
    }
    for (const required of REQUIRED_COMMANDS) {
      if (!commands.includes(required)) {
        bad('commands', `must include the exact command "${required}"`);
      }
    }
  }

  // --- provenance (driver-captured head + parsed evidence sha256 values) ----------
  const provenance = isPlainObject(record.provenance) ? record.provenance : {};
  if (typeof provenance.head !== 'string' || !HEX40.test(provenance.head)) {
    bad('provenance.head', 'must be the full 40-hex git commit captured by the driver');
  }
  const evidenceHashes = isPlainObject(provenance.evidence_sha256) ? provenance.evidence_sha256 : null;
  if (!evidenceHashes || Object.keys(evidenceHashes).length < 4) {
    bad('provenance.evidence_sha256', 'must carry at least four sha256 values parsed from the launcher evidence line');
  } else {
    for (const [key, value] of Object.entries(evidenceHashes)) {
      if (typeof value !== 'string' || !HEX64.test(value)) {
        bad(`provenance.evidence_sha256.${key}`, 'must be a 64-hex SHA-256');
      }
    }
    for (const key of ['historical_source', 'intake_workflow', 'reviewer_workflow', 'delivery_workflow']) {
      if (!(key in evidenceHashes)) {
        bad(`provenance.evidence_sha256.${key}`, 'must be present (parsed from the launcher evidence line)');
      }
    }
  }

  // --- static contracts / full suite / preservation ------------------------------
  if (record.static_contracts !== true) {
    bad('static_contracts', 'must be true — the STATIC CONTRACTS PASS line must be part of the capture');
  }
  const fullSuite = isPlainObject(record.full_suite) ? record.full_suite : {};
  if (!isCount(fullSuite.passed) || !isCount(fullSuite.total) || fullSuite.passed !== fullSuite.total) {
    bad('full_suite', 'must report passed === total — a partial suite is not evidence');
  }
  const preservation = isPlainObject(record.preservation) ? record.preservation : {};
  if (!isCount(preservation.preserved) || !isCount(preservation.total) || preservation.preserved !== preservation.total) {
    bad('preservation', 'must report preserved === total — unrelated-container preservation is not proven');
  }

  // --- cases: five distinct entries, launcher order, fixed counted states --------
  const cases = Array.isArray(record.cases) ? record.cases : [];
  if (cases.length !== EXPECTED_CASE_STATES.length) {
    bad('cases', `must hold exactly ${EXPECTED_CASE_STATES.length} distinct case entries in the launcher 1..5 order (got ${cases.length})`);
  }
  const seenNames = new Set();
  cases.forEach((entry, i) => {
    const label = `cases[${i}]`;
    if (!isPlainObject(entry)) {
      bad(label, 'each case must be an object');
      return;
    }
    if (entry.index !== i + 1) {
      bad(`${label}.index`, `must be ${i + 1} in the launcher fixed order`);
    }
    if (typeof entry.name !== 'string' || entry.name !== EXPECTED_CASE_STATES[i]?.name) {
      bad(`${label}.name`, `must be "${EXPECTED_CASE_STATES[i]?.name}" in the launcher fixed order`);
    } else if (seenNames.has(entry.name)) {
      bad(`${label}.name`, 'duplicate case names are not distinct entries');
    }
    seenNames.add(entry.name);
    if (typeof entry.summary !== 'string' || entry.summary.trim() === '') {
      bad(`${label}.summary`, 'must carry the launcher case summary text');
    }
    if (entry.result !== 'pass') {
      bad(`${label}.result`, 'must be "pass"');
    }
    const observed = isPlainObject(entry.observed) ? entry.observed : {};
    for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
      if (!isCount(observed[field])) {
        bad(`${label}.observed.${field}`, 'must be a non-negative integer count');
      }
    }
    // The launcher-asserted closing state for this case group: a divergence
    // means the record does not describe a passing full-suite run.
    const expected = isPlainObject(entry.expected) ? entry.expected : null;
    if (!expected) {
      bad(`${label}.expected`, 'must carry the launcher-asserted expected counted state');
    } else {
      for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
        if (!isCount(expected[field])) {
          bad(`${label}.expected.${field}`, 'must be a non-negative integer count');
        }
      }
      for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
        if (isCount(observed[field]) && observed[field] !== expected[field]) {
          bad(`${label}.observed.${field}`, `must equal the expected counted state ${expected[field]} (got ${observed[field]}) — a divergence means the case group did not pass`);
        }
      }
    }
    if (typeof entry.failure_condition !== 'string' || entry.failure_condition.trim().length < 20) {
      bad(`${label}.failure_condition`, 'must carry prose naming what divergence would have failed the case');
    }
    const launcherState = EXPECTED_CASE_STATES[i];
    if (launcherState && isPlainObject(expected)) {
      for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
        if (expected[field] !== launcherState[field]) {
          bad(
            `${label}.expected.${field}`,
            `must equal the launcher-asserted closing state ${launcherState[field]} for case ${launcherState.name} (got ${expected[field]})`
          );
        }
      }
    }
  });
  if (fullSuite.total !== cases.length && isCount(fullSuite.total)) {
    bad('full_suite.total', `must equal the case count (${cases.length})`);
  }

  if (!Array.isArray(record.notes)) {
    bad('notes', 'must be an array');
  }

  // --- limitations (PACK-01: the structured claim-boundary disclosure) -----------
  const limitations = Array.isArray(record.limitations) ? record.limitations : null;
  if (!limitations || limitations.length < FIXED_LIMITATIONS.length) {
    bad('limitations', `must be a non-empty array with at least ${FIXED_LIMITATIONS.length} entries covering the required disclosure themes`);
  } else {
    if (limitations.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      bad('limitations', 'every entry must be a non-empty disclosure string');
    }
    for (const matchers of REQUIRED_LIMITATION_MATCHERS) {
      const why = matchers[matchers.length - 1];
      const regexes = matchers.slice(0, -1);
      const covered = limitations.some((entry) => regexes.every((matcher) => matcher.test(entry)));
      if (!covered) {
        bad('limitations', `must include an entry covering: ${why}`);
      }
    }
  }

  // --- disclosure scan (T-03-01) — inside verify, over the serialized record ------
  let serialized = null;
  try {
    serialized = serializeFinalEvidence(record);
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
 * Run-vs-run matrix equality (PACK-02): both records must be completed, carry
 * the five cases in the launcher's fixed order, satisfy observed==expected
 * inside each record (the accepted matrix, enforced here with no second
 * hardcoded copy — the counted states come from EXPECTED_CASE_STATES), and
 * agree on every queue/approval_actions/crm_attempts/crm_effects value.
 * Fails closed naming the divergent case and field; never presents a
 * divergent rerun as identical (T-03-06).
 *
 * @param {object} a one published record
 * @param {object} b the other published record
 * @returns {{ok: true, per_case_identical: true, run_a: string, run_b: string}}
 */
export function compareFinalEvidenceRecords(a, b) {
  const label = (record) =>
    isPlainObject(record) && isPlainObject(record.run) && typeof record.run.id === 'string' ? record.run.id : 'unnamed record';
  for (const record of [a, b]) {
    if (!isPlainObject(record) || !isPlainObject(record.run) || record.run.status !== 'completed') {
      throw new Error(
        `${label(record)} must carry run.status "completed" — a partial, interrupted, or simulated record is not comparable evidence`
      );
    }
  }
  const expectedOrder = EXPECTED_CASE_STATES.map((state) => state.name).join(', ');
  for (const record of [a, b]) {
    if (!Array.isArray(record.cases) || record.cases.length !== EXPECTED_CASE_STATES.length) {
      throw new Error(
        `${label(record)} must carry exactly ${EXPECTED_CASE_STATES.length} cases in the launcher fixed order ${expectedOrder} (got ${Array.isArray(record.cases) ? record.cases.length : 0})`
      );
    }
    record.cases.forEach((entry, i) => {
      if (!isPlainObject(entry) || entry.name !== EXPECTED_CASE_STATES[i].name) {
        throw new Error(`${label(record)} case ${i + 1} must be "${EXPECTED_CASE_STATES[i].name}" in the launcher fixed order`);
      }
      // WR-01: full counter shape is mandatory — a missing observed/expected
      // block or a missing counter is a named rejection, never undefined ===
      // undefined.
      const observed = isPlainObject(entry.observed) ? entry.observed : null;
      if (!observed) {
        throw new Error(
          `${label(record)} case ${entry.name}: observed must carry the counted state (queue, approval_actions, crm_attempts, crm_effects)`
        );
      }
      for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
        if (!isCount(observed[field])) {
          throw new Error(
            `${label(record)} case ${entry.name}: observed.${field} must be a non-negative integer count (got ${JSON.stringify(observed[field])})`
          );
        }
      }
      const expected = isPlainObject(entry.expected) ? entry.expected : null;
      if (!expected) {
        throw new Error(
          `${label(record)} case ${entry.name}: expected must carry the launcher-asserted counted state`
        );
      }
      // WR-01: expected must equal the launcher-asserted matrix — two records
      // agreeing on the same WRONG counts are not identical accepted runs.
      const launcherState = EXPECTED_CASE_STATES[i];
      for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
        if (expected[field] !== launcherState[field]) {
          throw new Error(
            `${label(record)} case ${entry.name}: expected.${field} must equal the launcher-asserted matrix value ${launcherState[field]} for case ${launcherState.name} (got ${JSON.stringify(expected[field])})`
          );
        }
      }
      for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
        if (observed[field] !== expected[field]) {
          throw new Error(
            `${label(record)} case ${entry.name}: observed.${field}=${JSON.stringify(observed[field])} does not equal expected.${field}=${JSON.stringify(expected[field])} — the record does not describe a passing run against the accepted matrix`
          );
        }
      }
    });
  }
  a.cases.forEach((entry, i) => {
    const other = b.cases[i];
    for (const field of ['queue', 'approval_actions', 'crm_attempts', 'crm_effects']) {
      if (entry.observed[field] !== other.observed[field]) {
        throw new Error(
          `case ${entry.name}: ${field} diverges between runs (${label(a)}=${JSON.stringify(entry.observed[field])}, ${label(b)}=${JSON.stringify(other.observed[field])}) — the rerun is NOT identical to the accepted run`
        );
      }
    }
  });
  return { ok: true, per_case_identical: true, run_a: a.run.id, run_b: b.run.id };
}

/**
 * Verify then atomically publish a final-evidence record: write the
 * canonical serialization to a temporary sibling of the destination and
 * rename only after verification succeeds. A rejected record throws and
 * writes nothing (fail-closed publication).
 *
 * @param {object} record the record to publish
 * @param {string} destination path the accepted record is renamed to
 * @returns {{ok: true, destination: string, sha256: string, bytes: number}}
 */
export function publishFinalEvidence(record, destination) {
  const verdict = verifyFinalEvidence(record);
  if (!verdict.ok) {
    throw new Error(`final evidence rejected — not published: ${verdict.errors.join('; ')}`);
  }
  const payload = Buffer.from(serializeFinalEvidence(record), 'utf8');
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

// --- provenance git binding (CR-01) -------------------------------------------
//
// The repo-relative path each provenance.evidence_sha256 key names: the exact
// files whose bytes the launcher hashed during the run. The bound verify path
// re-reads these files FROM GIT at the recorded head (`git show <head>:<path>`)
// and requires the sha256 of those committed bytes to equal the recorded
// value — a forged head or a fabricated hash cannot pass.

export const EVIDENCE_PATH_MAP = Object.freeze({
  historical_source: 'workflows/client-intake-pipeline.json',
  intake_workflow: 'runtime/demo/workflows/intake-stage.json',
  reviewer_workflow: 'runtime/demo/workflows/reviewer-decision.json',
  delivery_workflow: 'runtime/demo/workflows/approved-delivery.json',
});

function gitBytes(root, args) {
  return execFileSync('git', args, { cwd: root, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Bind a record's provenance to the ACTUAL git bytes of a repository (CR-01):
 * the recorded head must be an existing commit in <root>, and for every
 * EVIDENCE_PATH_MAP entry the sha256 of `git show <head>:<path>` must equal
 * the recorded evidence_sha256 value. Shape validity alone is NOT provenance —
 * a forged head or fabricated hash fails here. Never throws for expected
 * conditions; every failure is a named error in the returned verdict.
 *
 * @param {object} record a final-evidence record (shape need not be valid)
 * @param {string} root absolute path of the git repository to bind against
 * @returns {{ok: boolean, errors: string[]}}
 */
export function bindProvenanceToGit(record, root) {
  if (!isPlainObject(record)) {
    return { ok: false, errors: ['record must be a JSON object before git binding'] };
  }
  if (typeof root !== 'string' || root.trim() === '') {
    return { ok: false, errors: ['git binding requires the repository root directory'] };
  }
  const provenance = isPlainObject(record.provenance) ? record.provenance : null;
  if (!provenance || typeof provenance.head !== 'string' || !HEX40.test(provenance.head)) {
    return { ok: false, errors: ['provenance.head must be a full 40-hex commit before git binding'] };
  }
  const head = provenance.head;
  const errors = [];
  const bad = (field, why) => errors.push(`${field}: ${why}`);
  try {
    gitBytes(root, ['cat-file', '-e', `${head}^{commit}`]);
  } catch {
    return {
      ok: false,
      errors: [`provenance.head ${head} is not a commit in this repository — the record cannot be attributed to these git bytes`],
    };
  }
  const hashes = isPlainObject(provenance.evidence_sha256) ? provenance.evidence_sha256 : null;
  for (const [key, relative] of Object.entries(EVIDENCE_PATH_MAP)) {
    const recorded = hashes ? hashes[key] : undefined;
    if (typeof recorded !== 'string' || !HEX64.test(recorded)) {
      bad(`provenance.evidence_sha256.${key}`, 'must be a 64-hex SHA-256 before git binding');
      continue;
    }
    let bytes;
    try {
      bytes = gitBytes(root, ['show', `${head}:${relative}`]);
    } catch {
      bad(`provenance.evidence_sha256.${key}`, `${relative} is missing from git at ${head} — the hash cannot bind to these bytes`);
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== recorded) {
      bad(`provenance.evidence_sha256.${key}`, `does not match the actual git bytes of ${relative} at ${head} (git bytes hash to ${actual})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- CLI ---------------------------------------------------------------------
//
//   node runtime/scripts/final-evidence.mjs build --capture <file> --output <path> --image-reference <ref>
//       Parse a real run's captured console output, build the canonical
//       record, verify it, and atomically publish it. Any missing or
//       unproven value exits non-zero WITHOUT writing the artifact.
//
//   node runtime/scripts/final-evidence.mjs verify <file>
//       Re-check a published evidence artifact from disk alone; prints
//       {ok, errors}; exit 0/1.

// IN-01: pathToFileURL + realpath — a repo path containing spaces, %, or #
// must still be recognized as a direct run, and so must a path reached
// through a symlinked directory (import.meta.url is realpath-resolved, so a
// naive file://<argv[1]> comparison silently skipped every verb and exited 0).
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  const [verb, ...rest] = process.argv.slice(2);
  const USAGE =
    'usage: final-evidence.mjs build --capture <file> --output <path> --image-reference <ref> --docker-client <v> --docker-compose <v> --head-commit <sha> [--compare-with <prior> --clean-sandbox-checks <a,b> --phase-base <ref>] | verify <file> | compare <a> <b>';
  // IN-01: an unrecognized or missing verb is a usage error — print usage and
  // exit 2 so chained commands never mistake a silent no-op for success.
  if (verb !== 'verify' && verb !== 'compare' && verb !== 'build') {
    process.stderr.write(`final-evidence: ${USAGE}\n`);
    process.exit(2);
  }
  const out = (document) => process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  try {
    if (verb === 'verify') {
      const [file] = rest;
      if (typeof file !== 'string') throw new Error('usage: final-evidence.mjs verify <file>');
      let record;
      try {
        record = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        out({ ok: false, errors: [`unreadable evidence file ${file}: ${error.message}`] });
        process.exit(1);
      }
      const verdict = verifyFinalEvidence(record);
      if (!verdict.ok) {
        out(verdict);
        process.exit(1);
      }
      // CR-01: the CLI verify path NEVER skips provenance binding. A record
      // that is merely shape-valid must still be attributed to actual git
      // bytes: the recorded head must exist here and every evidence_sha256
      // must match `git show <head>:<path>`. Fail-closed outside a git
      // checkout of this history.
      let root;
      try {
        root = gitBytes(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
      } catch (error) {
        out({
          ok: false,
          errors: [
            `could not resolve a git repository root from ${process.cwd()} — provenance binding is mandatory on the verify path (${error.message})`,
          ],
        });
        process.exit(1);
      }
      const bound = bindProvenanceToGit(record, root);
      out({
        ok: bound.ok,
        errors: bound.errors,
        provenance_bound: {
          head: record.provenance.head,
          paths: { ...EVIDENCE_PATH_MAP },
          repo_root: root,
        },
      });
      process.exit(bound.ok ? 0 : 1);
    }
    if (verb === 'compare') {
      const [fileA, fileB] = rest;
      if (typeof fileA !== 'string' || typeof fileB !== 'string') {
        throw new Error('usage: final-evidence.mjs compare <record-a> <record-b>');
      }
      const read = (file) => {
        try {
          return JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
          throw new Error(`unreadable evidence file ${file}: ${error.message}`);
        }
      };
      // WR-01: the compare CLI is the comparison authority — it must verify
      // BOTH inputs before comparing. A pair of records that each fail
      // verification (same wrong counts, missing counters) must never print
      // a PASS line.
      for (const file of [fileA, fileB]) {
        const verdict = verifyFinalEvidence(read(file));
        if (!verdict.ok) {
          throw new Error(`${file} failed verification — the compare verb only compares accepted-shape evidence: ${verdict.errors.join('; ')}`);
        }
      }
      const verdict = compareFinalEvidenceRecords(read(fileA), read(fileB));
      process.stdout.write(`RERUN COMPARISON PASS: per-case counted states identical (${verdict.run_a} vs ${verdict.run_b})\n`);
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
      process.exit(0);
    }
    if (verb === 'build') {
      const flag = (name) => {
        const index = rest.indexOf(name);
        return index !== -1 ? rest[index + 1] : undefined;
      };
      const captureFile = flag('--capture');
      const destination = flag('--output');
      const imageReference = flag('--image-reference');
      const dockerClient = flag('--docker-client');
      const dockerCompose = flag('--docker-compose');
      const headCommit = flag('--head-commit');
      const compareWith = flag('--compare-with');
      const cleanSandboxChecksRaw = flag('--clean-sandbox-checks');
      const phaseBase = flag('--phase-base');
      const missing = [
        ['--capture', captureFile],
        ['--output', destination],
        ['--image-reference', imageReference],
        ['--docker-client', dockerClient],
        ['--docker-compose', dockerCompose],
        ['--head-commit', headCommit],
      ]
        .filter(([, value]) => typeof value !== 'string')
        .map(([name]) => name);
      if (missing.length > 0) {
        throw new Error(
          `usage: final-evidence.mjs build --capture <file> --output <path> --image-reference <n8nio/n8n@sha256:...> --docker-client <v> --docker-compose <v> --head-commit <40-hex> (missing: ${missing.join(', ')})`
        );
      }
      // Rerun-section flags are all-or-nothing: a rerun record must name its
      // prior record, its clean-sandbox checks, and its phase base.
      const rerunFlags = [compareWith, cleanSandboxChecksRaw, phaseBase];
      const presentRerunFlags = rerunFlags.filter((value) => typeof value === 'string');
      if (presentRerunFlags.length > 0 && presentRerunFlags.length !== rerunFlags.length) {
        throw new Error(
          'usage: --compare-with <prior-record-path> requires BOTH --clean-sandbox-checks <a,b,...> and --phase-base <ref> (all three or none)'
        );
      }
      let priorRecord = null;
      if (typeof compareWith === 'string') {
        try {
          priorRecord = JSON.parse(readFileSync(compareWith, 'utf8'));
        } catch (error) {
          throw new Error(`unreadable prior record ${compareWith}: ${error.message}`);
        }
        const priorVerdict = verifyFinalEvidence(priorRecord);
        if (!priorVerdict.ok) {
          throw new Error(`prior record ${compareWith} failed verification — a rerun may only compare against accepted evidence: ${priorVerdict.errors.join('; ')}`);
        }
      }
      let captureText;
      try {
        captureText = readFileSync(captureFile, 'utf8');
      } catch (error) {
        throw new Error(`unreadable capture file ${captureFile}: ${error.message}`);
      }
      const parsed = parseLauncherCapture(captureText);
      const record = buildFinalEvidenceRecord({
        parsed,
        image_reference: imageReference,
        docker_client: dockerClient,
        docker_compose: dockerCompose,
        head_commit: headCommit,
      });
      // Compare BEFORE any publication: a divergent rerun writes nothing and
      // never receives a success marker; only equality adds run.rerun.
      if (priorRecord !== null) {
        compareFinalEvidenceRecords(priorRecord, record);
        const cleanSandboxChecks =
          typeof cleanSandboxChecksRaw === 'string'
            ? cleanSandboxChecksRaw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
            : [];
        if (cleanSandboxChecks.length === 0) {
          throw new Error('--clean-sandbox-checks must name at least one non-empty check');
        }
        record.run.rerun = {
          compared_with: priorRecord.run.id,
          per_case_identical: true,
          clean_sandbox_checks: cleanSandboxChecks,
          phase_base: phaseBase,
        };
      }
      const published = publishFinalEvidence(record, destination);
      out({
        ok: true,
        destination: published.destination,
        run_id: record.run.id,
        cases: record.cases.length,
        full_suite_total: record.full_suite.total,
        sha256: published.sha256,
        bytes: published.bytes,
      });
      process.exit(0);
    }
    // Unreachable: the verb is validated before the try block (exit 2).
    throw new Error(USAGE);
  } catch (error) {
    process.stderr.write(`final-evidence: ${error.message}\n`);
    // Usage errors exit 2 (IN-01); every other failure stays exit 1.
    process.exit(/^usage:/.test(error.message) ? 2 : 1);
  }
}
