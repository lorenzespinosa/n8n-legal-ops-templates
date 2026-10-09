// Dependency-free mock/state contracts for the Phase 2 gated demo (plan 02-03).
//
// These tests drive runtime/demo/mocks/server.mjs IN-PROCESS (ephemeral
// loopback port, Node standard library only — no package install per T-02-SC,
// no Docker) and pin the exact state-machine, idempotency, privacy, and
// failure-injection contracts the real-runtime e2e cases rely on:
//
//   - canonical intake hashing: one deterministic canonicalization over the
//     normalized delivery-relevant fictional fields — stable across JSON
//     object-key order, sensitive to semantically changed content;
//   - stable intake key + canonical hash: exact replay atomically returns the
//     original review with NO new queue/approval/CRM attempt/CRM effect;
//   - same key + different canonical hash: explicit 409 conflict, fail closed,
//     zero mutation of review/approval/delivery counts;
//   - the staged-intake route REQUIRES the graph-supplied canonical payload
//     hash and fails closed when it is missing or does not match the
//     server-side recomputation;
//   - sanitized audit surface: reviews/transitions/admin output never carry
//     raw fixture email/phone or reviewer proof material;
//   - /admin/reset clears every review, transition, proof consumption,
//     attempt, effect, and failure-injection record;
//   - the fictional-data guard rejects non-fictional contact material before
//     any queue or CRM write is counted.
//
// Every assertion here is a deterministic unit of the counted invariants the
// launcher asserts after the real pinned n8n run — mock-only GREEN is never
// sufficient evidence on its own (see runtime/tests/gated.e2e.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'payloads', 'intake-new-lead.json'), 'utf8'));

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Independent local reimplementation of the DOCUMENTED canonical projection —
// the six normalized delivery-relevant fields, keys sorted recursively — so
// the contract tests derive the expected hash without trusting the module
// under test.
const canonicalJsonLocal = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonLocal).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonLocal(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};
const documentedProjection = (body) => ({
  contact: body.contact ?? null,
  case_info: body.case_info ?? null,
  source: body.source ?? null,
  referral_source: body.referral_source ?? null,
  firm: body.firm ?? null,
  timestamp: body.timestamp ?? null,
});
const documentedHash = (body) => sha256(canonicalJsonLocal(documentedProjection(body)));

// Load the module lazily so the TDD RED run fails on an explicit assertion
// for the missing export instead of an import crash (Phase 1 pattern).
async function loadDemoServerModule() {
  try {
    return await import('../demo/mocks/server.mjs');
  } catch {
    return null;
  }
}

