// Deterministic endpoint and credential-placeholder mapper for the Flagship
// Intake baseline runtime (D-06).
//
// Reads the tracked source workflow (never writes it) and produces an
// ephemeral runtime copy under runtime/.generated/ in which:
//   - every HTTP Request node's URL value is mapped to the local Compose mock
//     service, preserving any n8n expression tail, and
//   - the five nodes that already declare `genericCredentialType` /
//     `genericAuthType: httpHeaderAuth` gain the one fixed local credential
//     reference imported by the launcher.
//   - one exact Validate Fields jsCode line unwraps n8n's Webhook body envelope.
// Node ids/names/types/order, all other expressions/bodies, and the complete
// connections object are preserved verbatim. Anything the
// mapper does not explicitly recognize fails closed (T-01-02/T-01-03).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const MOCK_ORIGIN = 'http://mock-api:9090';

// The single fixed local credential reference every authenticated HTTP node
// resolves after the launcher imports the ephemeral httpHeaderAuth credential.
export const LOCAL_CREDENTIAL_REFERENCE = Object.freeze({
  httpHeaderAuth: Object.freeze({
    id: 'greenfield-local-http-header-auth',
    name: 'Greenfield Local HTTP Header Auth',
  }),
});

// Per-node URL map: exact production URL (asserted against the source, so a
// drifted source fails closed) -> local mock URL. The PATCH node keeps its
// expression tail verbatim.
export const HTTP_NODE_URL_MAP = Object.freeze({
  'Check Duplicates — Airtable': {
    from: 'https://api.airtable.com/v0/YOUR_BASE_ID/Contacts',
    to: `${MOCK_ORIGIN}/airtable/v0/YOUR_BASE_ID/Contacts`,
  },
  'Update Existing Record': {
    from: 'https://api.airtable.com/v0/YOUR_BASE_ID/Contacts/{{ $json.records[0].id }}',
    to: `${MOCK_ORIGIN}/airtable/v0/YOUR_BASE_ID/Contacts/{{ $json.records[0].id }}`,
  },
  'AI Classify Case Type': {
    from: 'https://api.openai.com/v1/chat/completions',
    to: `${MOCK_ORIGIN}/openai/v1/chat/completions`,
  },
  'Human Review Gate — Queue': {
    from: 'https://api.airtable.com/v0/YOUR_BASE_ID/HumanReviewQueue',
    to: `${MOCK_ORIGIN}/airtable/v0/YOUR_BASE_ID/HumanReviewQueue`,
  },
  'Slack Alert — Urgent': {
    from: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK',
    to: `${MOCK_ORIGIN}/slack/services/YOUR/SLACK/WEBHOOK`,
  },
  'CRM Create — Lawmatics': {
    from: 'https://api.lawmatics.com/v1/contacts',
    to: `${MOCK_ORIGIN}/lawmatics/v1/contacts`,
  },
});

// Nodes expected to declare genericCredentialType/httpHeaderAuth. Exactly
// these five gain the local credential reference; Slack must stay
// credential-free exactly as in the source.
export const EXPECTED_AUTH_NODES = Object.freeze([
  'Check Duplicates — Airtable',
  'Update Existing Record',
  'AI Classify Case Type',
  'Human Review Gate — Queue',
  'CRM Create — Lawmatics',
]);

const HTTP_REQUEST_TYPE = 'n8n-nodes-base.httpRequest';
const VALIDATE_FIELDS_NAME = 'Validate Fields';
const SOURCE_INPUT_LINE = 'const input = $input.first().json;';
const BRIDGED_INPUT_LINES = 'const raw = $input.first().json;\nconst input = raw.body ?? raw;';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const declaresHeaderAuth = (node) =>
  node?.parameters?.authentication === 'genericCredentialType' &&
  node?.parameters?.genericAuthType === 'httpHeaderAuth';

/**
 * Derive the runtime workflow copy from `source`.
 *
 * @param {string|object} source path to the tracked workflow JSON, or an
 *   already-parsed workflow object (tests pass objects; the CLI passes paths)
 * @param {string} [destination] path the derived copy is written to; when the
 *   source is an object and no destination is given nothing is written
 * @returns {{sourceWorkflow: object, derivedWorkflow: object, sourceSha256: string,
 *   derivedSha256: string|null, urlMappedNodes: string[], credentialNodes: string[]}}
 */
