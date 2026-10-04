// Real-runtime gated intake tracer for the Phase 2 flagship demo (plan 02-01).
//
// This file is the acceptance driver invoked by `runtime/run-gated-demo.sh --tracer`
// AFTER that launcher has, in order:
//   1. started the pinned n8n + demo mock-api Compose project
//      (flagship-intake-gated-demo) on the internal-only runtime network,
//   2. imported and activated runtime/demo/workflows/intake-stage.json into
//      the real n8n instance under a fixed import id,
//   3. asserted the exact pinned n8n version (2.37.10) and that Docker
//      reports the runtime network as Internal,
//   4. reset the demo mock state,
// and exported the contract below through environment variables:
//
//   N8N_BASE_URL                    base URL of the real n8n instance
//   MOCK_BASE_URL                   base URL of the local demo mock service
//   GATED_IMPORTED_WORKFLOW_ID      n8n database id of the imported intake workflow
//   GATED_N8N_VERSION               exact n8n version reported by the runtime
//   GATED_NETWORK_INTERNAL          'true' when Docker reports the runtime network Internal
//   GATED_HISTORICAL_SOURCE_SHA256  pre-run SHA-256 of workflows/client-intake-pipeline.json
//   GATED_INTAKE_WORKFLOW_SHA256    pre-run SHA-256 of runtime/demo/workflows/intake-stage.json
//
// The test never starts, stops, or substitutes anything: valid, invalid, and
// urgent assertions all go through the REAL workflow webhook and the mock
// admin state, never direct calls to mock-only staging handlers. A passing
// run is evidence that the real pinned n8n runtime imported the gated intake
// graph and executed it with zero CRM attempts. A simulation is never
// acceptable evidence (project constraint; Phase 1 D-07 posture).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://127.0.0.1:5678';
const MOCK_BASE_URL = process.env.MOCK_BASE_URL ?? 'http://127.0.0.1:9090';
const WEBHOOK_URL = `${N8N_BASE_URL}/webhook/gated-intake-webhook`;
const REVIEWER_WEBHOOK_URL = `${N8N_BASE_URL}/webhook/reviewer-decision-webhook`;
const DELIVERY_WEBHOOK_URL = `${N8N_BASE_URL}/webhook/gated-delivery-webhook`;
const HISTORICAL_SOURCE_PATH = path.join(ROOT, 'workflows', 'client-intake-pipeline.json');
const INTAKE_WORKFLOW_PATH = path.join(ROOT, 'runtime', 'demo', 'workflows', 'intake-stage.json');
const REVIEWER_WORKFLOW_PATH = path.join(ROOT, 'runtime', 'demo', 'workflows', 'reviewer-decision.json');
const DELIVERY_WORKFLOW_PATH = path.join(ROOT, 'runtime', 'demo', 'workflows', 'approved-delivery.json');
const FIXTURE_PATH = path.join(ROOT, 'payloads', 'intake-new-lead.json');

// Case selection (plan 02-02): the launcher runs this suite once per case and
// exports GATED_CASE so only that case's tests register. The tracer default
// (including an empty/unset variable) preserves the plan 02-01 contract
// byte-for-byte.
const CASE = (process.env.GATED_CASE ?? '').trim() || 'tracer';

// The per-run ephemeral one-time reviewer proof, read from the invocation-
// owned permission-restricted file the launcher mounts read-only at
// /ephemeral/reviewer-proof (GATED_REVIEWER_PROOF_FILE). The raw value never
// travels as a compose-run command line or environment assignment — file
// transport only. The automated suite acts as a SIMULATED reviewer only —
// never an actual human reviewing a client.
const REVIEWER_PROOF = (() => {
  const proofFile = process.env.GATED_REVIEWER_PROOF_FILE ?? '';
  if (!proofFile) return '';
  try {
    return readFileSync(proofFile, 'utf8').trim();
  } catch {
    return '';
  }
})();

const EXPECTED_N8N_VERSION = '2.37.10';

const sha256OfFile = (filePath) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

const fixtureBytes = readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE = JSON.parse(fixtureBytes);

/**
 * POST one intake through the REAL n8n production webhook. The committed
 * fixture is posted byte-identical; derived cases post modified fictional
 * payloads. A timeout or connection reset after dispatch has an ambiguous
 * server-side outcome: the request may have executed despite the lost
 * response, so the caller must fail closed instead of blindly replaying.
 */
async function postIntake(body, key) {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-intake-idempotency-key': key,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Body shape is asserted explicitly by each case.
    }
    return { status: response.status, body: parsed, text, error: null };
  } catch (error) {
    return {
      status: null,
      body: null,
      text: null,
      error: new Error(
        `webhook POST outcome is ambiguous after dispatch (${error.name}: ${error.message}); ` +
          'the server may have accepted and executed it, so no replay is allowed'
      ),
    };
  }
}

async function getMockState() {
  const response = await fetch(`${MOCK_BASE_URL}/admin/state`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, 'demo mock admin state endpoint must respond');
  return response.json();
}