async function withDemoMock(fn) {
  const mod = await loadDemoServerModule();
  assert.ok(mod && typeof mod.createDemoServer === 'function', 'runtime/demo/mocks/server.mjs must be importable and export createDemoServer');
  const ctx = mod.createDemoServer();
  const { server } = ctx;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, routePath, body) => {
    const response = await fetch(base + routePath, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Callers assert the shapes they need.
    }
    return { status: response.status, body: parsed, text };
  };
  try {
    return await fn({ ...ctx, base, call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The staged-intake request body exactly as the gated intake graph sends it:
// stable key + graph-computed canonical payload hash + normalized fields.
// Pass hash: null to omit payload_hash entirely (the fail-closed negative).
const intakeRequest = (key, body = structuredClone(FIXTURE), hash = documentedHash(body)) => {
  const request = { ...body, idempotency_key: key };
  if (hash !== null) request.payload_hash = hash;
  return request;
};

// Same fixture with every object's keys inserted in a different order — the
// canonical hash must be invariant to this transport-level noise.
const shuffledFixture = () => ({
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
});

test('canonical intake hash is stable across JSON key order, sensitive to changed content, and matches the documented projection', async () => {
  const mod = await loadDemoServerModule();
  assert.ok(
    mod && typeof mod.canonicalIntakeHash === 'function',
    'runtime/demo/mocks/server.mjs must export canonicalIntakeHash — one deterministic canonicalization over the normalized delivery-relevant intake fields'
  );

  const orderedHash = mod.canonicalIntakeHash(structuredClone(FIXTURE));
  const shuffledHash = mod.canonicalIntakeHash(shuffledFixture());
  assert.equal(
    shuffledHash,
    orderedHash,
    'the canonical hash must be identical for the same logical payload regardless of JSON object-key order'
  );

  const changed = structuredClone(FIXTURE);
  changed.case_info.description = 'Different fictional incident description — semantically changed content';
  assert.notEqual(
    mod.canonicalIntakeHash(changed),
    orderedHash,
    'the canonical hash must change when normalized delivery-relevant content changes'
  );

  const changedPhone = structuredClone(FIXTURE);
  changedPhone.contact.phone = '+15555559999';
  assert.notEqual(
    mod.canonicalIntakeHash(changedPhone),
    orderedHash,
    'the canonical hash must change when the contact phone changes'
  );

  // The hash is exactly sha256(canonicalJson(projection)) — no hidden fields,
  // no omitted delivery-relevant field.
  assert.equal(orderedHash, documentedHash(FIXTURE), 'canonicalIntakeHash must equal the documented projection hash');
  assert.match(orderedHash, /^[0-9a-f]{64}$/, 'the canonical hash must be a hex sha256 digest');
});

test('staged intake requires the graph-supplied canonical payload hash and fails closed on mismatch', async () => {
  await withDemoMock(async ({ call, state }) => {
    const missing = await call('POST', '/demo/v1/intakes', intakeRequest('contract-hash-missing', structuredClone(FIXTURE), null));
    assert.equal(
      missing.status,
      400,
      `staging without the graph-computed payload hash must fail closed with 400 (got ${missing.status}: ${missing.text})`
    );
    assert.equal(state.counters.review_queue, 0, 'no review may be queued when the payload hash is missing');

    const wrong = await call('POST', '/demo/v1/intakes', intakeRequest('contract-hash-wrong', structuredClone(FIXTURE), 'a'.repeat(64)));
    assert.equal(
      wrong.status,
      400,
      `a payload hash that does not match the server-side recomputation must fail closed with 400 (got ${wrong.status}: ${wrong.text})`
    );
    assert.equal(state.counters.review_queue, 0, 'no review may be queued for a mismatched payload hash');

    const honest = await call('POST', '/demo/v1/intakes', intakeRequest('contract-hash-ok'));
    assert.equal(honest.status, 201, `staging with the correct canonical hash must succeed (got ${honest.status}: ${honest.text})`);
    assert.equal(state.counters.review_queue, 1, 'exactly one review is queued for the honest staging');
  });
});

test('exact replay with the same key and canonical hash reuses the review with zero new writes', async () => {
  await withDemoMock(async ({ call, state }) => {
    const first = await call('POST', '/demo/v1/intakes', intakeRequest('contract-replay'));
    assert.equal(first.status, 201, `initial staging must succeed (got ${first.status}: ${first.text})`);
    const reviewId = first.body?.review_id;
    assert.match(String(reviewId), /^rev_/, 'staging must return the review id');

    const replay = await call('POST', '/demo/v1/intakes', intakeRequest('contract-replay', shuffledFixture()));
    assert.equal(replay.status, 200, `exact replay must be a non-error reuse (got ${replay.status}: ${replay.text})`);
    assert.equal(replay.body?.status, 'replay', 'the replay response must be explicitly marked as a replay');
    assert.equal(replay.body?.review_id, reviewId, 'the replay must return the ORIGINAL review id');
    assert.equal(replay.body?.review_state, 'pending', 'the replay must surface the current review state');

    assert.equal(state.counters.review_queue, 1, 'exact replay must not queue a second review');
    assert.equal(state.counters.approval_actions, 0, 'a duplicate request is never an approval');
    assert.equal(state.counters.crm_attempts, 0, 'exact replay must produce zero CRM attempts');
    assert.equal(state.counters.crm_effects, 0, 'exact replay must produce zero CRM effects');
    assert.equal(state.reviews.length, 1, 'exactly one review record exists after the replay');
    assert.equal(state.reviews[0].transitions.length, 1, 'replay adds no review transition');
  });
});

test('same intake key with different canonical content returns 409 and mutates nothing', async () => {
  await withDemoMock(async ({ call, state }) => {
    const first = await call('POST', '/demo/v1/intakes', intakeRequest('contract-conflict'));
    assert.equal(first.status, 201, `initial staging must succeed (got ${first.status}: ${first.text})`);
    const reviewId = first.body?.review_id;

    const changed = structuredClone(FIXTURE);
    changed.case_info.description = 'Conflicting fictional content under the same idempotency key';
    const conflict = await call('POST', '/demo/v1/intakes', intakeRequest('contract-conflict', changed));
    assert.equal(
      conflict.status,
      409,
      `same key + different canonical hash must fail closed with 409 (got ${conflict.status}: ${conflict.text})`
    );
    assert.ok(
      typeof conflict.body?.error === 'string' && conflict.body.error.length > 0,
      'the conflict response must carry an explicit error message'
    );

    assert.equal(state.counters.review_queue, 1, 'the conflict must not queue anything');
    assert.equal(state.counters.approval_actions, 0, 'the conflict must not approve anything');
    assert.equal(state.counters.crm_attempts, 0, 'the conflict must produce zero CRM attempts');
    assert.equal(state.counters.crm_effects, 0, 'the conflict must produce zero CRM effects');
    assert.equal(state.reviews.length, 1, 'no second review record may exist');
    assert.equal(state.reviews[0].state, 'pending', 'the original review must remain pending');
    assert.equal(state.reviews[0].review_id, reviewId, 'the original review identity is unchanged');
  });
});

test('audit surface exposes no raw contact material or reviewer proof values', async () => {
  await withDemoMock(async ({ call, state }) => {
    const proof = 'contract-only-reviewer-proof-0123456789abcdef';
    const registered = await call('POST', '/admin/reviewer-proof', { proof });
    assert.equal(registered.status, 200, 'proof registration must succeed');

    // Duplicate, urgent, invalid, and conflict transitions all leave only
    // sanitized evidence behind.
    const staged = await call('POST', '/demo/v1/intakes', intakeRequest('contract-privacy'));
    const reviewId = staged.body?.review_id;
    const replay = await call('POST', '/demo/v1/intakes', intakeRequest('contract-privacy'));
    assert.equal(replay.status, 200, 'replay before the privacy scan');

    const admin = await call('GET', '/admin/state');
    const serialized = JSON.stringify(admin.body);
    assert.ok(!serialized.includes(FIXTURE.contact.email), 'admin state must never contain the raw fixture email');
    assert.ok(!serialized.includes(FIXTURE.contact.phone), 'admin state must never contain the raw fixture phone');
    assert.ok(!serialized.includes(proof), 'admin state must never contain the raw reviewer proof');

    // The live in-process state carries the same guarantee for transitions.
    const stateSerialized = JSON.stringify(state.reviews);
    assert.ok(!stateSerialized.includes(FIXTURE.contact.email), 'review transitions must never contain the raw fixture email');
    assert.ok(!stateSerialized.includes(FIXTURE.contact.phone), 'review transitions must never contain the raw fixture phone');

    // A reviewer transition (approve) must also stay PII/proof-free.
    const approved = await call('POST', '/demo/v1/reviews/decision', {
      review_id: reviewId,
      decision: 'approve',
      reviewer_proof: proof,
    });
    assert.equal(approved.status, 200, `approval must be recorded (got ${approved.status}: ${approved.text})`);
    const after = JSON.stringify(await call('GET', '/admin/state'));
    assert.ok(!after.includes(FIXTURE.contact.email), 'post-approval admin state must never contain the raw fixture email');
    assert.ok(!after.includes(FIXTURE.contact.phone), 'post-approval admin state must never contain the raw fixture phone');
    assert.ok(!after.includes(proof), 'post-approval admin state must never contain the raw reviewer proof');
  });
});

test('admin reset clears every review, transition, proof use, attempt, effect, and fault record', async () => {  await withDemoMock(async ({ call, state }) => {
    const proof = 'contract-reset-reviewer-proof-0123456789abcdef';
    await call('POST', '/admin/reviewer-proof', { proof });

    const staged = await call('POST', '/demo/v1/intakes', intakeRequest('contract-reset'));
    const reviewId = staged.body?.review_id;
    const approved = await call('POST', '/demo/v1/reviews/decision', {
      review_id: reviewId,
      decision: 'approve',
      reviewer_proof: proof,
    });
    assert.equal(approved.status, 200, 'approval must be recorded before the reset');

    // A CRM attempt + committed effect through the counted boundary.
    const crm = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: `crmkey_${reviewId}`,
      email: FIXTURE.contact.email,
      phone: FIXTURE.contact.phone,
    });
    assert.equal(crm.status, 201, `the CRM boundary must commit the effect (got ${crm.status}: ${crm.text})`);

    // A fault-injection record.
    const staged2 = await call('POST', '/demo/v1/intakes', intakeRequest('contract-reset-2'));
    const faulted = await call('POST', '/admin/fault-inject', { review_id: staged2.body?.review_id, mode: 'malformed_review_state' });
    assert.equal(faulted.status, 200, 'fault injection must be accepted');

    const reset = await call('POST', '/admin/reset');
    assert.equal(reset.status, 200, 'admin reset must succeed');

    const counters = state.counters;
    for (const [name, value] of Object.entries(counters)) {
      assert.equal(value, 0, `counter ${name} must be zero after reset (got ${value})`);
    }
    assert.deepEqual(state.reviews, [], 'every review record must be cleared');
    assert.deepEqual(state.crm_attempt_journal, [], 'every CRM attempt journal entry must be cleared');
    assert.deepEqual(state.crm_effects, {}, 'every committed CRM effect must be cleared');
    assert.deepEqual(state.deliveries, {}, 'every delivery record must be cleared');
    assert.deepEqual(state.faults, {}, 'every failure-injection record must be cleared');
    assert.deepEqual(Object.keys(state.intakes), [], 'every raw intake payload must be cleared');
    assert.equal(
      state.reviewer_proof,
      null,
      'reset must invalidate the current registration entirely — the old proof is refused until another registration window opens (WR-06)'
    );
  });
});

test('WR-06: an admin reset invalidates the registered one-time proof — the old raw proof is refused, a newly registered proof succeeds exactly once', async () => {
  await withDemoMock(async ({ call, state }) => {
    const firstProof = 'wr06-consume-reviewer-proof-0123456789abcdef';
    const registered = await call('POST', '/admin/reviewer-proof', { proof: firstProof });
    assert.equal(registered.status, 200, 'initial proof registration must succeed');

    const staged = await call('POST', '/demo/v1/intakes', intakeRequest('wr06-consume'));
    const firstReviewId = staged.body?.review_id;
    const consumed = await call('POST', '/demo/v1/reviews/decision', {
      review_id: firstReviewId,
      decision: 'approve',
      reviewer_proof: firstProof,
    });
    assert.equal(consumed.status, 200, `the first proof must authorize exactly its one decision (got ${consumed.status}: ${consumed.text})`);

    // The reset every isolated case (and every in-suite sub-scenario) runs.
    const reset = await call('POST', '/admin/reset');
    assert.equal(reset.status, 200, 'admin reset must succeed');

    // The OLD raw proof must now be REFUSED: the measured one-time scope is
    // per registration window, not lifetime uniqueness across reset and
    // explicit re-registration.
    const restaged = await call('POST', '/demo/v1/intakes', intakeRequest('wr06-restaged'));
    const secondReviewId = restaged.body?.review_id;
    const oldProof = await call('POST', '/demo/v1/reviews/decision', {
      review_id: secondReviewId,
      decision: 'approve',
      reviewer_proof: firstProof,
    });
    assert.notEqual(
      oldProof.status,
      200,
      `the old raw proof must be refused before any post-reset re-registration (got ${oldProof.status}: ${oldProof.text})`
    );
    assert.equal(state.counters.approval_actions, 0, 'the post-reset refusal must not record any approval action (the reset zeroed the counters; the refused old proof must keep them zero)');
    const secondReview = state.reviews.find((candidate) => candidate.review_id === secondReviewId);
    assert.equal(secondReview?.state, 'pending', 'the post-reset refusal must leave the newly staged review pending');

    // A NEWLY registered cryptographically fresh proof succeeds — exactly once.
    const secondProof = 'wr06-fresh-reviewer-proof-0123456789abcdef';
    const reregistered = await call('POST', '/admin/reviewer-proof', { proof: secondProof });
    assert.equal(reregistered.status, 200, 'fresh proof registration after a reset must succeed');
    const approved = await call('POST', '/demo/v1/reviews/decision', {
      review_id: secondReviewId,
      decision: 'approve',
      reviewer_proof: secondProof,
    });
    assert.equal(approved.status, 200, `the fresh proof must authorize its one decision (got ${approved.status}: ${approved.text})`);
    const replayed = await call('POST', '/demo/v1/reviews/decision', {
      review_id: secondReviewId,
      decision: 'approve',
      reviewer_proof: secondProof,
    });
    assert.notEqual(replayed.status, 200, 'the fresh proof must be consumed by its one successful decision — replay is refused');
  });
});

test('WR-06: reset permits a new registration window and raw proof reuse', async () => {
  await withDemoMock(async ({ call }) => {
    const proof = 'wr06-window-reuse-reviewer-proof-0123456789abcdef';
    const first = await call('POST', '/admin/reviewer-proof', { proof });
    assert.equal(first.status, 200);
    const staged = await call('POST', '/demo/v1/intakes', intakeRequest('wr06-window-a'));
    const decision = await call('POST', '/demo/v1/reviews/decision', {
      review_id: staged.body?.review_id, decision: 'approve', reviewer_proof: proof,
    });
    assert.equal(decision.status, 200, 'the first registration permits one decision');
    assert.equal((await call('POST', '/admin/reset')).status, 200);
    const reregistered = await call('POST', '/admin/reviewer-proof', { proof });
    assert.equal(reregistered.status, 200, 'the privileged reset currently permits re-registering the same raw proof');
    const restaged = await call('POST', '/demo/v1/intakes', intakeRequest('wr06-window-b'));
    const secondDecision = await call('POST', '/demo/v1/reviews/decision', {
      review_id: restaged.body?.review_id, decision: 'approve', reviewer_proof: proof,
    });
    assert.equal(secondDecision.status, 200, 'a second registration window can consume the same raw proof again');
  });
});

test('WR-09: PII-shaped intake keys and first names never appear in the sanitized admin/audit surface', async () => {
  await withDemoMock(async ({ call, state }) => {
    const proof = 'contract-wr09-reviewer-proof-0123456789abcdef';
    await call('POST', '/admin/reviewer-proof', { proof });

    // A PII-shaped caller-supplied idempotency key and a distinctive
    // fictional first name: neither raw string may survive into any
    // serialized admin/audit view.
    const piiKey = 'maria.secretary.personal@example.org';
    const distinctive = structuredClone(FIXTURE);
    distinctive.contact.first_name = 'Qwertyuiopzxcvbn';
    const staged = await call('POST', '/demo/v1/intakes', intakeRequest(piiKey, distinctive));
    assert.equal(staged.status, 201, `the PII-keyed intake must stage (got ${staged.status}: ${staged.text})`);
    const reviewId = staged.body?.review_id;

    // Approve so transitions, deliveries, and accepted evidence exist too.
    const approved = await call('POST', '/demo/v1/reviews/decision', {
      review_id: reviewId,
      decision: 'approve',
      reviewer_proof: proof,
    });
    assert.equal(approved.status, 200, `approval must be recorded (got ${approved.status}: ${approved.text})`);

    const admin = await call('GET', '/admin/state');
    const serialized = JSON.stringify(admin.body);
    assert.ok(
      !serialized.includes(piiKey),
      'the raw PII-shaped intake idempotency key must never appear in the serialized admin state — neither the intake-key listing nor any review record may carry it'
    );
    assert.ok(
      !serialized.includes(distinctive.contact.first_name),
      'the full fictional first name must never appear in the serialized admin state — the masked contact view must hash or drop it'
    );

    const transitions = JSON.stringify((admin.body.reviews ?? []).flatMap((review) => review.transitions ?? []));
    assert.ok(!transitions.includes(piiKey), 'no transition may carry the raw PII-shaped intake key');
    assert.ok(!transitions.includes(distinctive.contact.first_name), 'no transition may carry the raw first name');

    // A PII-shaped CRM idempotency key posted at the counted boundary must
    // not leak into the journaled/effect admin views either.
    const crmPiiKey = 'crm-personal-key-maria.secretary@example.org';
    const crm = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: crmPiiKey,
      email: FIXTURE.contact.email,
      phone: FIXTURE.contact.phone,
    });
    assert.equal(crm.status, 201, `the CRM boundary must commit (got ${crm.status}: ${crm.text})`);
    const after = JSON.stringify((await call('GET', '/admin/state')).body);
    assert.ok(!after.includes(crmPiiKey), 'a PII-shaped CRM idempotency key must never appear in the journaled attempt or effect admin views');
    assert.ok(!after.includes(piiKey), 'the intake key must still be absent after the CRM activity');
    assert.ok(!after.includes(distinctive.contact.first_name), 'the first name must still be absent after the CRM activity');

    // Controls for this in-process, no-state-file test instance: raw keys and
    // the fictional payload remain in RAM. The real Compose mock instead
    // persists its internal state to the disk-backed demo-state volume.
    assert.ok(state.intakes[piiKey], 'the internal intake key must keep driving idempotency');
    assert.equal(
      state.intakes[piiKey]?.payload?.contact?.first_name,
      distinctive.contact.first_name,
      'the isolated delivery store must retain the full fictional payload for approved delivery'
    );
    const replay = await call('POST', '/demo/v1/intakes', intakeRequest(piiKey, distinctive));
    assert.equal(replay.status, 200, 'idempotent replay under the internal key must still work');
    assert.equal(replay.body?.review_id, reviewId, 'the replay must return the original review');
  });
});