export function deriveRuntimeWorkflow(source, destination) {
  let sourceBytes;
  let sourceWorkflow;
  if (typeof source === 'string') {
    sourceBytes = readFileSync(source);
    sourceWorkflow = JSON.parse(sourceBytes.toString('utf8'));
  } else {
    sourceWorkflow = structuredClone(source);
    sourceBytes = Buffer.from(JSON.stringify(sourceWorkflow, null, 2));
  }

  const nodes = sourceWorkflow?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error('source workflow has no nodes array');
  }

  const derived = structuredClone(sourceWorkflow);
  const urlMappedNodes = [];
  const credentialNodes = [];
  let bridgedInput = false;

  for (const node of derived.nodes) {
    if (node.name === VALIDATE_FIELDS_NAME) {
      if (node.type !== 'n8n-nodes-base.code' || typeof node.parameters?.jsCode !== 'string') {
        throw new Error('Validate Fields must remain a Code node with jsCode');
      }
      const code = node.parameters.jsCode;
      if (code.split(SOURCE_INPUT_LINE).length !== 2) {
        throw new Error('Validate Fields input expression drifted — refusing webhook-body bridge');
      }
      node.parameters.jsCode = code.replace(SOURCE_INPUT_LINE, BRIDGED_INPUT_LINES);
      bridgedInput = true;
    }
    const mapping = HTTP_NODE_URL_MAP[node.name];

    if (node.type === HTTP_REQUEST_TYPE) {
      // Fail closed on any HTTP node the map does not know (T-01-01/T-01-03).
      if (!mapping) {
        throw new Error(`unmapped HTTP Request node "${node.name}" — refusing to derive a workflow with an unknown external destination`);
      }
    }
    if (mapping && node.type !== HTTP_REQUEST_TYPE) {
      throw new Error(`node "${node.name}" is expected to be an HTTP Request node but has type ${node.type}`);
    }

    if (mapping) {
      if (node.parameters?.url !== mapping.from) {
        throw new Error(
          `node "${node.name}" URL drifted from the expected production endpoint: expected ${mapping.from}, found ${node.parameters?.url}`
        );
      }
      node.parameters.url = mapping.to;
      urlMappedNodes.push(node.name);
    }

    const declares = declaresHeaderAuth(node);
    const expectedAuth = EXPECTED_AUTH_NODES.includes(node.name);
    if (declares && !expectedAuth) {
      throw new Error(`node "${node.name}" declares httpHeaderAuth but is not an expected authenticated node`);
    }
    if (expectedAuth && !declares) {
      throw new Error(`node "${node.name}" is expected to declare genericCredentialType/httpHeaderAuth but does not`);
    }
    if (declares && expectedAuth) {
      if (node.credentials?.httpHeaderAuth) {
        throw new Error(`node "${node.name}" already carries a credential reference — the source is expected to be credential-reference-free`);
      }
      node.credentials = structuredClone(LOCAL_CREDENTIAL_REFERENCE);
      credentialNodes.push(node.name);
    }
  }

  if (urlMappedNodes.length !== Object.keys(HTTP_NODE_URL_MAP).length) {
    const missing = Object.keys(HTTP_NODE_URL_MAP).filter((name) => !urlMappedNodes.includes(name));
    throw new Error(`source workflow is missing mapped HTTP nodes: ${missing.join(', ')}`);
  }
  if (credentialNodes.length !== EXPECTED_AUTH_NODES.length) {
    throw new Error(`expected ${EXPECTED_AUTH_NODES.length} credential-bearing nodes, mapped ${credentialNodes.length}`);
  }
  if (!bridgedInput) {
    throw new Error('source workflow is missing Validate Fields — refusing to derive');
  }

  let derivedSha256 = null;
  if (typeof destination === 'string') {
    const derivedBytes = Buffer.from(`${JSON.stringify(derived, null, 2)}\n`);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, derivedBytes);
    derivedSha256 = sha256(derivedBytes);
  }

  return {
    sourceWorkflow,
    derivedWorkflow: derived,
    sourceSha256: sha256(sourceBytes),
    derivedSha256,
    urlMappedNodes,
    credentialNodes,
    bodyBridgeNode: VALIDATE_FIELDS_NAME,
  };
}

// CLI: node runtime/scripts/derive-runtime-workflow.mjs [source] [destination]
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const source = process.argv[2] ?? 'workflows/client-intake-pipeline.json';
  const destination =
    process.argv[3] ?? 'runtime/.generated/client-intake-pipeline.runtime.json';
  const result = deriveRuntimeWorkflow(source, destination);
  process.stdout.write(
    `${JSON.stringify(
      {
        source,
        destination,
        sourceSha256: result.sourceSha256,
        derivedSha256: result.derivedSha256,
        urlMappedNodes: result.urlMappedNodes,
        credentialNodes: result.credentialNodes,
      },
      null,
      2
    )}\n`
  );
}
