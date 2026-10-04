# Evidence Summary — Flagship Intake Demo (Sanitized Public Excerpt)

## Derivation

Counted outcomes and runtime identities below come from the accepted
`runtime/evidence/final-evidence-log.json` (kind
`flagship-intake-final-evidence`, schema version 1), produced by a real local
`./runtime/run-final-evidence.sh` execution. Attachment SHA-256 values are
separately sourced from the retrospective, committed
`runtime/evidence/release-attachment-index.json`. Check both layers offline:

```bash
node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json
node runtime/scripts/verify-release-attachments.mjs
```

- Recorded run id: `final-20261004T151153Z` (execution mode `real-n8n`, status
  `completed`; full suite 5/5).
- Recorded source-run commit: `0e800e0916b90d5f2603ee1422bd7bf38cedcc82` — the
  commit the evidence pipeline bound its nine-file SHA-256 manifest to. It is
  **not** the later packaging/docs commit this excerpt lives at, and the two
  are never equated. The verify command above (run from the repository root)
  re-checks every recorded invariant and binds provenance to git: the recorded
  head must exist in this history and each provenance SHA-256 must match the
  actual bytes at that commit — verification fails closed outside a checkout
  of this history or on any forged head or hash.

This excerpt carries **only counts, hashes, status codes, version/digest
identities, and verdict lines** from that record. It never contains raw
one-time reviewer proof values, raw fictional intake payload content, URLs, or
contact data.

## Run identity

| Field | Recorded value |
|---|---|
| n8n runtime | 2.37.10 (pinned) |
| Image reference | `n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec` |
| Docker client | 29.7.2 |
| Docker Compose | 5.4.0 |
| Run id | `final-20261004T151153Z` |
| Execution mode | `real-n8n` (executed, not import-only) |
| Status | `completed` |

## Clean-sandbox rerun comparison (from the record)

- Compared with the earlier verified run `final-20261004T151046Z`: **per-case
  counted states identical**.
- Verified clean-sandbox checks before any Docker mutation: no-owned-containers,
  no-owned-networks, no-owned-volumes, generated-tree-absent,
  census-forensics-absent, launcher-lock-absent.
- Phase base: `2515498259a1e47ecb5088b2cb0ea22b3c63393b` (the full 40-hex
  frozen phase boundary, as recorded in the committed record).

## Offline comparison attachments

- Earlier full record: `runtime/evidence/prior-final-evidence-log.json`, SHA-256
  `59034a01f27ffd640e0cb073fce7dc6290980467d1cd5468b6eda0f9cca1d36b`.
- Nine-file source-run manifest: `runtime/evidence/source-run-manifest.json`,
  SHA-256 `c7bf1c214daac6143b5abd8a90ee182eaa4ea1964cb3f15a2bdd1f3dad4128f0`,
  attributed to the source-run commit stated above.
- Accepted final record SHA-256:
  `76795a5203570a16cd37e667e8720927353a68c648253e8c786bf302b6df7200`;
  committed baseline SHA-256:
  `2a08577e96f88505d275e65e68792dcd0ab74f41d0eac55ae22fbbb74b96ea83`.
- Retrospective attachment index SHA-256:
  `783267e605491f6ca2a00efd1579655ae7a2eb3579c92c7559c3dde9b1436a4b`.

The offline verifier hashes all four indexed artifact files, verifies both
record schemas and Git-bound provenance, recomputes the two counted matrices,
and checks all nine manifest paths against source-run Git bytes. This enables
third-party inspection of the archived comparison; it does **not** independently
prove that the earlier n8n execution took place. The accepted record stores
the prior run ID and comparison assertion but does **not** hash the prior
attachment or manifest itself; their digests are bound retrospectively by the
separately committed index and the Git tree.

## Per-case counted results

| # | Case group | Queue | Approvals | CRM attempts | CRM effects | Result |
|---|---|---|---|---|---|---|
| 1 | `tracer` | 1 | 0 | 0 | 0 | pass |
| 2 | `reviewer-gate` | 1 | 0 | 0 | 0 | pass |
| 3 | `approval-delivery` | 1 | 1 | 1 | 1 | pass |
| 4 | `intake-idempotency` | 1 | 0 | 0 | 0 | pass |
| 5 | `crm-recovery` | 1 | 1 | 2 | 1 | pass |

Status codes appearing in the recorded case outcomes: invalid intake fails
validation with 400; a conflicting intake key replay fails closed with 409;
case 5's counted sequence is a deterministic pre-commit failure (attempts 1,
effects 0) followed by one deliberate same-key retry (attempts 2, effects 1).

## Suite verdicts

- Full suite: **5/5 passed**.
- Static workflow contracts: **satisfied** (fail-closed structural verifier ran
  from inside the network before any case executed).
- Preservation/teardown: owned containers, networks, and volumes verified gone;
  **14/14** unrelated containers present at run start preserved with identical
  IDs and states.

## Provenance SHA-256 (from the record)

| Artifact | Recorded sha256 |
|---|---|
| `intake-stage` graph | `758a983aae207188667f23ed7eb256efc670a80d82c62c5477906bb97b857ea6` |
| `reviewer-decision` graph | `b0dc8979d4ac410aa566091de5c0b12c60b05698241bc80e60bc8c82d0c72474` |
| `approved-delivery` graph | `9aa832f7ebdde6f5ebf82ab78ddfa3423f7f92cdf6cb65073e4373442730de41` |
| Historical source (byte-identical before/after runs) | `4bcf9ab8664209bae7b9169226ab7dc6ab8232e9fe78e1395694e1c21bf96141` |

## Recorded limitations (verbatim themes from the record)

- Every approval in the automated matrix is **simulated reviewer input**
  performed by the test suite; no person is claimed to have exercised the
  manual two-terminal review path in this run.
- The one-time reviewer proof is consumed at most once per registration
  window; a privileged admin reset may re-register the same raw proof — a
  per-window semantic, not a durable one-use guarantee.
- Response-loss-after-commit handling, process-restart recovery, and universal exactly-once delivery are **NOT implemented and NOT claimed**.
- n8n runtime state is tmpfs-backed while invocation-owned host proof files are
  disk-backed until normal teardown — no blanket no-disk claim is made; the
  demo-state volume holds raw fictional intake payloads while live and is not claimed to be PII-free,
  and it is destroyed at verified teardown.
- External egress denial is attributed to the verified internal-only network
  topology plus the fail-closed URL allowlist; the TEST-NET-1 connect probe is
  supplementary defense-in-depth only.

Everything in this excerpt is **local mock evidence with fictional data — not a live business outcome**; no production deployment, real client or firm data,
no savings, conversion, revenue, or legal-expertise claims are made or implied.
