// Fail-closed structural contract for the committed Phase 2 gated intake
// workflow (plan 02-01, T-02-01).
//
// The verifier under test — runtime/scripts/verify-gated-workflows.mjs — is
// the fail-closed gate that independently proves the committed
// runtime/demo/workflows/intake-stage.json export can never attempt a CRM
// write and never drifts from its isolation contract:
//   - no CRM node and no CRM-capable HTTP destination anywhere in the graph
//     (even a LOCAL mock CRM URL is a violation — the intake graph must not
//     possess the capability at all),
//   - the graph terminates after staging/pending response; urgency or any
//     other data cannot branch toward delivery,
//   - every URL anywhere in the graph object is local to the demo mock
//     service (locality is input-independent),
//   - the export stays portable and inactive (no root id, no
//     meta.instanceId, active: false, pinned-compatible settings),
//   - the webhook shape is pinned (single POST webhook, responseNode mode,
//     fixed path),
//   - the immutable historical source hash is checked alongside the graph.
// Every tamper class below must produce an explicit verifier error and a
// non-zero CLI exit; the verifier must never return success on an exception.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const INTAKE_PATH = path.join(ROOT, 'runtime', 'demo', 'workflows', 'intake-stage.json');
const REVIEWER_PATH = path.join(ROOT, 'runtime', 'demo', 'workflows', 'reviewer-decision.json');
const DELIVERY_PATH = path.join(ROOT, 'runtime', 'demo', 'workflows', 'approved-delivery.json');
const VERIFIER_PATH = path.join(ROOT, 'runtime', 'scripts', 'verify-gated-workflows.mjs');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const intakeBytes = readFileSync(INTAKE_PATH);
const honest = () => JSON.parse(readFileSync(INTAKE_PATH, 'utf8'));

// Load the verifier without crashing the suite when it does not exist yet
// (TDD RED): the tests then fail on an explicit assertion for the missing
// feature instead of an import error.
async function loadVerifier() {
  try {
    return await import('../scripts/verify-gated-workflows.mjs');
  } catch {
    return null;
  }
}

const nodeByName = (workflow, name) => workflow.nodes.find((candidate) => candidate.name === name);

const CRM_HTTP_NODE = (name = 'CRM Create — Lawmatics', url = 'http://mock-api:9090/lawmatics/v1/contacts') => ({
  parameters: { method: 'POST', url, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({}) }}', options: {} },
  id: 'b2c3d4e5-2222-4bbb-cccc-000000000099',
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [2500, 200],
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  onError: 'stopWorkflow',
});

test('honest committed intake-stage.json verifies with ok:true and a full invariant report', async () => {
  const verifier = await loadVerifier();
  assert.ok(
    verifier && typeof verifier.verifyGatedWorkflow === 'function',
    'runtime/scripts/verify-gated-workflows.mjs must exist and export verifyGatedWorkflow'
  );

  const result = verifier.verifyGatedWorkflow(INTAKE_PATH);
  assert.equal(result.ok, true, `the honest committed graph must verify (errors: ${JSON.stringify(result.errors)})`);
  assert.equal(result.workflowSha256, sha256(intakeBytes), 'the report must carry the exact file-bytes SHA-256');
  assert.ok(Array.isArray(result.errors) && result.errors.length === 0, 'no errors for the honest graph');
  assert.ok(result.urlsChecked >= 1, 'the report must count the URLs scanned');
  assert.ok(Array.isArray(result.invariants) && result.invariants.length >= 6, 'the report must enumerate the invariants checked');
  assert.equal(result.historicalSourceOk, true, 'the immutable historical source hash must be checked and match');
  assert.equal(
    result.historicalSourceSha256,
    'b75f67261753343f4f1791aefa68a0176f8a505b37de8d0133b5dd24168640f5',
    'the verifier must pin the exact historical source hash'
  );
});