async function resetMockState() {
  const response = await fetch(`${MOCK_BASE_URL}/admin/reset`, {
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, 'demo mock admin reset must succeed between cases');
}

/**
 * WR-06: an admin reset invalidates the registered one-time proof ENTIRELY,
 * so after every in-suite reset the case's own proof (read from the
 * launcher-owned ephemeral file) must be re-registered before any decision.
 * Each registration window admits exactly one decision. Privileged reset may
 * re-register this same raw proof in another window; durable uniqueness is
 * not implemented in the local demo.
 */
async function rearmReviewerProof() {
  const response = await fetch(`${MOCK_BASE_URL}/admin/reviewer-proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proof: REVIEWER_PROOF }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(
    response.status,
    200,
    'the case\'s one-time reviewer proof must be re-registered after a state reset — a reset invalidates any prior registration'
  );
}

const isSuccess = (status) => status !== null && status >= 200 && status < 300;

// WR-09: the admin/audit view exposes caller-controllable idempotency keys
// only as sha256 16-hex prefixes — the exact masking the demo mock applies.
const adminKeyHash = (value) =>
  value === null || value === undefined || value === '' ? null : createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

/**
 * Issue one reviewer decision through the REAL reviewer webhook. This is the
 * separate, deliberate reviewer event — it is the ONLY way a review may leave
 * the pending state, and it is what the manual `--manual-review` command
 * reproduces for a human operator. In this suite the caller is a SIMULATED
 * reviewer: the one-time proof comes from the launcher environment.
 *
 * Like postIntake, an ambiguous network outcome after dispatch is never
 * blindly retried: the decision may have been recorded server-side.
 */
async function postReviewerAction({ reviewId, decision, proof }) {
  const headers = { 'content-type': 'application/json' };
  if (proof !== undefined) headers['x-reviewer-proof'] = proof;
  try {
    const response = await fetch(REVIEWER_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ review_id: reviewId, decision }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Body shape is asserted explicitly by each case.
    }
    return { status: response.status, body: parsed, text, error: null };
  } catch (error) {
    return {
      status: null,
      body: null,
      text: null,
      error: new Error(
        `reviewer webhook POST outcome is ambiguous after dispatch (${error.name}: ${error.message}); ` +
          'the decision may have been recorded, so no replay is allowed'
      ),
    };
  }
}

/**
 * AUDIT-01 posture: the sanitized admin state must never carry raw fictional
 * contact material — reviews expose hashes/masked identifiers only.
 */
function assertNoRawContactMaterial(state) {
  const serialized = JSON.stringify(state);
  for (const raw of [FIXTURE.contact.email, FIXTURE.contact.phone]) {
    assert.ok(
      !serialized.includes(raw),
      `sanitized admin state must not contain raw contact material (${raw.slice(0, 6)}...)`
    );
  }
}

if (CASE === 'tracer') {

test('launcher contract: gated tracer requires imported workflow id, exact n8n 2.37.10, internal network, and unchanged source hashes', () => {
  const importedId = process.env.GATED_IMPORTED_WORKFLOW_ID;
  assert.ok(
    importedId && importedId.trim().length > 0,
    'the --tracer launcher must import the intake workflow into real n8n and export GATED_IMPORTED_WORKFLOW_ID'
  );

  assert.equal(
    process.env.GATED_N8N_VERSION,
    EXPECTED_N8N_VERSION,
    'the launcher must prove the runtime is exactly the pinned n8n build'
  );

  assert.equal(
    process.env.GATED_NETWORK_INTERNAL,
    'true',
    'the launcher must prove Docker reports the runtime network as internal before executing'
  );

  const expectedHistorical = process.env.GATED_HISTORICAL_SOURCE_SHA256;
  assert.ok(
    expectedHistorical && expectedHistorical.length === 64,
    'the launcher must record the pre-run SHA-256 of the immutable historical source'
  );
  assert.equal(
    sha256OfFile(HISTORICAL_SOURCE_PATH),
    expectedHistorical,
    'workflows/client-intake-pipeline.json must be byte-identical to the pre-run hash'
  );

  const expectedIntake = process.env.GATED_INTAKE_WORKFLOW_SHA256;
  assert.ok(
    expectedIntake && expectedIntake.length === 64,
    'the launcher must record the pre-run SHA-256 of the gated intake workflow'
  );
  assert.equal(
    sha256OfFile(INTAKE_WORKFLOW_PATH),
    expectedIntake,
    'runtime/demo/workflows/intake-stage.json must be byte-identical to the pre-run hash'
  );
});

test('invalid nested-body intake returns a real-workflow validation failure and touches nothing', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const invalidFixture = structuredClone(FIXTURE);
  delete invalidFixture.contact.last_name;
  const response = await postIntake(JSON.stringify(invalidFixture), 'tracer-02-01-invalid');
  if (response.error) assert.fail(`real webhook must be reachable: ${response.error.message}`);

  assert.equal(
    response.status,
    400,
    `an intake missing last_name must be rejected with 400 by the real workflow (got ${response.status}: ${response.text})`
  );
  assert.equal(response.body?.status, 'error', 'the 400 body must be the validation-error response');
  assert.ok(
    Array.isArray(response.body?.errors) && response.body.errors.length > 0,
    'the 400 body must enumerate validation errors'
  );
  assert.ok(
    response.body.errors.some((error) => String(error).includes('last_name')),
    `the validation errors must name the missing field (got: ${JSON.stringify(response.body.errors)})`
  );

  const state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 0, 'no review may be queued for an invalid intake');
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'invalid intake must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'invalid intake must produce zero CRM effects');
  assert.deepEqual(state.reviews ?? [], [], 'no review record may exist for an invalid intake');
});

test('urgent fictional intake stays pending review with zero CRM attempts and effects', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const urgentFixture = structuredClone(FIXTURE);
  urgentFixture.case_info.urgency = 'urgent';
  const response = await postIntake(JSON.stringify(urgentFixture), 'tracer-02-01-urgent');
  if (response.error) assert.fail(`real webhook must be reachable: ${response.error.message}`);

  assert.equal(
    response.status,
    202,
    `an urgent intake must still be staged for review with 202 (got ${response.status}: ${response.text})`
  );
  assert.equal(
    response.body?.status,
    'pending_review',
    'urgency must never change the pending-review outcome — urgency is not approval'
  );
  assert.equal(response.body?.crm_attempted, false, 'the response must truthfully report no CRM attempt');

  const state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'the urgent intake creates exactly one pending review');
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'urgency must never produce a CRM attempt before review');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'urgency must never produce a CRM effect before review');

  const review = (state.reviews ?? [])[0];
  assert.ok(review, 'a sanitized review record must exist for the urgent intake');
  assert.equal(review.state, 'pending', 'the urgent review must still be pending');
  assert.equal(review.urgency, 'urgent', 'urgency is recorded as data and consumed by nothing');
  assertNoRawContactMaterial(state);
});

test('valid fictional intake executes on real n8n: 202 pending review, queue=1, CRM attempts=0, CRM effects=0', async () => {
  await resetMockState();
  await rearmReviewerProof();

  // The committed fictional fixture, posted byte-identical through the real
  // production webhook. This is the counted tracer case the launcher reports.
  const response = await postIntake(fixtureBytes, 'tracer-02-01-valid');
  if (response.error) assert.fail(`real webhook must be reachable: ${response.error.message}`);

  assert.equal(
    response.status,
    202,
    `the gated intake workflow must accept the fictional fixture with 202 (got ${response.status}: ${response.text})`
  );
  assert.equal(
    response.body?.status,
    'pending_review',
    'the 202 body must truthfully report a pending review, never delivery'
  );
  assert.match(
    String(response.body?.review_id),
    /^rev_/,
    'the 202 body must carry the review id produced by the staged demo state'
  );
  assert.equal(response.body?.crm_attempted, false, 'the response must truthfully report no CRM attempt');

  const state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'exactly one pending review must exist after the valid intake');
  assert.equal(
    state.counters?.crm_attempts ?? 0,
    0,
    'CRM attempts must be exactly zero before any reviewer action — the core safety boundary'
  );
  assert.equal(
    state.counters?.crm_effects ?? 0,
    0,
    'CRM effects must be exactly zero before any reviewer action'
  );

  const review = (state.reviews ?? [])[0];
  assert.ok(review, 'a sanitized review record must exist');
  assert.equal(review.state, 'pending', 'the review must be pending, not delivered');
  assert.match(String(review.review_id), /^rev_/, 'the review record must carry its fictional review id');
  assertNoRawContactMaterial(state);
});

} // end CASE === 'tracer'

if (CASE === 'reviewer-gate') {

test('reviewer-gate launcher contract: one-time reviewer proof injected, reviewer workflow imported, exact pin and unchanged hashes', () => {
  // The proof assertion comes first so the RED phase fails on exactly the
  // missing launcher capability this case is built to prove.
  assert.ok(
    REVIEWER_PROOF.trim().length >= 32,
    'the --case reviewer-gate launcher must mount the ephemeral one-time reviewer proof file (GATED_REVIEWER_PROOF_FILE) — this suite acts as a simulated reviewer only'
  );

  assert.equal(
    process.env.GATED_N8N_VERSION,
    EXPECTED_N8N_VERSION,
    'the launcher must prove the runtime is exactly the pinned n8n build'
  );
  assert.equal(
    process.env.GATED_NETWORK_INTERNAL,
    'true',
    'the launcher must prove Docker reports the runtime network as internal before executing'
  );

  assert.ok(
    process.env.GATED_IMPORTED_WORKFLOW_ID?.trim(),
    'the intake workflow must be imported and activated so cases can stage reviews through the real webhook'
  );
  assert.ok(
    process.env.GATED_REVIEWER_IMPORTED_WORKFLOW_ID?.trim(),
    'the reviewer-decision workflow must be imported and activated — decisions must go through the real graph'
  );

  const expectedIntake = process.env.GATED_INTAKE_WORKFLOW_SHA256;
  assert.ok(expectedIntake && expectedIntake.length === 64, 'the launcher must record the pre-run SHA-256 of the gated intake workflow');
  assert.equal(
    sha256OfFile(INTAKE_WORKFLOW_PATH),
    expectedIntake,
    'runtime/demo/workflows/intake-stage.json must be byte-identical to the pre-run hash'
  );

  const expectedReviewer = process.env.GATED_REVIEWER_WORKFLOW_SHA256;
  assert.ok(
    expectedReviewer && expectedReviewer.length === 64,
    'the launcher must record the pre-run SHA-256 of the reviewer-decision workflow'
  );
  assert.equal(
    sha256OfFile(REVIEWER_WORKFLOW_PATH),
    expectedReviewer,
    'runtime/demo/workflows/reviewer-decision.json must be byte-identical to the pre-run hash'
  );

  // T-02-05/T-02-08: the per-run proof is ephemeral launcher material — it
  // must never be baked into any committed workflow export.
  const reviewerExport = readFileSync(REVIEWER_WORKFLOW_PATH, 'utf8');
  assert.ok(
    !reviewerExport.includes(REVIEWER_PROOF),
    'the one-time reviewer proof must never appear inside the committed reviewer workflow export'
  );
});

test('missing, wrong, or replayed authorization and malformed or unknown decisions record no decision and zero CRM activity', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const staged = await postIntake(fixtureBytes, 'reviewer-gate-negatives');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  assert.equal(staged.status, 202, `staging must succeed first (got ${staged.status}: ${staged.text})`);
  const reviewId = staged.body?.review_id;
  assert.match(String(reviewId), /^rev_/, 'the staged review id must be returned');

  // 1. Missing proof (no header at all).
  const missing = await postReviewerAction({ reviewId, decision: 'reject' });
  if (missing.error) assert.fail(`reviewer webhook must be reachable: ${missing.error.message}`);
  assert.ok(
    !isSuccess(missing.status),
    `a reviewer action without the one-time proof must be non-success (got ${missing.status}: ${missing.text})`
  );

  // 2. Wrong proof value.
  const wrong = await postReviewerAction({ reviewId, decision: 'reject', proof: 'definitely-not-the-one-time-proof' });
  assert.ok(
    !isSuccess(wrong.status),
    `a reviewer action with the wrong proof must be non-success (got ${wrong.status}: ${wrong.text})`
  );

  // 3. Decision outside the exact approve/reject enum — rejected by the graph.
  const malformedDecision = await postReviewerAction({ reviewId, decision: 'maybe', proof: REVIEWER_PROOF });
  assert.equal(
    malformedDecision.status,
    400,
    `a decision other than exact approve/reject must fail closed with 400 (got ${malformedDecision.status}: ${malformedDecision.text})`
  );

  // 4. Unknown review id, even with the correct proof.
  const unknown = await postReviewerAction({ reviewId: 'rev_99999', decision: 'approve', proof: REVIEWER_PROOF });
  assert.ok(
    !isSuccess(unknown.status),
    `an unknown review id must be non-success even with a valid proof (got ${unknown.status}: ${unknown.text})`
  );

  // 5. Shape-invalid body (valid JSON, no review_id).
  const shapeless = await postReviewerAction({ reviewId: '', decision: 'reject', proof: REVIEWER_PROOF });
  assert.equal(
    shapeless.status,
    400,
    `a body without review_id must fail graph validation with 400 (got ${shapeless.status}: ${shapeless.text})`
  );

  // 6. Malformed JSON body — any non-success outcome is correct (fail closed).
  let malformedJson;
  try {
    const response = await fetch(REVIEWER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reviewer-proof': REVIEWER_PROOF },
      body: '{ not valid json',
      signal: AbortSignal.timeout(15_000),
    });
    malformedJson = { status: response.status, text: await response.text() };
  } catch (error) {
    malformedJson = { status: null, text: String(error) };
  }
  assert.ok(
    !isSuccess(malformedJson.status),
    `a malformed JSON body must never be interpreted as a decision (got ${malformedJson.status}: ${malformedJson.text})`
  );

  // Nothing above may have recorded a decision, consumed the proof, or moved
  // any CRM counter — the proof remains valid for a later genuine decision,
  // which the reject case below proves by consuming it successfully.
  const state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'exactly one staged review exists');
  assert.equal(state.counters?.approval_actions ?? 0, 0, 'no failed attempt may record an approval action');
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'failed authorization/decision attempts must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'failed authorization/decision attempts must produce zero CRM effects');
  const review = (state.reviews ?? [])[0];
  assert.ok(review, 'the staged review record must exist');
  assert.equal(review.state, 'pending', 'no decision may be recorded for any failed reviewer attempt');
  assert.ok(
    !review.transitions.some((transition) => transition.by === 'reviewer'),
    'no reviewer transition may exist after failed attempts'
  );

  // T-02-08: sanitized admin state carries no raw contact material and never
  // the proof value itself.
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(REVIEWER_PROOF), 'the admin state must never contain the raw one-time proof');
  assertNoRawContactMaterial(state);
});

test('approve records one separate approval action independent of queue count; replaying the consumed proof is non-mutating', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const staged = await postIntake(fixtureBytes, 'reviewer-gate-approve');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  const reviewId = staged.body?.review_id;

  const approved = await postReviewerAction({ reviewId, decision: 'approve', proof: REVIEWER_PROOF });
  if (approved.error) assert.fail(`reviewer webhook must be reachable: ${approved.error.message}`);
  assert.equal(
    approved.status,
    200,
    `an exact approve for a known pending review must be recorded (got ${approved.status}: ${approved.text})`
  );
  assert.equal(approved.body?.status, 'approved', 'the response must truthfully report the approved decision outcome');
  assert.ok(approved.body?.review_id, 'the approved response must carry the review id');

  let state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'approval never increments the queue');
  assert.equal(
    state.counters?.approval_actions ?? 0,
    1,
    'exactly one approval action must be recorded by the separate reviewer event'
  );
  // Approval recording invokes the delivery graph once (after the recorded
  // transition), so exactly one attempt/effect follows the authorized
  // approval — proven in depth by the approval-delivery case.
  assert.equal(state.counters?.crm_attempts ?? 0, 1, 'approval recording alone must still yield exactly one CRM attempt via the delivery invocation');
  assert.equal(state.counters?.crm_effects ?? 0, 1, 'approval recording alone must still yield exactly one committed CRM effect');

  const review = (state.reviews ?? []).find((candidate) => candidate.review_id === reviewId);
  assert.ok(review, 'the review record must exist');
  assert.equal(review.state, 'approved', 'the review must be approved');
  const approveTransition = review.transitions.find((transition) => transition.to === 'approved');
  assert.ok(approveTransition, 'an approved transition must be recorded');
  assert.equal(approveTransition.by, 'reviewer', 'the transition must be attributed to the reviewer event, not to queueing');
  assert.ok(!approveTransition.detail?.includes(REVIEWER_PROOF), 'the transition detail must never contain the proof value');

  // Replay the exact same request: the one-time proof is consumed, so the
  // replay is rejected and nothing new is recorded.
  const replay = await postReviewerAction({ reviewId, decision: 'approve', proof: REVIEWER_PROOF });
  assert.ok(
    !isSuccess(replay.status),
    `replaying the consumed one-time proof must be non-success (got ${replay.status}: ${replay.text})`
  );

  state = await getMockState();
  assert.equal(state.counters?.approval_actions ?? 0, 1, 'a replayed decision must not record a second approval action');
  assert.equal(state.counters?.review_queue ?? 0, 1, 'a replayed decision must not queue anything');
  assert.equal(state.counters?.crm_attempts ?? 0, 1, 'a replayed decision must not attempt CRM again');
  assert.equal(state.counters?.crm_effects ?? 0, 1, 'a replayed decision must not commit another CRM effect');

  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(REVIEWER_PROOF), 'the admin state must never contain the raw one-time proof');
  assertNoRawContactMaterial(state);
});

test('reject consumes one fresh proof, records one rejected transition, and never reaches CRM', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const staged = await postIntake(fixtureBytes, 'reviewer-gate-reject');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  const reviewId = staged.body?.review_id;

  const rejected = await postReviewerAction({ reviewId, decision: 'reject', proof: REVIEWER_PROOF });
  if (rejected.error) assert.fail(`reviewer webhook must be reachable: ${rejected.error.message}`);
  assert.equal(
    rejected.status,
    200,
    `an exact reject for a known pending review must be recorded (got ${rejected.status}: ${rejected.text})`
  );
  assert.equal(rejected.body?.status, 'recorded', 'the response must truthfully report a recorded decision');
  assert.equal(rejected.body?.review_state, 'rejected', 'the review state must be rejected after the decision');

  const state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'staging produced exactly one queue entry');
  assert.equal(state.counters?.approval_actions ?? 0, 0, 'rejection is never an approval action');
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'rejection must never reach CRM');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'rejection must never commit a CRM effect');

  const review = (state.reviews ?? [])[0];
  assert.ok(review, 'the review record must exist');
  assert.equal(review.state, 'rejected', 'the review must be rejected');
  const rejectTransition = review.transitions.find((transition) => transition.to === 'rejected');
  assert.ok(rejectTransition, 'a rejected transition must be recorded');
  assert.equal(rejectTransition.by, 'reviewer', 'the rejection must be attributed to the reviewer event');

  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(REVIEWER_PROOF), 'the admin state must never contain the raw one-time proof');
  assertNoRawContactMaterial(state);
});

} // end CASE === 'reviewer-gate'

if (CASE === 'approval-delivery') {

/**
 * Invoke the REAL approved-delivery webhook directly. Delivery must be
 * reachable ONLY through the recorded approved state — every direct call for
 * a non-approved state must be refused before the CRM node.
 */
async function postDelivery(reviewId) {
  try {
    const response = await fetch(DELIVERY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ review_id: reviewId }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Body shape is asserted explicitly by each case.
    }
    return { status: response.status, body: parsed, text, error: null };
  } catch (error) {
    return { status: null, body: null, text: null, error: new Error(`delivery webhook POST failed (${error.name}: ${error.message})`) };
  }
}

/** Deterministic test-only state corruption (admin fault injection). */
async function adminFault(reviewId, mode) {
  const response = await fetch(`${MOCK_BASE_URL}/admin/fault-inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ review_id: reviewId, mode }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, `fault injection (${mode}) must be accepted by the admin contract`);
}

