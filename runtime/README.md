# Runtime Baseline — Flagship Intake Demo (Phase 1)

One command, run from the **repository root**, reproduces the entire pinned-runtime
baseline measurement and publishes machine-verifiable evidence:

```bash
./runtime/run-baseline.sh
```

That is the only documented command for the Phase 1 baseline. Everything it does is
asserted step by step — nothing is slept over, simulated, or inferred from README
claims (D-10). The Phase 2 gated demo (approval gate, counted case suite, manual
reviewer reproduction) is documented in its own section at the bottom of this file.

## What the run proves

Against the real pinned n8n runtime (execution, not import-only):

- The **body-adapted runtime copy** of `workflows/client-intake-pipeline.json`
  (identical graph; only 6 URL mappings, 5 fixed local credential references, and
  exactly one `Validate Fields` webhook-body unwrap differ — the frozen 12-entry
  allowlist) accepts the fictional Greenfield intake fixture with **HTTP 202**, and
  its downstream graph then performs a **Lawmatics mock CRM write with zero approval
  actions** — the latent ungated-write defect this baseline exists to measure.
- The historical template's flat-reading validation was previously observed
  answering **HTTP 400** for the n8n Webhook body envelope on the same pinned
  runtime. The raw negative-control capture is **not published** in this
  release; the baseline record labels the 400 a *prior diagnostic*, not a
  measurement of this baseline run. The adapted copy's 202 and its ungated
  mock CRM write are the counted baseline measurements. See
  `docs/case-study.md` for the distinct claims and reproduction limits.
- **External egress is denied**: from inside the runtime's internal Docker network
  the local mock is reachable while a bounded TCP connect to an RFC 5737 TEST-NET-1
  address cannot be established. No live service is ever contacted.
- The tracked source stays **byte-identical** before and after the run
  (SHA-256 recorded in the evidence).

## Prerequisites (read-only)

- A running Docker engine (no configuration changes are made).
- The digest-pinned image already cached locally:
  `n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec`
- **No image pull ever happens.** If the image is not cached, the launcher fails
  closed instead of pulling (D-12). Pre-pull once on a connected machine with
  `docker image pull` of the same reference if you are starting from a clean host.
- No credentials, no `.env`, no external accounts. All data is the fictional
  Greenfield & Associates fixture (`payloads/intake-new-lead.json`).

## Expected output

A successful run ends with:

```
[baseline] BASELINE PASS: crm_writes=1 queue_writes=1 approval_actions=0
[baseline] evidence: runtime/evidence/baseline.json (n8n=2.37.10, source sha256=…, derived sha256=…)
```

followed by automatic teardown. A hard 55-second deadline guards the whole run —
no result may be reported after it.

## Generated artifacts

| Path | What it is |
| --- | --- |
| `runtime/evidence/baseline.json` | The measured baseline record (see below). Written atomically: a temporary sibling is renamed into place only after every invariant passes. |
| `runtime/.generated/` | Ephemeral launcher workspace (derived workflow copy, credential import file, single-writer lock). **Deleted on every exit path** — never committed. |

Re-verify the committed record any time:

```bash
node runtime/scripts/baseline-evidence.mjs verify runtime/evidence/baseline.json
```

## Counter semantics (what counts as what)

The mock service counts every route it serves; the evidence publishes those counters
under `measurements`:

- `lawmatics_contacts_post` → the **CRM write** (the measured defect). Baseline
  requires ≥ 1.
- `airtable_queue_post` → the **human-review queue write**. A queue insert is a
  write to a review queue — it is **not** an approval action and is never counted
  as one.
- `approval_actions` → a **dedicated counter** that no workflow-facing mock route
  can increment. The baseline run takes no approval action, so it must read exactly
  `0`. Approval is not implemented in Phase 1; its absence is measured by this
  counter staying zero, never inferred from prose, sticky notes, or queue writes.

## Safety, concurrency, and interruption

- Single writer, sequential execution (D-17): the launcher takes an atomic lock
  (`runtime/.generated/launcher.lock`) before touching anything. A second
  overlapping invocation is **rejected** with a non-zero exit and never starts a
  competing writer.
- Interruption (SIGTERM/SIGINT) or any failed step tears everything down and
  publishes **nothing** — evidence only ever appears via the verified atomic
  rename, so a partial run cannot leave an artifact that looks completed.
