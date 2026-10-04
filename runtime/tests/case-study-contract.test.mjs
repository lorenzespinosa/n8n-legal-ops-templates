// Docs contract test for the CASE-01 deliverables (plan 03-03, Task 2).
//
// The buyer-facing case study (docs/case-study.md) and the sanitized public
// evidence excerpt (docs/evidence-summary.md) are prose artifacts whose
// credibility IS the product: their claim boundary must not silently erode.
// This module mechanically locks that boundary. It fails when:
//
//   - a required case-study section is missing or out of order (the seven
//     problem/proof/reproduction/evidence/architecture/capture-decision/
//     boundaries sections), or the excerpt loses its derivation header;
//   - a prohibited AFFIRMATIVE claim appears (production use, real client or
//     firm data/outcomes, live business outcomes, money/conversion gains,
//     legal expertise, blanket no-disk/PII-free guarantees, exactly-once
//     guarantees, response-loss handling, process-restart recovery,
//     human-approval claims, clean-sandbox certification). A claim line is
//     accepted ONLY when its exact trimmed text is one of the sanctioned
//     boundary sentences (IN-06) — the repo's established truthful-negation
//     lines, sanctioned verbatim; any edit re-triggers review;
//   - the simulated-reviewer labeling is missing where approval is described,
//     or an affirmative human-approval claim appears;
//   - any DISCLOSURE_PATTERNS hit (imported from the evidence verifier)
//     appears in either document;
//   - any fixture contact-field literal (email/phone/contact-name from
//     payloads/intake-new-lead.json; the fictional firm name is exempt)
//     appears;
//   - a cited `./runtime/...` or `node runtime/...` command token names a
//     path that does not exist (or a `.sh` that is not executable);
//   - the architecture section stops naming the three gated graphs or stops
//     stating the historical gate was decorative;
//   - an evidence number drifts from the committed record;
//   - runtime/README.md still describes the delivered Phase 3 artifacts as
//     future work;
//   - the reproduction prose misstates the recorded rerun's promotion
//     ordering or drops the verification-only description of today's
//     ordinary rerun (FD-03-B);
//   - the reproduction prose broadens PASS truth to "a failed or
//     interrupted run prints no PASS" — false for a failed outer rerun
//     whose transcript may already carry earlier substep PASS markers
//     (FULL-SUITE PASS, FINAL-EVIDENCE PASS to the staged candidate);
//     only the outer CLEAN-RERUN PASS verdict is withheld.
//
// Every guard is a pure function over text, and the deliberate-violation
// fixtures at the bottom prove each guarded category CAN fail (the synthetic
// literals are built by concatenation so this test file itself stays clean
// under the phase disclosure diff-scan).

import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { DISCLOSURE_PATTERNS } from '../scripts/final-evidence.mjs';
import { fixtureContactLiterals } from '../scripts/evidence-manifest.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CASE_STUDY = path.join(ROOT, 'docs', 'case-study.md');
const EVIDENCE_SUMMARY = path.join(ROOT, 'docs', 'evidence-summary.md');
const RUNTIME_README = path.join(ROOT, 'runtime', 'README.md');
const INTAKE_FIXTURE = path.join(ROOT, 'payloads', 'intake-new-lead.json');
const EVIDENCE_LOG = path.join(ROOT, 'runtime', 'evidence', 'final-evidence-log.json');

// --- Guard 1: required case-study sections, present and in order -----------

