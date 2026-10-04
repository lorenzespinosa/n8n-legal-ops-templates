// Local-only demo state service for the Phase 2 gated Flagship Intake demo.
//
// Serves the staged-intake/review/CRM contracts the gated demo workflows
// touch, with counted journals and PII-free admin output. Zero dependencies:
// Node standard library only, so the pinned cached n8n image can run it via
// a plain `node` entrypoint with no package install (T-02-SC).
//
// Isolation and privacy model (T-02-02, AUDIT-01 posture):
//   - RAW fictional contact material lives in the internal `state.intakes`
//     (keyed by the caller-supplied intake idempotency key), including its
//     persisted copy. It is never exposed through /admin/state — reviews
//     carry sha256 contact hashes and masked identifiers only.
//   - WR-09: every caller-controllable identifier is hashed in the admin/
//     audit surface. The intake idempotency key and the CRM idempotency key
//     are arbitrary caller input (they may be PII-shaped), so the sanitized
//     view exposes only sha256 prefixes (`intake_key_hash`, `key_hash`,
//     `intake_key_hashes`); the masked contact view hashes the first name
//     (the last-name initial stays). Opaque raw keys are also persisted in
//     the internal demo state for idempotency, not in the admin response.
//   - CRM attempts are journaled BEFORE the outcome (counted even when the
//     call fails or is rejected), and CRM effects are counted/deduplicated
//     independently, so "zero attempts" is a measured fact, never inferred
//     from zero saved records.
//   - The demo-state volume contains raw fictional intake payloads and keys.
//     State persists to a dedicated mounted JSON file using the atomic
//     temp-sibling + fsync + rename publication pattern, so it survives
//     workflow retry attempts; mutations are serialized by the single
//     request-handling thread of this process.
//
// All data is fictional Greenfield & Associates material (555 phones,
// example.com addresses). Requests carrying non-fictional contact material
// are rejected with HTTP 400.

import http from 'node:http';
import process from 'node:process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Port resolution (Phase 1 IN-01 lesson): NEVER derive the exported port from
// process.argv — when this module is imported by a test runner, argv positions
// are test file paths. The export comes from the environment; the direct-CLI
// branch below reads its own arguments.
const envPort = Number(process.env.DEMO_MOCK_PORT);
export const DEMO_MOCK_PORT = Number.isFinite(envPort) ? envPort : 9090;
export const DEMO_MOCK_HOST = '0.0.0.0';

const FICTIONAL_FIRM = 'Greenfield & Associates';
const PHONE_555 = /^\+15555\d{6}$/;
const EMAIL_EXAMPLE = /@example\.com$/i;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Deterministic canonical JSON: object keys sorted recursively, arrays kept
 * in order, so the same logical payload always hashes identically regardless
 * of key order at the sender.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The canonical staged-intake projection: exactly the six normalized
 * delivery-relevant fictional fields. Idempotency metadata (the stable intake
 * key and the forwarded payload_hash itself) is deliberately excluded — it is
 * transport material, not delivery content, so it can never change the hash.
 */
const intakeCanonicalProjection = (body) => ({
  contact: body?.contact ?? null,
  case_info: body?.case_info ?? null,
  source: body?.source ?? null,
  referral_source: body?.referral_source ?? null,
  firm: body?.firm ?? null,
  timestamp: body?.timestamp ?? null,
});

/**
 * Canonical intake hash (T-02-09): sha256 over the canonical JSON of the
 * normalized delivery-relevant fields. This is the ONE deterministic
 * canonicalization both the gated intake graph (computed in-graph before the
 * staging call) and this service (authoritative recomputation at the trust
 * boundary) must agree on — stable across JSON object-key order, sensitive
 * to any semantically changed normalized content.
 */
export function canonicalIntakeHash(body) {
  return sha256(canonicalJson(intakeCanonicalProjection(body)));
}

/**
 * Reject non-fictional contact material (project safety constraint). Returns
 * an error string or null when the values are fictional-safe.
 */
export function fictionalViolation({ email, phone, firm } = {}) {
  if (firm !== undefined && firm !== FICTIONAL_FIRM) {
    return `firm must be the fictional "${FICTIONAL_FIRM}" (got ${JSON.stringify(firm)})`;
  }
  if (email != null && email !== '' && !EMAIL_EXAMPLE.test(String(email))) {
    return `email must use the fictional example.com domain (got ${JSON.stringify(email)})`;
  }
  if (phone != null && phone !== '' && !PHONE_555.test(String(phone))) {
    return `phone must use the fictional 555 format +1555555xxxx (got ${JSON.stringify(phone)})`;
  }
  return null;
}