- Cleanup always removes the Compose project (`down -v`) and `runtime/.generated/`
  (lock included).

## When the run fails — blockers, not workarounds

Any import failure, runtime startup failure, missing pinned image, unproven egress
denial, or verifier rejection exits non-zero with an explicit
`real-runtime blocker` reason. **A blocker is a stop-and-report condition**: rerun
after fixing the environment, or report it — never edit the evidence, never widen
the allowlist, and never substitute a simulated or dry-run result for the real
execution (D-07). There is no simulation fallback anywhere in this launcher.

`./runtime/run-baseline.sh --tracer` runs the same proven sequence without
publishing an artifact — a diagnostic mode for quick checks.

### Stale-lock recovery

A hard kill (`kill -9`, OOM, power loss, host crash) can interrupt cleanup and
leave `runtime/.generated/launcher.lock` behind with no live owner. Every later
invocation will then refuse to start. The lock records who owns it:

```bash
cat runtime/.generated/launcher.lock/owner   # pid=… / host=…
ps -p <pid>                                  # is that owner still alive?
```

If the recorded PID is dead (and the hostname is this machine), recover with:

```bash
rm -rf runtime/.generated
```

Never remove the lock while its recorded PID is alive — that would set up a
competing writer, not recover from one. The launcher itself detects a provably
dead owner PID and prints this recovery hint when it refuses to start.

## Scope boundaries (truthfulness)

- Everything here is **local mock evidence with fictional data — not a live
  business outcome**. The Lawmatics/Airtable/Slack/OpenAI endpoints are local mock
  contracts inside the Docker network; no real system is contacted.
- The **approval gate itself is Phase 2 work**; this baseline deliberately measures
  the ungated write it will fix.
- The full evidence package, the verified clean-sandbox rerun record, and the
  buyer-facing case study are **delivered Phase 3 artifacts** — see
  `runtime/evidence/final-evidence-log.json`, `./runtime/run-clean-rerun.sh`,
  and `docs/case-study.md`; this baseline section itself claims none of them.
- No live-deployment or financial-benefit claims are made or implied by these
  measurements.

---

# Phase 2 — Gated Demo: Approval Gate, Counted Suite, Manual Review

One command, run from the **repository root**, reproduces the complete gated
acceptance suite from clean demo state on the real pinned runtime:

```bash
./runtime/run-gated-demo.sh
```

That is the full acceptance path (RUNT-02). Everything it does is asserted step
by step: no step is slept over, simulated, or inferred from prose.

## What the full run proves

Against the real pinned n8n 2.37.10 (imported **and** executed — never
import-only, never a mock-only simulation):

- **Staging holds.** A valid fictional Greenfield intake (the committed fixture,
  byte-identical) creates exactly one pending review with **zero CRM attempts and
  zero CRM effects**. Invalid payloads fail validation (400) and touch nothing.
  Urgency is recorded as data and consumed by nothing — it is not approval.
- **Approval is a separate recorded event.** Approve/reject are distinct reviewer
  webhooks authorized by a proof consumed once per registration window. The
  launcher generates a fresh proof for every isolated case group (and once for
  the manual hold). A privileged admin reset invalidates its registration, but
  the same raw proof can be re-registered after an admin reset and authorize
  another decision in a later window; the in-suite sub-scenarios do this. This
  local mock does **not** prove a durable one-time capability across resets.
  Missing, wrong, replayed-within-window, or malformed authorization records no
  decision and no CRM activity. Queueing a review is never approval.
- **One authorized approval ⇒ exactly one committed CRM effect**, delivered only
  through the in-graph fail-closed approved-state assertion (the mock counts; it
  is not the gate). Committed replays return the existing effect and change no
  counter.
- **Duplicates replay; conflicts fail closed.** The same intake key with the same
  canonical content returns the original review (no new writes); the same key with
  changed content returns a truthful 409 and mutates nothing.
- **Recovery is bounded and counted.** A deterministic pre-commit CRM failure is
  answered as a transport-success application-failure (so the n8n retry policy
  never resends): exactly one journaled attempt, zero effects, delivery stays
  retryable. One deliberate same-key retry commits exactly one effect — the
  counted sequence is 1/0 → 2/1.