test('non-fictional contact material is rejected before any queue or CRM write', async () => {
  await withDemoMock(async ({ call, state }) => {
    const nonFictional = structuredClone(FIXTURE);
    nonFictional.contact.email = 'someone@real-domain.example.org';
    const rejected = await call('POST', '/demo/v1/intakes', intakeRequest('contract-nonfictional', nonFictional));
    assert.equal(
      rejected.status,
      400,
      `non-fictional contact material must be rejected with 400 (got ${rejected.status}: ${rejected.text})`
    );
    assert.equal(state.counters.rejected_nonfictional, 1, 'the rejection is counted on its own counter');
    assert.equal(state.counters.review_queue, 0, 'no review may be queued for non-fictional material');
    assert.equal(state.counters.crm_attempts, 0, 'non-fictional material must produce zero CRM attempts');
    assert.equal(state.counters.crm_effects, 0, 'non-fictional material must produce zero CRM effects');
  });
});

// ---------------------------------------------------------------------------
// WR-02/WR-03: absent contact channels and absent timestamps are legal input
// classes the graphs themselves permit ("need at least one" channel; optional
// timestamp) — they must stage, replay, and deliver truthfully, never be
// falsely rejected as non-fictional or conflict.
// ---------------------------------------------------------------------------

const runGraphNodeCode = (workflowFile, nodeName, inputJson) => {
  const workflow = JSON.parse(readFileSync(path.join(ROOT, 'runtime', 'demo', 'workflows', workflowFile), 'utf8'));
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  assert.ok(node && typeof node.parameters?.jsCode === 'string', `${workflowFile} must carry a Code node "${nodeName}" with jsCode`);
  return new Function('$input', node.parameters.jsCode)({ first: () => ({ json: inputJson }) });
};

