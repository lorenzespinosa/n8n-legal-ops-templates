// Fail-closed structural verifier for committed Phase 2 gated workflow
// exports (plan 02-01, T-02-01).
//
// Unlike the Phase 1 verifier (an allowlisted diff against the historical
// source), this gate asserts DIRECT structural invariants of the committed
// gated intake graph — nothing is accepted because it resembles a source;
// everything is accepted only because the structure itself is safe:
//
//   1. Portability: active:false, no root id, no meta.instanceId, pinned
//      execution settings, non-empty nodes/connections.
//   2. Node allowlist: only pinned-compatible node types may appear, in the
//      exact expected order — any added node (a CRM node, an urgency IF, a
//      subworkflow call) is an explicit violation.
//   3. No CRM capability: the ONLY HTTP Request node is the staging node,
//      and its URL is exactly the local staging route. Even a local mock CRM
//      URL is rejected — the intake graph must not possess CRM-write
//      capability at all.
//   4. Termination: the graph ends at the pending-review response; the
//      staging node feeds only that response node; the validation-error
//      response is terminal; nothing branches around review.
//   5. Single decision branch: the only IF node is the validity gate testing
//      exactly `$json.valid` — urgency (or any other data) can never branch.
//   6. Locality: every URL anywhere in the graph object (expressions, code,
//      sticky notes included) resolves to the local demo mock origin.
//   7. Webhook shape: exactly one POST webhook in responseNode mode with the
//      pinned path, carrying the body-envelope unwrap contract.
//   8. Historical control: the immutable Phase 1 source hash is verified
//      alongside the graph so a drifted control can never coexist with an
//      accepted Phase 2 export.
//   9. Pinned code hashes (CR-03): every load-bearing Code node's jsCode body
//      must hash to the pinned SHA-256 of the independently reviewed
//      committed graph — marker strings in comments prove nothing; any jsCode
//      byte change fails closed.
//
// Anything not explicitly recognized fails closed. The CLI prints the report
// as machine-readable JSON and exits 0 only when every invariant holds; a
// parse or verification exception surfaces as ok:false with a non-zero exit.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { MOCK_ORIGIN } from './derive-runtime-workflow.mjs';

export { MOCK_ORIGIN };

const HTTP_REQUEST_TYPE = 'n8n-nodes-base.httpRequest';
const WEBHOOK_TYPE = 'n8n-nodes-base.webhook';
const CODE_TYPE = 'n8n-nodes-base.code';
const IF_TYPE = 'n8n-nodes-base.if';
const RESPOND_TYPE = 'n8n-nodes-base.respondToWebhook';
const STICKY_TYPE = 'n8n-nodes-base.stickyNote';

// The exact committed composition of the gated intake graph, in order. Any
// deviation — added node, removed node, renamed node, wrong type, wrong
// order — is a violation. This is the structural anti-bypass core: there is
// no slot in this list where a CRM or urgency node could hide.
export const EXPECTED_NODE_ORDER = Object.freeze([
  { name: 'Webhook — Gated Intake', type: WEBHOOK_TYPE },
  { name: 'Validate Intake', type: CODE_TYPE },
  { name: 'IF Valid', type: IF_TYPE },
  { name: 'Respond — Validation Error', type: RESPOND_TYPE },
  { name: 'Stage Intake — Demo State', type: HTTP_REQUEST_TYPE },
  { name: 'Interpret Stage Result', type: CODE_TYPE },
  { name: 'IF Staged', type: IF_TYPE },
  { name: 'Respond — Pending Review', type: RESPOND_TYPE },
  { name: 'IF Replay', type: IF_TYPE },
  { name: 'Respond — Intake Replay', type: RESPOND_TYPE },
  { name: 'IF Conflict', type: IF_TYPE },
  { name: 'Respond — Intake Conflict', type: RESPOND_TYPE },
  { name: 'Respond — Stage Refused', type: RESPOND_TYPE },
  { name: 'Sticky Note — Gated Boundary', type: STICKY_TYPE },
  { name: 'Sticky Note — Validation', type: STICKY_TYPE },
]);

export const ALLOWED_NODE_TYPES = Object.freeze([
  WEBHOOK_TYPE,
  CODE_TYPE,
  IF_TYPE,
  RESPOND_TYPE,
  HTTP_REQUEST_TYPE,
  STICKY_TYPE,
]);

export const INTAKE_WEBHOOK_PATH = 'gated-intake-webhook';
export const REVIEWER_WEBHOOK_PATH = 'reviewer-decision-webhook';
export const DELIVERY_WEBHOOK_PATH = 'gated-delivery-webhook';
export const STAGING_URL = `${MOCK_ORIGIN}/demo/v1/intakes`;
export const DECISION_URL = `${MOCK_ORIGIN}/demo/v1/reviews/decision`;
export const DELIVERY_STATE_URL = `${MOCK_ORIGIN}/demo/v1/delivery/state`;
export const CRM_URL = `${MOCK_ORIGIN}/demo/v1/crm/contacts`;
// The only non-mock origin any gated graph may reference: the reviewer
// workflow's in-network self-call that invokes the delivery webhook after the
// recorded approval transition.
export const N8N_ORIGIN = 'http://n8n:5678';
export const DELIVERY_INVOKE_URL = `${N8N_ORIGIN}/webhook/${DELIVERY_WEBHOOK_PATH}`;

// The immutable Phase 1 historical control (workflows/client-intake-pipeline.json).
export const HISTORICAL_SOURCE_SHA256 =
  '4559c8516533a1f2150215f5662f0f78e9ab5f5059da8f64d2940479d4a9b0bc';

// CR-03: pinned SHA-256 of every load-bearing Code-node jsCode body in the
// three independently reviewed committed gated exports. Marker-string checks
// alone accept bypasses that keep the markers in COMMENTS while disabling the
// actual guards; bytes cannot lie. Expected values were computed from the
// COMMITTED graphs (after all other review fixes were final) and are NEVER
// derived from a candidate file being verified — a candidate only ever gets
// hashed and COMPARED. Any jsCode byte change, however small, fails closed.
// Re-pinning is an explicit reviewed act: recompute from the trusted
// committed sources and update this table in the same commit that changes
// the graphs.
export const PINNED_CODE_NODE_SHA256 = Object.freeze({
  intake: Object.freeze({
    'Validate Intake': '287ed18b269d67aeaaca31d5692042ebd886e70f3f3bf39323452d1bcd6665cd',
    'Interpret Stage Result': '9b3f82b9c90c189dd26db6525db3359c47690e57fec653f840735a20c370080e',
  }),
  reviewer: Object.freeze({
    'Validate Decision': '0cce437d064ee8ad3fd5e6373a8c63258552177d056c3ce5d2b2c4d44c8f9c40',
    'Interpret Decision Record': '4a4a410a62b794dca30f2871771cda64b37f828aaddb7a11ff6112c9a7c5cb18',
  }),
  delivery: Object.freeze({
    'Classify Delivery State': '9be54fe916041958f110f8d6d965c9ee93238b4a59fcb8b4a42b6c1ec2d17e21',
    'Assert Approved — Delivery State': 'cc76c7930584c7f4f4d76d1d13dffe7a10b7073d2a3bf94c0069b77def64b2eb',
    'Interpret CRM Result': 'a1ac2e292a1b440d8d0d3957203ff0215e957585b335dc89c7c05a311ab8da74',
  }),
});

