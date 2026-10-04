import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const workflow = (name) => JSON.parse(text(`workflows/${name}.json`));
const note = (graph, name) => {
  const node = graph.nodes.find((item) => item.name === name);
  assert.equal(node?.type, 'n8n-nodes-base.stickyNote', `${name} must remain a sticky note`);
  return node.parameters.content;
};

function honestQueueWarning(content, consequence) {
  return /not|no|does not|without/i.test(content) &&
    /queue|review/i.test(content) &&
    consequence.test(content) &&
    /do not|not safe|not deployment-ready/i.test(content);
}

test('the historical intake notes refuse the decorative CRM gate, and the source remains a separate graph', () => {
  const graph = workflow('client-intake-pipeline');
  const overview = note(graph, 'Sticky Note — Overview');
  const review = note(graph, 'Sticky Note — Human Review');
  assert.match(overview, /INSPECTION ONLY/);
  assert.ok(honestQueueWarning(review, /CRM|Lawmatics/i));
  assert.match(review, /no consumer/i);
  assert.match(review, /without checking an approved decision/i);
  assert.ok(!honestQueueWarning('Queue for review; CRM requires approval before any write.', /CRM/i),
    'an old affirmative claim without a warning must not pass the disclosure helper');
});

test('the historical missed-call notes disclose the direct, ungated SMS path', () => {
  const graph = workflow('missed-call-recovery');
  const review = note(graph, 'Sticky Note — Human Review');
  const overview = note(graph, 'Sticky Note — Overview');
  const outgoing = graph.connections['Human Review Gate — SMS Approval']?.main?.[0]?.map((edge) => edge.node) ?? [];
  assert.deepEqual(outgoing, ['Send SMS Follow-up — OpenPhone']);
  assert.match(overview, /not all audit-logged/i);
  assert.ok(honestQueueWarning(review, /SMS|OpenPhone/i));
  assert.match(review, /directly to Send SMS Follow-up/);
  assert.match(note(graph, 'Sticky Note — Edge Cases'), /Unimplemented safeguards/);
});

test('the historical routing and billing notes distinguish queues from approvals and unimplemented duplicate checks', () => {
  const route = workflow('case-routing');
  const routeWarning = note(route, 'Sticky Note — Human Review');
  assert.ok(honestQueueWarning(routeWarning, /assignment/i));
  assert.match(routeWarning, /No node reads an approve/i);
  const billing = workflow('billing-sync');
  const overview = note(billing, 'Sticky Note — Overview');
  const conflicts = note(billing, 'Sticky Note — Conflicts');
  assert.match(overview, /does NOT compare duplicate matter IDs/i);
  assert.match(conflicts, /does NOT detect duplicate matters/i);
  assert.match(conflicts, /valid-record path can proceed toward Clio independently/i);
  assert.match(note(billing, 'Sticky Note — Transformation'), /no SplitInBatches or Wait node/i);
});

test('the companion guides stage and STOP before separate conceptual approval-triggered delivery', () => {
  for (const [file, prefix] of [
    ['docs/make-equivalent.md', 'Scenario'],
    ['docs/zapier-equivalent.md', 'Zap'],
  ]) {
    const guide = text(file);
    assert.match(guide, /no (Make scenario|Zap) has been built or tested here/i);
    assert.equal((guide.match(new RegExp(`${prefix} A \\(proposed staging\\)|${prefix} 1 \\(proposed staging\\)`, 'g')) ?? []).length, 3,
      `${file} must mark three staging flows as proposed`);
    assert.ok((guide.match(/→ STOP/g) ?? []).length >= 3, `${file} must stop intake, SMS, and assignment staging`);
    assert.ok((guide.match(/SEPARATE approved-/g) ?? []).length >= 3, `${file} must show a separately triggered path for each action`);
    assert.doesNotMatch(guide, /← MANDATORY GATE/);
  }
});

test('the public architecture and contribution guidance do not present historical files as production-gated', () => {
  const architecture = text('docs/architecture.md');
  const contributing = text('CONTRIBUTING.md');
  assert.match(architecture, /not an integrated, tested, or deployment-ready system/i);
  assert.match(architecture, /no approval consumer/i);
  assert.match(architecture, /flows directly to an OpenPhone SMS-send request/i);
  assert.match(contributing, /not production-ready templates/i);
  assert.match(contributing.replace(/\*\*/g, ''), /do not enforce human approval/i);
  assert.doesNotMatch(architecture, /Every decision-making workflow includes a mandatory human review gate/);
  assert.doesNotMatch(contributing, /provides production-quality n8n workflow templates/);
});

test('all prominent HTTP 400 statements identify an unpublished prior observation, not reverified release evidence', () => {
  const readme = text('README.md');
  const historical = workflow('client-intake-pipeline');
  const overview = note(historical, 'Sticky Note — Overview');
  const validation = note(historical, 'Sticky Note — Validation');
  for (const [label, statement] of [
    ['README', readme],
    ['intake overview', overview],
    ['intake validation', validation],
  ]) {
    assert.match(statement, /unpublished prior local diagnostic/i, `${label}: 400 must be labeled as an unpublished prior observation`);
    assert.match(statement, /observed[^.]*HTTP 400|HTTP 400[^.]*observed/i, `${label}: 400 is an observation, not a new measured claim`);
    assert.match(statement, /public attachments do not independently reproduce/i, `${label}: no raw negative-control capture is included`);
  }
});