test('empty-string and null contact channels are treated as absent, not non-fictional', async () => {
  await withDemoMock(async ({ call }) => {
    // Intake route: phone as '' (what the intake graph used to send when the
    // caller omitted it) must be treated as an absent channel.
    const emailOnly = structuredClone(FIXTURE);
    delete emailOnly.contact.phone;
    const withEmptyPhone = structuredClone(emailOnly);
    withEmptyPhone.contact.phone = '';
    const staged = await call('POST', '/demo/v1/intakes', intakeRequest('contract-empty-phone', withEmptyPhone));
    assert.equal(
      staged.status,
      201,
      `an email-only intake whose absent phone arrives as '' must stage (got ${staged.status}: ${staged.text})`
    );

    // Phone-only intake (email key absent entirely) must stage.
    const phoneOnly = structuredClone(FIXTURE);
    delete phoneOnly.contact.email;
    const stagedPhoneOnly = await call('POST', '/demo/v1/intakes', intakeRequest('contract-phone-only', phoneOnly));
    assert.equal(
      stagedPhoneOnly.status,
      201,
      `a phone-only intake must stage (got ${stagedPhoneOnly.status}: ${stagedPhoneOnly.text})`
    );

    // CRM route: null channels (what the delivery graph used to send for the
    // absent channel) must commit, not 400.
    const crmNullEmail = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: 'crmkey_null_email',
      phone: FIXTURE.contact.phone,
      email: null,
    });
    assert.equal(crmNullEmail.status, 201, `a single-channel CRM body with email:null must commit (got ${crmNullEmail.status}: ${crmNullEmail.text})`);
    const crmNullPhone = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: 'crmkey_null_phone',
      email: FIXTURE.contact.email,
      phone: null,
    });
    assert.equal(crmNullPhone.status, 201, `a single-channel CRM body with phone:null must commit (got ${crmNullPhone.status}: ${crmNullPhone.text})`);

    // Genuinely non-fictional values must STILL be rejected when present.
    const badPhone = await call('POST', '/demo/v1/crm/contacts', { idempotency_key: 'crmkey_bad_phone', phone: '+12125551234' });
    assert.equal(badPhone.status, 400, 'a genuinely non-fictional phone must still be rejected before any commit');
    const badEmail = await call('POST', '/demo/v1/crm/contacts', { idempotency_key: 'crmkey_bad_email', email: 'someone@real-domain.example.org' });
    assert.equal(badEmail.status, 400, 'a genuinely non-fictional email must still be rejected before any commit');
  });
});