/**
 * CR-03: every pinned Code node must exist as a Code node with jsCode whose
 * SHA-256 equals the pinned constant. Missing nodes and ANY byte difference
 * (including comment-preserving bypasses that retain every marker string)
 * push an explicit error.
 */
function checkPinnedCodeNodes(parsed, pins, graphLabel, errors) {
  const nodesByName = new Map((Array.isArray(parsed.nodes) ? parsed.nodes : []).map((node) => [node.name, node]));
  for (const [nodeName, expectedHash] of Object.entries(pins)) {
    const node = nodesByName.get(nodeName);
    if (!node || node.type !== CODE_TYPE || typeof node.parameters?.jsCode !== 'string') {
      errors.push(
        `${graphLabel}: the load-bearing Code node "${nodeName}" is missing or malformed — its pinned jsCode contract cannot be verified`
      );
      continue;
    }
    const actualHash = sha256(Buffer.from(node.parameters.jsCode, 'utf8'));
    if (actualHash !== expectedHash) {
      errors.push(
        `${graphLabel}: "${nodeName}" pinned jsCode SHA-256 mismatch (expected ${expectedHash}, found ${actualHash}) — the load-bearing code body changed; comment-preserving bypasses and ANY jsCode byte change fail closed`
      );
    }
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
export const HISTORICAL_SOURCE_PATH = path.join(REPO_ROOT, 'workflows', 'client-intake-pipeline.json');

const URL_PATTERN = /https?:\/\/[^/\s"'`]+/g;
const WEBHOOK_BODY_UNWRAP = 'raw.body ?? raw';
const VALID_IF_LEFT = '={{ $json.valid }}';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Shared portability contract for every committed gated export. */
function checkPortability(parsed, errors) {
  if (parsed.active !== false) errors.push(`portability: workflow must be inactive (active: false), got ${JSON.stringify(parsed.active)}`);
  if (parsed.id !== undefined) errors.push(`portability: workflow carries a root id (${JSON.stringify(parsed.id)}) — exports must stay instance-independent`);
  if (parsed.meta?.instanceId !== undefined) errors.push(`portability: meta.instanceId present (${JSON.stringify(parsed.meta.instanceId)}) — exports must stay instance-independent`);
  if (parsed.settings?.executionOrder !== 'v1') errors.push(`portability: settings.executionOrder must be "v1", got ${JSON.stringify(parsed.settings?.executionOrder)}`);
  if (parsed.settings?.saveManualExecutions !== true) errors.push('portability: settings.saveManualExecutions must be true');
  if (parsed.settings?.callerPolicy !== 'workflowsFromSameOwner') errors.push(`portability: settings.callerPolicy must be "workflowsFromSameOwner", got ${JSON.stringify(parsed.settings?.callerPolicy)}`);
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) errors.push('portability: workflow name must be a non-empty string');
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) errors.push('portability: workflow must have a non-empty nodes array');
  if (parsed.nodes?.some((node) => node.id === undefined || typeof node.name !== 'string')) errors.push('portability: every node must carry an id and a name');
}

/** Shared exact ordered-composition check. */
function checkComposition(parsed, expected, errors) {
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  if (nodes.length !== expected.length) {
    errors.push(`node composition drifted: expected exactly ${expected.length} nodes in order, found ${nodes.length} — any added node (CRM, urgency branch, subworkflow call) is a violation`);
  }
  const overlap = Math.min(nodes.length, expected.length);
  for (let index = 0; index < overlap; index += 1) {
    if (nodes[index].name !== expected[index].name || nodes[index].type !== expected[index].type) {
      errors.push(
        `node order drifted at nodes[${index}]: expected "${expected[index].name}" (${expected[index].type}), found "${nodes[index].name}" (${nodes[index].type})`
      );
    }
  }
}

/** Flatten every connection edge as { source, target, branchIndex }. */
function allEdges(parsed) {
  const edges = [];
  for (const [source, definition] of Object.entries(parsed.connections ?? {})) {
    for (const [branchIndex, branch] of (definition?.main ?? []).entries()) {
      for (const edge of branch ?? []) {
        edges.push({ source, target: edge.node, branchIndex });
      }
    }
  }
  return edges;
}

/** Edges leaving a node, as target names per branch. */
function branchesOf(parsed, nodeName) {
  const branches = parsed.connections?.[nodeName]?.main;
  if (!Array.isArray(branches)) return null;
  return branches.map((branch) => (Array.isArray(branch) ? branch : []).map((edge) => edge.node));
}

/** Assert a pinned webhook node shape. */
function checkWebhookShape(parsed, expectedPath, errors) {
  const webhooks = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter((node) => node.type === WEBHOOK_TYPE);
  if (webhooks.length !== 1) {
    errors.push(`expected exactly one webhook node, found ${webhooks.length}`);
    return null;
  }
  const webhook = webhooks[0];
  if (webhook.parameters?.httpMethod !== 'POST') {
    errors.push(`webhook httpMethod must be POST, found ${JSON.stringify(webhook.parameters?.httpMethod)}`);
  }
  if (webhook.parameters?.responseMode !== 'responseNode') {
    errors.push(`webhook responseMode must be "responseNode" so the graph controls the response truthfully, found ${JSON.stringify(webhook.parameters?.responseMode)}`);
  }
  if (webhook.parameters?.path !== expectedPath) {
    errors.push(`webhook path must be exactly "${expectedPath}", found ${JSON.stringify(webhook.parameters?.path)}`);
  }
  return webhook;
}

/** Assert a pinned single-condition IF (leftValue/operator/rightValue). */
function checkIfNode(parsed, nodeName, leftValue, operator, rightValue, errors) {
  const node = (parsed.nodes ?? []).find((candidate) => candidate.name === nodeName);
  if (!node || node.type !== IF_TYPE) {
    errors.push(`an IF node "${nodeName}" is required`);
    return;
  }
  const entries = node.parameters?.conditions?.conditions;
  if (!Array.isArray(entries) || entries.length !== 1) {
    errors.push(`"${nodeName}" must carry exactly one condition`);
    return;
  }
  const condition = entries[0];
  if (condition.leftValue !== leftValue) {
    errors.push(`"${nodeName}" condition must test exactly ${leftValue}, found ${JSON.stringify(condition.leftValue)} — repurposing the branch to urgency or any other field is a bypass`);
  }
  if (condition.operator?.type !== operator.type || condition.operator?.operation !== operator.operation || condition.rightValue !== rightValue) {
    errors.push(`"${nodeName}" condition must be ${operator.type} ${operator.operation} ${JSON.stringify(rightValue)}, found ${JSON.stringify(condition.operator)} / ${JSON.stringify(condition.rightValue)}`);
  }
}

/** Every http(s) URL found in any string value of the workflow object. */
function collectUrls(workflow) {
  const urls = [];
  const visit = (value, at) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(URL_PATTERN)) {
        urls.push({ url: match[0], path: at });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${at}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) visit(value[key], `${at}.${key}`);
    }
  };
  visit(workflow, '');
  return urls;
}

