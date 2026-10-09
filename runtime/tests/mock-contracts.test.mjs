// Contract tests for every route the intake graph can touch (A-02/D-03),
// including branches the standard tracer never executes (Airtable PATCH,
// Slack webhook). Each contract is asserted against the shapes declared in
// the plan's <interfaces> block and the exact downstream expressions that
// consume them — so a missing or malformed field fails here, not at runtime.
//
// These tests drive the mock in-process (ephemeral loopback port, Node
// standard library only — no package install per T-01-SC) and are fully
// deterministic: no Docker, no network beyond 127.0.0.1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createMockServer } from '../mocks/server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'payloads', 'intake-new-lead.json'), 'utf8')
);

// The normalized "Validate Fields" output envelope for the approved fixture
// (phone is already E.164 in the fixture; no nulls to strip). The duplicate
// lookup response must be exactly this envelope plus `records` — because
// "IF Duplicate" reads `records` and "Merge AI Classification" later reloads
// this same response by node name as the intake record.
const INTAKE_ENVELOPE = {
  valid: true,
  errors: [],
  contact: { ...FIXTURE.contact },
  case_info: { ...FIXTURE.case_info },
  source: FIXTURE.source,
  referral_source: FIXTURE.referral_source,
  timestamp: FIXTURE.timestamp,
  firm: FIXTURE.firm,
};

// What "Merge AI Classification" submits to the review queue as RawData:
// the duplicate-lookup response (envelope + records) plus the AI block and
// review flags, with the >=0.8-confidence branch taking 'standard_gate'.
const MERGED_RECORD = {
  records: [],
  ...INTAKE_ENVELOPE,
  ai_classification: {
    case_type: 'personal_injury',
    confidence: 0.87,
    urgency: 'standard',
    summary: 'Rear-end collision with filed police report; documented personal-injury lead.',
  },
  requires_human_review: true,
  review_status: 'pending',
  review_reason: 'standard_gate',
};

const QUEUE_FIELDS = {
  ContactName: 'Maria Rodriguez',
  CaseType: 'personal_injury',
  Confidence: 0.87,
  Urgency: 'standard',
  Status: 'pending_review',
  RawData: JSON.stringify(MERGED_RECORD),
};

const LAWMATICS_BODY = {
  first_name: 'Maria',
  last_name: 'Rodriguez',
  email: 'maria.r@example.com',
  phone: '+15555551234',
  case_type: 'personal_injury',
  source: 'web_form',
  notes: 'Rear-end collision with filed police report; documented personal-injury lead.',
  status: 'new_lead',
};

