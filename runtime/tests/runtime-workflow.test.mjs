// Equivalence, credential, locality, and denied-egress coverage for the
// derived runtime workflow (D-06 extended allowlist, D-08/D-12 egress).
//
// The verifier under test — runtime/scripts/verify-runtime-workflow.mjs — is
// the fail-closed gate that independently re-derives the allowed difference
// set between the tracked source and ANY derived copy:
//   1. per-known-HTTP-node URL values (mapped to the local mock service),
//   2. the credentials.httpHeaderAuth id/name fields on exactly the five
//      nodes that already declare genericCredentialType/httpHeaderAuth,
//   3. the exact one-line Validate Fields webhook-body bridge.
// Everything else — node identities/order, the complete connections object,
// every other parameter, every other Code node — must be identical, and the
// tracked source must stay credential-reference-free. The suite fails closed
// on each violation class.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveRuntimeWorkflow,
  EXPECTED_AUTH_NODES,
  LOCAL_CREDENTIAL_REFERENCE,
} from '../scripts/derive-runtime-workflow.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE_PATH = path.join(ROOT, 'workflows', 'client-intake-pipeline.json');
const VERIFIER_PATH = path.join(ROOT, 'runtime', 'scripts', 'verify-runtime-workflow.mjs');
const COMPOSE_FILE = path.join(ROOT, 'runtime', 'docker-compose.yml');
const GENERATED_DIR = path.join(ROOT, 'runtime', '.generated');
const LOCK_DIR = path.join(GENERATED_DIR, 'launcher.lock');

// Single-writer safety (WR-03/D-17): the egress test below brings up a
// Compose project derived from the launcher's own topology. Even with its
// own isolated project name, running it while a real baseline invocation is
// in flight invites confusing interleaved output and races on the shared
// image — refuse to run at all while a launcher owns the lock.
if (existsSync(LOCK_DIR)) {
  assert.fail(
    `a baseline run owns ${LOCK_DIR} — refusing to run this suite while a launcher invocation is in flight (D-17 single writer, sequential execution only); rerun after the baseline completes`
  );
}

const sourceBytes = readFileSync(SOURCE_PATH);
const sourceWorkflow = JSON.parse(sourceBytes.toString('utf8'));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// Load the verifier without crashing the suite when it does not exist yet
// (TDD RED): the tests then fail on an explicit assertion for the missing
// feature instead of an import error.
async function loadVerifier() {
  try {
    return await import('../scripts/verify-runtime-workflow.mjs');
  } catch {
    return null;
  }
}

function deriveFresh() {
  return deriveRuntimeWorkflow(sourceWorkflow).derivedWorkflow;
}

function nodeByName(workflow, name) {
  return workflow.nodes.find((candidate) => candidate.name === name);
}

test('all five nodes declaring genericCredentialType/httpHeaderAuth gain the one fixed local credential reference — nothing else does, and the source stays credential-reference-free', () => {
  assert.equal(
    sourceWorkflow.nodes.filter((node) => node.credentials).length,
    0,
    'the tracked source must be credential-reference-free'
  );

  const { derivedWorkflow, credentialNodes } = deriveRuntimeWorkflow(sourceWorkflow);
  const bearing = derivedWorkflow.nodes.filter((node) => node.credentials);
  assert.equal(bearing.length, EXPECTED_AUTH_NODES.length, 'exactly five credential-bearing nodes');
  assert.deepEqual(
    [...bearing.map((node) => node.name)].sort(),
    [...EXPECTED_AUTH_NODES].sort(),
    'the credential-bearing nodes are exactly the expected authenticated nodes'
  );
  for (const node of bearing) {
    assert.deepEqual(node.credentials, LOCAL_CREDENTIAL_REFERENCE, `node ${node.name}`);
    // No authentication parameter is removed or bypassed (D-06).
    assert.equal(node.parameters.authentication, 'genericCredentialType');
    assert.equal(node.parameters.genericAuthType, 'httpHeaderAuth');
  }
  assert.deepEqual([...credentialNodes].sort(), [...EXPECTED_AUTH_NODES].sort());
});

test('the mapper fails closed on an unknown HTTP Request node (unmapped external destination)', () => {
  const tamperedSource = structuredClone(sourceWorkflow);
  tamperedSource.nodes.push({
    parameters: { method: 'GET', url: 'https://api.sendgrid.com/v3/mail/send' },
    id: 'a1b2c3d4-1111-4aaa-bbbb-000000000099',
    name: 'Evil Extra HTTP Node',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [0, 0],
  });
  assert.throws(
    () => deriveRuntimeWorkflow(tamperedSource),
    /unmapped HTTP Request node/,
    'derivation must refuse a workflow with an unknown HTTP destination'
  );
});