test('approval-delivery launcher contract: delivery workflow imported and asserted, proof injected, exact pin and unchanged hashes', () => {
  // The delivery-workflow assertion comes first so the RED phase fails on
  // exactly the missing capability this case is built to prove.
  assert.ok(
    process.env.GATED_DELIVERY_IMPORTED_WORKFLOW_ID?.trim(),
    'the --case approval-delivery launcher must import and activate the approved-delivery workflow — the in-graph assertion is load-bearing, the mock is not the gate'
  );

  assert.ok(
    REVIEWER_PROOF.trim().length >= 32,
    'the launcher must inject the one-time reviewer proof so the suite can act as a simulated reviewer'
  );
  assert.equal(process.env.GATED_N8N_VERSION, EXPECTED_N8N_VERSION, 'the launcher must prove the exact pinned n8n build');
  assert.equal(process.env.GATED_NETWORK_INTERNAL, 'true', 'the launcher must prove the runtime network is internal');
  assert.ok(process.env.GATED_IMPORTED_WORKFLOW_ID?.trim(), 'the intake workflow must be imported');
  assert.ok(process.env.GATED_REVIEWER_IMPORTED_WORKFLOW_ID?.trim(), 'the reviewer workflow must be imported');

  const expectedDelivery = process.env.GATED_DELIVERY_WORKFLOW_SHA256;
  assert.ok(expectedDelivery && expectedDelivery.length === 64, 'the launcher must record the pre-run SHA-256 of the approved-delivery workflow');
  assert.equal(
    sha256OfFile(DELIVERY_WORKFLOW_PATH),
    expectedDelivery,
    'runtime/demo/workflows/approved-delivery.json must be byte-identical to the pre-run hash'
  );

  const deliveryExport = readFileSync(DELIVERY_WORKFLOW_PATH, 'utf8');
  assert.ok(!deliveryExport.includes(REVIEWER_PROOF), 'the reviewer proof must never appear inside the delivery workflow export');
});

