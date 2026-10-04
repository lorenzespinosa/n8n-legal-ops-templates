// Fail-closed equivalence/locality/hash gate for the derived runtime
// workflow (D-06 extended allowlist, T-01-02).
//
// Independently re-derives the ALLOWED difference set between the tracked
// source workflow and ANY derived copy presented to it:
//   1. each known HTTP Request node's `parameters.url` value, and only the
//      exact expected production -> local-mock mapping,
//   2. an added `credentials.httpHeaderAuth` reference — the one fixed local
//      id/name — on exactly the five nodes that already declare
//      `genericCredentialType`/`httpHeaderAuth`,
//   3. the exact one-line Validate Fields `jsCode` webhook-body bridge
//      `const input = $input.first().json;` ->
//      `const raw = $input.first().json; const input = raw.body ?? raw;`.
// Everything else — ordered node identities, the complete connections
// object, every other parameter, every other Code node, `active`, settings,
// tags — must be identical, and every URL anywhere in the derived copy must
// resolve to the local Compose mock service. Anything not explicitly
// recognized fails closed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  EXPECTED_AUTH_NODES,
  HTTP_NODE_URL_MAP,
  LOCAL_CREDENTIAL_REFERENCE,
  MOCK_ORIGIN,
} from './derive-runtime-workflow.mjs';

const VALIDATE_FIELDS_NAME = 'Validate Fields';
const SOURCE_INPUT_LINE = 'const input = $input.first().json;';
const BRIDGED_INPUT_LINES = 'const raw = $input.first().json;\nconst input = raw.body ?? raw;';
const HTTP_REQUEST_TYPE = 'n8n-nodes-base.httpRequest';
const URL_PATTERN = /https?:\/\/[^/\s"'`]+/g;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/** Load a path-or-object argument the same way the mapper does. */
function loadWorkflow(value, { canonicalTrailingNewline = false } = {}) {
  if (typeof value === 'string') {
    const bytes = readFileSync(value);
    return { workflow: JSON.parse(bytes.toString('utf8')), bytes };
  }
  const workflow = structuredClone(value);
  const serialized = JSON.stringify(workflow, null, 2);
  return {
    workflow,
    bytes: Buffer.from(canonicalTrailingNewline ? `${serialized}\n` : serialized),
  };
}

/** Recursive JSON diff producing one entry per added/removed/changed leaf. */
function collectDifferences(source, derived) {
  const differences = [];
  const visit = (s, d, path) => {
    if (s === d) return;
    if (Array.isArray(s) && Array.isArray(d)) {
      if (s.length !== d.length) {
        differences.push({ path, kind: 'length', source: s.length, derived: d.length });
        return;
      }
      s.forEach((item, index) => visit(item, d[index], `${path}[${index}]`));
      return;
    }
    if (isPlainObject(s) && isPlainObject(d)) {
      for (const key of new Set([...Object.keys(s), ...Object.keys(d)])) {
        const nextPath = `${path}.${key}`;
        if (!Object.hasOwn(s, key)) {
          differences.push({ path: nextPath, kind: 'added', source: undefined, derived: d[key] });
        } else if (!Object.hasOwn(d, key)) {
          differences.push({ path: nextPath, kind: 'removed', source: s[key], derived: undefined });
        } else {
          visit(s[key], d[key], nextPath);
        }
      }
      return;
    }
    differences.push({ path, kind: 'changed', source: s, derived: d });
  };
  visit(source, derived, '');
  return differences;
}

/** Every http(s) URL found in any string value of the workflow object. */
function collectUrls(workflow) {
  const urls = [];
  const visit = (value, path) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(URL_PATTERN)) {
        urls.push({ url: match[0], path });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) visit(value[key], `${path}.${key}`);
    }
  };
  visit(workflow, '');
  return urls;
}