test('every CRM bypass tamper class fails verification with a precise error', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');
  const { verifyGatedWorkflow } = verifier;

  const mustReject = (label, mutate, pattern) => {
    const tampered = honest();
    mutate(tampered);
    const result = verifyGatedWorkflow(tampered);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(result.errors.length >= 1, `${label} must report an explicit error`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label} error must match ${pattern} (got: ${result.errors.join(' | ')})`
    );
    return result;
  };

  // A CRM HTTP node is forbidden even with a LOCAL mock URL — the intake
  // graph must not possess CRM-write capability at all.
  mustReject('orphan CRM node with a local mock URL', (w) => {
    w.nodes.push(CRM_HTTP_NODE());
  }, /CRM|unexpected node/i);

  mustReject('CRM node wired after staging', (w) => {
    w.nodes.push(CRM_HTTP_NODE());
    w.connections['Stage Intake — Demo State'].main[0].push({ node: 'CRM Create — Lawmatics', type: 'main', index: 0 });
  }, /CRM|unexpected node|terminal/i);

  mustReject('external CRM URL node', (w) => {
    w.nodes.push(CRM_HTTP_NODE('CRM Create — Lawmatics (External)', 'https://api.lawmatics.com/v1/contacts'));
  }, /CRM|unexpected node|local/i);

  mustReject('CRM edge from the valid branch', (w) => {
    w.nodes.push(CRM_HTTP_NODE());
    w.connections['IF Valid'].main[0].push({ node: 'CRM Create — Lawmatics', type: 'main', index: 0 });
  }, /CRM|unexpected node|IF Valid/i);

  // Urgency shortcut: an urgency-branching IF anywhere, or IF Valid itself
  // repurposed to test urgency, must both fail closed.
  mustReject('urgency IF node after staging', (w) => {
    w.nodes.push({
      parameters: {
        conditions: {
          options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'urgency-check',
              leftValue: '={{ $json.case_info.urgency }}',
              rightValue: 'urgent',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
      },
      id: 'b2c3d4e5-2222-4bbb-cccc-000000000098',
      name: 'IF Urgent',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [1100, 200],
    });
    w.connections['Stage Intake — Demo State'].main[0].push({ node: 'IF Urgent', type: 'main', index: 0 });
  }, /unexpected node|IF Valid|terminal/i);

  mustReject('IF Valid condition repurposed to urgency', (w) => {
    const condition = nodeByName(w, 'IF Valid').parameters.conditions.conditions[0];
    condition.leftValue = '={{ $json.case_info.urgency }}';
    condition.rightValue = 'urgent';
    condition.operator = { type: 'string', operation: 'equals' };
  }, /IF Valid|valid/i);

  mustReject('staging node repointed at the mock CRM route', (w) => {
    nodeByName(w, 'Stage Intake — Demo State').parameters.url = 'http://mock-api:9090/demo/v1/crm/contacts';
  }, /staging URL|crm/i);

  // The graph must terminate after the pending response — nothing may follow.
  mustReject('edge out of the pending-response terminal', (w) => {
    w.connections['Respond — Pending Review'] = {
      main: [[{ node: 'Sticky Note — Gated Boundary', type: 'main', index: 0 }]],
    };
  }, /terminal|pending/i);

  mustReject('reversed node order', (w) => {
    w.nodes.reverse();
  }, /node order|ordered/i);
});

test('locality, portability, and webhook-shape tamper classes fail verification', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');
  const { verifyGatedWorkflow } = verifier;

  const mustReject = (label, mutate, pattern) => {
    const tampered = honest();
    mutate(tampered);
    const result = verifyGatedWorkflow(tampered);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label} error must match ${pattern} (got: ${result.errors.join(' | ')})`
    );
  };

  // Locality is graph-wide and input-independent: an external URL hidden in
  // a sticky note must fail exactly like one on an HTTP node.
  mustReject('external URL in a sticky note', (w) => {
    nodeByName(w, 'Sticky Note — Validation').parameters.content +=
      '\nReference: https://api.airtable.com/v0/YOUR_BASE_ID/Contacts';
  }, /local|api\.airtable\.com/i);

  mustReject('staging node repointed at an external URL', (w) => {
    nodeByName(w, 'Stage Intake — Demo State').parameters.url = 'https://api.airtable.com/v0/YOUR_BASE_ID/Contacts';
  }, /local|url/i);

  mustReject('external webhook-bridge URL inside the validate code', (w) => {
    nodeByName(w, 'Validate Intake').parameters.jsCode += '\n// fetch("https://api.openai.com/v1/chat/completions")';
  }, /local|api\.openai\.com/i);

  // Portability / export drift.
  mustReject('root id added', (w) => {
    w.id = 'some-root-id';
  }, /root id|portab/i);
  mustReject('meta.instanceId added', (w) => {
    w.meta = { instanceId: 'some-instance' };
  }, /instanceId|portab/i);
  mustReject('workflow activated', (w) => {
    w.active = true;
  }, /active/i);
  mustReject('executionOrder setting removed', (w) => {
    delete w.settings.executionOrder;
  }, /settings|executionOrder/i);

  // Webhook shape drift.
  mustReject('webhook path changed', (w) => {
    nodeByName(w, 'Webhook — Gated Intake').parameters.path = 'other-webhook';
  }, /webhook path|webhook/i);
  mustReject('second webhook node', (w) => {
    w.nodes.push({
      parameters: { httpMethod: 'POST', path: 'gated-intake-webhook-2', responseMode: 'responseNode', options: {} },
      id: 'b2c3d4e5-2222-4bbb-cccc-000000000097',
      name: 'Webhook — Second',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 520],
      webhookId: 'second',
    });
  }, /webhook/i);
  mustReject('webhook responseMode changed away from responseNode', (w) => {
    nodeByName(w, 'Webhook — Gated Intake').parameters.responseMode = 'onReceived';
  }, /responseMode|webhook/i);

  // Unsupported node types are rejected outright — the allowed set is the
  // pinned-compatible minimal composition of this phase.
  mustReject('unsupported node type (executeWorkflow subworkflow call)', (w) => {
    w.nodes.push({
      parameters: { workflowId: 'some-other-workflow' },
      id: 'b2c3d4e5-2222-4bbb-cccc-000000000096',
      name: 'Call Delivery Workflow',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1,
      position: [1560, 400],
    });
  }, /unsupported node type|executeWorkflow|allowed/i);
});