/**
 * Verify a committed Phase 2 gated intake workflow export.
 *
 * @param {string|object} workflow path to the workflow JSON or a parsed object
 * @returns {{ok: boolean, errors: string[], workflowSha256: string, urlsChecked: number,
 *   invariants: string[], historicalSourceOk: boolean, historicalSourceSha256: string}}
 */
export function verifyGatedWorkflow(workflow) {
  const errors = [];
  const invariants = [];
  let workflowBytes;
  let parsed;

  if (typeof workflow === 'string') {
    workflowBytes = readFileSync(workflow);
    parsed = JSON.parse(workflowBytes.toString('utf8'));
  } else {
    parsed = structuredClone(workflow);
    workflowBytes = Buffer.from(JSON.stringify(parsed, null, 2));
  }

  const nodesByName = new Map((parsed.nodes ?? []).map((node) => [node.name, node]));

  // --- invariant: portability -----------------------------------------------
  {
    const label = 'portability';
    checkPortability(parsed, errors);
    if (!errors.length) invariants.push(label);
  }

  // --- invariant: allowed node types + exact ordered composition ------------
  {
    const label = 'node-allowlist-and-order';
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    for (const [index, node] of nodes.entries()) {
      if (!ALLOWED_NODE_TYPES.includes(node.type)) {
        errors.push(`unsupported node type "${node.type}" on node "${node.name}" (nodes[${index}]) — allowed types: ${ALLOWED_NODE_TYPES.join(', ')}`);
      }
    }
    const expected = EXPECTED_NODE_ORDER;
    if (nodes.length !== expected.length) {
      errors.push(`node composition drifted: expected exactly ${expected.length} nodes in order, found ${nodes.length} — any added node (CRM, urgency branch, subworkflow call) is a violation`);
    }
    const overlap = Math.min(nodes.length, expected.length);
    for (let index = 0; index < overlap; index += 1) {
      if (nodes[index].name !== expected[index].name || nodes[index].type !== expected[index].type) {
        errors.push(
          `node order drifted at nodes[${index}]: expected "${expected[index].name}" (${expected[index].type}), found "${nodes[index].name}" (${nodes[index].type})`
        );
      }
    }
    if (errors.length === 0) invariants.push(label);
  }

  // --- invariant: no CRM capability ------------------------------------------
  {
    const label = 'no-crm-capability';
    const httpNodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter((node) => node.type === HTTP_REQUEST_TYPE);
    if (httpNodes.length !== 1) {
      errors.push(`no-CRM-capability: expected exactly one HTTP Request node (the staging node), found ${httpNodes.length} — every additional HTTP node is CRM-attempt capability`);
    }
    for (const node of httpNodes) {
      if (node.parameters?.url !== STAGING_URL) {
        errors.push(
          `staging URL must be exactly ${STAGING_URL}, found ${JSON.stringify(node.parameters?.url)} on node "${node.name}" — the intake graph may call nothing but the local staging route`
        );
      }
    }
    if (errors.length === 0) invariants.push(label);
  }

  // --- invariant: termination after staging/pending response -----------------
  {
    const label = 'terminal-pending-response';
    const connections = parsed.connections ?? {};
    const targetsOf = (nodeName) => {
      const branches = connections[nodeName]?.main;
      if (!Array.isArray(branches)) return [];
      return branches.flatMap((branch, branchIndex) =>
        (Array.isArray(branch) ? branch : []).map((edge) => ({ ...edge, branchIndex }))
      );
    };

    const pending = targetsOf('Respond — Pending Review');
    if (pending.length !== 0) {
      errors.push(`the pending-review response must be terminal — found ${pending.length} outgoing edge(s) from "Respond — Pending Review"`);
    }
    const invalidRespond = targetsOf('Respond — Validation Error');
    if (invalidRespond.length !== 0) {
      errors.push(`the validation-error response must be terminal — found ${invalidRespond.length} outgoing edge(s) from "Respond — Validation Error"`);
    }
    for (const terminal of ['Respond — Intake Replay', 'Respond — Intake Conflict', 'Respond — Stage Refused']) {
      if (targetsOf(terminal).length !== 0) {
        errors.push(`"${terminal}" must be terminal — found outgoing edge(s)`);
      }
    }
    const stageTargets = targetsOf('Stage Intake — Demo State');
    if (stageTargets.length !== 1 || stageTargets[0].node !== 'Interpret Stage Result') {
      errors.push(
        `"Stage Intake — Demo State" must feed exactly "Interpret Stage Result" and nothing else — every staged-intake outcome is classified before any response (found: ${JSON.stringify(stageTargets.map((edge) => edge.node))})`
      );
    }
    const interpretTargets = targetsOf('Interpret Stage Result');
    if (interpretTargets.length !== 1 || interpretTargets[0].node !== 'IF Staged') {
      errors.push(
        `"Interpret Stage Result" must feed exactly "IF Staged" and nothing else (found: ${JSON.stringify(interpretTargets.map((edge) => edge.node))})`
      );
    }
    // Sticky notes are canvas documentation, never graph members.
    for (const stickyName of ['Sticky Note — Gated Boundary', 'Sticky Note — Validation']) {
      if (targetsOf(stickyName).length !== 0 || Object.hasOwn(connections, stickyName)) {
        errors.push(`sticky note "${stickyName}" must never appear in connections`);
      }
    }
    // Every connection endpoint must be a declared node.
    for (const [source, definition] of Object.entries(connections)) {
      if (!nodesByName.has(source)) {
        errors.push(`connection source "${source}" is not a declared node`);
      }
      for (const branch of definition?.main ?? []) {
        for (const edge of branch ?? []) {
          if (!nodesByName.has(edge.node)) {
            errors.push(`connection target "${edge.node}" (from "${source}") is not a declared node`);
          }
        }
      }
    }
    // Reachability: every non-sticky node must be reachable from the webhook.
    const adjacency = new Map();
    for (const [source, definition] of Object.entries(connections)) {
      for (const branch of definition?.main ?? []) {
        for (const edge of branch ?? []) {
          if (!adjacency.has(source)) adjacency.set(source, new Set());
          adjacency.get(source).add(edge.node);
        }
      }
    }
    const reachable = new Set(['Webhook — Gated Intake']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [source, targets] of adjacency) {
        if (reachable.has(source)) {
          for (const target of targets) {
            if (!reachable.has(target)) {
              reachable.add(target);
              grew = true;
            }
          }
        }
      }
    }
    for (const node of parsed.nodes ?? []) {
      if (node.type !== STICKY_TYPE && !reachable.has(node.name)) {
        errors.push(`node "${node.name}" is unreachable from the webhook — orphan branches are how bypasses hide`);
      }
    }
    if (errors.length === 0) invariants.push(label);
  }

  // --- invariant: single validity decision branch ----------------------------
  // The ONLY data-decision branches are the validity gate ($json.valid) and
  // the pinned staged-intake outcome routers ($json.outcome ∈ staged/replay/
  // conflict). Urgency or any other data must never branch anywhere.
  {
    const label = 'single-validity-branch';
    const ifNodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter((node) => node.type === IF_TYPE);
    const expectedIfNames = ['IF Valid', 'IF Staged', 'IF Replay', 'IF Conflict'];
    const ifNames = ifNodes.map((node) => node.name);
    if (JSON.stringify(ifNames) !== JSON.stringify(expectedIfNames)) {
      errors.push(
        `expected exactly the IF nodes [${expectedIfNames.join(', ')}] in order — found [${ifNames.join(', ')}] — urgency or any other data must never branch`
      );
    } else {
      const conditions = ifNodes[0].parameters?.conditions;
      const entries = conditions?.conditions;
      if (!Array.isArray(entries) || entries.length !== 1) {
        errors.push('"IF Valid" must carry exactly one condition');
      } else {
        const condition = entries[0];
        if (condition.leftValue !== VALID_IF_LEFT) {
          errors.push(`"IF Valid" condition must test exactly ${VALID_IF_LEFT}, found ${JSON.stringify(condition.leftValue)} — repurposing the gate to urgency or any other field is a bypass`);
        }
        if (condition.operator?.type !== 'boolean' || condition.operator?.operation !== 'equals' || condition.rightValue !== true) {
          errors.push(`"IF Valid" condition must be a boolean equals-true test, found ${JSON.stringify(condition.operator)} / ${JSON.stringify(condition.rightValue)}`);
        }
      }
      // The outcome routers may test ONLY the interpreted staging outcome.
      const outcomePins = [
        ['IF Staged', 'staged', 'Respond — Pending Review', 'IF Replay'],
        ['IF Replay', 'replay', 'Respond — Intake Replay', 'IF Conflict'],
        ['IF Conflict', 'conflict', 'Respond — Intake Conflict', 'Respond — Stage Refused'],
      ];
      for (const [nodeName, outcome, trueTarget, falseTarget] of outcomePins) {
        checkIfNode(parsed, nodeName, '={{ $json.outcome }}', { type: 'string', operation: 'equals' }, outcome, errors);
        const branches = parsed.connections?.[nodeName]?.main;
        if (!Array.isArray(branches) || branches.length !== 2) {
          errors.push(`"${nodeName}" must have exactly two branches (outcome → response, else → next router)`);
        } else {
          const trueTargets = (branches[0] ?? []).map((edge) => edge.node);
          const falseTargets = (branches[1] ?? []).map((edge) => edge.node);
          if (trueTargets.length !== 1 || trueTargets[0] !== trueTarget) {
            errors.push(`"${nodeName}" true branch must feed exactly "${trueTarget}" (found: ${JSON.stringify(trueTargets)})`);
          }
          if (falseTargets.length !== 1 || falseTargets[0] !== falseTarget) {
            errors.push(`"${nodeName}" false branch must feed exactly "${falseTarget}" (found: ${JSON.stringify(falseTargets)})`);
          }
        }
      }
      const validBranches = parsed.connections?.['IF Valid']?.main;
      if (!Array.isArray(validBranches) || validBranches.length !== 2) {
        errors.push('"IF Valid" must have exactly two branches (valid → staging, invalid → validation error)');
      } else {
        const validTargets = (validBranches[0] ?? []).map((edge) => edge.node);
        const invalidTargets = (validBranches[1] ?? []).map((edge) => edge.node);
        if (validTargets.length !== 1 || validTargets[0] !== 'Stage Intake — Demo State') {
          errors.push(`"IF Valid" true branch must feed exactly "Stage Intake — Demo State" (found: ${JSON.stringify(validTargets)})`);
        }
        if (invalidTargets.length !== 1 || invalidTargets[0] !== 'Respond — Validation Error') {
          errors.push(`"IF Valid" false branch must feed exactly "Respond — Validation Error" (found: ${JSON.stringify(invalidTargets)})`);
        }
      }
    }
    if (errors.length === 0) invariants.push(label);
  }

  // --- invariant: graph-wide URL locality -------------------------------------
  {
    const label = 'url-locality';
    const urls = collectUrls(parsed);
    for (const { url, at } of urls) {
      if (url !== MOCK_ORIGIN && !url.startsWith(`${MOCK_ORIGIN}/`)) {
        errors.push(`non-local URL ${url} found at ${at || '(root)'} — every URL anywhere in the graph must resolve to ${MOCK_ORIGIN}`);
      }
    }
    for (const node of parsed.nodes ?? []) {
      if (node.type === HTTP_REQUEST_TYPE && typeof node.parameters?.url === 'string') {
        if (node.parameters.url !== MOCK_ORIGIN && !node.parameters.url.startsWith(`${MOCK_ORIGIN}/`)) {
          errors.push(`HTTP Request node "${node.name}" URL is not local: ${node.parameters.url}`);
        }
      }
    }
    if (errors.length === 0) invariants.push(label);
  }

  // --- invariant: pinned webhook shape ----------------------------------------
  {
    const label = 'webhook-shape';
    const webhooks = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter((node) => node.type === WEBHOOK_TYPE);
    if (webhooks.length !== 1) {
      errors.push(`expected exactly one webhook node, found ${webhooks.length}`);
    } else {
      const webhook = webhooks[0];
      if (webhook.parameters?.httpMethod !== 'POST') {
        errors.push(`webhook httpMethod must be POST, found ${JSON.stringify(webhook.parameters?.httpMethod)}`);
      }
      if (webhook.parameters?.responseMode !== 'responseNode') {
        errors.push(`webhook responseMode must be "responseNode" so the graph controls the response truthfully, found ${JSON.stringify(webhook.parameters?.responseMode)}`);
      }
      if (webhook.parameters?.path !== INTAKE_WEBHOOK_PATH) {
        errors.push(`webhook path must be exactly "${INTAKE_WEBHOOK_PATH}", found ${JSON.stringify(webhook.parameters?.path)}`);
      }
    }
    // The pinned envelope unwrap contract must be present in the validate code.
    const validate = nodesByName.get('Validate Intake');
    if (!validate || validate.type !== CODE_TYPE || typeof validate.parameters?.jsCode !== 'string') {
      errors.push('a Code node "Validate Intake" with jsCode is required');
    } else if (!validate.parameters.jsCode.includes(WEBHOOK_BODY_UNWRAP)) {
      errors.push(`"Validate Intake" jsCode must contain the pinned webhook body-envelope unwrap contract (${WEBHOOK_BODY_UNWRAP})`);
    }
    if (errors.length === 0) invariants.push(label);
  }

  // --- invariant: stable intake key + canonical hash forwarding --------------
  // The graph boundary must REQUIRE the stable caller key, compute the
  // canonical payload hash IN-GRAPH (inline SHA-256 over the canonical JSON),
  // and forward BOTH with the staged content. Dropping any of the three
  // removes the graph-side integrity proof for replay/conflict semantics —
  // the mock enforces it too, but this contract is independent of the mock
  // implementation (T-02-09).
  {
    const label = 'stable-key-and-hash-forwarding';
    const validate = nodesByName.get('Validate Intake');
    const validateCode = typeof validate?.parameters?.jsCode === 'string' ? validate.parameters.jsCode : '';
    if (!validate || validate.type !== CODE_TYPE) {
      errors.push('a Code node "Validate Intake" with jsCode is required');
    } else {
      if (!validateCode.includes("'x-intake-idempotency-key'")) {
        errors.push('"Validate Intake" jsCode must require the stable intake key from the X-Intake-Idempotency-Key header — no key, no staging');
      }
      if (!validateCode.includes('sha256hex(unescape(encodeURIComponent(canonicalString)))')) {
        errors.push('"Validate Intake" jsCode must compute the canonical payload hash in-graph via inline SHA-256 — a constant or omitted hash removes the integrity proof');
      }
      if (!validateCode.includes('payload_hash')) {
        errors.push('"Validate Intake" jsCode must emit the computed payload_hash alongside the stable key');
      }
    }
    const stage = nodesByName.get('Stage Intake — Demo State');
    const stageBody = typeof stage?.parameters?.jsonBody === 'string' ? stage.parameters.jsonBody : '';
    if (!stage || stage.type !== HTTP_REQUEST_TYPE) {
      errors.push('the staging HTTP node "Stage Intake — Demo State" is required');
    } else {
      if (!stageBody.includes('idempotency_key: $json.idempotency_key')) {
        errors.push('"Stage Intake — Demo State" must forward the stable intake key (idempotency_key: $json.idempotency_key) — dropping it defeats replay/conflict detection');
      }
      if (!stageBody.includes('payload_hash: $json.payload_hash')) {
        errors.push('"Stage Intake — Demo State" must forward the in-graph canonical payload hash (payload_hash: $json.payload_hash) — the state service fails closed without it');
      }
    }
    if (errors.length === 0) invariants.push(label);
  }

  // --- invariant: pinned load-bearing code hashes (CR-03) --------------------
  {
    const label = 'pinned-code-hashes';
    checkPinnedCodeNodes(parsed, PINNED_CODE_NODE_SHA256.intake, 'intake', errors);
    if (!errors.length) invariants.push(label);
  }

  // --- invariant: immutable historical control --------------------------------
  let historicalSourceOk = false;
  let historicalSourceSha256 = '';
  {
    const label = 'historical-source-hash';
    try {
      const historicalBytes = readFileSync(HISTORICAL_SOURCE_PATH);
      historicalSourceSha256 = sha256(historicalBytes);
      if (historicalSourceSha256 !== HISTORICAL_SOURCE_SHA256) {
        errors.push(
          `immutable historical source drifted: expected ${HISTORICAL_SOURCE_SHA256}, found ${historicalSourceSha256} — the Phase 1 control must stay byte-identical`
        );
      } else {
        historicalSourceOk = true;
      }
    } catch (error) {
      errors.push(`could not verify the immutable historical source (${HISTORICAL_SOURCE_PATH}): ${error.message}`);
    }
    if (historicalSourceOk) invariants.push(label);
  }

  return {
    ok: errors.length === 0,
    errors,
    workflowSha256: sha256(workflowBytes),
    urlsChecked: collectUrls(parsed).length,
    invariants,
    historicalSourceOk,
    historicalSourceSha256,
  };
}