- **Static contracts run first, inside the network.** The fail-closed structural
  verifier (exact ordered compositions, cross-graph CRM exclusivity, and
  graph-wide URL locality — together with the machine-checked `internal: true`
  network these are the load-bearing no-egress proof) and the in-process mock
  contracts both run from the audit container before any case executes.

The launcher prints **one unambiguous PASS/FAIL verdict line per case group
with the exact `CRM ATTEMPTS` and `CRM EFFECTS` counts** only after teardown,
preservation, and source hashes are proven. A failed or interrupted run never
prints these launcher PASS verdicts. Earlier raw audit-test output is diagnostic,
not certified case evidence; `FULL-SUITE PASS` is the final success marker.

## Per-case output

The full suite runs five case groups (each isolated by an admin reset and
re-armed with its own freshly generated one-time reviewer proof — a reset
invalidates any previously registered proof; each case closing with an exact
counted state):

| # | Case group | Covers | Final counted state |
|---|---|---|---|
| 1 | `tracer` | invalid, urgent-unapproved, valid staging | queue=1 approvals=0 CRM ATTEMPTS=0 CRM EFFECTS=0 |
| 2 | `reviewer-gate` | missing/wrong/replayed reviewer proof, malformed/unknown decisions, rejected | queue=1 approvals=0 CRM ATTEMPTS=0 CRM EFFECTS=0 |
| 3 | `approval-delivery` | valid staged → simulated-reviewer approval → one committed effect; post-commit replay | queue=1 approvals=1 CRM ATTEMPTS=1 CRM EFFECTS=1 |
| 4 | `intake-idempotency` | exact duplicate replay; conflicting intake key (409) | queue=1 approvals=0 CRM ATTEMPTS=0 CRM EFFECTS=0 |
| 5 | `crm-recovery` | deterministic pre-commit failure (1/0) + deliberate same-key retry (2/1) | queue=1 approvals=1 CRM ATTEMPTS=2 CRM EFFECTS=1 |

## Counter semantics (what counts as what)

- `review_queue` → a **staged pending review** created by the intake webhook. A
  queue entry is a request for human review — it is not an approval and is never
  counted as one.
- `approval_actions` → a **separately recorded reviewer decision event** (approve),
  incremented only by the reviewer webhook after one-time-proof authorization.
- `crm_attempts` → the CRM **write-attempt journal**, incremented before every CRM
  call outcome. An attempt is not a success: a failed attempt still counts here.
  Safety is asserted on attempts (zero attempts before approval), never inferred
  from effects.
- `crm_effects` → **committed CRM writes**, deduplicated independently by the
  stable CRM idempotency key (`crmkey_<review_id>`).

## Prerequisites (read-only, same as Phase 1)

- A running Docker engine (no configuration changes are made).
- The digest-pinned image already cached locally:
  `n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec`
  (n8n 2.37.10 exactly — the launcher asserts the version pin and fails closed on
  any drift).
- **No image pull ever happens.** If the image is not cached, the launcher fails
  closed instead of pulling.
- No real/external credentials, no `.env`, no external accounts. All data is the fictional
  Greenfield & Associates fixture. The single Compose network is
  `internal: true` with zero published ports — the audit suite runs from inside
  the network, so the egress boundary has no inbound exceptions either.
- **The n8n execution database is memory-backed, but the host proof files are
  not** (WR-07). The launcher writes disk-backed 0600 host proof files at
  `runtime/demo/.generated/reviewer-proof` and `issued-proofs` for the local
  reviewer action and log check. A hard kill can leave those files behind until
  the owner-verified stale-lock recovery below; normal teardown removes the
  entire generated tree and verifies its absence before PASS. The pinned
  n8n 2.37.10 writes the raw proof into *in-flight* execution data while the
  sandbox is live. Its entire state directory is therefore tmpfs-backed, with
  no n8n data volume; execution-data saving is disabled as defense in depth.
  Before PASS, the launcher checks the tmpfs mount and confirms no issued
  proof appears in captured n8n logs. This proves the **n8n state/log boundary**,
  not a global claim that the temporary host files never touched disk.

## Single writer, teardown, and preservation

- Single writer, sequential execution: the launcher takes an atomic lock
  (`runtime/demo/.generated/launcher.lock`) before touching anything. A second
  overlapping invocation is **rejected** non-zero before any Docker mutation.
