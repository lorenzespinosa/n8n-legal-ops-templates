// Real-runtime happy-path tracer for the Client Intake Pipeline baseline.
//
// This file is the acceptance driver invoked by `runtime/run-baseline.sh --tracer`
// AFTER that launcher has, in order:
//   1. started the pinned n8n + mock-api Compose project on the internal-only
//      runtime network,
//   2. imported the ephemeral local HTTP Header Auth credential into the same
//      n8n data directory and encryption-key context used for execution,
//   3. imported and activated the derived runtime workflow copy,
//   4. reset the mock state,
// and exported the contract below through environment variables:
//
//   N8N_BASE_URL                  base URL of the real n8n instance (default http://127.0.0.1:5678)
//   MOCK_BASE_URL                 base URL of the local mock service (default http://127.0.0.1:9090)
//   BASELINE_SOURCE_SHA256        SHA-256 of the tracked source workflow recorded before the run
//   BASELINE_IMPORTED_WORKFLOW_ID n8n database id of the imported derived workflow
//
// The test never starts, stops, or substitutes anything. A passing run is
// evidence that the REAL pinned n8n runtime imported the derived graph and
// executed it against the local mocks. If the runtime cannot be reached, the
// first test fails with an explicit assertion — a simulation is never
// acceptable evidence (phase decision D-07).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://127.0.0.1:5678';
const MOCK_BASE_URL = process.env.MOCK_BASE_URL ?? 'http://127.0.0.1:9090';
const WEBHOOK_URL = `${N8N_BASE_URL}/webhook/intake-webhook`;
const SOURCE_WORKFLOW_PATH = path.join(ROOT, 'workflows', 'client-intake-pipeline.json');
const FIXTURE_PATH = path.join(ROOT, 'payloads', 'intake-new-lead.json');

const sha256OfFile = (filePath) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

/**
 * POST the fictional fixture exactly once. The launcher has already waited
 * for the production webhook to register. A timeout, connection reset, or
 * any other fetch error after dispatch has an ambiguous server-side outcome:
 * the request may have executed despite the lost response. Never replay it.
 */
async function postFixtureOnce() {
  const body = readFileSync(FIXTURE_PATH, 'utf8');
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Body shape is asserted explicitly below.
    }
    return { status: response.status, body: parsed, text, error: null };
  } catch (error) {
    return { status: null, body: null, text: null,
      error: new Error(`webhook POST outcome is ambiguous after dispatch (${error.name}: ${error.message}); ` +
        'the server may have accepted and executed it, so no replay is allowed') };
  }
}

async function getMockState() {
  const response = await fetch(`${MOCK_BASE_URL}/admin/state`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, 'mock admin state endpoint must respond');
  return response.json();
}

let tracerResponse = null;

test('real pinned n8n runtime returns 202 for the fictional intake fixture', async () => {
  const importedId = process.env.BASELINE_IMPORTED_WORKFLOW_ID;
  assert.ok(
    importedId && importedId.trim().length > 0,
    'the --tracer launcher must import the derived workflow into real n8n and export BASELINE_IMPORTED_WORKFLOW_ID'
  );

  tracerResponse = await postFixtureOnce();
  if (tracerResponse.error) {
    assert.fail(
      `the real pinned n8n runtime must be running and serve ${WEBHOOK_URL}: ${tracerResponse.error.message}`
    );
  }
  assert.equal(
    tracerResponse.status,
    202,
    `the imported workflow must accept the fictional fixture with 202 (got ${tracerResponse.status}: ${tracerResponse.text})`
  );
  assert.equal(
    tracerResponse.body?.status,
    'accepted',
    'the 202 body must come from the real Respond - Success node'
  );
  assert.ok(
    tracerResponse.body?.review_id,
    'the 202 body must carry the review_id produced by the executed graph'
  );
});