async function withMock(fn) {
  const ctx = createMockServer();
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

test('GET Contacts (duplicate lookup) returns exactly the normalized intake envelope plus records — the shape IF Duplicate and Merge AI Classification consume', async () => {
  await withMock(async ({ call, state }) => {
    const { status, body } = await call('GET', '/airtable/v0/YOUR_BASE_ID/Contacts');
    assert.equal(status, 200);
    // Exact contract: nothing more, nothing less than records + envelope.
    assert.deepEqual(body, { records: [], ...INTAKE_ENVELOPE });
    // The two downstream consumers, spelled out:
    assert.deepEqual(body.records, [], 'IF Duplicate reads $json.records — must be empty for the new-lead branch');
    assert.equal(
      body.case_info.description,
      FIXTURE.case_info.description,
      'the OpenAI node expression sends $json.case_info.description as the user message'
    );
    assert.equal(state.counters.airtable_contacts_get, 1);
  });
});

test('POST HumanReviewQueue reconstructs the parsed fields.RawData envelope plus its queue id/fields — the shape IF Urgent, Slack, and Lawmatics consume', async () => {
  await withMock(async ({ call, state }) => {
    const { status, body } = await call('POST', '/airtable/v0/YOUR_BASE_ID/HumanReviewQueue', {
      fields: QUEUE_FIELDS,
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ...MERGED_RECORD, id: 'matter_99901', fields: QUEUE_FIELDS });
    assert.equal(
      body.ai_classification.urgency,
      'standard',
      'IF Urgent reads $json.ai_classification?.urgency'
    );
    assert.equal(body.contact.email, FIXTURE.contact.email, 'Lawmatics reads $json.contact.email');
    assert.equal(body.contact.first_name, FIXTURE.contact.first_name, 'Slack/Lawmatics read $json.contact.first_name');
    assert.equal(body.source, FIXTURE.source, 'Lawmatics reads $json.source');
    assert.match(body.id, /^matter_999\d\d$/, 'Respond — Success reads $json.id as review_id');
    assert.equal(state.counters.airtable_queue_post, 1);
  });
});

test('PATCH Contacts/{id} (dead-end duplicate branch) returns the parsed fields envelope — consumer-compatible and separately counted', async () => {
  await withMock(async ({ call, state }) => {
    const fields = {
      LastContact: '2024-11-15T09:31:00.000Z',
      Notes: 'Returning lead — submitted new intake form',
    };
    const { status, body } = await call('PATCH', '/airtable/v0/YOUR_BASE_ID/Contacts/recGreenfield123', {
      fields: JSON.stringify(fields),
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'recGreenfield123', fields });
    assert.equal(state.counters.airtable_contacts_patch, 1);
    assert.equal(state.counters.airtable_contacts_get, 0, 'distinct per-route counters');
  });
});

test('POST chat/completions returns choices[0].message.content as a JSON string with the classification contract', async () => {
  await withMock(async ({ call, state }) => {
    const { status, body } = await call('POST', '/openai/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a legal intake classifier for Greenfield & Associates.' },
        { role: 'user', content: FIXTURE.case_info.description },
      ],
      temperature: 0.2,
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.choices) && body.choices.length === 1, 'exactly one choice');
    const message = body.choices[0].message;
    assert.equal(message.role, 'assistant');
    assert.equal(typeof message.content, 'string', 'content must be a JSON string');
    const classification = JSON.parse(message.content);
    assert.deepEqual(
      Object.keys(classification).sort(),
      ['case_type', 'confidence', 'summary', 'urgency'],
      'the classification contract keys'
    );
    assert.equal(classification.case_type, 'personal_injury');
    assert.equal(classification.urgency, 'standard', 'keeps the standard tracer off the Slack branch');
    assert.ok(
      typeof classification.confidence === 'number' && classification.confidence >= 0.8,
      'confidence >= 0.8 selects the standard_gate review_reason branch'
    );
    assert.ok(typeof classification.summary === 'string' && classification.summary.length > 0);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(state.counters.openai_chat_completions_post, 1);
  });
});