test('a pending (unapproved) review cannot pass delivery: direct invocation is refused with zero CRM activity', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const staged = await postIntake(fixtureBytes, 'approval-delivery-pending');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  const reviewId = staged.body?.review_id;
  assert.equal(staged.status, 202, `staging must succeed first (got ${staged.status}: ${staged.text})`);

  const delivery = await postDelivery(reviewId);
  if (delivery.error) assert.fail(`delivery webhook must be reachable: ${delivery.error.message}`);
  assert.ok(
    !isSuccess(delivery.status),
    `delivery for a pending review must be refused (got ${delivery.status}: ${delivery.text})`
  );
  assert.equal(delivery.body?.status, 'refused', `the refusal must be truthful (got ${delivery.text})`);

  const state = await getMockState();
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'a pending review must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'a pending review must produce zero CRM effects');
  assertNoRawContactMaterial(state);
});

test('a rejected review can never reach the CRM node', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const staged = await postIntake(fixtureBytes, 'approval-delivery-rejected');
  const reviewId = staged.body?.review_id;
  const rejected = await postReviewerAction({ reviewId, decision: 'reject', proof: REVIEWER_PROOF });
  if (rejected.error) assert.fail(`reviewer webhook must be reachable: ${rejected.error.message}`);
  assert.equal(rejected.status, 200, `rejection must be recorded first (got ${rejected.status}: ${rejected.text})`);

  const delivery = await postDelivery(reviewId);
  if (delivery.error) assert.fail(`delivery webhook must be reachable: ${delivery.error.message}`);
  assert.ok(
    !isSuccess(delivery.status),
    `delivery after rejection must be refused (got ${delivery.status}: ${delivery.text})`
  );

  const state = await getMockState();
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'rejection must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'rejection must produce zero CRM effects');
});