test('verifier proves ordered node identities and the complete connections object, rejects every non-allowlisted difference, and reports both SHA-256 hashes', async () => {
  const verifier = await loadVerifier();
  assert.ok(
    verifier && typeof verifier.verifyRuntimeWorkflow === 'function',
    'runtime/scripts/verify-runtime-workflow.mjs must exist and export verifyRuntimeWorkflow'
  );
  const { verifyRuntimeWorkflow } = verifier;

  const good = verifyRuntimeWorkflow(SOURCE_PATH, deriveFresh());
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.sourceSha256, sha256(sourceBytes), 'source hash must match the tracked bytes');
  assert.match(good.derivedSha256, /^[0-9a-f]{64}$/, 'derived hash must be reported');
  assert.ok(Array.isArray(good.allowedDifferences), 'the accepted difference set must be reported');
  assert.equal(good.allowedDifferences.length, 12, '6 URL values + 5 credential references + 1 jsCode bridge');
  assert.equal(
    good.allowedDifferences.filter((entry) => entry.includes('parameters.url')).length,
    6,
    'exactly six accepted URL value changes'
  );
  assert.equal(
    good.allowedDifferences.filter((entry) => entry.includes('credentials')).length,
    5,
    'exactly five accepted credential references'
  );
  assert.equal(
    good.allowedDifferences.filter((entry) => entry.includes('jsCode')).length,
    1,
    'exactly one accepted jsCode bridge'
  );

  const mustReject = (label, mutate, pattern) => {
    const tampered = deriveFresh();
    mutate(tampered);
    const result = verifyRuntimeWorkflow(sourceWorkflow, tampered);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(result.errors.length >= 1, `${label} must report an explicit error`);
    if (pattern) {
      assert.ok(
        result.errors.some((error) => pattern.test(error)),
        `${label} error must match ${pattern} (got: ${result.errors.join(' | ')})`
      );
    }
    return result;
  };

  mustReject('reversed node order', (w) => { w.nodes.reverse(); }, /node identit|node at index|nodes/i);
  mustReject('added connection edge', (w) => {
    w.connections['Validate Fields'].main[0].push({ node: 'Sticky Note — Overview', type: 'main', index: 0 });
  }, /connection/i);
  mustReject('changed webhook path parameter', (w) => { w.nodes[0].parameters.path = 'other-path'; }, /non-allowlisted|parameter|difference/i);
  mustReject('second Code-node change', (w) => {
    nodeByName(w, 'Merge AI Classification').parameters.jsCode += '\n// tampered';
  }, /Validate Fields|jsCode|Code/i);
  mustReject('drifted Validate Fields bridge', (w) => {
    const node = nodeByName(w, 'Validate Fields');
    node.parameters.jsCode += '\n// extra change beyond the exact one-line bridge';
  }, /jsCode|bridge|Validate Fields/i);
  mustReject('credential id drift', (w) => {
    nodeByName(w, 'CRM Create — Lawmatics').credentials.httpHeaderAuth.id = 'some-other-id';
  }, /credential/i);
  mustReject('credential reference on a non-authenticated node', (w) => {
    nodeByName(w, 'Slack Alert — Urgent').credentials = structuredClone(LOCAL_CREDENTIAL_REFERENCE);
  }, /credential/i);
  mustReject('unmapped production URL on a known HTTP node', (w) => {
    nodeByName(w, 'Check Duplicates — Airtable').parameters.url =
      'https://api.airtable.com/v0/YOUR_BASE_ID/Contacts';
  }, /url|local/i);
});

test('locality is graph-wide and input-independent (A-03): every URL anywhere in the derived workflow resolves to the local mock service', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-runtime-workflow.mjs must exist');
  const { verifyRuntimeWorkflow } = verifier;

  const good = verifyRuntimeWorkflow(sourceWorkflow, deriveFresh());
  assert.equal(good.ok, true, 'the honest derived copy is entirely local');

  // An external URL injected into a NON-HTTP node (a sticky note) must still
  // be caught: locality is a property of the whole graph object, so it holds
  // for any input and any branch, including ones the tracer never executes.
  const tampered = deriveFresh();
  nodeByName(tampered, 'Sticky Note — Overview').parameters.content +=
    '\nReference: https://api.airtable.com/v0/YOUR_BASE_ID/Contacts';
  const result = verifyRuntimeWorkflow(sourceWorkflow, tampered);
  assert.equal(result.ok, false, 'an external URL anywhere in the derived workflow must fail verification');
  assert.ok(
    result.errors.some((error) => error.includes('api.airtable.com')),
    'the locality error must name the offending host'
  );
});

