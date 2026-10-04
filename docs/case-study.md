# Flagship Intake Demo — Case Study: A Counted Reviewer-Decision Gate

This is a local, sandboxed engineering proof of one pattern: **no CRM write happens
without an explicit approval action, and that property is measured by counted
writes on a real pinned runtime — not asserted by prose.** Everything shown here
is **local mock evidence with fictional Greenfield & Associates fixture data —
not a live business outcome**; no production deployment is claimed, and no real
client or firm data was used anywhere in this work.

## The problem: a decorative review gate

The starting point was a publicly shared n8n legal-ops template repository whose
client-intake workflow *claimed* a mandatory human-review gate. Reading the
actual graph contradicted the claim:

- The **"Human Review Gate" node was decorative** — a one-way insert into a
  review queue with no consumer anywhere in the repository. Nothing ever read
  the queue; nothing ever required a human to act on it.
- The **mock CRM write fired unconditionally**, immediately after the queue
  insert, on the same execution path. In the graph's connections, no condition,
  approval state, or reviewer action stands between intake acceptance and the
  CRM write.

The historical graph names real external-service hosts, but its identifiers
and credential bindings are placeholders; it must not be activated with live
accounts. Under the pinned runtime used throughout this work
(n8n 2.37.10), the **unchanged tracked template's webhook validation answers
HTTP 400** — the bundled Webhook node nests the request payload under a body
key that the template's flat-reading validation does not unwrap. That 400 is a
recorded diagnostic of the tracked bytes and is stated here without
embellishment: the tracked file is not runnable as-is, and this case study never
implies otherwise.

To measure the defect empirically, a clearly labeled **narrowly adapted runtime
copy** was derived in Phase 01 — identical graph, with exactly six URL mappings
to local mocks, five fixed local credential references, and one `Validate
Fields` webhook-body unwrap bridge (a frozen 12-entry allowlist, hash-recorded).
Only that adapted copy reached **HTTP 202**, and its downstream graph then
performed **one mock CRM write with zero approval actions** — the latent
ungated-write defect, now a measured fact instead of a code-review opinion.

The 400 (unchanged tracked bytes) and the 202-with-ungated-write (adapted copy)
are recorded as distinct diagnostics and are never conflated: the CRM write is
attributed to the adapted copy alone, never to the shipped template bytes.

## What the gated demo proves

The fix is **not a patched copy of the historical template**. It is a **new
three-graph implementation** — `intake-stage`, `reviewer-decision`,
`approved-delivery` — in which the CRM handoff physically cannot occur inside
the intake path, because the intake graph contains no CRM node at all. Delivery
is a separate graph that a recorded reviewer decision must explicitly arm.

The counted guarantees, each asserted by the launcher after teardown (see
_Test evidence_ below):

- **Zero CRM activity without an approval action.** Valid staging, invalid
  payloads (fail-closed 400), exact duplicate replays, conflicting intake keys
  (truthful 409), missing, wrong, or replayed reviewer proof, and rejected
  reviews all close with **zero CRM attempts and zero CRM effects**.
- **One authorized approval commits exactly one CRM effect.** After exactly one
  recorded approval (issued as **simulated reviewer input** by the test suite —
  see _Boundaries_), the counted state is exactly one CRM attempt and exactly
  one committed effect.
- **Committed replay adds nothing.** Re-submitting after a committed effect
  returns the existing effect and changes no counter.
- **Rejection adds nothing.** A rejected review records the decision and never
  reaches CRM.