test('unknown reviews and malformed delivery requests fail closed before any CRM attempt', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const unknown = await postDelivery('rev_99999');
  if (unknown.error) assert.fail(`delivery webhook must be reachable: ${unknown.error.message}`);
  assert.ok(
    !isSuccess(unknown.status),
    `an unknown review id must be refused (got ${unknown.status}: ${unknown.text})`
  );

  // Malformed body: the state load cannot resolve a review and the workflow
  // must stop before the CRM node (non-success, never a delivery).
  let malformed;
  try {
    const response = await fetch(DELIVERY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ something_else: true }),
      signal: AbortSignal.timeout(15_000),
    });
    malformed = { status: response.status, text: await response.text() };
  } catch (error) {
    malformed = { status: null, text: String(error) };
  }
  assert.ok(
    !isSuccess(malformed.status),
    `a delivery request without review_id must be non-success (got ${malformed.status}: ${malformed.text})`
  );

  const state = await getMockState();
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'unknown/malformed delivery requests must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'unknown/malformed delivery requests must produce zero CRM effects');
});

test('malformed, conflicting, and garbage states terminate before the CRM node', async () => {
  await resetMockState();
  await rearmReviewerProof();

  // Malformed review state: the classifier must refuse, not deliver.
  const malformedStaged = await postIntake(fixtureBytes, 'approval-delivery-malformed');
  const malformedId = malformedStaged.body?.review_id;
  await adminFault(malformedId, 'malformed_review_state');
  const malformedDelivery = await postDelivery(malformedId);
  if (malformedDelivery.error) assert.fail(`delivery webhook must be reachable: ${malformedDelivery.error.message}`);
  assert.ok(
    !isSuccess(malformedDelivery.status),
    `a corrupted review state must be refused (got ${malformedDelivery.status}: ${malformedDelivery.text})`
  );

  // Conflicting state: review says approved but no separately recorded
  // approval action exists — the exact bypass the in-graph assertion exists
  // to kill.
  await resetMockState();
  await rearmReviewerProof();
  const conflictingStaged = await postIntake(fixtureBytes, 'approval-delivery-conflict');
  const conflictingId = conflictingStaged.body?.review_id;
  await adminFault(conflictingId, 'conflicting_approval');
  const conflictingDelivery = await postDelivery(conflictingId);
  assert.ok(
    !isSuccess(conflictingDelivery.status),
    `an approved state without a recorded reviewer approval must be refused (got ${conflictingDelivery.status}: ${conflictingDelivery.text})`
  );

  // Garbage state-load response: the classifier throws and the workflow
  // stops — an expression/state error can never fall through to delivery.
  await resetMockState();
  await rearmReviewerProof();
  const garbageStaged = await postIntake(fixtureBytes, 'approval-delivery-garbage');
  const garbageId = garbageStaged.body?.review_id;
  await adminFault(garbageId, 'garbage_state_response');
  const garbageDelivery = await postDelivery(garbageId);
  assert.ok(
    !isSuccess(garbageDelivery.status),
    `a malformed state-load response must stop the workflow non-success (got ${garbageDelivery.status}: ${garbageDelivery.text})`
  );

  const state = await getMockState();
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'malformed/conflicting/garbage states must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'malformed/conflicting/garbage states must produce zero CRM effects');
});