test('email-only intake stages through the graph normalization, approves, and delivers over one channel', async () => {
  await withDemoMock(async ({ call, state }) => {
    const proof = 'contract-email-only-proof-0123456789abcdef';
    await call('POST', '/admin/reviewer-proof', { proof });

    const emailOnly = structuredClone(FIXTURE);
    delete emailOnly.contact.phone;
    const graph = runGraphNodeCode('intake-stage.json', 'Validate Intake', {
      body: emailOnly,
      headers: { 'x-intake-idempotency-key': 'contract-email-only' },
    })[0].json;
    assert.equal(graph.valid, true, `an email-only intake is valid graph input (errors: ${JSON.stringify(graph.errors)})`);
    assert.equal(
      typeof graph.contact.phone,
      'undefined',
      "the intake graph must OMIT an absent phone channel entirely — an empty string re-enters the staged body and is falsely rejected as non-fictional"
    );
    const normalized = {
      contact: graph.contact,
      case_info: graph.case_info,
      source: graph.source,
      referral_source: graph.referral_source,
      firm: graph.firm,
      timestamp: graph.timestamp,
    };
    assert.equal(
      graph.payload_hash,
      documentedHash(normalized),
      'the in-graph canonical hash must equal the documented projection over the normalized single-channel body'
    );

    const staged = await call('POST', '/demo/v1/intakes', {
      ...normalized,
      idempotency_key: 'contract-email-only',
      payload_hash: graph.payload_hash,
    });
    assert.equal(staged.status, 201, `the graph-normalized email-only body must stage (got ${staged.status}: ${staged.text})`);
    const reviewId = staged.body?.review_id;

    const approved = await call('POST', '/demo/v1/reviews/decision', { review_id: reviewId, decision: 'approve', reviewer_proof: proof });
    assert.equal(approved.status, 200, `approval must be recorded (got ${approved.status}: ${approved.text})`);

    const deliveryState = await call('POST', '/demo/v1/delivery/state', { review_id: reviewId });
    const asserted = runGraphNodeCode('approved-delivery.json', 'Assert Approved — Delivery State', deliveryState.body)[0].json;
    assert.equal(asserted.idempotency_key, `crmkey_${reviewId}`, 'the assertion must bind the stable CRM key to the review');
    assert.equal(typeof asserted.email, 'string', 'the present channel must cross the CRM boundary');
    assert.equal(
      typeof asserted.phone,
      'undefined',
      'the delivery assertion must OMIT the absent channel from the CRM body — null re-enters as a falsely non-fictional value'
    );

    // Send exactly what the graph would send: undefined channels vanish from
    // the serialized body; null ones (the old shape) must not 400.
    const crm = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: asserted.idempotency_key,
      email: asserted.email,
      phone: asserted.phone,
    });
    assert.equal(crm.status, 201, `a single-channel approved delivery must commit (got ${crm.status}: ${crm.text})`);
    assert.equal(state.counters.crm_effects, 1, 'exactly one CRM effect is committed for the single-channel delivery');
    assert.equal(state.counters.rejected_nonfictional, 0, 'no non-fictional rejection may be recorded for fictional single-channel data');
  });
});