test('mock observes one duplicate lookup, one AI classification, one queue write, at least one CRM write, and no Slack write', async () => {
  assert.ok(tracerResponse, 'the tracer webhook execution must have succeeded first');
  const state = await getMockState();
  const counters = state.counters ?? {};

  assert.equal(
    counters.airtable_contacts_get ?? 0,
    1,
    'exactly one Airtable duplicate lookup must happen on the executed path'
  );
  assert.equal(
    counters.openai_chat_completions_post ?? 0,
    1,
    'exactly one OpenAI classification call must happen on the executed path'
  );
  assert.equal(
    counters.airtable_queue_post ?? 0,
    1,
    'exactly one human-review-queue write must happen (the decorative gate)'
  );
  assert.ok(
    (counters.lawmatics_contacts_post ?? 0) >= 1,
    'the ungated Lawmatics CRM write must be observed at least once (the baseline defect)'
  );
  assert.equal(
    counters.slack_webhook_post ?? 0,
    0,
    'no Slack write may happen for the standard (non-urgent) classification'
  );
  assert.equal(
    counters.airtable_contacts_patch ?? 0,
    0,
    'no duplicate update may happen when the duplicate lookup returns no records'
  );
});

test('mock responses preserve every downstream-consumed field (duplicate envelope and queue RawData reconstruction)', async () => {
  assert.ok(tracerResponse, 'the tracer webhook execution must have succeeded first');
  const fixture = readJson(FIXTURE_PATH);
  const state = await getMockState();
  const calls = state.calls ?? [];

  const duplicateCall = calls.find((call) => call.route === 'airtable_contacts_get');
  assert.ok(duplicateCall, 'the duplicate lookup call must be recorded by the mock');
  const duplicateBody = duplicateCall.response;
  // IF Duplicate reads `records`; Merge AI Classification later reloads this
  // same response by node name as the intake record, so every normalized
  // Validate Fields output must survive here.
  assert.deepEqual(duplicateBody.records, [], 'duplicate lookup must return no records');
  assert.equal(duplicateBody.valid, true, 'duplicate envelope must carry valid');
  assert.deepEqual(duplicateBody.errors, [], 'duplicate envelope must carry errors');
  assert.equal(
    duplicateBody.contact?.email,
    fixture.contact.email,
    'duplicate envelope must carry the normalized contact email'
  );
  assert.equal(
    duplicateBody.contact?.phone,
    fixture.contact.phone,
    'duplicate envelope must carry the normalized E.164 phone'
  );
  assert.equal(
    duplicateBody.contact?.first_name,
    fixture.contact.first_name,
    'duplicate envelope must carry the contact first name'
  );
  assert.equal(
    duplicateBody.case_info?.description,
    fixture.case_info.description,
    'duplicate envelope must carry case_info.description for the OpenAI node expression'
  );
  assert.equal(
    duplicateBody.source,
    fixture.source,
    'duplicate envelope must carry source'
  );
  assert.equal(
    duplicateBody.referral_source,
    fixture.referral_source,
    'duplicate envelope must carry referral_source'
  );
  assert.equal(
    duplicateBody.firm,
    'Greenfield & Associates',
    'duplicate envelope must carry the fictional firm'
  );

  const queueCall = calls.find((call) => call.route === 'airtable_queue_post');
  assert.ok(queueCall, 'the review-queue write must be recorded by the mock');
  const queueBody = queueCall.response;
  assert.ok(queueBody.id, 'queue response must carry its fictional queue record id');
  assert.ok(queueBody.fields, 'queue response must echo the submitted fields object');
  assert.ok(
    queueBody.ai_classification,
    'queue response must reconstruct ai_classification from the parsed RawData'
  );
  assert.equal(
    queueBody.ai_classification?.urgency,
    'standard',
    'queue response must keep the non-urgent classification for IF Urgent'
  );
  assert.equal(
    queueBody.contact?.email,
    fixture.contact.email,
    'queue response must keep contact for the Lawmatics node expressions'
  );
  assert.equal(
    queueBody.source,
    fixture.source,
    'queue response must keep source for the Lawmatics node expressions'
  );
});

test('tracked source workflow SHA-256 is unchanged and the executed copy was the derived import', async () => {
  assert.ok(tracerResponse, 'the tracer webhook execution must have succeeded first');
  const expectedSha = process.env.BASELINE_SOURCE_SHA256;
  assert.ok(
    expectedSha && expectedSha.length === 64,
    'the launcher must record the pre-run SHA-256 of the tracked source workflow'
  );
  const actualSha = sha256OfFile(SOURCE_WORKFLOW_PATH);
  assert.equal(
    actualSha,
    expectedSha,
    'the tracked workflows/client-intake-pipeline.json must be byte-identical before and after the run (D-06)'
  );
  assert.match(
    String(tracerResponse.body?.review_id),
    /^matter_/,
    'review_id must be a fictional matter id produced by the mock through the real graph'
  );
});