test('one authorized approval delivers exactly once through the in-graph assertion; committed replay returns the existing delivery', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const staged = await postIntake(fixtureBytes, 'approval-delivery-happy');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  const reviewId = staged.body?.review_id;

  // The approval is the separate reviewer event; delivery fires ONLY after
  // the recorded transition, through the graph's own approved-state
  // assertion, and the reviewer response carries the sanitized outcome.
  const approved = await postReviewerAction({ reviewId, decision: 'approve', proof: REVIEWER_PROOF });
  if (approved.error) assert.fail(`reviewer webhook must be reachable: ${approved.error.message}`);
  assert.equal(
    approved.status,
    200,
    `the approved reviewer action must succeed end-to-end including delivery (got ${approved.status}: ${approved.text})`
  );
  assert.equal(approved.body?.status, 'approved', 'the reviewer response must report the approval');
  assert.equal(approved.body?.delivery?.status, 'delivered', 'the reviewer response must carry the sanitized delivery outcome');
  assert.match(String(approved.body?.delivery?.effect_id), /^crm_/, 'the delivered effect id must be surfaced');
  assert.ok(!approved.text?.includes(FIXTURE.contact.email), 'the reviewer response must never carry raw contact material');

  let state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'exactly one staged review');
  assert.equal(state.counters?.approval_actions ?? 0, 1, 'exactly one approval action');
  assert.equal(
    state.counters?.crm_attempts ?? 0,
    1,
    `exactly one CRM attempt must follow the authorized approval (got ${state.counters?.crm_attempts})`
  );
  assert.equal(
    state.counters?.crm_effects ?? 0,
    1,
    `exactly one CRM effect must be committed (got ${state.counters?.crm_effects})`
  );

  const review = (state.reviews ?? []).find((candidate) => candidate.review_id === reviewId);
  assert.ok(review, 'the review record must exist');
  assert.equal(review.state, 'approved', 'the review must be approved');

  // Committed replay: a direct delivery invocation after the committed
  // effect must return the existing sanitized delivery through the
  // pre-assertion branch and change neither attempts nor effects.
  const replay = await postDelivery(reviewId);
  if (replay.error) assert.fail(`delivery webhook must be reachable: ${replay.error.message}`);
  assert.equal(replay.status, 200, `committed replay must succeed truthfully (got ${replay.status}: ${replay.text})`);
  assert.equal(replay.body?.status, 'already_delivered', `committed replay must return the existing delivery (got ${replay.text})`);
  assert.match(String(replay.body?.effect_id), /^crm_/, 'the existing effect id must be surfaced');

  state = await getMockState();
  assert.equal(state.counters?.crm_attempts ?? 0, 1, 'committed replay must not add a CRM attempt');
  assert.equal(state.counters?.crm_effects ?? 0, 1, 'committed replay must not add a CRM effect');

  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(REVIEWER_PROOF), 'the admin state must never contain the raw one-time proof');
  assertNoRawContactMaterial(state);
});

} // end CASE === 'approval-delivery'