- **Failure recovery is bounded and counted.** A deterministic pre-commit CRM
  failure is answered as a transport-success application-failure (so the
  workflow's retry policy never blindly resends): the counted sequence is
  attempts 1 / effects 0. One deliberate, state-observed, same-key retry
  commits exactly one effect: attempts 2 / effects 1.

**Counter semantics** (what counts as what):

- `crm_attempts` — the CRM **write-attempt journal**, incremented before every
  CRM call outcome. An attempt is not a success; a failed attempt still counts.
  Safety is asserted on attempts (zero attempts before approval), never
  inferred from effects.
- `crm_effects` — **committed CRM writes**, deduplicated independently by a
  stable CRM idempotency key derived from the review id.
- `approval_actions` — a **separately recorded reviewer decision event**,
  incremented only by the reviewer webhook after one-time-proof authorization.
  Queueing a review is a request for review — it is never counted as approval.

## Reproduce it

Prerequisites (read-only — nothing on your machine is reconfigured):

- A running Docker engine. The recorded runs used Docker client 29.7.2 and
  Docker Compose 5.4.0.
- The digest-pinned image already cached locally:
  `n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec`
  (n8n 2.37.10 exactly — the launcher asserts the version pin and fails closed
  on any drift).
- **No image pull ever happens.** If the image is not cached, the launcher
  fails closed instead of pulling. Pre-pull once on a connected machine with
  `docker image pull` of the same reference if you are starting from a clean
  host.
- No credentials, no `.env`, no external accounts. All data is the fictional
  Greenfield & Associates fixture committed to the repository.

The full gated acceptance suite is one command, run from the **repository
root**:

```bash
./runtime/run-gated-demo.sh
```

A successful run ends with the launcher's exact terminal line:

```
FULL-SUITE PASS: 5/5 case groups green on real pinned n8n 2.37.10 — per-case lines above carry the exact CRM ATTEMPTS and CRM EFFECTS counts
```

To reproduce the accepted evidence without republishing it, use the
verification-only clean-sandbox rerun bound to this release's committed
baseline, then verify the committed record:

```bash
./runtime/run-clean-rerun.sh --phase-base 19ce7afcfa1470512c7675cc5b0661e0714646d2
node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json
```

The accepted record was promoted by the standalone evidence driver only after
its Git-bound verifier and manifest checks. Its counted states were compared
with a prior verified run before promotion. An ordinary rerun today is
verification-only: it stages a fresh candidate, gates on comparison,
manifest, scan, regression, and end-state checks, requires the canonical log
to remain byte-identical, and discards the candidate. These are separate
actions; do not rerun the standalone publisher merely to verify this case
study. The observed acceptance and explicit comparison lines were:

```
FINAL-EVIDENCE PASS: 5/5 cases captured; record verified and published to runtime/evidence/final-evidence-log.json
RERUN COMPARISON PASS: per-case counted states identical (final-20261004T122457Z vs final-20261004T122650Z)
```

Every step inside these commands is asserted, never slept over or inferred:
import, version pin, network topology, static workflow contracts, per-case
counted states, teardown, preservation of unrelated containers, and source-hash
equality all gate the PASS lines. The verdicts are layered, not one flag: a
failed or interrupted run may still include earlier substep PASS markers — the
inner launcher's `FULL-SUITE PASS`, or `FINAL-EVIDENCE PASS` printed to the
staged candidate — before a later gate fails. What such a run never prints is
the outer rerun's final verdict: `CLEAN-RERUN PASS` is withheld until every
outer gate has passed. Standalone run-final-evidence.sh remains an explicit
republishing action that would require buyer-doc alignment; the ordinary
`run-clean-rerun.sh` is verification-only and never republishes.

## Test evidence (the committed record)

The machine-verifiable record is committed at
`runtime/evidence/final-evidence-log.json` (schema `flagship-intake-final-evidence`,
version 1). Every number below is copied from that record. The five case groups,
each isolated by a privileged admin reset and its own freshly generated one-time
reviewer proof:

| # | Case group | Covers | Final counted state |
|---|---|---|---|
| 1 | `tracer` | invalid, urgent-unapproved, valid staging | queue=1 approvals=0 CRM ATTEMPTS=0 CRM EFFECTS=0 |
| 2 | `reviewer-gate` | missing/wrong/replayed proof, malformed/unknown decisions, rejected | queue=1 approvals=0 CRM ATTEMPTS=0 CRM EFFECTS=0 |
| 3 | `approval-delivery` | staged review, simulated-reviewer approval, one committed effect, post-commit replay | queue=1 approvals=1 CRM ATTEMPTS=1 CRM EFFECTS=1 |
| 4 | `intake-idempotency` | exact duplicate replay; conflicting intake key fails closed with 409 | queue=1 approvals=0 CRM ATTEMPTS=0 CRM EFFECTS=0 |
| 5 | `crm-recovery` | deterministic pre-commit failure (1/0) + one deliberate same-key retry (2/1) | queue=1 approvals=1 CRM ATTEMPTS=2 CRM EFFECTS=1 |

Supporting verdicts from the same record:

- **Full suite:** 5/5 case groups passed on the real pinned runtime (execution,
  not import-only; the automated approvals in the matrix are **simulated
  reviewer input** performed by the test suite).
- **Static contracts:** satisfied — the fail-closed structural verifier (exact
  ordered graph compositions, a single validity IF, terminal pending response,
  cross-graph CRM exclusivity, and graph-wide URL locality) ran from inside the
  network before any case executed.
- **Preservation/teardown verdict:** every owned container, network, and volume
  was verified gone after verified teardown, and 14/14 unrelated containers
  present at run start were preserved with identical IDs and states.

**Run identity** (from the record): n8n 2.37.10; image
`n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec`;
Docker client 29.7.2; Docker Compose 5.4.0; run id `final-20261004T122650Z`,
execution mode `real-n8n`, status `completed`. The record's rerun section binds
it to the earlier accepted run `final-20261004T122457Z` with per-case counted
states identical, from a verified clean sandbox (no owned containers, networks,
volumes, generated tree, census forensics, or launcher lock — all checked
before any Docker mutation), over phase base
`19ce7afcfa1470512c7675cc5b0661e0714646d2` (the full 40-hex frozen phase
boundary, as recorded).

**Recorded source-run commit:** the evidence pipeline bound its nine-file
SHA-256 manifest to `5100860e7c887058f93607c6ab531ff370fa9997` — the commit the
recorded runs executed at. That commit is **not** the later packaging/docs
commit this case study lives at, and this document does not equate the two.
The verify command in _Reproduce it_ (run from the repository root) re-checks
every recorded invariant and additionally binds provenance to git: the
recorded head must exist in this repository's history, and each of the four
provenance SHA-256 values must equal the sha256 of the actual bytes
`git show <head>:<path>` returns for its workflow file — a record with a
forged head or fabricated hashes fails verification. The command does not
re-execute the demo.

Provenance SHA-256 (from the record): intake graph
`758a983aae207188667f23ed7eb256efc670a80d82c62c5477906bb97b857ea6`; reviewer
graph `b0dc8979d4ac410aa566091de5c0b12c60b05698241bc80e60bc8c82d0c72474`;
delivery graph
`9aa832f7ebdde6f5ebf82ab78ddfa3423f7f92cdf6cb65073e4373442730de41`; historical
source `4559c8516533a1f2150215f5662f0f78e9ab5f5059da8f64d2940479d4a9b0bc`
(byte-identical before and after every run).

A sanitized public excerpt of the same record — counts, hashes, status codes,
and identity strings only — is `docs/evidence-summary.md`.

## Architecture: three gated graphs

The historical template's human-review gate was **decorative** (a one-way queue
insert with no consumer, and a CRM write that fired unconditionally right after
it). The gated demo replaces that single graph with three deliberately small
n8n graphs, all executing on the pinned runtime against a local mock boundary:

```
   intake webhook              reviewer action               mock CRM write
         │                            │                             │
         ▼                            ▼                             ▼
 ┌──────────────────┐    ┌───────────────────────┐    ┌───────────────────────┐
 │   intake-stage   │    │   reviewer-decision   │    │  approved-delivery    │
 │   (n8n graph)    │    │   (n8n graph)         │    │  (n8n graph)          │
 │                  │    │                       │    │                       │
 │  validate (400   │    │  one-time proof       │    │  fail-closed          │
 │  on invalid);    │    │  consumed once per    │    │  approved-state       │
 │  canonical key;  │    │  registration window; │    │  assertion; single    │
 │  staged pending  │    │  approve / reject     │    │  idempotent write;    │
 │  review; NO CRM  │    │  recorded as a        │    │  attempts + effects   │
 │  node at all     │    │  separate decision    │    │  counted by the mock  │
 │                  │    │  event (reject ends)  │    │  boundary             │
 └────────┬─────────┘    └───────────┬───────────┘    └───────────┬───────────┘
          │  one pending review       │  approved state only        │  one write
          ▼                           ▼                             ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │            local mock boundary — one internal-only Docker network            │
 │   mock state service (review queue, decisions, counted admin state)          │
 │   mock CRM (attempt journal + idempotent committed effects)                  │
 │   audit container (static workflow contracts, container census, evidence)    │
 └─────────────────────────────────────────────────────────────────────────────┘
```