- Interruption (SIGTERM/SIGINT) or any failed step tears down **only the
  invocation-owned** Compose project (`flagship-intake-gated-demo`) and its
  ephemeral tree, publishes nothing, and prints no PASS.
- **PASS is printed only after teardown is proven**: no owned project
  container/network/volume remains, the ephemeral tree (one-time proof, census,
  lock, import files) is gone, and the **unrelated-container census** re-verified —
  every container present at run start (irrespective of count; 14 were observed
  during Phase 1, not a required future count) must still exist with the identical
  ID and running state. Any mismatch, or any uncertainty anywhere (import,
  version, network, case, census), exits non-zero with an explicit reason. A
  blocker is a stop-and-report condition — never a reason to simulate a pass.

### Stale-lock recovery (Phase 2)

Same guidance as Phase 1, different path: a hard kill can leave
`runtime/demo/.generated/launcher.lock` behind with no live owner. Check
`cat runtime/demo/.generated/launcher.lock/owner` and `ps -p <pid>`; if the
recorded PID is dead, recover with BOTH steps — the launcher's stale-lock
hint prints the same commands:

1. Remove the whole invocation-owned ephemeral tree (lock, import files,
   census snapshot, and the stale one-time proof file):

   ```bash
   rm -rf runtime/demo/.generated
   ```

2. Tear down any owned containers, networks, and volumes the dead run left
   behind:

   ```bash
   docker compose -f runtime/demo/docker-compose.yml down -v --remove-orphans
   ```

Never remove the lock while its recorded PID is alive. The step-2 teardown
matters for host cleanliness; the unrelated-container census excludes this
project's own containers, so leftover owned residue alone does not fail the
rerun's preservation check.

## Manual reviewer reproduction (two terminals)

The automated suite issues its reviewer actions as **simulated reviewer input** —
a separate recorded HTTP action performed by the test suite, not an actual human
reviewing a client. To reproduce a genuine human decision:

1. **Terminal 1** — start the held sandbox and wait for its readiness line:

   ```bash
   ./runtime/run-gated-demo.sh --manual-review
   ```

   Wait until it prints:

   ```
   [gated] manual-review sandbox is LIVE: one pending review rev_…, fresh unconsumed one-time proof
   ```

   The sandbox stays live while it waits — the launcher does **not** tear down
   before the reviewer acts or you explicitly interrupt it (Ctrl-C / SIGTERM /
   SIGINT triggers the ownership-guarded teardown).

2. **Terminal 2** — execute the exact command the launcher printed (token-free;
   run it from the repository root). Choose exactly one:

   ```bash
   docker compose -f runtime/demo/docker-compose.yml run --rm -T -u 0:0 -e REVIEW_ID=<rev_…> -e DECISION=approve -e REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof audit /repo/runtime/scripts/reviewer-action.mjs
   ```

   ```bash
   docker compose -f runtime/demo/docker-compose.yml run --rm -T -u 0:0 -e REVIEW_ID=<rev_…> -e DECISION=reject -e REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof audit /repo/runtime/scripts/reviewer-action.mjs
   ```

   The helper reads the one-time proof from the ephemeral file mount — the proof
   value never appears on a command line, in console output, or in any committed
   artifact.

3. Terminal 1 observes the recorded decision (state leaves `pending`), prints
   `MANUAL REVIEW ACTION OBSERVED`, tears the owned sandbox down with full
   verification, and exits 0.

Each isolated case group (and the manual hold) begins with a freshly generated
cryptographically random proof. Internal test sub-scenarios reset mock state and
can re-register that same case proof; the consume-once promise applies only
within the current registration window. A production design would need durable
consumed-hash tombstones and new proofs across reset boundaries. While a proof
waits to be used it lives in an
invocation-owned permission-restricted file (`0600`, gitignored, inside
`runtime/demo/.generated/`) and is removed at teardown. Its raw value is never
printed. The automated lifecycle test in
`runtime/tests/gated-launcher-lifecycle.test.mjs` drives this same flow with
explicitly labeled simulated input — it is not evidence that a human reviewed
anything.

## Diagnostic modes

Focused single-run modes using the same fail-closed sequence:
`--tracer`, `--case reviewer-gate`, `--case approval-delivery`,
`--case intake-idempotency`, `--case crm-recovery`. Only the default
no-argument command is the full acceptance surface.