test('verifier CLI emits both hashes as JSON on stdout and exits non-zero on violations', async () => {
  const verifier = await loadVerifier();
  assert.ok(verifier, 'runtime/scripts/verify-runtime-workflow.mjs must exist');

  const dir = mkdtempSync(path.join(tmpdir(), 'gsd-0101-verifier-'));
  try {
    const derivedPath = path.join(dir, 'derived.json');
    writeFileSync(derivedPath, `${JSON.stringify(deriveFresh(), null, 2)}\n`);

    const good = spawnSync('node', [VERIFIER_PATH, SOURCE_PATH, derivedPath], { encoding: 'utf8' });
    assert.equal(good.status, 0, `verifier CLI must exit 0 on the honest copy (stderr: ${good.stderr})`);
    const report = JSON.parse(good.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.sourceSha256, sha256(sourceBytes));
    assert.match(report.derivedSha256, /^[0-9a-f]{64}$/);

    const tamperedWorkflow = deriveFresh();
    nodeByName(tamperedWorkflow, 'Update Existing Record').parameters.url =
      'http://mock-api:9090/airtable/v0/YOUR_BASE_ID/Contacts/{{ $json.records[0].id }}/extra';
    const tamperedPath = path.join(dir, 'tampered.json');
    writeFileSync(tamperedPath, `${JSON.stringify(tamperedWorkflow, null, 2)}\n`);
    const bad = spawnSync('node', [VERIFIER_PATH, SOURCE_PATH, tamperedPath], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, 'verifier CLI must exit non-zero on a violation');
    const badReport = JSON.parse(bad.stdout);
    assert.equal(badReport.ok, false);
    assert.ok(badReport.errors.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('egress enforcement is machine-checked host-side (runtime-net Internal=true) and the supplementary in-network TEST-NET probe cannot connect (D-08/D-12)', async () => {
  // Fail closed: if Docker is unavailable the denied-egress property of the
  // internal-only Compose network simply cannot be proven (D-07 philosophy —
  // absence of evidence is never a pass).
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    assert.fail('Docker is unavailable — the denied-egress property cannot be proven; failing closed (D-07)');
  }

  // Isolated Compose project (WR-03): a dedicated project name keeps this
  // test's containers, network, and `n8n-data` volume fully separate from
  // the launcher's flagship-intake-baseline project, so the test's
  // `down -v` teardown can never destroy an in-flight baseline run's state.
  const EGRESS_TEST_PROJECT = 'flagship-intake-egress-test';
  const dc = (args) =>
    spawnSync(
      'docker',
      ['compose', '-p', EGRESS_TEST_PROJECT, '-f', COMPOSE_FILE, ...args],
      { encoding: 'utf8', timeout: 60_000 }
    );

  try {
    const up = dc(['up', '-d', 'mock-api']);
    assert.equal(up.status, 0, `mock-api must start on the internal network (stderr: ${up.stderr})`);

    // PRIMARY enforcement check (WR-02): TEST-NET-1 is globally unroutable,
    // so a probe alone cannot distinguish deliberate denial from inherent
    // unroutability. Assert the network property Docker itself reports.
    const networkName = spawnSync(
      'docker',
      [
        'network', 'ls',
        '--filter', 'label=com.docker.compose.project=flagship-intake-egress-test',
        '--filter', 'label=com.docker.compose.network=runtime-net',
        '--format', '{{.Name}}',
      ],
      { encoding: 'utf8' }
    ).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)[0];
    assert.ok(
      networkName,
      'the runtime-net network must exist after compose up so its internal flag can be machine-checked'
    );
    const internal = spawnSync(
      'docker',
      ['network', 'inspect', networkName, '--format', '{{.Internal}}'],
      { encoding: 'utf8' }
    );
    assert.equal(
      internal.status,
      0,
      `docker network inspect must succeed for ${networkName} (stderr: ${internal.stderr})`
    );
    assert.equal(
      internal.stdout.trim(),
      'true',
      `runtime-net must report Internal=true — the actual egress enforcement (got: ${internal.stdout.trim()})`
    );

    // SUPPLEMENTARY in-network probe (defense-in-depth). Runs INSIDE the
    // internal runtime network via the audit service: it first proves the
    // local mock is reachable, then attempts a strict sub-second (500 ms)
    // TCP connect to 192.0.2.1 — an RFC 5737 TEST-NET-1 documentation
    // address. No live hostname or service is contacted.
    const PROBE = [
      'const net = require("net");',
      '(async () => {',
      '  let healthy = false;',
      '  for (let i = 0; i < 40 && !healthy; i++) {',
      '    try { const r = await fetch("http://mock-api:9090/admin/health"); if (r.ok) healthy = true; } catch {}',
      '    if (!healthy) await new Promise((res) => setTimeout(res, 250));',
      '  }',
      '  if (!healthy) { console.error("MOCK_UNREACHABLE"); process.exit(2); }',
      '  const outcome = await new Promise((resolve) => {',
      '    const socket = net.connect({ host: "192.0.2.1", port: 80 });',
      '    const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 500);',
      '    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });',
      '    socket.on("error", (err) => { clearTimeout(timer); resolve("error:" + (err.code || err.message)); });',
      '  });',
      '  if (outcome === "connected") { console.error("EGRESS_CONNECTED to RFC 5737 TEST-NET address"); process.exit(3); }',
      '  console.log("EGRESS_DENIED:" + outcome);',
      '})();',
    ].join('\n');

    const probe = dc(['run', '--rm', '-T', '--no-deps', 'audit', '-e', PROBE]);
    assert.equal(
      probe.status,
      0,
      `the in-network probe must succeed (exit ${probe.status}; stdout: ${probe.stdout}; stderr: ${probe.stderr})`
    );
    assert.ok(probe.stdout.includes('EGRESS_DENIED:'), `probe must report denial, got: ${probe.stdout}`);
    assert.ok(!probe.stdout.includes('EGRESS_CONNECTED'), 'an established external connection is a hard failure');
  } finally {
    dc(['down', '-v', '--remove-orphans']);
  }
});
