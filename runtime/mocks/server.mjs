// Local-only mock service for the Flagship Intake baseline runtime.
//
// Serves every external endpoint the client-intake-pipeline graph touches
// (Airtable, OpenAI, Slack, Lawmatics) as deterministic local contracts with
// per-route counters, plus admin routes for health/reset/state. Zero
// dependencies: Node standard library only, so the pinned cached n8n image can
// run it via a plain `node` entrypoint with no package install (T-01-SC).
//
// All data is fictional Greenfield & Associates material (555 phones,
// example.com addresses, matter_999xx ids) per D-04/D-11/D-16. Requests that
// carry non-fictional contact material are rejected with HTTP 400.

import http from 'node:http';
import process from 'node:process';

// Port resolution (IN-01): NEVER derive the exported MOCK_PORT from
// process.argv — when this module is imported by a test runner, argv[2] is a
// test file path and Number(path) is NaN. The export comes from the
// environment (defaulting to 9090); the direct-CLI branch below reads its
// positional port argument on its own.
const envPort = Number(process.env.MOCK_PORT);
export const MOCK_PORT = Number.isFinite(envPort) ? envPort : 9090;
export const MOCK_HOST = '0.0.0.0';

// Fictional seed mirroring payloads/intake-new-lead.json in the exact shape
// produced by the workflow's "Validate Fields" Code node (E.164 phone,
// nulls stripped, defaults filled). The duplicate-lookup response reloads
// this envelope by node name inside the real graph, so it must carry every
// downstream-consumed field.
const INTAKE_ENVELOPE = Object.freeze({
  valid: true,
  errors: [],
  contact: {
    first_name: 'Maria',
    last_name: 'Rodriguez',
    email: 'maria.r@example.com',
    phone: '+15555551234',
    preferred_contact: 'phone',
  },
  case_info: {
    type: 'personal_injury',
    description: 'Rear-ended at intersection on Nov 10, police report filed',
    incident_date: '2024-11-10',
    urgency: 'standard',
  },
  source: 'web_form',
  referral_source: 'google_search',
  timestamp: '2024-11-15T09:30:00Z',
  firm: 'Greenfield & Associates',
});

// Standard (non-urgent) classification so the baseline tracer exercises the
// non-Slack branch: queue write + ungated CRM write, no Slack alert.
const AI_CLASSIFICATION = Object.freeze({
  case_type: 'personal_injury',
  confidence: 0.87,
  urgency: 'standard',
  summary: 'Rear-end collision with filed police report; documented personal-injury lead.',
});

const FICTIONAL_FIRM = 'Greenfield & Associates';
const PHONE_555 = /^\+15555\d{6}$/;
const EMAIL_EXAMPLE = /@example\.com$/i;

function fictionalMatterId(seq) {
  return `matter_${String(99900 + seq).padStart(5, '0')}`;
}

/**
 * Reject non-fictional contact material (D-04/D-11/D-16). Returns an error
 * string or null when the values are fictional-safe.
 */
export function fictionalViolation({ email, phone, firm } = {}) {
  if (firm !== undefined && firm !== FICTIONAL_FIRM) {
    return `firm must be the fictional "${FICTIONAL_FIRM}" (got ${JSON.stringify(firm)})`;
  }
  if (email !== undefined && !EMAIL_EXAMPLE.test(String(email))) {
    return `email must use the fictional example.com domain (got ${JSON.stringify(email)})`;
  }
  if (phone !== undefined && !PHONE_555.test(String(phone))) {
    return `phone must use the fictional 555 format +1555555xxxx (got ${JSON.stringify(phone)})`;
  }
  return null;
}

const freshCounters = () => ({
  airtable_contacts_get: 0,
  airtable_contacts_patch: 0,
  airtable_queue_post: 0,
  openai_chat_completions_post: 0,
  slack_webhook_post: 0,
  lawmatics_contacts_post: 0,
  // Dedicated approval-action counter (A-06/T-01-09): initialized to zero,
  // reset to zero, and incremented by NO route in this server — approval is
  // not implemented in Phase 1, so "zero approval actions" is measured by
  // this counter staying zero, never inferred from a queue write.
  approval_actions: 0,
  rejected_nonfictional: 0,
  unknown_routes: 0,
});

/**
 * Create the local mock server. Returns { server, state, reset } so contract
 * tests can drive it in-process; the CLI entry below runs it standalone.
 */