test('verifier CLI reports machine-readable JSON, exits non-zero on every violation, and never succeeds on an exception', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');

  const dir = mkdtempSync(path.join(tmpdir(), 'gsd-0201-verifier-'));
  try {
    const good = spawnSync('node', [VERIFIER_PATH, INTAKE_PATH], { encoding: 'utf8' });
    assert.equal(good.status, 0, `CLI must exit 0 on the honest graph (stderr: ${good.stderr})`);
    const goodReport = JSON.parse(good.stdout);
    assert.equal(goodReport.ok, true);
    assert.equal(goodReport.workflowSha256, sha256(intakeBytes));
    assert.equal(goodReport.historicalSourceOk, true);

    const tampered = honest();
    tampered.nodes.push(CRM_HTTP_NODE());
    const tamperedPath = path.join(dir, 'tampered.json');
    writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const bad = spawnSync('node', [VERIFIER_PATH, tamperedPath], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, 'CLI must exit non-zero on a CRM-capable tamper');
    const badReport = JSON.parse(bad.stdout);
    assert.equal(badReport.ok, false);
    assert.ok(badReport.errors.length >= 1);

    // Fail-closed on malformed input: a parser failure must surface as
    // ok:false with a non-zero exit, never as success.
    const garbagePath = path.join(dir, 'garbage.json');
    writeFileSync(garbagePath, '{ this is not json');
    const garbage = spawnSync('node', [VERIFIER_PATH, garbagePath], { encoding: 'utf8' });
    assert.notEqual(garbage.status, 0, 'CLI must exit non-zero on unparseable input');
    const garbageReport = JSON.parse(garbage.stdout);
    assert.equal(garbageReport.ok, false, 'the exception report must be ok:false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifier carries no dead portability operand and rejects a typo-only saveManualExecations setting', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');

  const source = readFileSync(VERIFIER_PATH, 'utf8');
  assert.ok(
    !source.includes('saveManualExecations'),
    'the fail-closed verifier must not carry the dead typo\'d saveManualExecations operand (always-true clause) anywhere in its source'
  );

  // Behavior must stay strict: a workflow whose settings carry ONLY the
  // typo'd key fails the real saveManualExecutions requirement.
  const tampered = honest();
  delete tampered.settings.saveManualExecutions;
  tampered.settings.saveManualExecations = true;
  const result = verifier.verifyGatedWorkflow(tampered);
  assert.equal(result.ok, false, 'a typo-only saveManualExecations setting must fail verification');
  assert.ok(
    result.errors.some((error) => /saveManualExecutions must be true/.test(error)),
    `the error must name the real saveManualExecutions requirement (got: ${result.errors.join(' | ')})`
  );
});

// ---------------------------------------------------------------------------
// Plan 02-02 Task 3: the three-graph contract — the recorded approval
// assertion is the ONLY CRM predecessor and no bypass topology verifies.
// ---------------------------------------------------------------------------

const reviewerBytes = readFileSync(REVIEWER_PATH);
const deliveryBytes = readFileSync(DELIVERY_PATH);
const honestReviewer = () => JSON.parse(readFileSync(REVIEWER_PATH, 'utf8'));
const honestDelivery = () => JSON.parse(readFileSync(DELIVERY_PATH, 'utf8'));
const deliveryNode = (workflow, name) => workflow.nodes.find((candidate) => candidate.name === name);

const DELIVERY_CRM_TAMPER = (name = 'CRM Create — Lawmatics', url = 'http://mock-api:9090/demo/v1/crm/contacts') => ({
  parameters: { method: 'POST', url, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({}) }}', options: {} },
  id: 'e5f6a7b8-5555-4fff-ffff-000000000099',
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [2500, 200],
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  onError: 'stopWorkflow',
});