test('a timestamp-less intake normalizes to a stable null timestamp and replays idempotently', async () => {
  await withDemoMock(async ({ call, state }) => {
    const noTimestamp = structuredClone(FIXTURE);
    delete noTimestamp.timestamp;

    const firstRun = runGraphNodeCode('intake-stage.json', 'Validate Intake', {
      body: structuredClone(noTimestamp),
      headers: { 'x-intake-idempotency-key': 'contract-no-timestamp' },
    })[0].json;
    assert.equal(firstRun.valid, true, 'a timestamp-less intake is valid graph input');
    assert.equal(
      firstRun.timestamp,
      null,
      'the graph must normalize an omitted timestamp to null — seeding now() into the canonical payload makes every replay of the same body a content conflict'
    );

    const secondRun = runGraphNodeCode('intake-stage.json', 'Validate Intake', {
      body: structuredClone(noTimestamp),
      headers: { 'x-intake-idempotency-key': 'contract-no-timestamp' },
    })[0].json;
    assert.equal(
      secondRun.payload_hash,
      firstRun.payload_hash,
      'two evaluations of the same timestamp-less body must produce the IDENTICAL canonical hash'
    );

    const normalized = {
      contact: firstRun.contact,
      case_info: firstRun.case_info,
      source: firstRun.source,
      referral_source: firstRun.referral_source,
      firm: firstRun.firm,
      timestamp: firstRun.timestamp,
    };
    const staged = await call('POST', '/demo/v1/intakes', {
      ...normalized,
      idempotency_key: 'contract-no-timestamp',
      payload_hash: firstRun.payload_hash,
    });
    assert.equal(staged.status, 201, `the graph-normalized timestamp-less body must stage (got ${staged.status}: ${staged.text})`);
    const reviewId = staged.body?.review_id;

    const replay = await call('POST', '/demo/v1/intakes', {
      ...normalized,
      idempotency_key: 'contract-no-timestamp',
      payload_hash: firstRun.payload_hash,
    });
    assert.equal(replay.status, 200, `an exact replay of the same timestamp-less body must be a replay, never a 409 conflict (got ${replay.status}: ${replay.text})`);
    assert.equal(replay.body?.status, 'replay', 'the replay response must be explicitly marked as a replay');
    assert.equal(replay.body?.review_id, reviewId, 'the replay must return the ORIGINAL review');
    assert.equal(state.counters.review_queue, 1, 'the replay must not queue a second review');
  });
});

