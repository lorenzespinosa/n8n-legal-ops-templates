// In-network manual reviewer action helper (plan 02-02).
//
// Reproduces, for a human operator, the exact separate reviewer event the
// automated suite issues as SIMULATED reviewer input. It runs inside the
// isolated Compose network (audit service) and reads the one-time reviewer
// proof from an invocation-owned permission-restricted ephemeral file mounted
// at /ephemeral/reviewer-proof — the proof is never passed on the command
// line, never printed, and never committed.
//
// Usage (printed by ./runtime/run-gated-demo.sh --manual-review):
//   REVIEW_ID=rev_00001 DECISION=approve|reject
//   REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof
//
// Exits 0 only when the real reviewer webhook records the decision.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const reviewId = process.env.REVIEW_ID ?? '';
const decision = process.env.DECISION ?? '';
const proofFile = process.env.REVIEWER_PROOF_FILE ?? '';
const n8nBase = process.env.N8N_BASE_URL ?? 'http://n8n:5678';

if (!reviewId || !proofFile || (decision !== 'approve' && decision !== 'reject')) {
  process.stderr.write(
    'usage: REVIEW_ID=<rev_#####> DECISION=approve|reject REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof\n'
  );
  process.exit(2);
}

let proof = '';
try {
  proof = readFileSync(proofFile, 'utf8').trim();
} catch (error) {
  process.stderr.write(`could not read the one-time reviewer proof file ${proofFile}: ${error.message}\n`);
  process.exit(2);
}
if (proof.length < 16) {
  process.stderr.write('the one-time reviewer proof file is empty or malformed\n');
  process.exit(2);
}

const response = await fetch(`${n8nBase}/webhook/reviewer-decision-webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-reviewer-proof': proof,
  },
  body: JSON.stringify({ review_id: reviewId, decision }),
  signal: AbortSignal.timeout(30_000),
});

const text = await response.text();
process.stdout.write(`manual reviewer action (${decision} for ${reviewId}) — HTTP ${response.status}: ${text}\n`);
process.exit(response.ok ? 0 : 1);