if (CASE === 'intake-idempotency') {

test('intake-idempotency launcher contract: workflows imported, exact pin, internal network, unchanged hashes', () => {
  assert.equal(
    process.env.GATED_N8N_VERSION,
    EXPECTED_N8N_VERSION,
    'the launcher must prove the runtime is exactly the pinned n8n build'
  );
  assert.equal(
    process.env.GATED_NETWORK_INTERNAL,
    'true',
    'the launcher must prove Docker reports the runtime network as internal before executing'
  );
  assert.ok(
    process.env.GATED_IMPORTED_WORKFLOW_ID?.trim(),
    'the intake workflow must be imported and activated so replay/conflict cases run through the real graph'
  );

  const expectedIntake = process.env.GATED_INTAKE_WORKFLOW_SHA256;
  assert.ok(expectedIntake && expectedIntake.length === 64, 'the launcher must record the pre-run SHA-256 of the gated intake workflow');
  assert.equal(
    sha256OfFile(INTAKE_WORKFLOW_PATH),
    expectedIntake,
    'runtime/demo/workflows/intake-stage.json must be byte-identical to the pre-run hash'
  );
});

test('exact replay through the real webhook returns the same review with zero new writes', async () => {
  await resetMockState();
  await rearmReviewerProof();

  // Stage once through the REAL production webhook.
  const staged = await postIntake(fixtureBytes, 'intake-idem-replay');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  assert.equal(staged.status, 202, `staging must succeed first (got ${staged.status}: ${staged.text})`);
  const reviewId = staged.body?.review_id;
  assert.match(String(reviewId), /^rev_/, 'the staged review id must be returned');

  let state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'exactly one review after the initial staging');

  // Byte-identical replay under the same key: a non-mutating reuse.
  const replay = await postIntake(fixtureBytes, 'intake-idem-replay');
  if (replay.error) assert.fail(`real intake webhook must be reachable: ${replay.error.message}`);
  assert.equal(
    replay.status,
    200,
    `an exact replay must answer truthfully as a reuse, not a second staging (got ${replay.status}: ${replay.text})`
  );
  assert.equal(replay.body?.status, 'replay', `the replay response must be marked as a replay (got ${replay.text})`);
  assert.equal(replay.body?.review_id, reviewId, 'the replay must return the ORIGINAL review id');
  assert.equal(replay.body?.crm_attempted ?? false, false, 'the replay response must never imply a CRM attempt');

  // Same logical payload with shuffled JSON object keys: the canonical hash is
  // order-invariant, so this is still an exact replay.
  const reordered = {
    firm: FIXTURE.firm,
    timestamp: FIXTURE.timestamp,
    referral_source: FIXTURE.referral_source,
    contact: {
      phone: FIXTURE.contact.phone,
      preferred_contact: FIXTURE.contact.preferred_contact,
      last_name: FIXTURE.contact.last_name,
      email: FIXTURE.contact.email,
      first_name: FIXTURE.contact.first_name,
    },
    source: FIXTURE.source,
    case_info: {
      urgency: FIXTURE.case_info.urgency,
      incident_date: FIXTURE.case_info.incident_date,
      description: FIXTURE.case_info.description,
      type: FIXTURE.case_info.type,
    },
  };
  const reorderedReplay = await postIntake(JSON.stringify(reordered), 'intake-idem-replay');
  if (reorderedReplay.error) assert.fail(`real intake webhook must be reachable: ${reorderedReplay.error.message}`);
  assert.equal(
    reorderedReplay.status,
    200,
    `key-reordered but semantically identical content is still an exact replay (got ${reorderedReplay.status}: ${reorderedReplay.text})`
  );
  assert.equal(reorderedReplay.body?.review_id, reviewId, 'the reordered replay must return the same original review id');

  state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'exact replay must not queue a second review');
  assert.equal(state.counters?.approval_actions ?? 0, 0, 'a duplicate request is never an approval');
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'exact replay must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'exact replay must produce zero CRM effects');
  const reviews = state.reviews ?? [];
  assert.equal(reviews.length, 1, 'exactly one review record exists after replay');
  assert.equal(reviews[0]?.state, 'pending', 'the review stays pending — a duplicate is not a decision');
  assertNoRawContactMaterial(state);
});

test('conflicting content under the same intake key fails closed with a truthful 409 and zero mutation', async () => {
  await resetMockState();
  await rearmReviewerProof();

  const staged = await postIntake(fixtureBytes, 'intake-idem-conflict');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  assert.equal(staged.status, 202, `staging must succeed first (got ${staged.status}: ${staged.text})`);
  const reviewId = staged.body?.review_id;

  // Same idempotency key, semantically changed canonical content.
  const conflicting = structuredClone(FIXTURE);
  conflicting.case_info.description = 'Conflicting fictional content replayed under the same intake key';
  const conflict = await postIntake(JSON.stringify(conflicting), 'intake-idem-conflict');
  if (conflict.error) assert.fail(`real intake webhook must be reachable: ${conflict.error.message}`);
  assert.equal(
    conflict.status,
    409,
    `same key + different canonical content must surface the mock\'s conflict truthfully as 409 (got ${conflict.status}: ${conflict.text})`
  );
  assert.equal(
    conflict.body?.status,
    'conflict',
    `the 409 body must be the explicit conflict response, never an empty or pending-review body (got ${conflict.text})`
  );

  const state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'the conflicting request must not queue anything');
  assert.equal(state.counters?.approval_actions ?? 0, 0, 'the conflicting request must not approve anything');
  assert.equal(state.counters?.crm_attempts ?? 0, 0, 'the conflicting request must produce zero CRM attempts');
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'the conflicting request must produce zero CRM effects');
  const review = (state.reviews ?? []).find((candidate) => candidate.review_id === reviewId);
  assert.ok(review, 'the original review record must still exist');
  assert.equal(review.state, 'pending', 'the original review must remain pending');
  assert.equal(review.transitions.length, 1, 'the conflicting request adds no transition');
  assertNoRawContactMaterial(state);
});

} // end CASE === 'intake-idempotency'

if (CASE === 'crm-recovery') {

/**
 * Invoke the REAL approved-delivery webhook directly — used ONLY as the
 * deliberate, state-observed recovery retry (the suite first reads the admin
 * state and confirms the delivery is retryable) and for committed replay.
 * Never a blind replay after an ambiguous network outcome.
 */
async function postDeliveryRecovery(reviewId) {
  try {
    const response = await fetch(DELIVERY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ review_id: reviewId }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Body shape is asserted explicitly by the case.
    }
    return { status: response.status, body: parsed, text, error: null };
  } catch (error) {
    return { status: null, body: null, text: null, error: new Error(`delivery webhook POST failed (${error.name}: ${error.message})`) };
  }
}