Design points that make the gate real rather than decorative:

- **The intake graph has no CRM capability at all.** The verifier rejects the
  intake graph at the capability level if it possesses any HTTP node except the
  local staging route — the gate is structural, not a conditional that could be
  skipped.
- **Approval is a separate recorded event**, authorized by a one-time proof
  consumed at most once per registration window, and counted by a dedicated
  admin counter that no workflow-facing mock route can increment.
- **Delivery asserts the approved state fail-closed** before its single
  idempotent write; the mock counts attempts and effects independently, so the
  assertion is measured, not trusted.
- **The whole sandbox sits on one internal-only Docker network** (verified
  `internal`, zero published ports) with a fail-closed URL allowlist across all
  graphs — the load-bearing no-egress proof. The audit suite runs from inside
  the network, so the boundary has no inbound exceptions either.

## Why no screenshots

No screenshot or screen recording is included, deliberately. The demo is an
isolated, Docker-only sandbox with no capture infrastructure in this
repository, and a screen capture of the n8n editor or the mock logs would risk
framing one-time reviewer proof values or raw (fictional) intake payloads
inside the frame. Producing a capture would also require changing the approved
internal-only network boundary to admit a browser session, and no alternate
browser identity is permitted in this work. Verified command and log evidence
is substituted instead: every number in _Test evidence_ above is
machine-parsed from the committed record, which any reader can re-derive with
the commands in _Reproduce it_.

## Boundaries (truthfulness)

- Everything here is **local mock evidence with fictional data — not a live
  business outcome**; the CRM, review, and queue endpoints are local mock
  contracts inside the Docker network, and no real system is contacted.
- No production deployment, real client or firm data, or real outcomes are
  claimed; the fixtures are fictional Greenfield & Associates records.
- No monetary or measurable gains are claimed or implied — no savings, no
  revenue effect, no conversion claims, and no legal expertise is offered.
- Every approval in the automated matrix is **simulated reviewer input**
  performed by the test suite through the separate recorded reviewer HTTP
  action; **no person is claimed to have exercised the manual two-terminal
  review path** in the recorded runs (that flow is documented in
  `runtime/README.md` for genuine human reproduction).
- The one-time reviewer proof is consumed at most once per registration
  window; a privileged admin reset may invalidate a registration and
  re-register the same raw proof value — a per-window semantic, not a durable
  one-use guarantee.
- Response-loss-after-commit handling, process-restart recovery, and universal exactly-once delivery are **NOT implemented and NOT claimed**; the
  only recovery proven is the counted pre-commit failure plus one deliberate
  same-key retry (attempts 2, effects 1).
- No blanket no-disk claim is made: n8n runtime state is tmpfs-backed, while
  invocation-owned host proof files are disk-backed until normal teardown, and
  the demo-state volume holds raw fictional intake payloads while the sandbox
  is live — it is not claimed to be PII-free; it is destroyed at verified
  teardown.
- External egress denial is attributed to the verified internal-only network
  topology plus the fail-closed URL allowlist; the supplementary TEST-NET-1
  connect probe is defense-in-depth and never cited as the sole denial proof.