const preview = (value) => {
  if (value === undefined) return '(absent)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/**
 * Verify a derived runtime workflow copy against the tracked source under
 * the extended D-06 allowlist.
 *
 * @param {string|object} source path to the tracked workflow JSON or a parsed object
 * @param {string|object} derived path to the derived copy or a parsed object
 * @returns {{ok: boolean, errors: string[], allowedDifferences: string[],
 *   sourceSha256: string, derivedSha256: string, urlsChecked: number}}
 */
export function verifyRuntimeWorkflow(source, derived) {
  const errors = [];
  const allowedDifferences = [];

  const sourceInput = loadWorkflow(source);
  const derivedInput = loadWorkflow(derived, { canonicalTrailingNewline: true });
  const sourceWorkflow = sourceInput.workflow;
  const derivedWorkflow = derivedInput.workflow;

  if (!Array.isArray(sourceWorkflow?.nodes)) {
    return failFast('source workflow has no nodes array', sourceInput, derivedInput);
  }
  if (!Array.isArray(derivedWorkflow?.nodes)) {
    return failFast('derived workflow has no nodes array', sourceInput, derivedInput);
  }

  // --- ordered node identities ---------------------------------------------
  if (sourceWorkflow.nodes.length !== derivedWorkflow.nodes.length) {
    errors.push(
      `node identity changed: source has ${sourceWorkflow.nodes.length} nodes, derived has ${derivedWorkflow.nodes.length}`
    );
  } else {
    for (let index = 0; index < sourceWorkflow.nodes.length; index += 1) {
      const s = sourceWorkflow.nodes[index];
      const d = derivedWorkflow.nodes[index];
      for (const key of ['id', 'name', 'type', 'typeVersion']) {
        if (!deepEqual(s[key], d[key])) {
          errors.push(
            `node identity changed at nodes[${index}].${key}: ${JSON.stringify(s[key])} -> ${JSON.stringify(d[key])}`
          );
        }
      }
    }
  }

  // --- complete connections object ------------------------------------------
  if (!deepEqual(sourceWorkflow.connections, derivedWorkflow.connections)) {
    const connectionDiffs = collectDifferences(sourceWorkflow.connections, derivedWorkflow.connections);
    const first = connectionDiffs[0];
    errors.push(
      `connections object differs at connections${first?.path ?? ''} ` +
        `(${first ? `${first.kind}: ${preview(first.source)} -> ${preview(first.derived)}` : 'structural difference'})`
    );
  }

  // --- source integrity (fail closed on drift) -------------------------------
  for (const node of sourceWorkflow.nodes) {
    if (node.credentials) {
      errors.push(
        `source must be credential-reference-free, but node "${node.name}" carries credentials (${preview(node.credentials)})`
      );
    }
  }
  const sourceValidate = sourceWorkflow.nodes.find((node) => node.name === VALIDATE_FIELDS_NAME);
  if (!sourceValidate || sourceValidate.type !== 'n8n-nodes-base.code') {
    errors.push(`source must contain a Code node named "${VALIDATE_FIELDS_NAME}"`);
  } else if (sourceValidate.parameters.jsCode.split(SOURCE_INPUT_LINE).length !== 2) {
    errors.push(
      `source "${VALIDATE_FIELDS_NAME}" jsCode drifted — the exact line "${SOURCE_INPUT_LINE}" must appear exactly once`
    );
  }

  // --- recursive diff under the extended D-06 allowlist -----------------------
  const differences = collectDifferences(sourceWorkflow, derivedWorkflow);
  for (const difference of differences) {
    const nodeMatch = /^\.nodes\[(\d+)\]\.(.+)$/.exec(difference.path);
    if (!nodeMatch) {
      errors.push(
        `non-allowlisted difference at ${difference.path || '(root)'}: ${preview(difference.source)} -> ${preview(difference.derived)}`
      );
      continue;
    }
    const index = Number(nodeMatch[1]);
    const rest = nodeMatch[2];
    const sourceNode = sourceWorkflow.nodes[index];
    const nodeName = sourceNode?.name ?? `nodes[${index}]`;

    // Rule 1 — per-known-HTTP-node URL value.
    if (rest === 'parameters.url') {
      const mapping = HTTP_NODE_URL_MAP[nodeName];
      if (!mapping) {
        errors.push(`URL difference on unknown HTTP node "${nodeName}" — no mapping exists for it`);
      } else if (difference.source !== mapping.from || difference.derived !== mapping.to) {
        errors.push(
          `URL difference on node "${nodeName}" is not the allowed mapping: expected ${mapping.from} -> ${mapping.to}, got ${preview(difference.source)} -> ${preview(difference.derived)}`
        );
      } else {
        allowedDifferences.push(`nodes[${index}].parameters.url (${nodeName})`);
      }
      continue;
    }

    // Rule 2 — the fixed local credential reference on exactly the five
    // nodes that already declare genericCredentialType/httpHeaderAuth.
    if (rest === 'credentials' || rest.startsWith('credentials.')) {
      if (difference.kind === 'added' && rest === 'credentials') {
        if (!EXPECTED_AUTH_NODES.includes(nodeName)) {
          errors.push(
            `credential reference added to node "${nodeName}" which is not one of the five authenticated nodes`
          );
        } else if (!deepEqual(difference.derived, LOCAL_CREDENTIAL_REFERENCE)) {
          errors.push(
            `credential reference on node "${nodeName}" is not the fixed local reference: ${preview(difference.derived)}`
          );
        } else {
          allowedDifferences.push(`nodes[${index}].credentials (${nodeName})`);
        }
      } else {
        errors.push(
          `credential difference at nodes[${index}].${rest} — only the fixed local reference may be added whole on the five authenticated nodes`
        );
      }
      continue;
    }

    // Rule 3 — the exact one-line Validate Fields webhook-body bridge.
    if (rest === 'parameters.jsCode') {
      if (nodeName !== VALIDATE_FIELDS_NAME) {
        errors.push(
          `Code-node change on "${nodeName}" — only "${VALIDATE_FIELDS_NAME}" jsCode may change (the one allowlisted body bridge)`
        );
      } else {
        const expected = sourceNode.parameters.jsCode.replace(SOURCE_INPUT_LINE, BRIDGED_INPUT_LINES);
        if (difference.derived === expected) {
          allowedDifferences.push(`nodes[${index}].parameters.jsCode (${VALIDATE_FIELDS_NAME} body bridge)`);
        } else {
          errors.push(
            `"${VALIDATE_FIELDS_NAME}" jsCode differs from the exact one-line body bridge substitution`
          );
        }
      }
      continue;
    }

    errors.push(
      `non-allowlisted difference at nodes[${index}].${rest}: ${preview(difference.source)} -> ${preview(difference.derived)}`
    );
  }

  // --- graph-wide URL locality (input-independent, A-03) ----------------------
  const urls = collectUrls(derivedWorkflow);
  for (const { url, path } of urls) {
    if (url !== MOCK_ORIGIN) {
      errors.push(`non-local URL ${url} found at ${path || '(root)'} — every URL must resolve to ${MOCK_ORIGIN}`);
    }
  }
  for (const [index, node] of derivedWorkflow.nodes.entries()) {
    if (node.type === HTTP_REQUEST_TYPE && typeof node.parameters?.url === 'string') {
      if (!node.parameters.url.startsWith(`${MOCK_ORIGIN}/`) && node.parameters.url !== MOCK_ORIGIN) {
        errors.push(`HTTP Request node "${node.name}" URL is not local: ${node.parameters.url}`);
      }
    }
  }

  // --- credential-bearing node census ------------------------------------------
  const bearing = derivedWorkflow.nodes.filter((node) => node.credentials);
  if (bearing.length !== EXPECTED_AUTH_NODES.length) {
    errors.push(
      `derived workflow has ${bearing.length} credential-bearing nodes, expected exactly ${EXPECTED_AUTH_NODES.length}`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    allowedDifferences,
    sourceSha256: sha256(sourceInput.bytes),
    derivedSha256: sha256(derivedInput.bytes),
    urlsChecked: urls.length,
  };
}

function failFast(message, sourceInput, derivedInput) {
  return {
    ok: false,
    errors: [message],
    allowedDifferences: [],
    sourceSha256: sha256(sourceInput.bytes),
    derivedSha256: sha256(derivedInput.bytes),
    urlsChecked: 0,
  };
}

// CLI: node runtime/scripts/verify-runtime-workflow.mjs <source> <derived>
// Prints the JSON report on stdout and exits 0 only when the copy verifies.
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const [source, derived] = process.argv.slice(2);
  if (typeof source !== 'string' || typeof derived !== 'string') {
    process.stderr.write('usage: node runtime/scripts/verify-runtime-workflow.mjs <source> <derived>\n');
    process.exit(2);
  }
  let report;
  try {
    report = verifyRuntimeWorkflow(source, derived);
  } catch (error) {
    report = { ok: false, errors: [`verification failed: ${error.message}`], allowedDifferences: [] };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}