test('POST Slack webhook (urgent-only branch) returns the incoming-webhook acknowledgement', async () => {
  await withMock(async ({ call, state }) => {
    const { status, body } = await call('POST', '/slack/services/YOUR/SLACK/WEBHOOK', {
      text: ':rotating_light: URGENT INTAKE — Maria Rodriguez — personal_injury',
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(state.counters.slack_webhook_post, 1);
  });
});

test('POST Lawmatics contacts (the ungated CRM write) returns an object containing its fictional id that feeds the response node', async () => {
  await withMock(async ({ call, state }) => {
    const { status, body } = await call('POST', '/lawmatics/v1/contacts', LAWMATICS_BODY);
    assert.equal(status, 201);
    assert.deepEqual(body, { ...LAWMATICS_BODY, id: body.id });
    assert.match(body.id, /^matter_999\d\d$/, 'fictional matter id consumed as review_id upstream');
    assert.equal(state.counters.lawmatics_contacts_post, 1);
  });
});

test('exercising all six graph routes increments each distinct counter exactly once', async () => {
  await withMock(async ({ call, state }) => {
    await call('GET', '/airtable/v0/YOUR_BASE_ID/Contacts');
    await call('PATCH', '/airtable/v0/YOUR_BASE_ID/Contacts/recGreenfield123', {
      fields: JSON.stringify({ LastContact: '2024-11-15T09:31:00.000Z' }),
    });
    await call('POST', '/airtable/v0/YOUR_BASE_ID/HumanReviewQueue', { fields: QUEUE_FIELDS });
    await call('POST', '/openai/v1/chat/completions', { model: 'gpt-4o-mini', messages: [] });
    await call('POST', '/slack/services/YOUR/SLACK/WEBHOOK', { text: 'urgent' });
    await call('POST', '/lawmatics/v1/contacts', LAWMATICS_BODY);
    assert.deepEqual(state.counters, {
      airtable_contacts_get: 1,
      airtable_contacts_patch: 1,
      airtable_queue_post: 1,
      openai_chat_completions_post: 1,
      slack_webhook_post: 1,
      lawmatics_contacts_post: 1,
      approval_actions: 0,
      rejected_nonfictional: 0,
      unknown_routes: 0,
    });
  });
});

test('unknown routes fail closed with a 404 and are counted', async () => {
  await withMock(async ({ call, state }) => {
    const { status } = await call('GET', '/airtable/v0/YOUR_BASE_ID/SomeOtherTable');
    assert.equal(status, 404);
    assert.equal(state.counters.unknown_routes, 1);
  });
});

test('fictional-data guards reject a non-Greenfield firm, a non-555 phone, and a non-example.com email (D-04/D-11/D-16)', async () => {
  await withMock(async ({ call, state }) => {
    const queueWith = (overrides) => {
      const record = JSON.parse(JSON.stringify(MERGED_RECORD));
      Object.assign(record, overrides);
      return { fields: { ...QUEUE_FIELDS, RawData: JSON.stringify(record) } };
    };

    const wrongFirm = await call('POST', '/airtable/v0/YOUR_BASE_ID/HumanReviewQueue', queueWith({ firm: 'Smith & Co' }));
    assert.equal(wrongFirm.status, 400, 'firm other than Greenfield & Associates must be rejected');
    assert.match(wrongFirm.body.error, /firm/);

    const wrongPhone = await call('POST', '/airtable/v0/YOUR_BASE_ID/HumanReviewQueue', queueWith({
      contact: { ...FIXTURE.contact, phone: '+12125551234' },
    }));
    assert.equal(wrongPhone.status, 400, 'non-555 phone must be rejected');
    assert.match(wrongPhone.body.error, /phone/);

    const wrongEmail = await call('POST', '/airtable/v0/YOUR_BASE_ID/HumanReviewQueue', queueWith({
      contact: { ...FIXTURE.contact, email: 'maria.r@realemail.com' },
    }));
    assert.equal(wrongEmail.status, 400, 'non-example.com email must be rejected');
    assert.match(wrongEmail.body.error, /email/);

    const lawmaticsBadEmail = await call('POST', '/lawmatics/v1/contacts', {
      ...LAWMATICS_BODY,
      email: 'maria.r@realemail.com',
    });
    assert.equal(lawmaticsBadEmail.status, 400);

    const lawmaticsBadPhone = await call('POST', '/lawmatics/v1/contacts', {
      ...LAWMATICS_BODY,
      phone: '+14155552671',
    });
    assert.equal(lawmaticsBadPhone.status, 400);

    assert.equal(state.counters.rejected_nonfictional, 5);
    assert.equal(state.counters.lawmatics_contacts_post, 0, 'rejected writes must never count as CRM writes');
    assert.equal(state.counters.airtable_queue_post, 0, 'rejected writes must never count as queue writes');
  });
});

test('admin reset returns every counter and recorded call to zero', async () => {
  await withMock(async ({ call, state }) => {
    await call('GET', '/airtable/v0/YOUR_BASE_ID/Contacts');
    await call('POST', '/lawmatics/v1/contacts', LAWMATICS_BODY);
    assert.ok(state.counters.airtable_contacts_get === 1);

    const { status, body } = await call('POST', '/admin/reset');
    assert.equal(status, 200);
    assert.equal(body.status, 'reset');
    assert.deepEqual(
      state.counters,
      Object.fromEntries(Object.keys(state.counters).map((key) => [key, 0]))
    );
    assert.deepEqual(state.calls, []);
  });
});