export const freshDemoCounters = () => ({
  review_queue: 0,
  approval_actions: 0,
  crm_attempts: 0,
  crm_effects: 0,
  rejected_nonfictional: 0,
  unknown_routes: 0,
});

const freshState = () => ({
  counters: freshDemoCounters(),
  // idempotency_key -> { canonical_hash, review_id, received_at, payload }
  // RAW fictional contact data is stored here (and persisted when stateFile
  // is configured) — never in admin output.
  intakes: {},
  // PII-free review records and state transitions. `intake_key` stays RAW on
  // the internal persisted record (the delivery lookup needs it) but is
  // replaced by its hash prefix in every admin/audit view (WR-09).
  reviews: [],
  // Per-registration one-time reviewer authorization: ONLY the hash is
  // stored, plus consumption/failure metadata. The raw proof never touches
  // state (T-02-05, T-02-08). `consumed` is set by the first successful
  // decision; replays are rejected. An admin reset invalidates the
  // registration ENTIRELY (WR-06); a new registration is required after
  // reset. Privileged reset can re-register the same raw proof and authorize
  // a later decision: this is one use per registration window, not a durable
  // across-reset capability. The launcher issues a fresh random proof per
  // isolated case; in-suite sub-scenarios re-register their case proof.
  reviewer_proof: null,
  // review_id -> delivery record created ONLY by a recorded approval:
  // { review_id, state: pending|retryable|committed, crm_idempotency_key,
  //   payload_hash, effect_id, attempts }. The stable CRM key is derived from
  // the review id so retries deduplicate effects independently of attempts.
  deliveries: {},
  // Deterministic test-only state corruption (admin fault injection) so the
  // delivery graph's fail-closed classifier can be exercised against
  // malformed/conflicting/garbage states from the real runtime.
  faults: {},
  // Every CRM call outcome, journaled before the outcome is known.
  crm_attempt_journal: [],
  // crm idempotency key -> committed effect record.
  crm_effects: {},
});

function loadPersisted(stateFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (error) {
    throw new Error(`demo state file ${stateFile} is unreadable or malformed: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`demo state file ${stateFile} is not a state object`);
  }
  const state = freshState();
  state.counters = { ...state.counters, ...(parsed.counters ?? {}) };
  state.intakes = parsed.intakes && typeof parsed.intakes === 'object' ? parsed.intakes : {};
  state.reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
  state.reviewer_proof =
    parsed.reviewer_proof && typeof parsed.reviewer_proof === 'object' ? parsed.reviewer_proof : null;
  state.deliveries = parsed.deliveries && typeof parsed.deliveries === 'object' ? parsed.deliveries : {};
  state.faults = parsed.faults && typeof parsed.faults === 'object' ? parsed.faults : {};
  state.crm_attempt_journal = Array.isArray(parsed.crm_attempt_journal) ? parsed.crm_attempt_journal : [];
  state.crm_effects = parsed.crm_effects && typeof parsed.crm_effects === 'object' ? parsed.crm_effects : {};
  return state;
}

/**
 * Atomic publication (Phase 1 evidence pattern): write a temporary sibling,
 * fsync, then rename over the destination. A crash mid-write can never leave
 * a half-written state file under the destination name.
 */
function persistState(stateFile, state) {
  const directory = path.dirname(stateFile);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(stateFile)}.tmp-${process.pid}`);
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const fd = openSync(temporary, 'wx');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, stateFile);
}

const maskedHash = (value) => (value === undefined || value === null || value === '' ? null : sha256(String(value)).slice(0, 16));

/**
 * Create the local demo mock server. Returns { server, state, reset } so
 * contract tests can drive it in-process; the CLI entry below runs it
 * standalone with a persistent state file.
 */