export const REQUIRED_SECTIONS = Object.freeze([
  ['problem', /^## .*problem/i],
  ['proof', /^## .*proves/i],
  ['reproduction', /^## .*reproduce/i],
  ['evidence', /^## .*evidence/i],
  ['architecture', /^## .*architecture/i],
  ['capture-decision', /^## .*screenshot/i],
  ['boundaries', /^## .*boundar/i],
]);

export function requiredSections(doc) {
  const lines = doc.split(/\r?\n/);
  const indices = REQUIRED_SECTIONS.map(([name, pattern]) => {
    const index = lines.findIndex((line) => pattern.test(line));
    return [name, index];
  });
  const missing = indices.filter(([, index]) => index === -1).map(([name]) => name);
  let orderOk = true;
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i][1] !== -1 && indices[i - 1][1] !== -1 && indices[i][1] <= indices[i - 1][1]) {
      orderOk = false;
    }
  }
  return { ok: missing.length === 0 && orderOk, missing, orderOk, indices };
}

// --- Guard 2: prohibited affirmative claims vs exact sanctioned sentences ---

export const PROHIBITED_CLAIM_PATTERNS = Object.freeze([
  [/\bdeployed (?:in|to) production\b|\bproduction deployment\b|\bin production use\b|\blive deployment\b/i, 'production/live deployment claim'],
  [/\breal (?:client|firm)\b[^\n]*\b(?:data|outcomes?)\b/i, 'real client/firm data or outcome claim'],
  [/\blive business outcome\b/i, 'live business outcome claim'],
  [/\b(?:savings|revenue|ROI|conversion)\b/i, 'monetary/measurable-gain claim'],
  [/\blegal expertise\b/i, 'legal expertise claim'],
  [/\bPII-free\b|\bdisk-free\b|\bno-disk\b|never touches disk/i, 'blank privacy/no-disk claim'],
  [/\bexactly-once\b/i, 'exactly-once guarantee claim'],
  [/\bresponse[- ]loss\b/i, 'response-loss handling claim'],
  [/\bprocess[- ]restart\b/i, 'process-restart recovery claim'],
  [/\ba human reviewer approved\b|\bapproved by (?:a )?human\b|\bhuman(?:-| )reviewed\b|\ba person approved\b/i, 'human-approval claim'],
  [/\bcertified clean sandbox\b|\bclean-sandbox certifi/i, 'clean-sandbox certification claim'],
]);

// IN-06: a line carrying a prohibited-claim hit passes ONLY when its exact
// trimmed text is one of the sanctioned boundary sentences below — collected
// verbatim from the shipped documents. A generic negation word anywhere on
// the line no longer waives every pattern on that line (the old heuristic let
// "Not a live business outcome — conversion improved 300%" clear the
// monetary-claim guard). Any edit to a boundary sentence breaks the exact
// match and re-triggers review — by design.
export const SANCTIONED_BOUNDARY_SENTENCES = Object.freeze([
  // docs/case-study.md (verbatim lines)
  'not a live business outcome**; no production deployment is claimed, and no real',
  '- No production deployment, real client or firm data, or real outcomes are',
  '- No monetary or measurable gains are claimed or implied — no savings, no',
  'revenue effect, no conversion claims, and no legal expertise is offered.',
  '- Response-loss-after-commit handling, process-restart recovery, and universal exactly-once delivery are **NOT implemented and NOT claimed**; the',
  '- No blanket no-disk claim is made: n8n runtime state is tmpfs-backed, while',
  'is live — it is not claimed to be PII-free; it is destroyed at verified',
  // docs/evidence-summary.md (verbatim lines)
  '- Response-loss-after-commit handling, process-restart recovery, and universal exactly-once delivery are **NOT implemented and NOT claimed**.',
  'disk-backed until normal teardown — no blanket no-disk claim is made; the',
  'demo-state volume holds raw fictional intake payloads while live and is not claimed to be PII-free,',
  'Everything in this excerpt is **local mock evidence with fictional data — not a live business outcome**; no production deployment, real client or firm data,',
  'no savings, conversion, revenue, or legal-expertise claims are made or implied.',
  // the deliberate-violation fixture pass-case (exact sentence)
  'These local mock metrics are not a live business outcome, and no savings are claimed.',
]);

export function prohibitedClaims(doc) {
  const violations = [];
  doc.split(/\r?\n/).forEach((line, i) => {
    for (const [pattern, message] of PROHIBITED_CLAIM_PATTERNS) {
      if (pattern.test(line) && !SANCTIONED_BOUNDARY_SENTENCES.includes(line.trim())) {
        violations.push(`line ${i + 1}: ${message}: ${line.trim()}`);
      }
    }
  });
  return { ok: violations.length === 0, violations };
}

// --- Guard 3: simulated-reviewer labeling, no human-approval claim ----------

const HUMAN_CLAIM_PATTERNS = Object.freeze([
  /\ba human reviewer approved\b/i,
  /\bapproved by (?:a )?human\b/i,
  /\bhuman(?:-| )reviewed\b/i,
  /\ba person approved\b/i,
  /\bhuman exercised the manual\b/i,
]);

export function simulatedReviewerLabeling(caseStudy, excerpt) {
  const issues = [];
  for (const [label, doc] of [['docs/case-study.md', caseStudy], ['docs/evidence-summary.md', excerpt]]) {
    if (!/simulated reviewer input/i.test(doc)) {
      issues.push(`${label} must label automated approvals as simulated reviewer input`);
    }
    for (const pattern of HUMAN_CLAIM_PATTERNS) {
      const match = doc.match(pattern);
      if (match) {
        issues.push(`${label} carries an affirmative human-approval claim (${match[0]})`);
      }
    }
  }
  // Where approval is described in the case study's proof/evidence sections,
  // the simulated labeling must be present in the same section.
  const sections = extractSections(caseStudy);
  for (const sectionName of ['proof', 'evidence']) {
    const section = sections.find(([name]) => name === sectionName);
    if (section && !/simulated/i.test(section[1])) {
      issues.push(`the case-study ${sectionName} section describes approvals without the simulated labeling`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function extractSections(doc) {
  const headings = [...REQUIRED_SECTIONS, ...[['limitations', /^## .*limitations/i]]];
  const marks = [];
  const lines = doc.split(/\r?\n/);
  for (const [name, pattern] of headings) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index !== -1) marks.push([name, index]);
  }
  marks.sort((a, b) => a[1] - b[1]);
  return marks.map(([name, start], i) => {
    const end = i + 1 < marks.length ? marks[i + 1][1] : lines.length;
    return [name, lines.slice(start, end).join('\n')];
  });
}

// --- Guard 4: DISCLOSURE_PATTERNS scan (the evidence verifier's own set) ----

export function disclosureScan(doc) {
  const hits = [];
  doc.split(/\r?\n/).forEach((line, i) => {
    for (const [pattern, message] of DISCLOSURE_PATTERNS) {
      if (pattern.test(line)) hits.push(`line ${i + 1}: ${message}`);
    }
  });
  return { ok: hits.length === 0, hits };
}

// --- Guard 5: fixture contact-field literals (firm name exempt) -------------

export function fixtureLiteralScan(doc, literals) {
  const hits = [];
  doc.split(/\r?\n/).forEach((line, i) => {
    for (const literal of literals) {
      if (literal !== '' && line.includes(literal)) hits.push(`line ${i + 1}: raw fixture contact-field literal present`);
    }
  });
  return { ok: hits.length === 0, hits };
}

// --- Guard 6: every cited runtime command target exists (and .sh is +x) -----

export const COMMAND_TOKEN_PATTERN = /(\.\/runtime\/[A-Za-z0-9/._-]+|node runtime\/[A-Za-z0-9/._-]+)/g;

export function citedCommandTargets(doc, root) {
  const tokens = [...new Set([...doc.matchAll(COMMAND_TOKEN_PATTERN)].map((m) => m[0]))];
  const bad = [];
  for (const token of tokens) {
    const relative = token.replace(/^\.\//, '').replace(/^node /, '');
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) {
      bad.push(`${token} -> ${relative} does not exist`);
      continue;
    }
    if (relative.endsWith('.sh')) {
      try {
        accessSync(absolute, constants.X_OK);
      } catch {
        bad.push(`${token} -> ${relative} is not executable`);
      }
    }
  }
  return { ok: bad.length === 0, bad, tokens };
}

// --- Guard 7: architecture section content ----------------------------------

export function architectureContent(doc) {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## .*architecture/i.test(line));
  if (start === -1) return { ok: false, issues: ['no architecture section'] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join('\n');
  const issues = [];
  for (const graph of ['intake-stage', 'reviewer-decision', 'approved-delivery']) {
    if (!section.includes(graph)) issues.push(`architecture section does not name the ${graph} graph`);
  }
  if (!/decorative/.test(section)) issues.push('architecture section does not state the historical gate was decorative');
  return { ok: issues.length === 0, issues };
}

// --- Guard 8: excerpt derivation header --------------------------------------

const RUN_ID = /final-\d{8}T\d{6}Z/;
const COMMIT_40HEX = /\b[0-9a-f]{40}\b/;

export function excerptDerivation(excerpt) {
  const issues = [];
  if (!/[Dd]erived[^\n]*final-evidence-log\.json/.test(excerpt)) {
    issues.push('excerpt must state it is derived from runtime/evidence/final-evidence-log.json');
  }
  if (!RUN_ID.test(excerpt)) issues.push('excerpt must name the recorded run id');
  if (!COMMIT_40HEX.test(excerpt)) issues.push('excerpt must name the recorded source-run commit');
  if (!/not[^\n]*later packaging\/docs commit/.test(excerpt)) {
    issues.push('excerpt must state the source-run commit is not the later packaging/docs commit');
  }
  return { ok: issues.length === 0, issues };
}

// --- Guard 9: evidence numbers equal the committed record ---------------------

export function evidenceNumbers(caseStudy, excerpt, log) {
  const issues = [];
  for (const c of log.cases) {
    const counted = `queue=${c.observed.queue} approvals=${c.observed.approval_actions} CRM ATTEMPTS=${c.observed.crm_attempts} CRM EFFECTS=${c.observed.crm_effects}`;
    if (!caseStudy.includes(counted)) issues.push(`case-study missing counted state for case ${c.index} (${c.name}): ${counted}`);
    const row = `| ${c.index} | \`${c.name}\` | ${c.observed.queue} | ${c.observed.approval_actions} | ${c.observed.crm_attempts} | ${c.observed.crm_effects} | ${c.result} |`;
    if (!excerpt.includes(row)) issues.push(`excerpt missing case row: ${row}`);
  }
  const preservation = `${log.preservation.preserved}/${log.preservation.total}`;
  if (!caseStudy.includes(preservation) || !excerpt.includes(preservation)) issues.push(`preservation verdict ${preservation} missing`);
  const suite = `${log.full_suite.passed}/${log.full_suite.total}`;
  if (!caseStudy.includes(suite) || !excerpt.includes(suite)) issues.push(`full-suite verdict ${suite} missing`);
  for (const [label, doc] of [['case-study', caseStudy], ['excerpt', excerpt]]) {
    if (!doc.includes(log.run.id)) issues.push(`${label} missing run id ${log.run.id}`);
    if (!doc.includes(log.provenance.head)) issues.push(`${label} missing recorded source-run commit ${log.provenance.head}`);
    if (!doc.includes(log.versions.image_reference)) issues.push(`${label} missing the pinned image digest`);
    if (!doc.includes(log.versions.n8n_runtime)) issues.push(`${label} missing the pinned n8n version`);
  }
  return { ok: issues.length === 0, issues };
}

// --- Guard 10: README deferral repointed at the delivered artifacts -----------

const STALE_DEFERRAL = /are\s+\*\*Phase 3 work\*\*|Phase 3 work\*\*\s*—\s*nothing here claims them/;

export function readmeRepointed(readme) {
  const issues = [];
  if (STALE_DEFERRAL.test(readme)) {
    issues.push('runtime/README.md still describes the packaged evidence log / clean-rerun record / case study as future Phase 3 work');
  }
  if (!readme.includes('docs/case-study.md')) {
    issues.push('runtime/README.md must reference the delivered docs/case-study.md');
  }
  if (!readme.includes('runtime/evidence/final-evidence-log.json')) {
    issues.push('runtime/README.md must reference the delivered runtime/evidence/final-evidence-log.json');
  }
  return { ok: issues.length === 0, issues };
}

// --- Guard 11: truthful recorded-rerun history vs current procedure (FD-03-B) --
//
// The recorded rerun (final-20261004T072326Z) ran the pre-closure drivers:
// its canonical promotion happened after every comparison, manifest, scan,
// and regression gate but BEFORE the then-current fallible end-state tree
// check — the exact post-promotion window RR-03-A later closed. The
// reproduction prose must state that ordering truthfully, must never claim
// the recorded run promoted "only after every check passed", and must keep
// describing today's ordinary rerun as verification-only. History and
// current procedure are asserted separately so they cannot be blended.
export function rerunHistoryTruth(caseStudy) {
  const issues = [];
  const falseOrdering = /promoted(?:\s+atomically)?\s+only\s+after\s+every\s+check(?:\s+passed)?/i;
  if (falseOrdering.test(caseStudy)) {
    issues.push('claims a promotion happened "only after every check passed" — historically false for the recorded rerun (its promotion preceded the then-current end-state check)');
  }
  if (!/before\s+its\s+then-current\s+final\s+end-state\s+check/i.test(caseStudy)) {
    issues.push('must state the recorded rerun promoted before its then-current final end-state check');
  }
  if (!/verification-only/.test(caseStudy)) {
    issues.push('must keep describing today\u2019s ordinary rerun as verification-only');
  }
  return { ok: issues.length === 0, issues };
}

// --- Guard 12: failed-run PASS truth — substep markers vs outer verdict --------
//
// "A failed or interrupted run prints no PASS." was globally false: a failed
// outer run-clean-rerun.sh can still carry earlier substep PASS markers —
// the inner launcher's FULL-SUITE PASS line, or FINAL-EVIDENCE PASS printed
// to the staged candidate — because those print before later outer gates
// run. Only the outer CLEAN-RERUN PASS terminal line is correctly withheld
// until every outer gate has passed. The reproduction prose must draw
// exactly that distinction and must never re-broaden into a blanket no-PASS
// claim.
export function passMarkerTruth(caseStudy) {
  const issues = [];
  const broadNoPass = /\b(?:failed|interrupted)\b[^.\n]{0,80}\bprints? no PASS\b/i;
  if (broadNoPass.test(caseStudy)) {
    issues.push('broad "failed/interrupted run prints no PASS" claim — false for a failed outer rerun whose transcript may already carry earlier substep PASS markers');
  }
  if (!/may (?:still )?(?:include|carry|print)[^.\n]{0,80}PASS markers/i.test(caseStudy)) {
    issues.push('must state a failed or interrupted run may still include earlier substep PASS markers');
  }
  if (!/\bCLEAN-RERUN PASS\b[^.\n]{0,80}withheld|\bwithheld[^.\n]{0,80}\bCLEAN-RERUN PASS\b/i.test(caseStudy)) {
    issues.push('must state CLEAN-RERUN PASS is the final outer rerun verdict withheld until every outer gate has passed');
  }
  return { ok: issues.length === 0, issues };
}

// --- The documents under contract ---------------------------------------------

const caseStudy = readFileSync(CASE_STUDY, 'utf8');
const evidenceSummary = readFileSync(EVIDENCE_SUMMARY, 'utf8');
const runtimeReadme = readFileSync(RUNTIME_README, 'utf8');
const intakeFixture = JSON.parse(readFileSync(INTAKE_FIXTURE, 'utf8'));
const evidenceLog = JSON.parse(readFileSync(EVIDENCE_LOG, 'utf8'));

test('docs/case-study.md carries the seven required sections in the skeleton order', () => {
  const verdict = requiredSections(caseStudy);
  assert.deepEqual(verdict.missing, [], 'no required section may be missing');
  assert.ok(verdict.orderOk, 'the seven sections must appear in the problem→boundaries order');
  const h2count = (caseStudy.match(/^## /gm) || []).length;
  assert.ok(h2count >= 7, `expected at least seven H2 sections, found ${h2count}`);
});

test('docs/evidence-summary.md carries its derivation header (source, run id, source-run commit)', () => {
  const verdict = excerptDerivation(evidenceSummary);
  assert.deepEqual(verdict.issues, []);
});

test('the prohibited-claim boundary holds in both documents (negation-aware)', () => {
  for (const [label, doc] of [['docs/case-study.md', caseStudy], ['docs/evidence-summary.md', evidenceSummary]]) {
    const verdict = prohibitedClaims(doc);
    assert.deepEqual(verdict.violations, [], `${label}: ${verdict.violations.join('; ')}`);
  }
});

test('a negation word does not waive other claim patterns on the same line (IN-06)', () => {
  const attack = 'Not a live business outcome — conversion improved 300%';
  const verdict = prohibitedClaims(attack);
  assert.ok(!verdict.ok, 'a negation-scoped phrase must not waive a different claim (monetary gain) on the same line');
  assert.ok(
    verdict.violations.some((entry) => /monetary/i.test(entry)),
    'the monetary-claim guard must fire on the attack line'
  );

  // Every sanctioned sentence passes exactly, and a one-word edit of one
  // fails (exact-match sanctioning, not phrase matching).
  for (const sentence of SANCTIONED_BOUNDARY_SENTENCES) {
    assert.deepEqual(
      prohibitedClaims(sentence).violations,
      [],
      `the sanctioned boundary sentence must pass exactly: ${sentence.slice(0, 60)}…`
    );
  }
  const mutated = SANCTIONED_BOUNDARY_SENTENCES[1].replace('No production', 'Our production');
  assert.ok(!prohibitedClaims(mutated).ok, 'a one-word edit of a sanctioned sentence must fail');

  // Sync: every claim-carrying line in the shipped documents is sanctioned.
  for (const [label, doc] of [['docs/case-study.md', caseStudy], ['docs/evidence-summary.md', evidenceSummary]]) {
    doc.split(/\r?\n/).forEach((line, i) => {
      if (PROHIBITED_CLAIM_PATTERNS.some(([pattern]) => pattern.test(line))) {
        assert.ok(
          SANCTIONED_BOUNDARY_SENTENCES.includes(line.trim()),
          `${label} line ${i + 1} carries a claim hit without an exact sanction: ${line.trim()}`
        );
      }
    });
  }
});

test('automated approvals stay labeled simulated reviewer input; no affirmative human-approval claim', () => {
  const verdict = simulatedReviewerLabeling(caseStudy, evidenceSummary);
  assert.deepEqual(verdict.issues, []);
});

test('DISCLOSURE_PATTERNS hit nothing in either document', () => {
  for (const [label, doc] of [['docs/case-study.md', caseStudy], ['docs/evidence-summary.md', evidenceSummary]]) {
    const verdict = disclosureScan(doc);
    assert.deepEqual(verdict.hits, [], `${label}: ${verdict.hits.join('; ')}`);
  }
});

test('no fixture contact-field literal appears in either document (firm name exempt)', () => {
  const literals = fixtureContactLiterals(intakeFixture);
  assert.ok(literals.length >= 3, 'the intake fixture must supply contact literals to scan for');
  for (const [label, doc] of [['docs/case-study.md', caseStudy], ['docs/evidence-summary.md', evidenceSummary]]) {
    const verdict = fixtureLiteralScan(doc, literals);
    assert.deepEqual(verdict.hits, [], `${label}: ${verdict.hits.join('; ')}`);
  }
});

test('every cited runtime command token names an existing (executable for .sh) target', () => {
  const tokens = new Set();
  for (const doc of [caseStudy, evidenceSummary]) {
    const verdict = citedCommandTargets(doc, ROOT);
    assert.deepEqual(verdict.bad, [], `cited-command check failed: ${verdict.bad.join('; ')}`);
    for (const token of verdict.tokens) tokens.add(token);
  }
  assert.ok(tokens.size >= 3, `expected the docs to cite at least three runtime commands, found ${[...tokens].join(', ')}`);
});

test('the architecture section names the three gated graphs and states the historical gate was decorative', () => {
  const verdict = architectureContent(caseStudy);
  assert.deepEqual(verdict.issues, []);
});

test('every evidence number in both documents equals the committed record', () => {
  const verdict = evidenceNumbers(caseStudy, evidenceSummary, evidenceLog);
  assert.deepEqual(verdict.issues, [], verdict.issues.join('; '));
});

test('runtime/README.md deferral lines are repointed at the delivered Phase 3 artifacts', () => {
  const verdict = readmeRepointed(runtimeReadme);
  assert.deepEqual(verdict.issues, [], verdict.issues.join('; '));
});

test('the reproduction prose states the recorded rerun ordering truthfully and keeps today\u2019s rerun verification-only (FD-03-B)', () => {
  const verdict = rerunHistoryTruth(caseStudy);
  assert.deepEqual(verdict.issues, [], verdict.issues.join('; '));
});

test('failed-run PASS truth is scoped to the withheld outer CLEAN-RERUN PASS verdict, not a blanket no-PASS claim', () => {
  const verdict = passMarkerTruth(caseStudy);
  assert.deepEqual(verdict.issues, [], verdict.issues.join('; '));
});

// --- Deliberate-violation fixtures: every guarded category can fail -----------
//
// Synthetic literals are built by concatenation so this file stays clean under
// the phase disclosure diff-scan; fixture contact literals come from the
// committed fixture JSON at runtime, never spelled out here.

test('deliberate-violation fixtures prove every guard can fail', () => {
  // Guard 1 — sections: a doc with sections missing and out of order.
  const badSections = '## Boundaries\nstuff\n## The problem\nstuff\n';
  const sectionsVerdict = requiredSections(badSections);
  assert.ok(!sectionsVerdict.ok, 'a doc missing five sections and swapping order must fail');
  assert.ok(sectionsVerdict.missing.length >= 5, 'missing sections are named');

  // Guard 2 — prohibited claims: affirmative fails, truthful negation passes.
  const affirmativeClaim = 'Deployed in production, the firm measured financial savings.';
  const affirmativeVerdict = prohibitedClaims(affirmativeClaim);
  assert.ok(!affirmativeVerdict.ok, 'an unnegated production + savings claim must fail');
  assert.ok(affirmativeVerdict.violations.length >= 2, 'both claim families are named');
  const negatedClaim = 'These local mock metrics are not a live business outcome, and no savings are claimed.';
  assert.ok(prohibitedClaims(negatedClaim).ok, 'the truthful negated boundary sentence must pass');

  // Guard 3 — labeling: approvals described without simulated labeling fail.
  const unlabeled = '## What the gated demo proves\none approval commits the CRM write\n\n## Test evidence\nthe approval was recorded\n';
  const labelingVerdict = simulatedReviewerLabeling(
    unlabeled,
    'approvals: 1'
  );
  assert.ok(!labelingVerdict.ok, 'docs describing approvals without simulated-reviewer labeling must fail');
  const humanClaim = 'The matrix proves a human reviewer approved the intake.';
  assert.ok(!simulatedReviewerLabeling(humanClaim, humanClaim).ok, 'an affirmative human-approval claim must fail');

  // Guard 4 — disclosure: constructed URL / E.164 / bearer shapes are caught.
  const badUrl = ['http', 's://', 'fixture.invalid/proof'].join('');
  const badPhone = `+${'1'}${'5555550123'}`;
  const badBearer = `Bearer ${'x'.repeat(24)}`;
  const disclosureVerdict = disclosureScan(`see ${badUrl} or call ${badPhone} with ${badBearer}`);
  assert.ok(!disclosureVerdict.ok, 'URL / E.164 / bearer material must be caught');
  assert.ok(disclosureVerdict.hits.length >= 3, 'each synthetic shape is reported');

  // Guard 5 — fixture literals: the fixture's own contact values are caught.
  const fixtureLiterals = fixtureContactLiterals(intakeFixture);
  const literalVerdict = fixtureLiteralScan(`the lead can be reached at ${fixtureLiterals[0]}`, fixtureLiterals);
  assert.ok(!literalVerdict.ok, 'a raw fixture contact-field literal must be caught');

  // Guard 6 — command targets: a cited non-existent script fails.
  const badCommands = 'run it with ./runtime/does-not-exist.sh today';
  const commandVerdict = citedCommandTargets(badCommands, ROOT);
  assert.ok(!commandVerdict.ok, 'a cited command naming a missing file must fail');

  // Guard 7 — architecture content: graph names / decorative statement absent.
  const badArchitecture = '## Architecture\na single graph does everything at once\n';
  const architectureVerdict = architectureContent(badArchitecture);
  assert.ok(!architectureVerdict.ok, 'an architecture section without the three graphs and the decorative statement must fail');

  // Guard 8 — excerpt derivation: a header-less excerpt fails.
  const badExcerpt = '# Evidence\nsome numbers happened in a run once\n';
  const derivationVerdict = excerptDerivation(badExcerpt);
  assert.ok(!derivationVerdict.ok, 'an excerpt without the derivation header must fail');

  // Guard 9 — evidence numbers: drifted counts fail.
  const driftedCase = { index: 9, name: 'drift', observed: { queue: 4, approval_actions: 4, crm_attempts: 4, crm_effects: 4 }, result: 'pass' };
  const driftedLog = { ...evidenceLog, cases: [...evidenceLog.cases, driftedCase] };
  const numbersVerdict = evidenceNumbers(caseStudy, evidenceSummary, driftedLog);
  assert.ok(!numbersVerdict.ok, 'a case row absent from the docs must fail the numbers guard');

  // Guard 10 — README deferral: the stale future-work wording fails, repointed passes.
  const staleReadme = 'Clean-sandbox rerun record, the packaged evidence log, and the\nbuyer-facing case study are **Phase 3 work** — nothing here claims them.\n';
  const staleVerdict = readmeRepointed(staleReadme);
  assert.ok(!staleVerdict.ok, 'the stale Phase 3 future-work deferral must fail');
  const repointedReadme = 'The evidence log, rerun record, and case study are delivered: see runtime/evidence/final-evidence-log.json and docs/case-study.md.\n';
  assert.ok(readmeRepointed(repointedReadme).ok, 'the repointed wording must pass');

  // Guard 11 — rerun history truth: the old blended "only after every check"
  // claim fails; the truthful historical/current split passes.
  const falseHistory = 'the committed record was promoted atomically only after every check passed';
  assert.ok(!rerunHistoryTruth(falseHistory).ok, 'the historically false "only after every check passed" ordering claim must fail');
  const truthfulHistory = 'the recorded rerun promoted the verified candidate before its then-current final end-state check; an ordinary rerun today is verification-only';
  assert.ok(rerunHistoryTruth(truthfulHistory).ok, 'the truthful historical/current split must pass');

  // Guard 12 — PASS-marker truth: the broad blanket no-PASS claim fails; the
  // substep-marker vs withheld-outer-verdict distinction passes.
  const broadNoPassClaim = 'A failed or interrupted run prints no PASS.';
  assert.ok(!passMarkerTruth(broadNoPassClaim).ok, 'the blanket failed-run no-PASS claim must fail');
  const truthfulMarkers = 'a failed or interrupted run may still include earlier substep PASS markers; CLEAN-RERUN PASS is the withheld outer verdict';
  assert.ok(passMarkerTruth(truthfulMarkers).ok, 'the substep-marker vs outer-verdict distinction must pass');
});