test('WR-06: reviewer canvas documents per-window proof consumption and reset reuse', () => {
  const reviewer = JSON.parse(readFileSync(REVIEWER_PATH, 'utf8'));
  const notes = reviewer.nodes.filter((node) => node.type === 'n8n-nodes-base.stickyNote')
    .map((node) => String(node.parameters?.content ?? '')).join('\n');
  assert.match(notes, /per-registration-window proof/i,
    'buyer-visible canvas text must scope consumption to a registration window');
  assert.match(notes, /privileged admin reset.*re-register/i,
    'buyer-visible canvas text must disclose a later window can reuse the raw value');
  assert.doesNotMatch(notes, /per-run one-time proof/i,
    'the canvas must not claim global uniqueness that the reset path does not enforce');
});

test('honest committed reviewer and delivery graphs verify together with the full invariant set', async () => {
  const verifier = await loadVerifier();
  assert.ok(
    verifier && typeof verifier.verifyReviewerWorkflow === 'function',
    'runtime/scripts/verify-gated-workflows.mjs must exist and export verifyReviewerWorkflow for the committed reviewer graph'
  );
  assert.ok(
    typeof verifier.verifyDeliveryWorkflow === 'function',
    'the verifier must export verifyDeliveryWorkflow for the committed delivery graph'
  );
  assert.ok(
    typeof verifier.verifyAllGatedWorkflows === 'function',
    'the verifier must export verifyAllGatedWorkflows so all three exports verify together'
  );

  const reviewerReport = verifier.verifyReviewerWorkflow(REVIEWER_PATH);
  assert.equal(reviewerReport.ok, true, `the honest reviewer graph must verify (errors: ${JSON.stringify(reviewerReport.errors)})`);
  assert.equal(reviewerReport.workflowSha256, sha256(reviewerBytes), 'the reviewer report must carry the exact file-bytes SHA-256');
  assert.ok(Array.isArray(reviewerReport.invariants) && reviewerReport.invariants.length >= 5, 'the reviewer report must enumerate invariants');

  const deliveryReport = verifier.verifyDeliveryWorkflow(DELIVERY_PATH);
  assert.equal(deliveryReport.ok, true, `the honest delivery graph must verify (errors: ${JSON.stringify(deliveryReport.errors)})`);
  assert.equal(deliveryReport.workflowSha256, sha256(deliveryBytes), 'the delivery report must carry the exact file-bytes SHA-256');
  assert.ok(Array.isArray(deliveryReport.invariants) && deliveryReport.invariants.length >= 6, 'the delivery report must enumerate invariants');

  const together = verifier.verifyAllGatedWorkflows({
    intake: INTAKE_PATH,
    reviewer: REVIEWER_PATH,
    delivery: DELIVERY_PATH,
  });
  assert.equal(together.ok, true, `all three honest graphs must verify together (errors: ${JSON.stringify(together.errors)})`);
  assert.equal(together.reports.intake.ok, true, 'the intake report must still verify inside the combined check');
  assert.equal(together.reports.reviewer.ok, true, 'the reviewer report must verify inside the combined check');
  assert.equal(together.reports.delivery.ok, true, 'the delivery report must verify inside the combined check');
});