## Scope boundaries (truthfulness)

- Everything here is **local mock evidence with fictional data — not a live
  business outcome**. The CRM/review endpoints are local mock contracts inside
  the Docker network; no real system is contacted, and no live outcome is claimed
  or implied.
- The approval in the automated matrix is **simulated reviewer input** (see
  above); the manual two-terminal flow exists precisely so a human decision can
  be demonstrated and reproduced.
- **Response-loss-after-commit, process-restart semantics, and universal
  exactly-once delivery are NOT implemented and NOT proven** — the suite contains
  no dedicated cases for them. The proven recovery scope is exactly: a
  pre-commit application failure followed by one deliberate, state-observed,
  same-key retry.
- The packaged evidence log, the verified clean-sandbox rerun record, and the
  buyer-facing case study are **delivered Phase 3 artifacts** —
  `runtime/evidence/final-evidence-log.json`, `./runtime/run-clean-rerun.sh`,
  and `docs/case-study.md`; this Phase 2 section itself claims none of them.

---

# Phase 3 — Packaging: Evidence Log & Clean-Sandbox Rerun

Phase 3 packages the proof. Two commands, run from the **repository root**:

```bash
./runtime/run-final-evidence.sh
./runtime/run-clean-rerun.sh --phase-base <ref>
```

- `./runtime/run-final-evidence.sh` executes the unchanged Phase 2 full suite
  on the real pinned runtime, captures its genuine combined console output,
  and publishes the machine-verified evidence log at
  `runtime/evidence/final-evidence-log.json` — exact commands and pinned
  versions, the five per-case counted states with their failure conditions,
  and the recorded claim limitations. Publication is staged: the record is
  built into a sibling candidate, every check (evidence manifest, git-bound
  record verify) runs against the candidate, and only then is it atomically
  promoted — a failed check leaves the previous record byte-unchanged. The
  log is re-verifiable any time:

  ```bash
  node runtime/scripts/final-evidence.mjs verify runtime/evidence/final-evidence-log.json
  node runtime/scripts/verify-release-attachments.mjs
  ```

  The second command checks the separately archived prior full record, the
  nine-file source-run manifest, and the retrospective SHA-256 attachment
  index against this repository's Git bytes. It independently compares the
  counted matrices offline; it does not rerun n8n or turn the earlier 400
  diagnostic into a published measurement. The accepted record itself does
  not hash the archival attachments; the committed index binds their bytes.

  Its terminal success line is `FINAL-EVIDENCE PASS: 5/5 cases captured…`.

- `./runtime/run-clean-rerun.sh --phase-base <ref>` first **verifies** the
  sandbox is clean — no owned containers, networks, or volumes carrying the
  project label, no leftover generated tree, no census-forensics directory,
  no launcher lock, all fail-closed **before any Docker mutation** — then
  repeats the full suite through the evidence driver with the run-to-run
  comparison armed. The rerun is **verification-only**: the fresh record is
  staged as a candidate, the accepted record's per-case counted states must
  be reproduced exactly, every reviewed deliverable byte (the three gated
  workflows, the intake fixture, the historical source, the baseline
  evidence, the launcher, the compose file, the mock server) is bound by
  SHA-256 to the exact HEAD commit, the phase delta is disclosure-scanned for
  secrets and raw contact data, and the regression gates (host suite,
  baseline tracer, baseline evidence verification, the `-T` compose-run rule,
  historical byte-identity) re-run. Finally the canonical evidence log must
  still be **byte-identical** to the accepted record (cmp gate) and the
  verified candidate is discarded — an ordinary rerun never overwrites the
  committed record, so the committed evidence and the buyer-facing docs stay
  aligned. Republishing the canonical record is an explicit standalone
  `./runtime/run-final-evidence.sh` action reserved for a deliberate release
  decision (and updates the buyer docs contract with it), never a rerun side
  effect. The terminal line, printed only after every gate passes:

  ```
  [rerun] CLEAN-RERUN PASS: suite identical to accepted matrix (5/5); manifest bound to <head>; diff scan clean; regressions green
  ```

Everything here remains **local mock evidence with fictional data — not a
live business outcome**. The automated approvals stay labeled simulated
reviewer input, and the claim boundaries recorded in the evidence log are
exactly the ones stated in the sections above.