/** Deterministic test-only fault injection through the admin contract. */
async function adminRecoveryFault(reviewId, mode) {
  const response = await fetch(`${MOCK_BASE_URL}/admin/fault-inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ review_id: reviewId, mode }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, `fault injection (${mode}) must be accepted by the admin contract`);
}

test('crm-recovery launcher contract: delivery workflow imported, proof injected, exact pin and unchanged hashes', () => {
  assert.ok(
    process.env.GATED_DELIVERY_IMPORTED_WORKFLOW_ID?.trim(),
    'the --case crm-recovery launcher must import and activate the approved-delivery workflow — the recovery path runs through the real graph'
  );
  assert.ok(
    REVIEWER_PROOF.trim().length >= 32,
    'the launcher must inject the one-time reviewer proof so the suite can act as a simulated reviewer'
  );
  assert.equal(process.env.GATED_N8N_VERSION, EXPECTED_N8N_VERSION, 'the launcher must prove the exact pinned n8n build');
  assert.equal(process.env.GATED_NETWORK_INTERNAL, 'true', 'the launcher must prove the runtime network is internal');
  assert.ok(process.env.GATED_IMPORTED_WORKFLOW_ID?.trim(), 'the intake workflow must be imported');

  const expectedDelivery = process.env.GATED_DELIVERY_WORKFLOW_SHA256;
  assert.ok(expectedDelivery && expectedDelivery.length === 64, 'the launcher must record the pre-run SHA-256 of the approved-delivery workflow');
  assert.equal(
    sha256OfFile(DELIVERY_WORKFLOW_PATH),
    expectedDelivery,
    'runtime/demo/workflows/approved-delivery.json must be byte-identical to the pre-run hash'
  );
});

test('pre-commit CRM failure records one truthful attempt with zero effects, then one deliberate same-key retry commits exactly one effect', async () => {
  await resetMockState();
  await rearmReviewerProof();

  // Stage and arm the deterministic pre-commit fault BEFORE the approval so
  // the approval-triggered first delivery is the failing invocation.
  const staged = await postIntake(fixtureBytes, 'crm-recovery-fault');
  if (staged.error) assert.fail(`real intake webhook must be reachable: ${staged.error.message}`);
  const reviewId = staged.body?.review_id;
  await adminRecoveryFault(reviewId, 'crm_precommit_failure');

  const approved = await postReviewerAction({ reviewId, decision: 'approve', proof: REVIEWER_PROOF });
  if (approved.error) assert.fail(`reviewer webhook must be reachable: ${approved.error.message}`);
  assert.equal(approved.status, 200, `the approved reviewer action must be recorded (got ${approved.status}: ${approved.text})`);
  assert.notEqual(
    approved.body?.delivery?.status,
    'delivered',
    `the first (faulted) delivery must NEVER be reported as delivered (got: ${approved.text})`
  );

  let state = await getMockState();
  assert.equal(state.counters?.review_queue ?? 0, 1, 'exactly one staged review');
  assert.equal(state.counters?.approval_actions ?? 0, 1, 'exactly one recorded approval action');
  assert.equal(
    state.counters?.crm_attempts ?? 0,
    1,
    `the faulted first invocation must end at exactly ONE CRM attempt despite the HTTP node's retryOnFail:true/maxTries:3 (got ${state.counters?.crm_attempts})`
  );
  assert.equal(state.counters?.crm_effects ?? 0, 0, 'a pre-commit failure commits ZERO effects');
  const journal = state.crm_attempt_journal ?? [];
  assert.equal(journal.length, 1, 'exactly one journaled attempt — the transport-success fault response triggered no automatic resend');
  assert.equal(journal[0]?.outcome, 'fault_injected', 'the journal records the truthful fault outcome');
  const crmKey = `crmkey_${reviewId}`;
  assert.equal(journal[0]?.key_hash, adminKeyHash(crmKey), 'the attempt journal (admin view) must carry the hashed stable CRM idempotency key — raw keys never appear in admin output (WR-09)');
  const delivery = state.deliveries?.[reviewId];
  assert.equal(delivery?.state, 'retryable', 'the approved delivery stays retryable after the pre-commit failure');
  assert.equal(delivery?.attempts, 1, 'the delivery record counts exactly one attempt');

  // Deliberate, state-observed recovery: the retry happens ONLY after the
  // suite observed the retryable state above — never as a blind client
  // replay after an ambiguous outcome.
  const retried = await postDeliveryRecovery(reviewId);
  if (retried.error) assert.fail(`delivery webhook must be reachable: ${retried.error.message}`);
  assert.equal(retried.status, 200, `the deliberate retry must deliver (got ${retried.status}: ${retried.text})`);
  assert.equal(retried.body?.status, 'delivered', `the retry response must report the delivery (got ${retried.text})`);
  assert.match(String(retried.body?.effect_id), /^crm_/, 'the committed effect id must be surfaced');

  state = await getMockState();
  assert.equal(state.counters?.crm_attempts ?? 0, 2, 'the deliberate retry brings attempts to exactly two');
  assert.equal(state.counters?.crm_effects ?? 0, 1, 'exactly ONE committed effect after failure + retry');
  const retryJournal = state.crm_attempt_journal ?? [];
  assert.deepEqual(
    retryJournal.map((entry) => entry.key_hash),
    [adminKeyHash(crmKey), adminKeyHash(crmKey)],
    'both attempts used the IDENTICAL stable CRM idempotency key (compared through the admin view\'s hashed form — raw keys never appear in admin output, WR-09)'
  );
  assert.deepEqual(
    retryJournal.map((entry) => entry.outcome),
    ['fault_injected', 'committed'],
    'the journal truthfully records the failed attempt then the committed retry'
  );
  assert.equal(state.deliveries?.[reviewId]?.state, 'committed', 'the delivery is committed after the retry');

  // Committed replay: adds neither an attempt nor an effect.
  const replay = await postDeliveryRecovery(reviewId);
  if (replay.error) assert.fail(`delivery webhook must be reachable: ${replay.error.message}`);
  assert.equal(replay.status, 200, `committed replay must succeed truthfully (got ${replay.status}: ${replay.text})`);
  assert.equal(replay.body?.status, 'already_delivered', `committed replay returns the existing sanitized delivery (got ${replay.text})`);
  assert.match(String(replay.body?.effect_id), /^crm_/, 'the existing effect id is surfaced');
  assert.ok(!replay.text?.includes(FIXTURE.contact.email), 'the replay response must never carry raw contact material');

  state = await getMockState();
  assert.equal(state.counters?.crm_attempts ?? 0, 2, 'committed replay adds no CRM attempt');
  assert.equal(state.counters?.crm_effects ?? 0, 1, 'committed replay adds no CRM effect');
  assert.equal((state.crm_attempt_journal ?? []).length, 2, 'committed replay adds no journal entry');

  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(REVIEWER_PROOF), 'the admin state must never contain the raw one-time proof');
  assertNoRawContactMaterial(state);
});

} // end CASE === 'crm-recovery'