test('every reviewer/delivery bypass tamper class fails verification with a precise error', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');
  const { verifyReviewerWorkflow, verifyDeliveryWorkflow } = verifier;

  const mustRejectReviewer = (label, mutate, pattern) => {
    const tampered = honestReviewer();
    mutate(tampered);
    const result = verifyReviewerWorkflow(tampered);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label} error must match ${pattern} (got: ${result.errors.join(' | ')})`
    );
  };
  const mustRejectDelivery = (label, mutate, pattern) => {
    const tampered = honestDelivery();
    mutate(tampered);
    const result = verifyDeliveryWorkflow(tampered);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label} error must match ${pattern} (got: ${result.errors.join(' | ')})`
    );
  };

  // --- assertion removal / reorder / bypass in the delivery graph ---------
  mustRejectDelivery('assertion node removed and classify wired straight to CRM', (w) => {
    w.nodes = w.nodes.filter((node) => node.name !== 'Assert Approved — Delivery State');
    w.connections['IF Deliverable'].main[0] = [{ node: 'CRM Create — Demo Boundary', type: 'main', index: 0 }];
  }, /Assert|order|composition|predecessor/i);

  mustRejectDelivery('assertion moved after the CRM node', (w) => {
    const assertIndex = w.nodes.findIndex((node) => node.name === 'Assert Approved — Delivery State');
    const crmIndex = w.nodes.findIndex((node) => node.name === 'CRM Create — Demo Boundary');
    const [assertNode] = w.nodes.splice(assertIndex, 1);
    w.nodes.splice(crmIndex, 0, assertNode);
    w.connections['IF Deliverable'].main[0] = [{ node: 'CRM Create — Demo Boundary', type: 'main', index: 0 }];
    w.connections['CRM Create — Demo Boundary'] = { main: [[{ node: 'Assert Approved — Delivery State', type: 'main', index: 0 }]] };
    w.connections['Assert Approved — Delivery State'] = { main: [[{ node: 'Respond — Delivered', type: 'main', index: 0 }]] };
  }, /Assert|order|predecessor/i);

  mustRejectDelivery('added second immediate CRM predecessor (classify feeds CRM too)', (w) => {
    w.connections['Classify Delivery State'].main[0].push({ node: 'CRM Create — Demo Boundary', type: 'main', index: 0 });
  }, /predecessor|Assert|CRM/i);

  mustRejectDelivery('assertion replaced by an IF pass-through', (w) => {
    const index = w.nodes.findIndex((node) => node.name === 'Assert Approved — Delivery State');
    w.nodes[index] = {
      parameters: {
        conditions: {
          options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'bypass-check',
              leftValue: '={{ $json.classification }}',
              rightValue: 'candidate',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
      },
      id: 'e5f6a7b8-5555-4fff-ffff-000000000098',
      name: 'Assert Approved — Delivery State',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [1320, 360],
    };
  }, /Assert|Code|type/i);

  mustRejectDelivery('assertion body stripped of the recorded-approval guard', (w) => {
    const node = deliveryNode(w, 'Assert Approved — Delivery State');
    node.parameters.jsCode = node.parameters.jsCode.replace(
      "if (!review.approval || review.approval.recorded !== true || review.approval.action !== 'approve' || review.approval.by !== 'reviewer') {\n  throw new Error('approval is not a separately recorded reviewer action — CRM delivery refused');\n}\n",
      ''
    );
  }, /assertion|approval|guard/i);

  mustRejectDelivery('assertion body stripped of the payload-hash guard', (w) => {
    const node = deliveryNode(w, 'Assert Approved — Delivery State');
    node.parameters.jsCode = node.parameters.jsCode.replace('delivery.payload_hash', 'null');
  }, /assertion|hash|guard/i);

  mustRejectDelivery('assertion body stripped of the stable CRM key guard', (w) => {
    const node = deliveryNode(w, 'Assert Approved — Delivery State');
    node.parameters.jsCode = node.parameters.jsCode.replace("'crmkey_' + review.review_id", "$json.idempotency_key");
  }, /assertion|key|guard/i);

  mustRejectDelivery('urgency shortcut IF inside the delivery graph', (w) => {
    w.nodes.push({
      parameters: {
        conditions: {
          options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'urgency-check',
              leftValue: '={{ $json.review?.urgency }}',
              rightValue: 'urgent',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
      },
      id: 'e5f6a7b8-5555-4fff-ffff-000000000097',
      name: 'IF Urgent',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [1200, 620],
    });
    w.connections['Classify Delivery State'].main[0].push({ node: 'IF Urgent', type: 'main', index: 0 });
  }, /unexpected node|order|composition/i);

  mustRejectDelivery('second CRM node added to the delivery graph', (w) => {
    w.nodes.push(DELIVERY_CRM_TAMPER());
  }, /CRM|order|composition/i);

  mustRejectDelivery('external URL on the load node', (w) => {
    deliveryNode(w, 'Load Delivery State — Demo').parameters.url = 'https://api.lawmatics.com/v1/contacts';
  }, /local|url/i);

  // --- reviewer graph bypass classes --------------------------------------
  mustRejectReviewer('rejection branch wired to the delivery invocation', (w) => {
    w.connections['IF Approved'].main[1] = [{ node: 'Invoke Approved Delivery', type: 'main', index: 0 }];
  }, /IF Approved|Invoke|delivery/i);

  mustRejectReviewer('record node repointed at the mock CRM route', (w) => {
    deliveryNode(w, 'Record Decision — Demo State').parameters.url = 'http://mock-api:9090/demo/v1/crm/contacts';
  }, /decision|url|CRM/i);

  mustRejectReviewer('CRM node added to the reviewer graph', (w) => {
    w.nodes.push(DELIVERY_CRM_TAMPER());
  }, /CRM|order|composition/i);

  mustRejectReviewer('invoke node moved to the refusal branch', (w) => {
    w.connections['IF Recorded'].main[1] = [{ node: 'Invoke Approved Delivery', type: 'main', index: 0 }];
  }, /IF Recorded|Invoke|approved/i);

  mustRejectReviewer('validate code stripped of the exact decision enum check', (w) => {
    const node = deliveryNode(w, 'Validate Decision');
    node.parameters.jsCode = node.parameters.jsCode.replace(
      "if (decision !== 'approve' && decision !== 'reject') {",
      "if (false) {"
    );
  }, /enum|approve.*reject|validate/i);

  mustRejectReviewer('invoke node repointed at an external URL', (w) => {
    deliveryNode(w, 'Invoke Approved Delivery').parameters.url = 'https://api.example-external.invalid/webhook/delivery';
  }, /local|url|invoke/i);
});