export function createDemoServer({ stateFile = null } = {}) {
  const state = stateFile && existsSync(stateFile) ? loadPersisted(stateFile) : freshState();
  let reviewSeq = state.reviews.length;

  const persist = () => {
    if (stateFile) persistState(stateFile, state);
  };

  const reset = () => {
    state.counters = freshDemoCounters();
    state.intakes = {};
    state.reviews = [];
    state.crm_attempt_journal = [];
    state.crm_effects = {};
    // Reset invalidates the current registration (WR-06), not the raw proof
    // for all time. The same value can be re-registered in a later window;
    // the internal test sub-scenarios do this. No durable tombstone is claimed.
    state.reviewer_proof = null;
    state.deliveries = {};
    state.faults = {};
    reviewSeq = 0;
    persist();
  };

  // WR-09: sanitized admin/audit projection. Caller-controllable identifiers
  // (intake keys, CRM keys) appear ONLY as sha256 prefixes; the masked
  // contact view carries no raw first name. Raw keys and full fictional
  // payloads stay in internal state (including the mounted demo-state JSON),
  // excluded from this sanitized admin output.
  const sanitizeReviewForAdmin = (review) => {
    const { intake_key, ...rest } = review;
    return { ...rest, intake_key_hash: maskedHash(intake_key) };
  };
  const sanitizedState = () => ({
    counters: { ...state.counters },
    reviews: state.reviews.map(sanitizeReviewForAdmin),
    reviewer_proof: structuredClone(state.reviewer_proof),
    deliveries: structuredClone(state.deliveries),
    faults: structuredClone(state.faults),
    crm_attempt_journal: state.crm_attempt_journal.map(({ key, ...entry }) => ({ ...entry, key_hash: maskedHash(key) })),
    crm_effects: Object.fromEntries(
      Object.entries(state.crm_effects).map(([key, { key: _rawKey, ...effect }]) => [
        maskedHash(key),
        { ...effect, key_hash: maskedHash(key) },
      ])
    ),
    intake_key_hashes: Object.keys(state.intakes).map((key) => maskedHash(key)),
  });

  const server = http.createServer((req, res) => {
    req.on('error', () => {
      try {
        res.destroy();
      } catch {}
    });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'mock-api'}`);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = { _raw: rawBody };
        }
      }
      const request = { method: req.method, path: url.pathname, body };
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };
      const fail = (status, message, route) => {
        if (route === 'rejected_nonfictional' || route === 'unknown_routes') {
          state.counters[route] = (state.counters[route] ?? 0) + 1;
          persist();
        }
        // `code` mirrors the HTTP status into the body so graphs that route
        // on the parsed response (neverError) can answer truthfully.
        send(status, { error: message, code: status });
      };

      try {
        dispatch(request, send, fail);
      } catch (error) {
        send(500, { error: `demo mock handler error: ${error.message}` });
      }
    });
  });

  function dispatch(request, send, fail) {
    const { method, path: routePath, body } = request;

    // ---- admin routes --------------------------------------------------
    if (method === 'GET' && routePath === '/admin/health') {
      return send(200, { status: 'ok' });
    }
    if (method === 'POST' && routePath === '/admin/reset') {
      reset();
      return send(200, { status: 'reset', counters: { ...state.counters } });
    }
    if (method === 'GET' && routePath === '/admin/state') {
      return send(200, sanitizedState());
    }

    // ---- internal admin: register a per-window reviewer proof ------------
    // Receives the RAW proof over the in-network wire and stores ONLY its
    // SHA-256 plus metadata. The hash is the sanctioned audit form; the raw
    // value is never persisted or exposed (T-02-05/T-02-08).
    if (method === 'POST' && routePath === '/admin/reviewer-proof') {
      const proof = typeof body?.proof === 'string' ? body.proof : '';
      if (proof.trim().length < 16) {
        return fail(400, 'reviewer proof must be a non-empty string of at least 16 characters');
      }
      state.reviewer_proof = {
        hash: sha256(proof),
        registered_at: new Date().toISOString(),
        consumed: null,
        failed_attempts: 0,
        last_failure: null,
      };
      persist();
      return send(200, { status: 'registered', proof_hash: state.reviewer_proof.hash });
    }

    // ---- staged intake: validate, deduplicate, create pending review ----
    if (method === 'POST' && routePath === '/demo/v1/intakes') {
      const key = typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
      if (!key) {
        return fail(400, 'idempotency_key is required for every staged intake');
      }
      const violation = fictionalViolation({
        email: body?.contact?.email,
        phone: body?.contact?.phone,
        firm: body?.firm,
      });
      if (violation) {
        return fail(400, `non-fictional data rejected: ${violation}`, 'rejected_nonfictional');
      }

      // Trust boundary (T-02-09): the intake graph MUST compute and forward
      // the canonical payload hash, and it must equal this service's own
      // authoritative recomputation over the received normalized content.
      // Missing or mismatched hashes fail closed — staged content whose
      // integrity cannot be proven is never queued.
      const clientHash = typeof body?.payload_hash === 'string' ? body.payload_hash.trim().toLowerCase() : '';
      if (!clientHash) {
        return fail(400, 'payload_hash is required — the intake graph must compute and forward the canonical payload hash with the stable intake key');
      }
      if (!/^[0-9a-f]{64}$/.test(clientHash)) {
        return fail(400, 'payload_hash must be a lowercase hex sha256 digest');
      }
      const canonicalHash = canonicalIntakeHash(body);
      if (clientHash !== canonicalHash) {
        return fail(
          400,
          'payload_hash mismatch — the forwarded canonical hash does not match the authoritative recomputation over the received content; staging fails closed'
        );
      }

      const existing = state.intakes[key];
      if (existing) {
        if (existing.canonical_hash === canonicalHash) {
          const review = state.reviews.find((candidate) => candidate.review_id === existing.review_id);
          return send(200, {
            status: 'replay',
            review_id: existing.review_id,
            review_state: review?.state ?? 'unknown',
          });
        }
        return send(409, {
          error:
            'idempotency key conflict: this key already staged a different canonical payload — a duplicate request is never approval and never a second review',
          // `code` mirrors the HTTP status into the body (same contract as
          // fail()) so the intake graph's interpret branch can classify the
          // conflict truthfully from the parsed neverError response.
          code: 409,
        });
      }

      reviewSeq += 1;
      const reviewId = `rev_${String(reviewSeq).padStart(5, '0')}`;
      const now = new Date().toISOString();
      state.reviews.push({
        review_id: reviewId,
        intake_key: key,
        state: 'pending',
        urgency: body?.case_info?.urgency ?? 'unknown',
        case_type: body?.case_info?.type ?? 'unknown',
        contact_email_hash: maskedHash(body?.contact?.email),
        contact_phone_hash: maskedHash(body?.contact?.phone),
        // WR-09: the masked contact view carries NO raw first name — only
        // its hash prefix plus the last-name initial.
        contact_masked: body?.contact
          ? `${maskedHash(body.contact.first_name) ?? '?'} ${String(body.contact.last_name ?? '?').slice(0, 1)}.`
          : null,
        created_at: now,
        transitions: [{ at: now, from: null, to: 'pending', by: 'intake', detail: 'staged by gated intake webhook' }],
      });
      state.intakes[key] = {
        canonical_hash: canonicalHash,
        review_id: reviewId,
        received_at: now,
        payload: {
          contact: body?.contact ?? null,
          case_info: body?.case_info ?? null,
          source: body?.source ?? null,
          referral_source: body?.referral_source ?? null,
          firm: body?.firm ?? null,
          timestamp: body?.timestamp ?? null,
        },
      };
      state.counters.review_queue += 1;
      persist();
      return send(201, { status: 'staged', review_id: reviewId, review_state: 'pending' });
    }

    // ---- reviewer decision: the ONLY transition out of pending ------------
    // Approval and rejection are separate, deliberate reviewer events. Every
    // failure mode — malformed body, bad decision enum, missing/wrong/replayed
    // one-time proof, unknown review, conflicting re-decision — records NO
    // decision and consumes nothing. Queueing can never reach this route.
    if (method === 'POST' && routePath === '/demo/v1/reviews/decision') {
      if (body === null || typeof body !== 'object' || Array.isArray(body) || body._raw !== undefined) {
        return fail(400, 'malformed decision body — a decision must be a JSON object');
      }
      const reviewId = typeof body.review_id === 'string' ? body.review_id.trim() : '';
      const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
      const proof = typeof body.reviewer_proof === 'string' ? body.reviewer_proof : '';
      if (!reviewId) {
        return fail(400, 'review_id is required');
      }
      if (decision !== 'approve' && decision !== 'reject') {
        return fail(400, 'decision must be exactly "approve" or "reject" — no other value can be recorded');
      }

      const recordProofFailure = (outcome) => {
        state.reviewer_proof.failed_attempts += 1;
        state.reviewer_proof.last_failure = { at: new Date().toISOString(), outcome };
        persist();
      };
      if (!state.reviewer_proof) {
        return fail(401, 'no reviewer authorization is registered for this run — decisions are impossible');
      }
      if (!proof) {
        recordProofFailure('missing');
        return fail(401, 'missing one-time reviewer authorization');
      }
      if (sha256(proof) !== state.reviewer_proof.hash) {
        recordProofFailure('wrong');
        return fail(401, 'wrong one-time reviewer authorization');
      }
      if (state.reviewer_proof.consumed) {
        recordProofFailure('replayed');
        return fail(401, 'the one-time reviewer authorization was already used — replay is rejected');
      }

      const review = state.reviews.find((candidate) => candidate.review_id === reviewId);
      if (!review) {
        return fail(404, `unknown review id ${JSON.stringify(reviewId)} — no decision recorded`);
      }
      if (review.state !== 'pending') {
        return fail(409, `review ${reviewId} is already ${review.state} — conflicting decisions fail closed`);
      }

      const now = new Date().toISOString();
      const to = decision === 'approve' ? 'approved' : 'rejected';
      review.state = to;
      review.transitions.push({
        at: now,
        from: 'pending',
        to,
        by: 'reviewer',
        detail: `decision=${decision} proof=consumed proof_hash_prefix=${state.reviewer_proof.hash.slice(0, 12)}`,
      });
      // Approval increments a dedicated counter INDEPENDENT of review_queue:
      // queueing a review is never approval, and rejection is never an
      // approval action. Approval alone also creates the PENDING delivery
      // record — delivery state exists only after this recorded transition,
      // and its stable CRM idempotency key is derived from the review id.
      if (decision === 'approve') {
        state.counters.approval_actions += 1;
        const intake = state.intakes[review.intake_key];
        state.deliveries[reviewId] = {
          review_id: reviewId,
          state: 'pending',
          crm_idempotency_key: `crmkey_${reviewId}`,
          payload_hash: intake?.canonical_hash ?? null,
          effect_id: null,
          attempts: 0,
        };
      }
      state.reviewer_proof.consumed = { at: now, review_id: reviewId, decision };
      persist();
      return send(200, {
        status: 'recorded',
        review_id: reviewId,
        review_state: to,
        decision,
        approval_actions: state.counters.approval_actions,
      });
    }

    // ---- delivery state: what the approved-delivery graph loads ----------
    // Read-only view for the delivery workflow's classifier/assertion. The
    // RAW fictional payload is included ONLY for an approved review with a
    // pending/retryable delivery — an information-disclosure boundary, not an
    // approval gate: the load-bearing approval assertion lives INSIDE the
    // n8n graph, and the CRM attempt boundary is counted at the CRM route
    // regardless of what this route returns.
    if (method === 'POST' && routePath === '/demo/v1/delivery/state') {
      const reviewId = typeof body?.review_id === 'string' ? body.review_id.trim() : '';
      if (!reviewId) {
        return fail(400, 'review_id is required to load delivery state');
      }
      if (state.faults[reviewId] === 'garbage_state_response') {
        // Deterministic malformed response for the state/expression-error
        // tamper cases: a well-formed contract is absent on purpose.
        return send(200, { garbage: true });
      }
      const review = state.reviews.find((candidate) => candidate.review_id === reviewId);
      if (!review) {
        return send(200, { review: null, delivery: null, payload: null });
      }
      let approval = null;
      if (review.state === 'approved') {
        const transition = review.transitions.find(
          (candidate) => candidate.to === 'approved' && candidate.by === 'reviewer'
        );
        approval = transition
          ? { recorded: true, action: 'approve', by: 'reviewer', at: transition.at }
          : null;
      }
      const delivery = state.deliveries[reviewId] ?? null;
      const includePayload =
        approval !== null &&
        delivery !== null &&
        (delivery.state === 'pending' || delivery.state === 'retryable');
      const intake = state.intakes[review.intake_key];
      return send(200, {
        review: {
          review_id: review.review_id,
          state: review.state,
          approval,
        },
        delivery,
        payload: includePayload ? intake?.payload ?? null : null,
      });
    }

    // ---- admin fault injection: deterministic test-only corruption -------
    if (method === 'POST' && routePath === '/admin/fault-inject') {
      const reviewId = typeof body?.review_id === 'string' ? body.review_id.trim() : '';
      const mode = typeof body?.mode === 'string' ? body.mode : '';
      const allowed = [
        'malformed_review_state',
        'conflicting_approval',
        'garbage_state_response',
        'crm_precommit_failure',
        'clear',
      ];
      if (!reviewId || !allowed.includes(mode)) {
        return fail(400, `fault injection requires review_id and one mode of ${allowed.join(', ')}`);
      }
      if (mode === 'clear') {
        delete state.faults[reviewId];
        persist();
        return send(200, { status: 'cleared', review_id: reviewId });
      }
      const review = state.reviews.find((candidate) => candidate.review_id === reviewId);
      if (!review) {
        return fail(404, `unknown review id ${JSON.stringify(reviewId)} — nothing to corrupt`);
      }
      if (mode === 'malformed_review_state') {
        review.state = 'corrupted-malformed';
      }
      if (mode === 'conflicting_approval') {
        // Forged approved state WITHOUT the separately recorded reviewer
        // approval — exactly the bypass the in-graph assertion must kill.
        review.state = 'approved';
        review.transitions = review.transitions.filter(
          (candidate) => !(candidate.to === 'approved' && candidate.by === 'reviewer')
        );
      }
      state.faults[reviewId] = mode;
      persist();
      return send(200, { status: 'injected', review_id: reviewId, mode });
    }
    // ---- CRM boundary: attempts journaled before outcome, effects counted
    // independently (the counted safety boundary — no Phase 2 intake path may
    // ever reach this route before an explicit reviewer approval) ----------
    if (method === 'POST' && routePath === '/demo/v1/crm/contacts') {
      const key = typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
      const at = new Date().toISOString();
      state.counters.crm_attempts += 1;
      const journalEntry = { at, key: key || null, outcome: null };
      state.crm_attempt_journal.push(journalEntry);
      // Delivery linkage: when the stable CRM key belongs to a delivery
      // record, its attempt count and committed state track this call so the
      // graph's committed-replay branch reflects real effect history.
      const deliveryEntry = key
        ? Object.values(state.deliveries).find((candidate) => candidate.crm_idempotency_key === key)
        : null;
      if (deliveryEntry) deliveryEntry.attempts += 1;

      const violation = fictionalViolation({ email: body?.email, phone: body?.phone });
      if (violation) {
        journalEntry.outcome = 'rejected_nonfictional';
        persist();
        return fail(400, `non-fictional data rejected: ${violation}`, 'rejected_nonfictional');
      }

      // Deterministic one-shot pre-commit failure injection (test-only). The
      // attempt is already journaled above; NO effect is committed. The
      // response is deliberately a TRANSPORT SUCCESS carrying an explicit
      // application failure (committed:false, retryable:true,
      // fault_injected:true) so the CRM HTTP node's retryOnFail/maxTries
      // policy sees no transport or status error and never resends — the
      // first invocation ends at exactly attempts=1/effects=0. Only a
      // separate deliberate delivery invocation, reusing the same stable CRM
      // idempotency key, may append attempt 2 and commit the one effect.
      if (
        key &&
        deliveryEntry &&
        state.faults[deliveryEntry.review_id] === 'crm_precommit_failure' &&
        !Object.hasOwn(state.crm_effects, key)
      ) {
        delete state.faults[deliveryEntry.review_id]; // one-shot: cleared after firing
        deliveryEntry.state = 'retryable';
        journalEntry.outcome = 'fault_injected';
        persist();
        return send(200, {
          status: 'fault_injected',
          committed: false,
          retryable: true,
          fault_injected: true,
          review_id: deliveryEntry.review_id,
        });
      }

      if (key && Object.hasOwn(state.crm_effects, key)) {
        journalEntry.outcome = 'replay';
        persist();
        return send(200, { status: 'exists', effect: state.crm_effects[key], review_id: deliveryEntry?.review_id ?? null });
      }

      state.counters.crm_effects += 1;
      const effect = { effect_id: `crm_${String(state.counters.crm_effects).padStart(5, '0')}`, at, key: key || null };
      if (key) state.crm_effects[key] = effect;
      if (deliveryEntry) {
        deliveryEntry.state = 'committed';
        deliveryEntry.effect_id = effect.effect_id;
      }
      journalEntry.outcome = 'committed';
      persist();
      return send(201, { status: 'committed', effect, review_id: deliveryEntry?.review_id ?? null });
    }

    return fail(404, `unrecognized route ${method} ${routePath}`, 'unknown_routes');
  }

  return { server, state, reset };
}

// CLI entry: `node server.mjs [stateFile]`
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const stateFile = process.argv[2] && process.argv[2].length > 0 ? process.argv[2] : null;
  const { server } = createDemoServer({ stateFile });
  server.listen(DEMO_MOCK_PORT, DEMO_MOCK_HOST, () => {
    process.stdout.write(
      `demo mock-api listening on ${DEMO_MOCK_HOST}:${DEMO_MOCK_PORT}${stateFile ? ` (state: ${stateFile})` : ' (ephemeral in-memory state)'}\n`
    );
  });
}