export function createMockServer() {
  const state = {
    counters: freshCounters(),
    calls: [],
  };
  let matterSeq = 0;

  const reset = () => {
    state.counters = freshCounters();
    state.calls = [];
    matterSeq = 0;
  };

  const record = (route, request, response) => {
    state.counters[route] = (state.counters[route] ?? 0) + 1;
    state.calls.push({
      route,
      at: new Date().toISOString(),
      method: request.method,
      path: request.path,
      query: request.query,
      body: request.body,
      response,
    });
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'mock-api'}`);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (rawBody.length > 0) {
        const contentType = String(req.headers['content-type'] ?? '');
        if (contentType.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody));
        } else {
          try {
            body = JSON.parse(rawBody);
          } catch {
            body = { _raw: rawBody };
          }
        }
      }
      const request = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      };
      const send = (status, payload, route) => {
        if (route !== undefined) {
          record(route, request, payload);
        }
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };

      const fail = (status, message, route) => {
        if (route === 'rejected_nonfictional' || route === 'unknown_routes') {
          state.counters[route] = (state.counters[route] ?? 0) + 1;
        }
        send(status, { error: message });
      };

      try {
        dispatch(request, send, fail);
      } catch (error) {
        fail(500, `mock handler error: ${error.message}`);
      }
    });
  });

  function dispatch(request, send, fail) {
    const { method, path, body } = request;

    // ---- admin routes -------------------------------------------------
    if (method === 'GET' && path === '/admin/health') {
      return send(200, { status: 'ok' });
    }
    if (method === 'POST' && path === '/admin/reset') {
      reset();
      return send(200, { status: 'reset', counters: state.counters });
    }
    if (method === 'GET' && path === '/admin/state') {
      return send(200, { counters: state.counters, calls: state.calls });
    }

    // ---- Airtable: duplicate lookup ------------------------------------
    if (method === 'GET' && path === '/airtable/v0/YOUR_BASE_ID/Contacts') {
      // `records: []` drives "IF Duplicate" down the new-lead branch; the
      // spread envelope is what "Merge AI Classification" reloads by node
      // name, so every Validate Fields output key must survive here.
      const payload = { records: [], ...structuredClone(INTAKE_ENVELOPE) };
      return send(200, payload, 'airtable_contacts_get');
    }

    // ---- Airtable: duplicate update (dead-end branch) -------------------
    if (method === 'PATCH' && /^\/airtable\/v0\/YOUR_BASE_ID\/Contacts\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      let fields = {};
      if (typeof body?.fields === 'string') {
        try {
          fields = JSON.parse(body.fields);
        } catch {
          fields = { _unparsed: true };
        }
      } else if (body?.fields && typeof body.fields === 'object') {
        fields = body.fields;
      }
      return send(200, { id, fields }, 'airtable_contacts_patch');
    }

    // ---- Airtable: human review queue write ------------------------------
    if (method === 'POST' && path === '/airtable/v0/YOUR_BASE_ID/HumanReviewQueue') {
      const fields = body?.fields ?? {};
      let parsed;
      try {
        parsed = typeof fields.RawData === 'string' ? JSON.parse(fields.RawData) : null;
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object') {
        return fail(400, 'fields.RawData must be a JSON string of the intake record', 'rejected_nonfictional');
      }
      const violation = fictionalViolation({
        email: parsed.contact?.email,
        phone: parsed.contact?.phone,
        firm: parsed.firm,
      });
      if (violation) {
        return fail(400, `non-fictional data rejected: ${violation}`, 'rejected_nonfictional');
      }
      // Spread the parsed record so "IF Urgent", Slack, and Lawmatics keep
      // ai_classification/contact/source; echo the queue id + submitted
      // fields for downstream expressions.
      matterSeq += 1;
      const payload = { ...parsed, id: fictionalMatterId(matterSeq), fields };
      return send(200, payload, 'airtable_queue_post');
    }

    // ---- OpenAI: chat completion classification ---------------------------
    if (method === 'POST' && path === '/openai/v1/chat/completions') {
      matterSeq += 1;
      const payload = {
        id: `chatcmpl-greenfield-${matterSeq}`,
        object: 'chat.completion',
        created: 1731663000,
        model: body?.model ?? 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify(AI_CLASSIFICATION),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 96, completion_tokens: 48, total_tokens: 144 },
      };
      return send(200, payload, 'openai_chat_completions_post');
    }

    // ---- Slack: incoming webhook ------------------------------------------
    if (method === 'POST' && path === '/slack/services/YOUR/SLACK/WEBHOOK') {
      return send(200, { ok: true }, 'slack_webhook_post');
    }

    // ---- Lawmatics: THE ungated CRM write the baseline counts --------------
    if (method === 'POST' && path === '/lawmatics/v1/contacts') {
      const violation = fictionalViolation({ email: body?.email, phone: body?.phone });
      if (violation) {
        return fail(400, `non-fictional data rejected: ${violation}`, 'rejected_nonfictional');
      }
      matterSeq += 1;
      const payload = {
        id: fictionalMatterId(matterSeq),
        ...body,
        status: body?.status ?? 'new_lead',
      };
      return send(201, payload, 'lawmatics_contacts_post');
    }

    return fail(404, `unrecognized route ${method} ${path}`, 'unknown_routes');
  }

  return { server, state, reset };
}

// CLI entry: `node server.mjs [port]`
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const argPort = Number(process.argv[2]);
  const port = Number.isFinite(argPort) ? argPort : MOCK_PORT;
  const { server } = createMockServer();
  server.listen(port, MOCK_HOST, () => {
    process.stdout.write(`mock-api listening on ${MOCK_HOST}:${port}\n`);
  });
}