// ---------------------------------------------------------------------------
// Plan 02-02 Task 3: reviewer/delivery graph contracts + the three-graph
// combined check proving the recorded approval assertion is the only CRM
// predecessor and no bypass topology verifies.
// ---------------------------------------------------------------------------

export const EXPECTED_REVIEWER_NODE_ORDER = Object.freeze([
  { name: 'Webhook — Reviewer Decision', type: WEBHOOK_TYPE },
  { name: 'Validate Decision', type: CODE_TYPE },
  { name: 'IF Decision Valid', type: IF_TYPE },
  { name: 'Respond — Decision Error', type: RESPOND_TYPE },
  { name: 'Record Decision — Demo State', type: HTTP_REQUEST_TYPE },
  { name: 'Interpret Decision Record', type: CODE_TYPE },
  { name: 'IF Recorded', type: IF_TYPE },
  { name: 'Respond — Decision Refused', type: RESPOND_TYPE },
  { name: 'IF Approved', type: IF_TYPE },
  { name: 'Invoke Approved Delivery', type: HTTP_REQUEST_TYPE },
  { name: 'Respond — Approved', type: RESPOND_TYPE },
  { name: 'Respond — Decision Recorded', type: RESPOND_TYPE },
  { name: 'Sticky Note — Reviewer Gate', type: STICKY_TYPE },
  { name: 'Sticky Note — Decision Rules', type: STICKY_TYPE },
]);