test('CR-03: the comment-preserving bypass (markers retained only in comments, guards disabled) fails verification', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');

  // --- delivery graph: the exact bypass from the review. The classifier
  // unconditionally returns candidate; the assertion unconditionally
  // forwards CRM data; EVERY marker string the verifier's marker checks
  // trust survives — inside comments.
  const bypass = honestDelivery();
  const classify = deliveryNode(bypass, 'Classify Delivery State');
  classify.parameters.jsCode = [
    "// markers preserved for the verifier: delivery.state === 'committed', 'candidate', 'refused'",
    'const s = $input.first().json;',
    "return [{ json: { classification: 'candidate', reason: 'comment-preserving bypass', review: s.review, delivery: s.delivery, payload: s.payload } }];",
  ].join('\n');
  const assertNode = deliveryNode(bypass, 'Assert Approved — Delivery State');
  assertNode.parameters.jsCode = [
    '// markers preserved for the verifier:',
    "//   review.state !== 'approved'",
    "//   review.approval.recorded !== true",
    "//   delivery.state !== 'pending' && delivery.state !== 'retryable'",
    "//   'crmkey_' + review.review_id",
    '//   delivery.payload_hash',
    '//   sha256hex ... throw new Error',
    'const s = $input.first().json;',
    "return [{ json: { idempotency_key: 'crmkey_' + s.review.review_id, review_id: s.review.review_id, email: s.payload?.contact?.email, phone: s.payload?.contact?.phone, payload_hash: s.delivery?.payload_hash } }];",
  ].join('\n');
  const deliveryResult = verifier.verifyDeliveryWorkflow(bypass);
  assert.equal(
    deliveryResult.ok,
    false,
    'the comment-preserving bypass must FAIL verification — marker strings living in comments prove nothing about behavior (the guards are gone)'
  );
  assert.ok(
    deliveryResult.errors.some((error) => /pinned jsCode SHA-256 mismatch/i.test(error)),
    `the failure must come from the pinned code-hash contract, not an unrelated invariant (got: ${deliveryResult.errors.join(' | ')})`
  );

  // --- reviewer graph: the exact decision enum check commented out (marker
  // retained inside the comment).
  const reviewerBypass = honestReviewer();
  const validateDecision = deliveryNode(reviewerBypass, 'Validate Decision');
  validateDecision.parameters.jsCode = validateDecision.parameters.jsCode.replace(
    "if (decision !== 'approve' && decision !== 'reject') {",
    "// if (decision !== 'approve' && decision !== 'reject') {\nif (false) {"
  );
  const reviewerResult = verifier.verifyReviewerWorkflow(reviewerBypass);
  assert.equal(
    reviewerResult.ok,
    false,
    'a disabled decision-enum check whose marker string survives in a comment must FAIL verification'
  );
  assert.ok(
    reviewerResult.errors.some((error) => /pinned jsCode SHA-256 mismatch/i.test(error)),
    `the failure must come from the pinned code-hash contract (got: ${reviewerResult.errors.join(' | ')})`
  );

  // --- intake graph: the stable-key requirement replaced by a constant with
  // the marker string retained in a trailing comment.
  const intakeBypass = honest();
  const validateIntake = nodeByName(intakeBypass, 'Validate Intake');
  validateIntake.parameters.jsCode = validateIntake.parameters.jsCode.replace(
    "raw.headers?.['x-intake-idempotency-key'] ?? input.idempotency_key ?? ''",
    "'always-the-same-key' // raw.headers?.['x-intake-idempotency-key'] ?? input.idempotency_key ?? ''"
  );
  const intakeResult = verifier.verifyGatedWorkflow(intakeBypass);
  assert.equal(
    intakeResult.ok,
    false,
    'a neutralized stable-key requirement whose marker string survives in a comment must FAIL verification'
  );
  assert.ok(
    intakeResult.errors.some((error) => /pinned jsCode SHA-256 mismatch/i.test(error)),
    `the failure must come from the pinned code-hash contract (got: ${intakeResult.errors.join(' | ')})`
  );

  // The CLI must exit non-zero on the comment-preserving bypass too.
  const dir = mkdtempSync(path.join(tmpdir(), 'gsd-cr03-bypass-'));
  try {
    const bypassPath = path.join(dir, 'approved-delivery.json');
    writeFileSync(bypassPath, `${JSON.stringify(bypass, null, 2)}\n`);
    const cli = spawnSync('node', [VERIFIER_PATH, bypassPath], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, 'the verifier CLI must exit non-zero on the comment-preserving bypass');
    const report = JSON.parse(cli.stdout);
    assert.equal(report.ok, false, 'the bypass report must be ok:false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('combined verification rejects a CRM node outside the delivery graph and fails closed on exceptions', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');
  const { verifyAllGatedWorkflows } = verifier;

  const intakeWithCrm = JSON.parse(readFileSync(INTAKE_PATH, 'utf8'));
  intakeWithCrm.nodes.push(DELIVERY_CRM_TAMPER('CRM Create — Lawmatics'));
  const reviewerWithCrm = honestReviewer();
  reviewerWithCrm.nodes.push(DELIVERY_CRM_TAMPER('CRM Create — Lawmatics'));

  const intakeViolation = verifyAllGatedWorkflows({
    intake: intakeWithCrm,
    reviewer: REVIEWER_PATH,
    delivery: DELIVERY_PATH,
  });
  assert.equal(intakeViolation.ok, false, 'a CRM node in the intake graph must fail the combined check');
  assert.ok(
    intakeViolation.errors.some((error) => /only the delivery workflow/i.test(error)),
    `the combined error must name the CRM-exclusivity rule (got: ${intakeViolation.errors.join(' | ')})`
  );

  const reviewerViolation = verifyAllGatedWorkflows({
    intake: INTAKE_PATH,
    reviewer: reviewerWithCrm,
    delivery: DELIVERY_PATH,
  });
  assert.equal(reviewerViolation.ok, false, 'a CRM node in the reviewer graph must fail the combined check');

  // The three-file CLI invocation: honest trio exits 0; any tampered member
  // exits non-zero with machine-readable JSON.
  const dir = mkdtempSync(path.join(tmpdir(), 'gsd-0202-verifier-'));
  try {
    const good = spawnSync('node', [VERIFIER_PATH, INTAKE_PATH, REVIEWER_PATH, DELIVERY_PATH], { encoding: 'utf8' });
    assert.equal(good.status, 0, `three-file CLI must exit 0 on the honest trio (stderr: ${good.stderr})`);
    const reports = JSON.parse(good.stdout);
    assert.ok(Array.isArray(reports) && reports.length === 3, 'the CLI must report one entry per workflow');
    assert.ok(reports.every((report) => report.ok), 'every honest report must be ok:true');

    const tamperedDelivery = honestDelivery();
    tamperedDelivery.connections['Classify Delivery State'].main[0].push({ node: 'CRM Create — Demo Boundary', type: 'main', index: 0 });
    const tamperedPath = path.join(dir, 'tampered-delivery.json');
    writeFileSync(tamperedPath, `${JSON.stringify(tamperedDelivery, null, 2)}\n`);
    const bad = spawnSync('node', [VERIFIER_PATH, INTAKE_PATH, REVIEWER_PATH, tamperedPath], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, 'three-file CLI must exit non-zero when any member is tampered');
    const badReports = JSON.parse(bad.stdout);
    assert.ok(badReports.some((report) => !report.ok), 'the tampered member must report ok:false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Plan 02-03 Task 3: stable-key, replay, and sanitized committed-state
// invariants — the graph contract must reject stable-key drift, lost
// delivery-state guards, alternate replay routes to CRM, and unsanitized
// existing-delivery responses, independent of the mock implementation.
// ---------------------------------------------------------------------------

test('stable-key and hash-forwarding tamper classes on the intake graph fail verification', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');
  const { verifyGatedWorkflow } = verifier;

  const mustReject = (label, mutate, pattern) => {
    const tampered = honest();
    mutate(tampered);
    const result = verifyGatedWorkflow(tampered);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label} error must match ${pattern} (got: ${result.errors.join(' | ')})`
    );
  };

  // Dropping the canonical payload hash from the staging call removes the
  // graph-side integrity proof — the state service would fail closed, but the
  // GRAPH contract must reject it too, independent of the mock.
  mustReject('payload hash forwarding removed from the staging body', (w) => {
    const node = nodeByName(w, 'Stage Intake — Demo State');
    node.parameters.jsonBody = node.parameters.jsonBody.replace('payload_hash: $json.payload_hash, ', '');
  }, /payload_hash|hash|key/i);

  // Dropping the stable intake key from the staging body.
  mustReject('stable intake key forwarding removed from the staging body', (w) => {
    const node = nodeByName(w, 'Stage Intake — Demo State');
    node.parameters.jsonBody = node.parameters.jsonBody.replace('idempotency_key: $json.idempotency_key, ', '');
  }, /idempotency|key/i);

  // Stripping the key REQUIREMENT from the validation code (header read
  // replaced with a constant) — the graph boundary must demand the key.
  mustReject('stable key requirement stripped from validation', (w) => {
    const node = nodeByName(w, 'Validate Intake');
    node.parameters.jsCode = node.parameters.jsCode.replace(
      "raw.headers?.['x-intake-idempotency-key'] ?? input.idempotency_key ?? ''",
      "'always-the-same-key'"
    );
  }, /x-intake-idempotency-key|stable intake key|key/i);

  // Replacing the in-graph canonical hash computation with a fake constant.
  mustReject('in-graph canonical hash computation replaced by a constant', (w) => {
    const node = nodeByName(w, 'Validate Intake');
    node.parameters.jsCode = node.parameters.jsCode.replace(
      'const payloadHash = sha256hex(unescape(encodeURIComponent(canonicalString)));',
      "const payloadHash = 'deadbeef';"
    );
  }, /sha256|canonical|hash/i);
});

test('delivery replay-guard tamper classes fail verification', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-gated-workflows.mjs must exist');
  const { verifyDeliveryWorkflow } = verifier;

  const mustReject = (label, mutate, pattern) => {
    const tampered = honestDelivery();
    mutate(tampered);
    const result = verifyDeliveryWorkflow(tampered);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label} error must match ${pattern} (got: ${result.errors.join(' | ')})`
    );
  };

  // The CRM node must send the STORED stable idempotency key on every
  // attempt — a per-attempt/derived key would defeat effect deduplication.
  mustReject('CRM body sends a per-attempt key instead of the stored stable key', (w) => {
    const node = deliveryNode(w, 'CRM Create — Demo Boundary');
    node.parameters.jsonBody = node.parameters.jsonBody.replace(
      'idempotency_key: $json.idempotency_key',
      "idempotency_key: 'attempt-' + Math.random()"
    );
  }, /stable|idempotency|key/i);

  // An alternate replay route straight into the assertion (bypassing the IF
  // Deliverable classification) — the assertion must have exactly one
  // incoming edge, from the candidate branch.
  mustReject('alternate incoming edge wired into the assertion node', (w) => {
    w.connections['Load Delivery State — Demo'].main[0].push({ node: 'Assert Approved — Delivery State', type: 'main', index: 0 });
  }, /assert|predecessor|incoming|IF Deliverable/i);

  // The committed-state classifier must keep its committed branch: routing
  // committed deliveries into the assertion/CRM path is the classic
  // duplicate-write topology.
  mustReject('committed classifier branch rewired to the candidate router', (w) => {
    w.connections['IF Already Committed'].main = [
      [{ node: 'IF Deliverable', type: 'main', index: 0 }],
      [{ node: 'IF Deliverable', type: 'main', index: 0 }],
    ];
  }, /IF Already Committed|committed|existing/i);

  // Removing the committed classification from the classifier code.
  mustReject('committed classification removed from the classifier code', (w) => {
    const node = deliveryNode(w, 'Classify Delivery State');
    node.parameters.jsCode = node.parameters.jsCode.replace(
      "if (delivery && delivery.state === 'committed')",
      "if (false)"
    );
  }, /committed|classif/i);

  // Unsanitized existing-delivery response: the committed-replay branch must
  // answer with stored identity only — never raw payload/contact material.
  mustReject('existing-delivery response returns unsanitized payload data', (w) => {
    const node = deliveryNode(w, 'Respond — Existing Delivery');
    node.parameters.responseBody =
      "={{ JSON.stringify({ status: 'already_delivered', payload: $json.payload, contact: $json.payload?.contact }) }}";
  }, /sanit|payload|existing/i);

  // Regression guards from the earlier contract (still rejected).
  mustReject('assertion retryable-state guard stripped', (w) => {
    const node = deliveryNode(w, 'Assert Approved — Delivery State');
    node.parameters.jsCode = node.parameters.jsCode.replace(
      "if (delivery.state !== 'pending' && delivery.state !== 'retryable') {",
      'if (false) {'
    );
  }, /pending|retryable|guard/i);

  mustReject('extra edge into the CRM node bypassing the assertion', (w) => {
    w.connections['IF Already Committed'].main[0].push({ node: 'CRM Create — Demo Boundary', type: 'main', index: 0 });
  }, /predecessor|Assert|CRM/i);
});