test('a client abort mid-request cannot take the state service down', async () => {
  await withDemoMock(async ({ base, call, server }) => {
    const before = await call('GET', '/admin/health');
    assert.equal(before.status, 200, 'baseline health check before the abort');

    let captured = null;
    const onRequest = (req) => {
      captured = req;
    };
    server.on('request', onRequest);
    try {
      const port = Number(new URL(base).port);
      await new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        sock.on('connect', () => {
          sock.write('POST /demo/v1/intakes HTTP/1.1\r\nHost: mock-api\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"partial":');
        });
        sock.on('error', () => {});
        const kill = setTimeout(() => {
          try {
            sock.resetAndDestroy();
          } catch {
            sock.destroy();
          }
        }, 50);
        sock.on('close', () => {
          clearTimeout(kill);
          resolve();
        });
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(captured, 'the aborted request must have reached the handler');
      assert.ok(
        captured.listenerCount('error') > 0,
        'the mock request handler must attach an error handler to the incoming request stream — one client abort (ECONNRESET) must fail only that request, never the whole state service'
      );
      let threw = null;
      try {
        captured.emit('error', Object.assign(new Error('simulated ECONNRESET'), { code: 'ECONNRESET' }));
      } catch (error) {
        threw = error;
      }
      assert.equal(threw, null, `an error on the request stream must be handled, not thrown (got: ${threw && threw.message})`);
      const after = await call('GET', '/admin/health');
      assert.equal(after.status, 200, 'the state service must still answer after the aborted request');
    } finally {
      server.off('request', onRequest);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 02-03 Task 2: recoverable failure-before-commit on the CRM boundary.
// The counted truth is the attempt/effect pair: a deterministic one-shot
// pre-commit fault yields attempts=1/effects=0 with a retryable delivery;
// only a deliberate same-key retry commits exactly one effect (2/1); a
// committed replay adds neither.
// ---------------------------------------------------------------------------

test('deterministic pre-commit CRM failure journals one attempt, zero effects, and stays retryable as a transport success', async () => {
  await withDemoMock(async ({ call, state }) => {
    const proof = 'contract-fault-reviewer-proof-0123456789abcdef';
    await call('POST', '/admin/reviewer-proof', { proof });
    const staged = await call('POST', '/demo/v1/intakes', intakeRequest('contract-crm-fault'));
    const reviewId = staged.body?.review_id;
    const approved = await call('POST', '/demo/v1/reviews/decision', {
      review_id: reviewId,
      decision: 'approve',
      reviewer_proof: proof,
    });
    assert.equal(approved.status, 200, `approval must be recorded (got ${approved.status}: ${approved.text})`);
    assert.equal(state.deliveries[reviewId]?.state, 'pending', 'approval creates a pending delivery');

    const injected = await call('POST', '/admin/fault-inject', { review_id: reviewId, mode: 'crm_precommit_failure' });
    assert.equal(
      injected.status,
      200,
      `crm_precommit_failure must be an accepted fault mode (got ${injected.status}: ${injected.text})`
    );

    const crmKey = `crmkey_${reviewId}`;
    const faulted = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: crmKey,
      email: FIXTURE.contact.email,
      phone: FIXTURE.contact.phone,
    });
    assert.equal(
      faulted.status,
      200,
      `the injected pre-commit fault must be a TRANSPORT SUCCESS (HTTP 200) so the HTTP node's retryOnFail policy never fires (got ${faulted.status}: ${faulted.text})`
    );
    assert.equal(faulted.body?.fault_injected, true, 'the fault response must be explicitly marked fault_injected');
    assert.equal(faulted.body?.committed, false, 'the fault response must state committed:false');
    assert.equal(faulted.body?.retryable, true, 'the fault response must state retryable:true');

    assert.equal(state.counters.crm_attempts, 1, 'exactly one CRM attempt is journaled for the failed invocation');
    assert.equal(state.counters.crm_effects, 0, 'a pre-commit failure commits ZERO effects');
    assert.equal(state.deliveries[reviewId]?.state, 'retryable', 'the delivery must remain retryable after the fault');
    assert.equal(state.crm_attempt_journal.length, 1, 'exactly one journal entry exists after the fault');
    assert.equal(state.crm_attempt_journal[0]?.outcome, 'fault_injected', 'the journal records the truthful fault outcome');
    assert.equal(state.crm_attempt_journal[0]?.key, crmKey, 'the journal entry carries the stable CRM idempotency key');
    assert.equal(state.faults[reviewId], undefined, 'the fault is one-shot: cleared after firing');
  });
});

test('deliberate same-key retry commits exactly one effect and a further CRM replay adds no effect', async () => {
  await withDemoMock(async ({ call, state }) => {
    const proof = 'contract-retry-reviewer-proof-0123456789abcdef';
    await call('POST', '/admin/reviewer-proof', { proof });
    const staged = await call('POST', '/demo/v1/intakes', intakeRequest('contract-crm-retry'));
    const reviewId = staged.body?.review_id;
    await call('POST', '/demo/v1/reviews/decision', { review_id: reviewId, decision: 'approve', reviewer_proof: proof });
    await call('POST', '/admin/fault-inject', { review_id: reviewId, mode: 'crm_precommit_failure' });

    const crmKey = `crmkey_${reviewId}`;
    const faulted = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: crmKey,
      email: FIXTURE.contact.email,
      phone: FIXTURE.contact.phone,
    });
    assert.equal(faulted.body?.fault_injected, true, 'first invocation fails before commit');

    // The deliberate retry observes the retryable state first — never a
    // blind client replay after an ambiguous outcome.
    assert.equal(state.deliveries[reviewId]?.state, 'retryable', 'retry only after observing retryable state');
    const retried = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: crmKey,
      email: FIXTURE.contact.email,
      phone: FIXTURE.contact.phone,
    });
    assert.equal(retried.status, 201, `the deliberate retry must commit (got ${retried.status}: ${retried.text})`);
    assert.equal(retried.body?.status, 'committed', 'the retry response must report the committed effect');

    assert.equal(state.counters.crm_attempts, 2, 'the retry brings the attempt journal to exactly two');
    assert.equal(state.counters.crm_effects, 1, 'exactly ONE effect exists after the failed attempt plus retry');
    assert.equal(state.deliveries[reviewId]?.state, 'committed', 'the delivery is committed after the retry');
    const keys = state.crm_attempt_journal.map((entry) => entry.key);
    assert.deepEqual(keys, [crmKey, crmKey], 'both attempts used the IDENTICAL stable CRM idempotency key');
    assert.deepEqual(
      state.crm_attempt_journal.map((entry) => entry.outcome),
      ['fault_injected', 'committed'],
      'the journal truthfully records the failed attempt then the committed retry'
    );

    // A further CRM-route replay returns the existing effect and adds no
    // effect (the graph-level committed replay never reaches this route at
    // all — proven by the real-runtime case).
    const replayed = await call('POST', '/demo/v1/crm/contacts', {
      idempotency_key: crmKey,
      email: FIXTURE.contact.email,
      phone: FIXTURE.contact.phone,
    });
    assert.equal(replayed.status, 200, 'a replayed CRM key returns the existing effect');
    assert.equal(replayed.body?.status, 'exists', 'the replay response reports the existing effect');
    assert.equal(state.counters.crm_effects, 1, 'the replay adds no effect');
  });
});