export const EXPECTED_DELIVERY_NODE_ORDER = Object.freeze([
  { name: 'Webhook — Approved Delivery', type: WEBHOOK_TYPE },
  { name: 'Load Delivery State — Demo', type: HTTP_REQUEST_TYPE },
  { name: 'Classify Delivery State', type: CODE_TYPE },
  { name: 'IF Already Committed', type: IF_TYPE },
  { name: 'Respond — Existing Delivery', type: RESPOND_TYPE },
  { name: 'IF Deliverable', type: IF_TYPE },
  { name: 'Assert Approved — Delivery State', type: CODE_TYPE },
  { name: 'CRM Create — Demo Boundary', type: HTTP_REQUEST_TYPE },
  { name: 'Interpret CRM Result', type: CODE_TYPE },
  { name: 'IF CRM Delivered', type: IF_TYPE },
  { name: 'Respond — Delivered', type: RESPOND_TYPE },
  { name: 'Respond — Delivery Retryable', type: RESPOND_TYPE },
  { name: 'Respond — Delivery Refused', type: RESPOND_TYPE },
  { name: 'Sticky Note — Delivery Boundary', type: STICKY_TYPE },
  { name: 'Sticky Note — State Contract', type: STICKY_TYPE },
]);

const REVIEWER_ASSERT_NODE = 'Assert Approved — Delivery State';
const REVIEWER_CRM_NODE = 'CRM Create — Demo Boundary';

function loadWorkflow(workflow) {
  if (typeof workflow === 'string') {
    const workflowBytes = readFileSync(workflow);
    return { parsed: JSON.parse(workflowBytes.toString('utf8')), workflowBytes };
  }
  const parsed = structuredClone(workflow);
  return { parsed, workflowBytes: Buffer.from(JSON.stringify(parsed, null, 2)) };
}

/**
 * Verify the committed reviewer-decision export. The deliberate event graph:
 * exact composition, the decision-record HTTP node pinned to the local
 * decision route, the delivery invocation reachable ONLY from the recorded
 * approval branch, and no CRM capability anywhere.
 */
