import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveRuntimeWorkflow } from '../scripts/derive-runtime-workflow.mjs';

const SOURCE = 'workflows/client-intake-pipeline.json';
const ORIGINAL_LINE = 'const input = $input.first().json;';
const BRIDGE = 'const raw = $input.first().json;\nconst input = raw.body ?? raw;';

test('runtime copy unwraps the Webhook body without changing the source graph', () => {
  const bytesBefore = readFileSync(SOURCE);
  const source = JSON.parse(bytesBefore.toString('utf8'));
  const original = source.nodes.find((node) => node.name === 'Validate Fields');
  assert.ok(original?.parameters?.jsCode.includes(ORIGINAL_LINE));

  const { derivedWorkflow } = deriveRuntimeWorkflow(SOURCE);
  const adapted = derivedWorkflow.nodes.find((node) => node.name === 'Validate Fields');
  assert.equal(adapted.parameters.jsCode, original.parameters.jsCode.replace(ORIGINAL_LINE, BRIDGE));
  assert.deepEqual(derivedWorkflow.connections, source.connections);
  assert.deepEqual(derivedWorkflow.nodes.map(({ id, name, type }) => ({ id, name, type })),
    source.nodes.map(({ id, name, type }) => ({ id, name, type })));
  assert.deepEqual(readFileSync(SOURCE), bytesBefore);
});