export function verifyReviewerWorkflow(workflow) {
  const errors = [];
  const invariants = [];
  const { parsed, workflowBytes } = loadWorkflow(workflow);

  {
    const label = 'portability';
    checkPortability(parsed, errors);
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'node-allowlist-and-order';
    for (const node of parsed.nodes ?? []) {
      if (!ALLOWED_NODE_TYPES.includes(node.type)) {
        errors.push(`unsupported node type "${node.type}" on node "${node.name}" — allowed types: ${ALLOWED_NODE_TYPES.join(', ')}`);
      }
    }
    checkComposition(parsed, EXPECTED_REVIEWER_NODE_ORDER, errors);
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'decision-and-invoke-urls';
    const httpNodes = (parsed.nodes ?? []).filter((node) => node.type === HTTP_REQUEST_TYPE);
    if (httpNodes.length !== 2) {
      errors.push(`the reviewer graph must carry exactly two HTTP nodes (decision record + delivery invocation), found ${httpNodes.length}`);
    }
    const record = (parsed.nodes ?? []).find((node) => node.name === 'Record Decision — Demo State');
    if (!record || record.parameters?.url !== DECISION_URL) {
      errors.push(`the decision-record node URL must be exactly ${DECISION_URL}, found ${JSON.stringify(record?.parameters?.url)}`);
    }
    const invoke = (parsed.nodes ?? []).find((node) => node.name === 'Invoke Approved Delivery');
    if (!invoke || invoke.parameters?.url !== DELIVERY_INVOKE_URL) {
      errors.push(`the delivery invocation URL must be exactly ${DELIVERY_INVOKE_URL}, found ${JSON.stringify(invoke?.parameters?.url)}`);
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'approval-only-delivery-edge';
    const approvedBranches = branchesOf(parsed, 'IF Approved');
    if (approvedBranches === null) {
      errors.push('"IF Approved" must exist with exactly two branches');
    } else {
      const trueTargets = approvedBranches[0] ?? [];
      const falseTargets = approvedBranches[1] ?? [];
      if (trueTargets.length !== 1 || trueTargets[0] !== 'Invoke Approved Delivery') {
        errors.push(`"IF Approved" true branch must feed exactly "Invoke Approved Delivery" (found: ${JSON.stringify(trueTargets)})`);
      }
      if (falseTargets.length !== 1 || falseTargets[0] !== 'Respond — Decision Recorded') {
        errors.push(
          `"IF Approved" false branch must feed exactly "Respond — Decision Recorded" — rejection and refusal have NO delivery edge (found: ${JSON.stringify(falseTargets)})`
        );
      }
    }
    const invokeBranches = branchesOf(parsed, 'Invoke Approved Delivery');
    if (!invokeBranches || JSON.stringify(invokeBranches) !== JSON.stringify([['Respond — Approved']])) {
      errors.push(`"Invoke Approved Delivery" must feed exactly "Respond — Approved" and nothing else (found: ${JSON.stringify(invokeBranches)})`);
    }
    // The invocation is reachable ONLY from the recorded approval branch:
    // exactly one incoming edge, from "IF Approved" true branch — wiring it
    // from the refusal/rejection side is a bypass topology.
    const invokeIncoming = allEdges(parsed).filter((edge) => edge.target === 'Invoke Approved Delivery');
    if (invokeIncoming.length !== 1 || invokeIncoming[0].source !== 'IF Approved' || invokeIncoming[0].branchIndex !== 0) {
      errors.push(
        `"Invoke Approved Delivery" must be reachable ONLY from the "IF Approved" true branch (found incoming: ${JSON.stringify(invokeIncoming.map((edge) => `${edge.source}[${edge.branchIndex}]`))}) — refusal/rejection paths must have no delivery edge`
      );
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'no-crm-capability';
    const urls = collectUrls(parsed);
    for (const { url, at } of urls) {
      if (url !== MOCK_ORIGIN && !url.startsWith(`${MOCK_ORIGIN}/`) && url !== N8N_ORIGIN && !url.startsWith(`${N8N_ORIGIN}/`)) {
        errors.push(`non-local URL ${url} found at ${at || '(root)'} — reviewer graph URLs must resolve to ${MOCK_ORIGIN} or ${N8N_ORIGIN}`);
      }
    }
    for (const node of parsed.nodes ?? []) {
      if (typeof node.parameters?.url === 'string' && node.parameters.url.includes('/demo/v1/crm/')) {
        errors.push(`CRM route on reviewer node "${node.name}" — only the approved-delivery graph may reference the CRM HTTP route`);
      }
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'decision-validation-contract';
    checkWebhookShape(parsed, REVIEWER_WEBHOOK_PATH, errors);
    const validate = (parsed.nodes ?? []).find((node) => node.name === 'Validate Decision');
    const code = validate?.parameters?.jsCode ?? '';
    if (!validate || validate.type !== CODE_TYPE) {
      errors.push('a Code node "Validate Decision" is required');
    } else {
      if (!code.includes(WEBHOOK_BODY_UNWRAP)) {
        errors.push(`"Validate Decision" jsCode must contain the pinned webhook body-envelope unwrap contract (${WEBHOOK_BODY_UNWRAP})`);
      }
      if (!code.includes("decision !== 'approve' && decision !== 'reject'")) {
        errors.push('"Validate Decision" jsCode must enforce the exact approve/reject decision enum — anything else fails closed');
      }
      if (!code.includes("'x-reviewer-proof'")) {
        errors.push('"Validate Decision" jsCode must require the one-time reviewer proof header');
      }
    }
    checkIfNode(parsed, 'IF Decision Valid', '={{ $json.valid }}', { type: 'boolean', operation: 'equals' }, true, errors);
    checkIfNode(parsed, 'IF Recorded', '={{ $json.recorded }}', { type: 'boolean', operation: 'equals' }, true, errors);
    checkIfNode(parsed, 'IF Approved', '={{ $json.review_state }}', { type: 'string', operation: 'equals' }, 'approved', errors);
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'terminal-responses';
    for (const terminal of ['Respond — Decision Error', 'Respond — Decision Refused', 'Respond — Approved', 'Respond — Decision Recorded']) {
      if (branchesOf(parsed, terminal) !== null) {
        errors.push(`"${terminal}" must be terminal — found outgoing edge(s)`);
      }
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'pinned-code-hashes';
    checkPinnedCodeNodes(parsed, PINNED_CODE_NODE_SHA256.reviewer, 'reviewer', errors);
    if (!errors.length) invariants.push(label);
  }

  return {
    ok: errors.length === 0,
    errors,
    workflowSha256: sha256(workflowBytes),
    urlsChecked: collectUrls(parsed).length,
    invariants,
  };
}

/**
 * Verify the committed approved-delivery export. The load-bearing contract:
 * the CRM node's sole immediate predecessor is the fail-closed approval
 * assertion Code node carrying every recorded-state invariant, the
 * committed-replay branch terminates before the assertion, and no IF node
 * can route anything but an explicit candidate classification toward it.
 */
export function verifyDeliveryWorkflow(workflow) {
  const errors = [];
  const invariants = [];
  const { parsed, workflowBytes } = loadWorkflow(workflow);

  {
    const label = 'portability';
    checkPortability(parsed, errors);
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'node-allowlist-and-order';
    for (const node of parsed.nodes ?? []) {
      if (!ALLOWED_NODE_TYPES.includes(node.type)) {
        errors.push(`unsupported node type "${node.type}" on node "${node.name}" — allowed types: ${ALLOWED_NODE_TYPES.join(', ')}`);
      }
    }
    checkComposition(parsed, EXPECTED_DELIVERY_NODE_ORDER, errors);
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'single-crm-node';
    const httpNodes = (parsed.nodes ?? []).filter((node) => node.type === HTTP_REQUEST_TYPE);
    if (httpNodes.length !== 2) {
      errors.push(`the delivery graph must carry exactly two HTTP nodes (state load + CRM), found ${httpNodes.length}`);
    }
    const crmNodes = httpNodes.filter((node) => node.parameters?.url === CRM_URL);
    if (crmNodes.length !== 1 || crmNodes[0]?.name !== REVIEWER_CRM_NODE) {
      errors.push(`exactly one node named "${REVIEWER_CRM_NODE}" may reference the CRM route ${CRM_URL}, found ${crmNodes.length}`);
    }
    const load = (parsed.nodes ?? []).find((node) => node.name === 'Load Delivery State — Demo');
    if (!load || load.parameters?.url !== DELIVERY_STATE_URL) {
      errors.push(`the state-load node URL must be exactly ${DELIVERY_STATE_URL}, found ${JSON.stringify(load?.parameters?.url)}`);
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'assertion-sole-crm-predecessor';
    const incoming = allEdges(parsed).filter((edge) => edge.target === REVIEWER_CRM_NODE);
    if (incoming.length !== 1 || incoming[0].source !== REVIEWER_ASSERT_NODE) {
      errors.push(
        `the CRM node's sole immediate predecessor must be "${REVIEWER_ASSERT_NODE}" (found: ${JSON.stringify(incoming.map((edge) => edge.source))}) — every other topology is a bypass`
      );
    }
    const assertBranches = branchesOf(parsed, REVIEWER_ASSERT_NODE);
    if (!assertBranches || JSON.stringify(assertBranches) !== JSON.stringify([[REVIEWER_CRM_NODE]])) {
      errors.push(`"${REVIEWER_ASSERT_NODE}" must feed exactly "${REVIEWER_CRM_NODE}" and nothing else (found: ${JSON.stringify(assertBranches)})`);
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'assertion-guard-body';
    const assert = (parsed.nodes ?? []).find((node) => node.name === REVIEWER_ASSERT_NODE);
    if (!assert || assert.type !== CODE_TYPE || typeof assert.parameters?.jsCode !== 'string') {
      errors.push(`a Code node "${REVIEWER_ASSERT_NODE}" with jsCode is required immediately before the CRM node`);
    } else {
      const code = assert.parameters.jsCode;
      const guards = [
        ["review.state !== 'approved'", 'exact approved state'],
        ['review.approval.recorded !== true', 'separately recorded reviewer approval'],
        ["delivery.state !== 'pending' && delivery.state !== 'retryable'", 'pending/retryable delivery state'],
        ["'crmkey_' + review.review_id", 'stable CRM idempotency key'],
        ['delivery.payload_hash', 'recorded payload hash comparison'],
        ['sha256hex', 'in-graph payload hash recomputation'],
        ['throw new Error', 'fail-closed throws'],
      ];
      for (const [marker, description] of guards) {
        if (!code.includes(marker)) {
          errors.push(`"${REVIEWER_ASSERT_NODE}" jsCode must contain the ${description} guard (marker: ${marker})`);
        }
      }
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'classifier-and-branch-pinning';
    const classify = (parsed.nodes ?? []).find((node) => node.name === 'Classify Delivery State');
    const classifyCode = classify?.parameters?.jsCode ?? '';
    if (!classify || classify.type !== CODE_TYPE) {
      errors.push('a Code node "Classify Delivery State" is required');
    } else {
      // The committed classification must be driven by the DELIVERY STATE
      // itself — merely mentioning 'committed' is not enough; removing the
      // state check silently routes committed replays into the candidate path.
      for (const marker of ["delivery.state === 'committed'", "'candidate'", "'refused'"]) {
        if (!classifyCode.includes(marker)) {
          errors.push(`"Classify Delivery State" jsCode must produce the ${marker} classification`);
        }
      }
    }
    checkIfNode(parsed, 'IF Already Committed', '={{ $json.classification }}', { type: 'string', operation: 'equals' }, 'committed', errors);
    checkIfNode(parsed, 'IF Deliverable', '={{ $json.classification }}', { type: 'string', operation: 'equals' }, 'candidate', errors);
    const committedBranches = branchesOf(parsed, 'IF Already Committed');
    if (!committedBranches || JSON.stringify(committedBranches) !== JSON.stringify([['Respond — Existing Delivery'], ['IF Deliverable']])) {
      errors.push(
        `"IF Already Committed" must route true → "Respond — Existing Delivery" (terminal, pre-assertion) and false → "IF Deliverable" (found: ${JSON.stringify(committedBranches)})`
      );
    }
    const deliverableBranches = branchesOf(parsed, 'IF Deliverable');
    if (!deliverableBranches || JSON.stringify(deliverableBranches) !== JSON.stringify([[REVIEWER_ASSERT_NODE], ['Respond — Delivery Refused']])) {
      errors.push(
        `"IF Deliverable" must route true → "${REVIEWER_ASSERT_NODE}" and false → "Respond — Delivery Refused" (found: ${JSON.stringify(deliverableBranches)})`
      );
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'url-locality';
    const urls = collectUrls(parsed);
    for (const { url, at } of urls) {
      if (url !== MOCK_ORIGIN && !url.startsWith(`${MOCK_ORIGIN}/`)) {
        errors.push(`non-local URL ${url} found at ${at || '(root)'} — every URL in the delivery graph must resolve to ${MOCK_ORIGIN}`);
      }
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'webhook-shape';
    checkWebhookShape(parsed, DELIVERY_WEBHOOK_PATH, errors);
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'replay-route-and-sanitization';
    // The assertion node's incoming edges: EXACTLY one, from the candidate
    // branch. Any alternate route into the assertion (a state-load edge, a
    // committed-branch edge) is a replay path that bypasses classification.
    const assertIncoming = allEdges(parsed).filter((edge) => edge.target === REVIEWER_ASSERT_NODE);
    if (assertIncoming.length !== 1 || assertIncoming[0].source !== 'IF Deliverable' || assertIncoming[0].branchIndex !== 0) {
      errors.push(
        `"${REVIEWER_ASSERT_NODE}" must be reachable ONLY from the "IF Deliverable" true branch (found incoming: ${JSON.stringify(assertIncoming.map((edge) => `${edge.source}[${edge.branchIndex}]`))}) — alternate replay routes into the assertion are rejected`
      );
    }

    // The CRM node must send the STORED stable idempotency key on every
    // attempt — a per-attempt or derived key would defeat effect
    // deduplication across the deliberate recovery retry.
    const crmNode = (parsed.nodes ?? []).find((node) => node.name === REVIEWER_CRM_NODE);
    const crmBody = typeof crmNode?.parameters?.jsonBody === 'string' ? crmNode.parameters.jsonBody : '';
    if (!crmNode) {
      errors.push(`the CRM node "${REVIEWER_CRM_NODE}" is required`);
    } else if (!crmBody.includes('idempotency_key: $json.idempotency_key')) {
      errors.push(
        `"${REVIEWER_CRM_NODE}" must send the stored stable CRM idempotency key (idempotency_key: $json.idempotency_key) on every attempt — a per-attempt key breaks effect deduplication`
      );
    }

    // The committed-replay response must be SANITIZED: stored identity only
    // (review/effect ids, stable key, message) — never raw payload or
    // contact material.
    const existing = (parsed.nodes ?? []).find((node) => node.name === 'Respond — Existing Delivery');
    const existingBody = typeof existing?.parameters?.responseBody === 'string' ? existing.parameters.responseBody : '';
    if (!existing) {
      errors.push('the committed-replay response node "Respond — Existing Delivery" is required');
    } else if (/(payload|email|phone|contact)/i.test(existingBody)) {
      errors.push(
        '"Respond — Existing Delivery" must return the stored sanitized delivery identity only — raw payload/contact material in the committed-replay response is an information disclosure'
      );
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'crm-outcome-interpretation';
    // The CRM result MUST be interpreted before any delivery claim: only an
    // explicit committed/exists effect may answer 'delivered'; the pre-commit
    // application failure answers retryable. Wiring the CRM node straight to
    // a delivered response would claim delivery for failed attempts.
    const crmOutgoing = branchesOf(parsed, REVIEWER_CRM_NODE);
    if (!crmOutgoing || JSON.stringify(crmOutgoing) !== JSON.stringify([['Interpret CRM Result']])) {
      errors.push(
        `"${REVIEWER_CRM_NODE}" must feed exactly "Interpret CRM Result" and nothing else — a delivery claim requires an interpreted CRM outcome (found: ${JSON.stringify(crmOutgoing)})`
      );
    }
    const interpretOutgoing = branchesOf(parsed, 'Interpret CRM Result');
    if (!interpretOutgoing || JSON.stringify(interpretOutgoing) !== JSON.stringify([['IF CRM Delivered']])) {
      errors.push(`"Interpret CRM Result" must feed exactly "IF CRM Delivered" (found: ${JSON.stringify(interpretOutgoing)})`);
    }
    checkIfNode(parsed, 'IF CRM Delivered', '={{ $json.outcome }}', { type: 'string', operation: 'equals' }, 'delivered', errors);
    const crmDeliveredBranches = branchesOf(parsed, 'IF CRM Delivered');
    if (
      !crmDeliveredBranches ||
      JSON.stringify(crmDeliveredBranches) !== JSON.stringify([['Respond — Delivered'], ['Respond — Delivery Retryable']])
    ) {
      errors.push(
        `"IF CRM Delivered" must route true → "Respond — Delivered" and false → "Respond — Delivery Retryable" (found: ${JSON.stringify(crmDeliveredBranches)})`
      );
    }
    const interpret = (parsed.nodes ?? []).find((node) => node.name === 'Interpret CRM Result');
    const interpretCode = interpret?.parameters?.jsCode ?? '';
    if (!interpret || interpret.type !== CODE_TYPE) {
      errors.push('a Code node "Interpret CRM Result" is required after the CRM node');
    } else {
      for (const marker of ["'committed'", 'fault_injected', 'committed: false', 'retryable']) {
        if (!interpretCode.includes(marker)) {
          errors.push(`"Interpret CRM Result" jsCode must distinguish the ${marker} outcome — a pre-commit application failure is never a delivery`);
        }
      }
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'terminal-responses';
    for (const terminal of ['Respond — Existing Delivery', 'Respond — Delivered', 'Respond — Delivery Retryable', 'Respond — Delivery Refused']) {
      if (branchesOf(parsed, terminal) !== null) {
        errors.push(`"${terminal}" must be terminal — found outgoing edge(s)`);
      }
    }
    if (!errors.length) invariants.push(label);
  }
  {
    const label = 'pinned-code-hashes';
    checkPinnedCodeNodes(parsed, PINNED_CODE_NODE_SHA256.delivery, 'delivery', errors);
    if (!errors.length) invariants.push(label);
  }

  return {
    ok: errors.length === 0,
    errors,
    workflowSha256: sha256(workflowBytes),
    urlsChecked: collectUrls(parsed).length,
    invariants,
  };
}

/**
 * Verify all three committed gated exports together: each graph against its
 * own contract plus the cross-graph rules — ONLY the delivery workflow may
 * contain the CRM HTTP route, and the reviewer's delivery invocation must
 * target the delivery workflow's registered webhook path.
 */
export function verifyAllGatedWorkflows({ intake, reviewer, delivery }) {
  const errors = [];
  const reports = {};

  const attempt = (key, verifier, value) => {
    try {
      reports[key] = verifier(value);
    } catch (error) {
      reports[key] = {
        ok: false,
        errors: [`verification failed: ${error.message}`],
        workflowSha256: null,
        urlsChecked: 0,
        invariants: [],
      };
    }
    if (!reports[key].ok) errors.push(`${key}: ${reports[key].errors.join('; ')}`);
  };
  attempt('intake', verifyGatedWorkflow, intake);
  attempt('reviewer', verifyReviewerWorkflow, reviewer);
  attempt('delivery', verifyDeliveryWorkflow, delivery);

  // Cross-graph CRM exclusivity: scan the raw parsed objects so a CRM route
  // hidden anywhere (node URL, sticky, expression) outside delivery fails.
  const scanForCrmRoute = (key, value) => {
    try {
      const { parsed } = loadWorkflow(value);
      if (JSON.stringify(parsed).includes('/demo/v1/crm/')) {
        errors.push(`only the delivery workflow may contain the CRM HTTP route — found it in the ${key} graph`);
      }
    } catch {
      errors.push(`${key}: could not parse for the cross-graph CRM exclusivity scan`);
    }
  };
  scanForCrmRoute('intake', intake);
  scanForCrmRoute('reviewer', reviewer);

  return { ok: errors.length === 0, errors, reports };
}

// CLI: node runtime/scripts/verify-gated-workflows.mjs <workflow.json> [more...]
// Prints one machine-readable JSON report per workflow and exits 0 only when
// every presented workflow verifies. Files are dispatched by basename:
// intake-stage.json → intake contract, reviewer-decision.json → reviewer
// contract, approved-delivery.json → delivery contract, anything else → the
// intake contract (legacy single-file behavior). When all three known
// exports are presented together, the cross-graph rules run too. An
// exception is a failure, never a pass.
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('usage: node runtime/scripts/verify-gated-workflows.mjs <workflow.json> [more...]\n');
    process.exit(2);
  }
  const dispatch = (target) => {
    const base = path.basename(target);
    if (base === 'reviewer-decision.json') return verifyReviewerWorkflow;
    if (base === 'approved-delivery.json') return verifyDeliveryWorkflow;
    return verifyGatedWorkflow;
  };
  const knownTrio = ['intake-stage.json', 'reviewer-decision.json', 'approved-delivery.json'];
  const basenames = targets.map((target) => path.basename(target));
  const runCross = knownTrio.every((name) => basenames.includes(name));
  const reports = [];
  for (const target of targets) {
    let report;
    try {
      report = dispatch(target)(target);
    } catch (error) {
      report = {
        ok: false,
        errors: [`verification failed: ${error.message}`],
        workflowSha256: null,
        urlsChecked: 0,
        invariants: [],
        historicalSourceOk: false,
        historicalSourceSha256: '',
      };
    }
    reports.push({ workflow: target, ...report });
  }
  if (runCross) {
    const combined = verifyAllGatedWorkflows({
      intake: targets.find((target) => path.basename(target) === 'intake-stage.json'),
      reviewer: targets.find((target) => path.basename(target) === 'reviewer-decision.json'),
      delivery: targets.find((target) => path.basename(target) === 'approved-delivery.json'),
    });
    if (!combined.ok) {
      const deliveryReport = reports.find((report) => path.basename(report.workflow) === 'approved-delivery.json');
      const targetReport = deliveryReport ?? reports[reports.length - 1];
      targetReport.ok = false;
      targetReport.errors = [...(targetReport.errors ?? []), ...combined.errors.map((error) => `cross-graph: ${error}`)];
    }
  }
  process.stdout.write(`${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`);
  process.exit(reports.every((report) => report.ok) ? 0 : 1);
}
