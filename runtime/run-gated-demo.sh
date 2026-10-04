#!/usr/bin/env bash
# One-command gated runtime for the Phase 2 Flagship Intake demo.
#
#   ./runtime/run-gated-demo.sh                  the COMPLETE acceptance path
#                                                  (plan 02-04): fresh demo
#                                                  state, all three workflows
#                                                  imported+activated on the
#                                                  pinned n8n, static
#                                                  workflow/mock contracts,
#                                                  and the full real-runtime
#                                                  case matrix — one
#                                                  PASS/FAIL line per case
#                                                  with exact CRM ATTEMPTS
#                                                  and CRM EFFECTS counts.
#   ./runtime/run-gated-demo.sh --tracer            real-runtime intake tracer:
#                                                    import + activate + execute
#                                                    the gated intake workflow
#                                                    on pinned n8n 2.37.10 and
#                                                    prove one pending review
#                                                    with ZERO CRM attempts and
#                                                    ZERO CRM effects.
#   ./runtime/run-gated-demo.sh --case reviewer-gate
#                                                  real-runtime reviewer-gate
#                                                    case: missing/wrong/
#                                                    replayed one-time proof,
#                                                    malformed/unknown decisions
#                                                    record nothing; approve is
#                                                    a separate recorded action;
#                                                    reject never reaches CRM.
#   ./runtime/run-gated-demo.sh --manual-review    held manual-review sandbox:
#                                                    stage ONE fictional pending
#                                                    review, print the exact
#                                                    in-network approve/reject
#                                                    command (proof read from an
#                                                    invocation-owned ephemeral
#                                                    file, never revealed), and
#                                                    stay live until that action
#                                                    is observed or the operator
#                                                    explicitly interrupts.
#
# The single-case diagnostic modes (--tracer, --case ...) remain for focused
# debugging; only the default full command satisfies RUNT-02. Any other
# invocation fails closed with usage.
#
# Proven sequence (asserted, not slept — Phase 1 A-04 posture):
#   0. acquire the single-writer lock (atomic mkdir, ownership-guarded),
#      tear down prior owned Compose state FAIL-CLOSED (a failed pre-clean
#      aborts the run; all owned containers including stopped, networks,
#      and volumes are verified absent before import), hash the immutable
#      historical source AND the gated workflow exports
#   0c. preconditions proven read-only (Docker daemon, cached pinned digest —
#      never a pull), then SNAPSHOT the unrelated-container universe (every
#      container present at this run's start, ID + running state, irrespective
#      of count) BEFORE any Docker mutation (T-02-14)
#   1. generate the import files (fixed root ids injected) under
#      runtime/demo/.generated/import/
#   2. start the demo mock-api on the internal-only network, wait for its
#      health endpoint, and machine-check that Docker reports the network
#      Internal=true (egress enforcement, fail-closed)
#   3. start the real n8n server (its entrypoint imports the gated workflows
#      with root ids injected at import time and activates them before the
#      server boots, against a memory-backed tmpfs state directory — WR-07:
#      no n8n state ever touches disk), then assert the exact n8n version
#      (must be EXACTLY 2.37.10) and the three expected ACTIVE workflow ids
#      against the LIVE server's own database
#   4. define the one-time reviewer proof issuance: a fresh cryptographically
#      random proof per issuance, registered ONLY by hash with the demo mock
#      (raw proof travels over the in-network wire, never a command line or
#      committed artifact) and staged in the invocation-owned ephemeral tree
#      for the manual command and the automated audit runs (which read it back
#      from the read-only ephemeral mount — stdin/file transport only,
#      everywhere). WR-06: a fresh proof is issued after every
#      launcher-controlled state reset — one per isolated case, and the manual-review hold keeps
#      its own single fresh proof — because a reset invalidates any previous
#      registration. This is one use per registration window, NOT a durable
#      guarantee across privileged admin reset and re-registration of a value.
#   5. poll every production webhook with an invalid probe body until
#      registered
#   6. reset the demo mock state (invalidating any registered proof) and
#      immediately issue a fresh one-time proof, then run the gated acceptance
#      test from INSIDE the network via the audit service (case selected by
#      GATED_CASE; the suite acts as a SIMULATED reviewer using the case's
#      fresh proof read from the read-only ephemeral mount). The
#      default full mode first runs the static workflow/mock contracts, then
#      the complete case matrix — one counted PASS/FAIL line per case
#   7. read the counted admin state and assert the case's exact invariants
#   8. prove no issued one-time proof persists anywhere in the n8n runtime
#      files (SQLite incl. WAL sidecars) or logs (WR-07), tear the Compose
#      project down (-v) and verify containers, network, volumes, and the
#      generated directory are actually gone, then re-verify the
#      unrelated-container census against the pre-run snapshot BEFORE PASS
#   9. re-hash the immutable historical source and the gated exports; only
#      then print launcher verdict PASS lines. Audit-runner test output before
#      teardown is diagnostic, never certified case evidence.
#
# Manual-review mode deliberately differs: no watchdog deadline (a human may
# take minutes), and after step 7 it stages one fictional pending review,
# prints the executable token-free reviewer command, and WAITS until the
# reviewer action is observed in the demo state or TERM/INT requests an
# explicit teardown.
#
# Hard limits (automated modes): deadline watchdog, no image pull
# (digest-pinned cached image only), no external service contact, no
# simulation fallback. Repository-root-safe: paths resolve from git toplevel.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$ROOT"

COMPOSE_FILE="runtime/demo/docker-compose.yml"
COMPOSE_PROJECT="flagship-intake-gated-demo"
GENERATED_DIR="runtime/demo/.generated"
IMPORT_DIR="$GENERATED_DIR/import"
LOCK_DIR="$GENERATED_DIR/launcher.lock"
CENSUS_FORENSICS_DIR="runtime/demo/.census-forensics"
HISTORICAL_SOURCE="workflows/client-intake-pipeline.json"
INTAKE_WORKFLOW="runtime/demo/workflows/intake-stage.json"
REVIEWER_WORKFLOW="runtime/demo/workflows/reviewer-decision.json"
DELIVERY_WORKFLOW="runtime/demo/workflows/approved-delivery.json"
FIXTURE_FILE="payloads/intake-new-lead.json"
PINNED_IMAGE="n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec"
INTAKE_WORKFLOW_ID="greenfield-intake-gated-demo"
REVIEWER_WORKFLOW_ID="greenfield-reviewer-decision-demo"
DELIVERY_WORKFLOW_ID="greenfield-approved-delivery-demo"
REVIEWER_WEBHOOK_PATH="reviewer-decision-webhook"
DELIVERY_WEBHOOK_PATH="gated-delivery-webhook"
EXPECTED_N8N_VERSION="2.37.10"
EXPECTED_HISTORICAL_SHA256="4559c8516533a1f2150215f5662f0f78e9ab5f5059da8f64d2940479d4a9b0bc"

MODE=""
CASE_NAME=""
if [ "$#" -eq 0 ]; then
  MODE="full"
elif [ "$#" -eq 1 ] && [ "$1" = "--tracer" ]; then
  MODE="tracer"
elif [ "$#" -eq 2 ] && [ "$1" = "--case" ] && [ "$2" = "reviewer-gate" ]; then
  MODE="case"
  CASE_NAME="reviewer-gate"
elif [ "$#" -eq 2 ] && [ "$1" = "--case" ] && [ "$2" = "approval-delivery" ]; then
  MODE="case"
  CASE_NAME="approval-delivery"
elif [ "$#" -eq 2 ] && [ "$1" = "--case" ] && [ "$2" = "intake-idempotency" ]; then
  MODE="case"
  CASE_NAME="intake-idempotency"
elif [ "$#" -eq 2 ] && [ "$1" = "--case" ] && [ "$2" = "crm-recovery" ]; then
  MODE="case"
  CASE_NAME="crm-recovery"
elif [ "$#" -eq 1 ] && [ "$1" = "--manual-review" ]; then
  MODE="manual-review"
else
  printf '[gated] FAIL: usage: ./runtime/run-gated-demo.sh (no arguments = full acceptance suite) | --tracer | --case reviewer-gate | --case approval-delivery | --case intake-idempotency | --case crm-recovery | --manual-review\n' >&2
  exit 1
fi

case "$MODE" in
  full) DEADLINE_SECONDS=900 ;;
  tracer) DEADLINE_SECONDS=90 ;;
  case) DEADLINE_SECONDS=240 ;;
  manual-review) DEADLINE_SECONDS=0 ;;
esac

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Portable host-side hashing (Phase 1 IN-02): `shasum` is macOS/most-desktop-
# Linux; minimal and container hosts commonly ship only `sha256sum`. Callers
# guard with a 64-char length check so a host with neither tool fails closed.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f1
  else
    return 127
  fi
}

log() { printf '[gated] %s\n' "$*"; }
fail() {
  printf '[gated] FAIL: %s\n' "$*" >&2
  exit 1
}

assert_manual_decision_state() {
  case "$1" in
    approved|rejected) ;;
    *) fail "manual-review wait loop exited on non-decision state '$1' — no reviewer action was observed" ;;
  esac
}

DEADLINE_PID=""
OWNS_LOCK=0
TEARDOWN_DONE=0
CENSUS_VERIFY_FAILED=0
# Ownership-guarded cleanup: only the invocation that owns the lock may tear
# the runtime down — a rejected overlapping invocation must never destroy the
# owner's lock, Compose project, or state.
cleanup() {
  local rc=$?
  local teardown_failed=0
  if [ "$OWNS_LOCK" -eq 1 ] && [ "$TEARDOWN_DONE" -eq 0 ]; then
    if [ "$MODE" = "manual-review" ]; then
      printf '[gated] manual-review: explicit interruption received — tearing down the held sandbox now\n' >&2
    fi
    if ! compose down -v --remove-orphans >/dev/null 2>&1; then teardown_failed=1; fi
  fi
  if [ -n "$DEADLINE_PID" ]; then
    kill -KILL "$DEADLINE_PID" 2>/dev/null || true
    wait "$DEADLINE_PID" 2>/dev/null || true
  fi
  if [ "$OWNS_LOCK" -eq 1 ]; then
    if [ "$CENSUS_VERIFY_FAILED" -eq 1 ] && [ -f "$CENSUS_FILE" ]; then
      PRESERVED_CENSUS_DIR="$CENSUS_FORENSICS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$"
      mkdir -p "$PRESERVED_CENSUS_DIR" 2>/dev/null || true
      printf '[gated] census verification failed — preserving forensic evidence in %s before ephemeral cleanup\n' "$PRESERVED_CENSUS_DIR" >&2
      cp "$CENSUS_FILE" "$PRESERVED_CENSUS_DIR/recorded.snapshot" 2>/dev/null || true
      node runtime/scripts/docker-container-census.mjs snapshot "$PRESERVED_CENSUS_DIR/current.snapshot" "$COMPOSE_PROJECT" >/dev/null 2>&1 || true
      printf '[gated] recorded unrelated-container census was:\n' >&2
      cat "$CENSUS_FILE" >&2 2>/dev/null || true
    fi
    if ! rm -rf "$GENERATED_DIR"; then rc=1; fi
  fi
  if [ "$teardown_failed" -ne 0 ]; then
    printf '[gated] FAIL: Compose teardown failed — sandbox residue may remain; no successful cleanup is claimed\n' >&2
    rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 1' TERM INT

# --- 0a. single-writer lock: atomic mkdir rejects overlap BEFORE any
# mutation. The lock lives in the launcher-owned ephemeral directory and is
# removed by cleanup on every exit path. Ownership (PID + hostname) is
# recorded inside the lock dir so a later invocation can tell a live owner
# from a stale lock left by a hard kill. A rejected invocation creates
# nothing: only the lock's parent is ensured beforehand, and the import
# directory is created strictly after ownership is proven.
mkdir -p "$GENERATED_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  STALE_OWNER_PID="$(sed -n 's/^pid=//p' "$LOCK_DIR/owner" 2>/dev/null | tail -1)"
  if [ -n "$STALE_OWNER_PID" ] && ! ps -p "$STALE_OWNER_PID" >/dev/null 2>&1; then
    STALE_OWNER_HOST="$(sed -n 's/^host=//p' "$LOCK_DIR/owner" 2>/dev/null | tail -1)"
    fail "stale lock: $LOCK_DIR was left behind by dead PID $STALE_OWNER_PID (host: ${STALE_OWNER_HOST:-unknown}) — no live gated run owns it. Recover manually with: rm -rf $GENERATED_DIR && docker compose -f $COMPOSE_FILE down -v --remove-orphans — then rerun."
  fi
  fail "another gated-demo invocation owns $LOCK_DIR — overlapping runs are rejected; single writer, sequential execution only"
fi
OWNS_LOCK=1
printf 'pid=%s\nhost=%s\n' "$$" "$(hostname)" > "$LOCK_DIR/owner" ||
  fail "could not record lock ownership in $LOCK_DIR/owner"
mkdir -p "$IMPORT_DIR" ||
  fail "could not create the invocation-owned import directory"

# --- hard deadline: no result may be reported after this -----------------------
# Manual-review mode is deliberately unwatched: the sandbox must stay live
# until the reviewer acts or the operator interrupts it.
if [ "$DEADLINE_SECONDS" -gt 0 ]; then
  node runtime/scripts/deadline-watchdog.mjs "$$" "$DEADLINE_SECONDS" & DEADLINE_PID=$!
else
  log "manual-review mode: no deadline watchdog — the sandbox stays live until the reviewer action or explicit interruption"
fi

# --- 0b. preconditions (read-only; no pull ever) ------------------------------
docker info >/dev/null 2>&1 || fail "Docker daemon unavailable — real-runtime blocker"
docker image inspect "$PINNED_IMAGE" >/dev/null 2>&1 ||
  fail "pinned image $PINNED_IMAGE not cached locally and pulling is forbidden — real-runtime blocker"

# --- 0c. unrelated-container census BEFORE any Docker mutation (T-02-14) ------
# Snapshot every container present at this run's start (ID + running state,
# irrespective of count — 14 were observed during Phase 1, not a required
# future count), EXCLUDING this launcher's own compose project: owned
# containers are this run's lifecycle to manage, so the pre-run teardown of
# crashed-run residue can never read back as a vanished unrelated container.
# The teardown path re-verifies this census before any PASS: an unrelated
# workload that disappeared or changed state, or an unrecorded container
# that appeared, means preservation is NOT proven and the run fails closed.
CENSUS_FILE="$GENERATED_DIR/unrelated-containers.snapshot"
UNRELATED_COUNT="$(node runtime/scripts/docker-container-census.mjs snapshot "$CENSUS_FILE" "$COMPOSE_PROJECT")" ||
  fail "could not snapshot the unrelated-container census before mutation — preservation would be unproven, failing closed"
log "unrelated-container census captured: $UNRELATED_COUNT containers (IDs + running states) — preservation is re-verified before any success line is printed"

HISTORICAL_SHA256="$(sha256_of "$HISTORICAL_SOURCE" || true)"
INTAKE_SHA256="$(sha256_of "$INTAKE_WORKFLOW" || true)"
REVIEWER_SHA256="$(sha256_of "$REVIEWER_WORKFLOW" || true)"
DELIVERY_SHA256="$(sha256_of "$DELIVERY_WORKFLOW" || true)"
FIXTURE_SHA256="$(sha256_of "$FIXTURE_FILE" || true)"
[ "${#HISTORICAL_SHA256}" -eq 64 ] && [ "${#INTAKE_SHA256}" -eq 64 ] && [ "${#REVIEWER_SHA256}" -eq 64 ] && [ "${#DELIVERY_SHA256}" -eq 64 ] && [ "${#FIXTURE_SHA256}" -eq 64 ] ||
  fail "could not hash the historical source, gated workflows, and fictional fixture (needs shasum or sha256sum on PATH)"
[ "$HISTORICAL_SHA256" = "$EXPECTED_HISTORICAL_SHA256" ] ||
  fail "immutable historical source drifted: expected $EXPECTED_HISTORICAL_SHA256, got $HISTORICAL_SHA256 — refusing to run against a mutated Phase 1 control"

# --- 0d. pre-run teardown of prior owned Compose state (fail closed) --------
# A failed pre-clean can leave owned containers, networks, or volumes behind;
# swallowing it would let this run import and execute over state it never
# cleaned and eventually claim success over that residue (CR-02). The pre-clean
# result is asserted, and ALL owned resources — including STOPPED containers
# (docker ps -a, not just the running view) — are verified absent before
# anything is created. The unrelated-container census above is unaffected: it
# already excludes this project's own containers by label.
compose down -v --remove-orphans >/dev/null 2>&1 ||
  fail "pre-run Compose teardown failed — owned residue may remain; refusing to import or start the sandbox (no success will be printed)"
PRECLEAN_CONTAINERS="$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.ID}}')" ||
  fail "could not verify the pre-run owned-container teardown (docker ps -a) — uncertainty fails closed"
PRECLEAN_NETWORKS="$(docker network ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Name}}')" ||
  fail "could not verify the pre-run owned-network teardown — uncertainty fails closed"
PRECLEAN_VOLUMES="$(docker volume ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Name}}')" ||
  fail "could not verify the pre-run owned-volume teardown — uncertainty fails closed"
[ -z "$PRECLEAN_CONTAINERS" ] && [ -z "$PRECLEAN_NETWORKS" ] && [ -z "$PRECLEAN_VOLUMES" ] ||
  fail "pre-run teardown left owned containers/networks/volumes behind — refusing to start against unclean state (no success will be printed)"

# --- 1. generate the import files (fixed root ids injected host-side) ---------
inject_workflow_id() {
  node - "$1" "$2" "$3" <<'NODE' >/dev/null
import { readFileSync, writeFileSync } from 'node:fs';
const [sourcePath, workflowId, destinationPath] = process.argv.slice(2);
const workflow = JSON.parse(readFileSync(sourcePath, 'utf8'));
workflow.id = workflowId;
writeFileSync(destinationPath, `${JSON.stringify(workflow, null, 2)}\n`);
NODE
}
inject_workflow_id "$INTAKE_WORKFLOW" "$INTAKE_WORKFLOW_ID" "$IMPORT_DIR/intake-stage.import.json" ||
  fail "could not generate the intake import workflow file (id injection failed)"
inject_workflow_id "$REVIEWER_WORKFLOW" "$REVIEWER_WORKFLOW_ID" "$IMPORT_DIR/reviewer-decision.import.json" ||
  fail "could not generate the reviewer import workflow file (id injection failed)"
inject_workflow_id "$DELIVERY_WORKFLOW" "$DELIVERY_WORKFLOW_ID" "$IMPORT_DIR/approved-delivery.import.json" ||
  fail "could not generate the delivery import workflow file (id injection failed)"

# --- 2. demo mock service up + explicit health signal -------------------------
compose up -d mock-api >/dev/null

# --- 2a. machine-check the egress enforcement itself --------------------------
# `internal: true` in the compose file is the actual enforcement; assert the
# network property host-side and fail closed unless Docker itself reports
# Internal=true.
RUNTIME_NET_NAME="$(docker network ls \
  --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
  --filter "label=com.docker.compose.network=runtime-net" \
  --format '{{.Name}}' | head -1)"
[ -n "$RUNTIME_NET_NAME" ] ||
  fail "runtime-net was not created — egress enforcement unproven, failing closed"
RUNTIME_NET_INTERNAL="$(docker network inspect "$RUNTIME_NET_NAME" --format '{{.Internal}}')"
[ "$RUNTIME_NET_INTERNAL" = "true" ] ||
  fail "runtime-net is NOT internal ($RUNTIME_NET_NAME reports Internal=$RUNTIME_NET_INTERNAL) — egress enforcement missing, failing closed"
log "egress enforcement machine-checked: $RUNTIME_NET_NAME Internal=true"

for _ in $(seq 1 60); do
  if compose exec -T mock-api node -e "fetch('http://127.0.0.1:9090/admin/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
compose exec -T mock-api node -e "fetch('http://127.0.0.1:9090/admin/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null ||
  fail "demo mock-api health endpoint never became ready"

# --- 3. start the real n8n server: entrypoint import + live assertions -------
# The n8n service entrypoint (runtime/demo/docker-compose.yml) imports the
# three gated workflows from the read-only /import mount (root ids injected
# host-side below) and activates them BEFORE starting the server, against the
# service's memory-backed (tmpfs) state directory — WR-07: no n8n data ever
# touches disk. The exact version pin and the imported ids are then asserted
# against the LIVE server's own database — the same fail-closed guarantees the
# previous one-off setup container provided.
compose up -d n8n >/dev/null

compose exec -T n8n node -e '
  (async () => {
    for (let i = 0; i < 240; i++) {
      try { const r = await fetch("http://127.0.0.1:5678/healthz"); if (r.ok) process.exit(0); } catch {}
      await new Promise((res) => setTimeout(res, 250));
    }
    process.exit(1);
  })();
' >/dev/null || fail "n8n /healthz never became ready — real-runtime blocker (check: docker compose -f $COMPOSE_FILE logs n8n for entrypoint import failures)"

N8N_VERSION="$(compose exec -T n8n node -e 'process.stdout.write(require("/usr/local/lib/node_modules/n8n/package.json").version)' | tail -1)"
# Strip any carriage return a TTY line discipline may still have left behind —
# the version assertion below requires an exact pin (Phase 1 CR-01).
N8N_VERSION="${N8N_VERSION%$'\r'}"
[ -n "$N8N_VERSION" ] || fail "could not read the pinned n8n version from the live server"
[ "$N8N_VERSION" = "$EXPECTED_N8N_VERSION" ] ||
  fail "runtime n8n version is $N8N_VERSION, expected exactly $EXPECTED_N8N_VERSION — refusing to execute on an unpinned runtime"
log "real n8n runtime version: $N8N_VERSION (exact pin asserted)"

IMPORTED_WORKFLOWS_JSON="$(compose exec -T n8n node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/home/node/.n8n/database.sqlite", { readOnly: true });
  const rows = db.prepare("SELECT id, active FROM workflow_entity").all();
  process.stdout.write(JSON.stringify(rows));
' | tail -1)" || fail "could not read the imported workflows from the live n8n database"
IMPORTED_CHECK="$(node - "$INTAKE_WORKFLOW_ID" "$REVIEWER_WORKFLOW_ID" "$DELIVERY_WORKFLOW_ID" "$IMPORTED_WORKFLOWS_JSON" <<'NODE'
const [intakeId, reviewerId, deliveryId, raw] = process.argv.slice(2);
let rows = [];
try { rows = JSON.parse(raw); } catch {}
const byId = new Map(rows.map((row) => [String(row.id), row.active]));
const expected = [intakeId, reviewerId, deliveryId];
const isActive = (value) => value === 1 || value === true;
const bad =
  byId.size !== expected.length ||
  expected.some((id) => !byId.has(id) || !isActive(byId.get(id)));
if (bad) {
  console.log("BAD state=" + JSON.stringify([...byId.entries()]));
} else {
  console.log("OK");
}
NODE
)" || fail "could not verify the imported workflow ids in the live n8n database"
[ "$IMPORTED_CHECK" = "OK" ] ||
  fail "the live n8n database does not hold exactly the three expected ACTIVE gated workflows — import/activation failed: $IMPORTED_CHECK"
log "live n8n database holds exactly the three expected active gated workflows (ids asserted)"

# --- 4. one-time reviewer proof issuance + the shared state reset -----------
# WR-06: a fresh cryptographically random proof is generated, staged in the
# invocation-owned ephemeral tree, and registered (hash-only) with the demo
# mock IMMEDIATELY AFTER EVERY STATE RESET — one fresh proof per isolated
# case, and the manual-review hold keeps its own single fresh proof. An admin
# reset invalidates the current registration; internal test sub-scenarios can
# re-register the same case proof after reset and consume it in another window.
# The raw value travels over the in-network
# wire via stdin (never a command line); only its SHA-256 is stored by the
# mock. The disk-backed 0600 host proof files (`reviewer-proof` and the
# `issued-proofs` log) live in the generated tree until normal teardown; a
# hard kill may leave them for owner-verified stale-lock recovery. The final
# check proves only that n8n state is tmpfs-backed and its logs contain no
# issued proof (WR-07), not that these temporary host files never touched disk.
issue_reviewer_proof() {
  local proof old_umask
  proof="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  [ "${#proof}" -ge 32 ] || fail "could not generate a fresh one-time reviewer proof"
  old_umask="$(umask)"
  umask 077
  printf '%s' "$proof" > "$GENERATED_DIR/reviewer-proof" ||
    fail "could not write the invocation-owned ephemeral reviewer proof file"
  chmod 600 "$GENERATED_DIR/reviewer-proof"
  printf '%s\n' "$proof" >> "$GENERATED_DIR/issued-proofs" ||
    fail "could not append to the invocation-owned issued-proofs log"
  chmod 600 "$GENERATED_DIR/issued-proofs"
  umask "$old_umask"
  printf '%s' "$proof" | compose exec -T mock-api node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      fetch("http://127.0.0.1:9090/admin/reviewer-proof", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof: d.trim() }),
      })
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1));
    });
  ' >/dev/null || fail "could not register the fresh one-time reviewer proof hash with the demo mock"
}

# The single shared demo-state reset (manual-review branch, full matrix, and
# single-case branch): a reset invalidates any registered one-time proof
# ENTIRELY, so every call site must immediately issue a fresh proof.
reset_demo_state() {
  compose exec -T mock-api node -e 'fetch("http://127.0.0.1:9090/admin/reset",{method:"POST"}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null
}

# --- 5. wait for webhook registration (the server is up since step 3) --------
# Invalid-body probes: n8n answers 404 until a production webhook is
# registered; once registered each probe takes the 400 validation path, which
# performs zero mock writes (counters are reset again below regardless).
wait_for_webhook() {
  local webhook_path="$1"
  compose exec -T n8n node -e '
    (async () => {
      for (let i = 0; i < 80; i++) {
        try {
          const r = await fetch("http://127.0.0.1:5678/webhook/'"$webhook_path"'", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          if (r.status !== 404) process.exit(0);
        } catch {}
        await new Promise((res) => setTimeout(res, 250));
      }
      process.exit(1);
    })();
  ' >/dev/null || fail "production webhook $webhook_path never registered — real-runtime blocker"
}
wait_for_webhook "gated-intake-webhook"
wait_for_webhook "$REVIEWER_WEBHOOK_PATH"
wait_for_webhook "$DELIVERY_WEBHOOK_PATH"

# --- WR-07: prove the n8n state/log boundary, not host-file RAM-only storage ---
# Measured on the pinned 2.37.10 (see runtime/demo/docker-compose.yml): the
# token unavoidably transits the reviewer webhook request, n8n writes
# in-flight execution data unconditionally at execution start, and webhook
# executions are never finalized — so the token DOES exist in the n8n SQLite
# database WHILE THE SANDBOX IS LIVE. The containment this launcher proves
# before any PASS is:
#   1. the captured n8n container logs contain no issued token (byte search,
#      token read from the 0600 issued-proofs log — file/stdin transport
#      only, never argv or console);
#   2. the ENTIRE n8n state directory is memory-backed (tmpfs, asserted via
#      statfs from inside the container): the database, its WAL sidecars, and
#      every other n8n file never touch DISK — they die with the container;
#   3. no owned n8n-data volume exists at all (disk residue is structurally
#      impossible for n8n state; the demo-state volume has fictional contact
#      payloads but no raw reviewer proof).
# This check does NOT say the 0600 host proof files are RAM-only. Any failed
# n8n state/log check fails closed before PASS; normal teardown removes the
# host generated tree separately and verifies it is gone.
assert_no_proof_persisted() {
  [ -s "$GENERATED_DIR/issued-proofs" ] ||
    fail "the issued-proofs log is missing — the n8n state/log proof boundary cannot be checked, failing closed"
  compose logs --no-color n8n > "$GENERATED_DIR/n8n-container.log" 2>/dev/null ||
    fail "could not capture the n8n container logs for the proof-persistence check"
  if ! node - "$GENERATED_DIR/issued-proofs" "$GENERATED_DIR/n8n-container.log" <<'NODE'
const { readFileSync } = require('node:fs');
const [proofsPath, logsPath] = process.argv.slice(2);
const tokens = readFileSync(proofsPath, 'utf8')
  .split('\n')
  .map((token) => token.trim())
  .filter((token) => token.length >= 16);
if (tokens.length === 0) {
  console.error('no issued proofs recorded — absence cannot be proven');
  process.exit(1);
}
const logs = readFileSync(logsPath);
for (const token of tokens) {
  if (logs.includes(Buffer.from(token, 'utf8'))) {
    console.error('the raw one-time reviewer proof was found in the n8n container logs');
    process.exit(1);
  }
}
NODE
  then
    fail "the raw one-time reviewer proof was found in the n8n container logs — no PASS will be printed"
  fi
  compose exec -T n8n node -e '
    const fs = require("fs");
    const TMPFS_MAGIC = 0x01021994;
    let stats;
    try {
      stats = fs.statfsSync("/home/node/.n8n");
    } catch (error) {
      console.error("could not statfs the n8n state directory: " + error.message);
      process.exit(1);
    }
    if (Number(stats.type) !== TMPFS_MAGIC) {
      console.error("the n8n state directory is NOT memory-backed (statfs type " + Number(stats.type) + ") — execution data would persist to disk");
      process.exit(1);
    }
    process.exit(0);
  ' >/dev/null ||
    fail "the n8n state directory is not tmpfs-backed — the one-time proof could reach disk — no PASS will be printed"
  local owned_volumes n8n_volume
  owned_volumes="$(docker volume ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Name}}')" ||
    fail "could not verify that no n8n-data volume exists — uncertainty fails closed"
  n8n_volume="$(printf '%s\n' "$owned_volumes" | grep -c "n8n-data" || true)"
  [ "$n8n_volume" -eq 0 ] ||
    fail "an owned n8n-data volume exists — n8n state (and any in-flight proof) could persist on disk — no PASS will be printed"
  log "n8n proof boundary verified: no issued proof appears in n8n logs, n8n state is tmpfs-backed, and no n8n-data volume exists; temporary 0600 host proof files remain until teardown"
}

# --- shared teardown, used by BOTH mode branches --------------------------------
# Defined once above the manual-review branch so the human-review path and
# the automated paths can never fork the teardown guarantee: owned Compose
# resources down (-v), every owned container/network/volume verified gone,
# the unrelated-container census re-verified, and the ephemeral tree removed
# — all BEFORE any PASS or action-observed line is printed.
teardown_runtime() {
  # WR-07: the n8n state/log check runs FIRST while its memory-backed state
  # still exists — the compose down below would destroy that evidence.
  assert_no_proof_persisted
  compose down -v --remove-orphans >/dev/null 2>&1 ||
    fail "final Compose teardown failed — no PASS will be printed"
  local remaining_containers remaining_networks remaining_volumes
  # WR-08: docker ps -a, not the running-only view — a stopped labeled
  # container left behind by a "successful" compose down is residue too and
  # must refuse this teardown's success claim.
  remaining_containers="$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.ID}}')" ||
    fail "could not verify final Compose container teardown"
  remaining_networks="$(docker network ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Name}}')" ||
    fail "could not verify final Compose network teardown"
  remaining_volumes="$(docker volume ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Name}}')" ||
    fail "could not verify final Compose volume teardown"
  [ -z "$remaining_containers" ] && [ -z "$remaining_networks" ] && [ -z "$remaining_volumes" ] ||
    fail "Compose returned success but project containers, networks, or volumes remain — no PASS will be printed"
  if ! node runtime/scripts/docker-container-census.mjs verify "$CENSUS_FILE" "$COMPOSE_PROJECT"; then
    CENSUS_VERIFY_FAILED=1
    fail "unrelated-container census mismatch — preservation is NOT proven; no PASS will be printed"
  fi
  UNRELATED_PRESERVED="$(node runtime/scripts/docker-container-census.mjs count "$CENSUS_FILE")"
  rm -rf "$GENERATED_DIR"
  [ ! -e "$GENERATED_DIR" ] ||
    fail "generated directory $GENERATED_DIR still exists after cleanup — no PASS will be printed"
  log "unrelated containers preserved: ${UNRELATED_PRESERVED}/${UNRELATED_COUNT} (ID + running state identical); owned teardown verified"
  TEARDOWN_DONE=1
  OWNS_LOCK=0
}

# --- manual-review mode: stage, print the command, hold the sandbox live ------
if [ "$MODE" = "manual-review" ]; then
  reset_demo_state ||
    fail "demo state reset failed before staging the manual review"
  # WR-06: the manual hold runs under its OWN single fresh one-time proof,
  # issued after the reset that just invalidated any prior registration.
  issue_reviewer_proof

  # Stage ONE fictional pending review through the REAL intake webhook, from
  # inside the network, using the committed fixture byte-identical (passed to
  # the already-running n8n container as base64 env — its node executes the
  # staging fetch against its own webhook on 127.0.0.1).
  FIXTURE_B64="$(base64 < "$FIXTURE_FILE" | tr -d '\n')"
  [ -n "$FIXTURE_B64" ] || fail "could not encode the fictional fixture for staging"
  STAGE_OUTPUT="$(compose exec -T -e FIXTURE_B64="$FIXTURE_B64" n8n node -e '
    (async () => {
      const body = Buffer.from(process.env.FIXTURE_B64, "base64");
      const key = "manual-review-" + Date.now();
      const r = await fetch("http://127.0.0.1:5678/webhook/gated-intake-webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intake-idempotency-key": key },
        body,
      });
      const text = await r.text();
      console.log("STAGE_STATUS=" + r.status);
      console.log("STAGE_BODY=" + text);
    })().catch((e) => { console.error(String(e)); process.exit(1); });
  ' 2>&1)" || fail "could not stage the manual-review pending intake — real-runtime blocker. Output: $(printf '%s' "$STAGE_OUTPUT" | tail -n 3)"

  STAGE_STATUS="$(printf '%s\n' "$STAGE_OUTPUT" | sed -n 's/^STAGE_STATUS=//p' | tail -1 | tr -d '\r')"
  STAGE_BODY="$(printf '%s\n' "$STAGE_OUTPUT" | sed -n 's/^STAGE_BODY=//p' | tail -1)"
  [ "$STAGE_STATUS" = "202" ] ||
    fail "the manual-review intake did not stage as pending (HTTP $STAGE_STATUS: $STAGE_BODY)"
  MANUAL_REVIEW_ID="$(printf '%s' "$STAGE_BODY" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).review_id??"")}catch{console.log("")}})')"
  case "$MANUAL_REVIEW_ID" in
    rev_*) ;;
    *) fail "could not read the staged manual review id (got '${MANUAL_REVIEW_ID:-<absent>}')" ;;
  esac

  log "manual-review sandbox is LIVE: one pending review $MANUAL_REVIEW_ID, fresh unconsumed one-time proof"
  log "issue the reviewer decision (a HUMAN acting as reviewer) with EXACTLY one of:"
  log "  docker compose -f $COMPOSE_FILE run --rm -T -u 0:0 -e REVIEW_ID=$MANUAL_REVIEW_ID -e DECISION=approve -e REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof audit /repo/runtime/scripts/reviewer-action.mjs"
  log "  docker compose -f $COMPOSE_FILE run --rm -T -u 0:0 -e REVIEW_ID=$MANUAL_REVIEW_ID -e DECISION=reject -e REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof audit /repo/runtime/scripts/reviewer-action.mjs"
  log "the command reads the proof from the invocation-owned ephemeral file — the proof value is never printed or committed"
  log "waiting for the reviewer action (Ctrl-C tears the sandbox down explicitly)..."

  MANUAL_DECISION_STATE="waiting"
  while true; do
    MANUAL_STATE_NOW="$(compose exec -T mock-api node -e '
      fetch("http://127.0.0.1:9090/admin/state")
        .then((r) => r.json())
        .then((s) => {
          const review = (s.reviews || []).find((candidate) => candidate.review_id === "'"$MANUAL_REVIEW_ID"'");
          console.log(review ? review.state : "missing");
        })
        .catch(() => console.log("poll-error"));
    ' 2>/dev/null || echo poll-error)"
    if [ "$MANUAL_STATE_NOW" != "pending" ] && [ "$MANUAL_STATE_NOW" != "poll-error" ]; then
      MANUAL_DECISION_STATE="$MANUAL_STATE_NOW"
      break
    fi
    sleep 1
  done

  teardown_runtime
  assert_manual_decision_state "$MANUAL_DECISION_STATE"
  log "MANUAL REVIEW ACTION OBSERVED: review $MANUAL_REVIEW_ID is now $MANUAL_DECISION_STATE"
  log "evidence: n8n=$N8N_VERSION (exact pin), intake id=$INTAKE_WORKFLOW_ID, reviewer id=$REVIEWER_WORKFLOW_ID, historical source sha256=$HISTORICAL_SHA256"
  exit 0
fi

# --- shared counted-state reader (used by the full matrix and single cases) ---
state_field() { printf '%s' "$STATE_JSON" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const r=JSON.parse(d);const v=(r.counters??{})["'"$1"'"]??0;console.log(String(v))})'; }
read_admin_state() {
  compose exec -T mock-api node -e 'fetch("http://127.0.0.1:9090/admin/state").then((r)=>{if(!r.ok)process.exit(1);return r.json()}).then((s)=>console.log(JSON.stringify(s)))'
}

if [ "$MODE" = "full" ]; then
  # --- 6a. static workflow/mock contracts from the audit container ------------
  # The fail-closed structural verifier (graph-wide URL locality, ordered
  # compositions, CRM-exclusivity) and the in-process mock contracts run
  # inside the network before any case executes: egress/locality and
  # contract uncertainty is a blocker here, never a later surprise.
  log "running static workflow/mock contracts inside the audit container (n8n $N8N_VERSION)"
  if ! compose run --rm -T \
      -e N8N_BASE_URL=http://n8n:5678 \
      -e MOCK_BASE_URL=http://mock-api:9090 \
      audit --test runtime/tests/gated-workflows.test.mjs runtime/tests/gated-mock-contracts.test.mjs; then
    fail "static workflow/mock contracts failed — structural or mock-contract uncertainty is a blocker, NOT a pass"
  fi
  log "static workflow/mock contracts verified; results pending teardown and source checks"

  # --- 6b. the complete real-runtime case matrix: one counted PASS/FAIL line
  # per case group. Required coverage: valid staged→simulated-reviewer
  # approval, invalid, exact duplicate plus post-commit replay, rejected,
  # deterministic pre-commit failure plus deliberate retry, urgent-unapproved,
  # conflicting intake key, and missing/wrong/replayed reviewer proof.
  FULL_CASES="tracer reviewer-gate approval-delivery intake-idempotency crm-recovery"
  FULL_TOTAL=5
  FULL_INDEX=0
  CASE_PASS_LINES=()
  for FULL_CASE in $FULL_CASES; do
    FULL_INDEX=$((FULL_INDEX + 1))
    CASE_NAME="$FULL_CASE"
    reset_demo_state ||
      fail "demo state reset failed before case $CASE_NAME — state persistence is broken, failing closed"
    # WR-06: each isolated case runs under its OWN freshly generated
    # proof (the reset above invalidated the previous registration; internal
    # sub-scenarios may re-register this case's proof in a later window).
    issue_reviewer_proof
    log "running full-suite case $FULL_INDEX/$FULL_TOTAL: $CASE_NAME"
    if ! compose run --rm -T -u 0:0 \
        -e N8N_BASE_URL=http://n8n:5678 \
        -e MOCK_BASE_URL=http://mock-api:9090 \
        -e GATED_CASE="$CASE_NAME" \
        -e "GATED_IMPORTED_WORKFLOW_ID=$INTAKE_WORKFLOW_ID" \
        -e "GATED_REVIEWER_IMPORTED_WORKFLOW_ID=$REVIEWER_WORKFLOW_ID" \
        -e "GATED_DELIVERY_IMPORTED_WORKFLOW_ID=$DELIVERY_WORKFLOW_ID" \
        -e "GATED_REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof" \
        -e "GATED_N8N_VERSION=$N8N_VERSION" \
        -e "GATED_NETWORK_INTERNAL=$RUNTIME_NET_INTERNAL" \
        -e "GATED_HISTORICAL_SOURCE_SHA256=$HISTORICAL_SHA256" \
        -e "GATED_INTAKE_WORKFLOW_SHA256=$INTAKE_SHA256" \
        -e "GATED_REVIEWER_WORKFLOW_SHA256=$REVIEWER_SHA256" \
        -e "GATED_DELIVERY_WORKFLOW_SHA256=$DELIVERY_SHA256" \
        audit --test runtime/tests/gated.e2e.test.mjs; then
      fail "CASE FAIL ($FULL_INDEX/$FULL_TOTAL) $CASE_NAME: gated acceptance test failed against the real pinned runtime — NOT a simulation, NOT a pass"
    fi

    STATE_JSON="$(read_admin_state)" ||
      fail "could not read the counted demo admin state after case $CASE_NAME"
    REVIEW_QUEUE="$(state_field review_queue)"
    APPROVAL_ACTIONS="$(state_field approval_actions)"
    CRM_ATTEMPTS="$(state_field crm_attempts)"
    CRM_EFFECTS="$(state_field crm_effects)"

    case "$CASE_NAME" in
      tracer)
        EXPECT_QUEUE=1; EXPECT_APPROVALS=0; EXPECT_ATTEMPTS=0; EXPECT_EFFECTS=0
        CASE_SUMMARY="invalid, urgent-unapproved, and valid staging all hold zero CRM activity before any reviewer action" ;;
      reviewer-gate)
        EXPECT_QUEUE=1; EXPECT_APPROVALS=0; EXPECT_ATTEMPTS=0; EXPECT_EFFECTS=0
        CASE_SUMMARY="missing/wrong/replayed reviewer proof and malformed/unknown decisions record nothing; the closing reject never reaches CRM" ;;
      approval-delivery)
        EXPECT_QUEUE=1; EXPECT_APPROVALS=1; EXPECT_ATTEMPTS=1; EXPECT_EFFECTS=1
        CASE_SUMMARY="valid staged pending review plus simulated-reviewer approval commits exactly one CRM effect; committed replay changes nothing" ;;
      intake-idempotency)
        EXPECT_QUEUE=1; EXPECT_APPROVALS=0; EXPECT_ATTEMPTS=0; EXPECT_EFFECTS=0
        CASE_SUMMARY="exact duplicate replay reuses the one review; a conflicting intake key fails closed with 409" ;;
      crm-recovery)
        EXPECT_QUEUE=1; EXPECT_APPROVALS=1; EXPECT_ATTEMPTS=2; EXPECT_EFFECTS=1
        CASE_SUMMARY="deterministic pre-commit CRM failure (1/0) plus one deliberate same-key retry (2/1) commits exactly one effect" ;;
    esac

    [ "$REVIEW_QUEUE" -eq "$EXPECT_QUEUE" ] ||
      fail "CASE FAIL ($FULL_INDEX/$FULL_TOTAL) $CASE_NAME: expected queue=$EXPECT_QUEUE, got $REVIEW_QUEUE — NOT a pass"
    [ "$APPROVAL_ACTIONS" -eq "$EXPECT_APPROVALS" ] ||
      fail "CASE FAIL ($FULL_INDEX/$FULL_TOTAL) $CASE_NAME: expected approval_actions=$EXPECT_APPROVALS, got $APPROVAL_ACTIONS — NOT a pass"
    [ "$CRM_ATTEMPTS" -eq "$EXPECT_ATTEMPTS" ] ||
      fail "CASE FAIL ($FULL_INDEX/$FULL_TOTAL) $CASE_NAME: expected CRM ATTEMPTS=$EXPECT_ATTEMPTS, got $CRM_ATTEMPTS — NOT a pass"
    [ "$CRM_EFFECTS" -eq "$EXPECT_EFFECTS" ] ||
      fail "CASE FAIL ($FULL_INDEX/$FULL_TOTAL) $CASE_NAME: expected CRM EFFECTS=$EXPECT_EFFECTS, got $CRM_EFFECTS — NOT a pass"

    CASE_PASS_LINES+=("CASE PASS ($FULL_INDEX/$FULL_TOTAL) $CASE_NAME: $CASE_SUMMARY — queue=$REVIEW_QUEUE approval_actions=$APPROVAL_ACTIONS CRM ATTEMPTS=$CRM_ATTEMPTS CRM EFFECTS=$CRM_EFFECTS")
  done
else

# --- 6. clean demo state, run the acceptance test from inside the network -----
reset_demo_state ||
  fail "demo state reset failed before the acceptance test — state persistence is broken, failing closed"
# WR-06: the single isolated case runs under its own fresh one-time proof.
issue_reviewer_proof

log "running pinned-runtime gated case (n8n $N8N_VERSION, mode $MODE${CASE_NAME:+, case $CASE_NAME})"
if ! compose run --rm -T -u 0:0 \
    -e N8N_BASE_URL=http://n8n:5678 \
    -e MOCK_BASE_URL=http://mock-api:9090 \
    -e GATED_CASE="$CASE_NAME" \
    -e "GATED_IMPORTED_WORKFLOW_ID=$INTAKE_WORKFLOW_ID" \
    -e "GATED_REVIEWER_IMPORTED_WORKFLOW_ID=$REVIEWER_WORKFLOW_ID" \
    -e "GATED_DELIVERY_IMPORTED_WORKFLOW_ID=$DELIVERY_WORKFLOW_ID" \
    -e "GATED_REVIEWER_PROOF_FILE=/ephemeral/reviewer-proof" \
    -e "GATED_N8N_VERSION=$N8N_VERSION" \
    -e "GATED_NETWORK_INTERNAL=$RUNTIME_NET_INTERNAL" \
    -e "GATED_HISTORICAL_SOURCE_SHA256=$HISTORICAL_SHA256" \
    -e "GATED_INTAKE_WORKFLOW_SHA256=$INTAKE_SHA256" \
    -e "GATED_REVIEWER_WORKFLOW_SHA256=$REVIEWER_SHA256" \
    -e "GATED_DELIVERY_WORKFLOW_SHA256=$DELIVERY_SHA256" \
    audit --test runtime/tests/gated.e2e.test.mjs; then
  fail "gated acceptance test failed against the real pinned runtime — NOT a simulation, NOT a pass"
fi

# --- 7. counted demo state: per-mode exact invariants --------------------------
STATE_JSON="$(read_admin_state)" ||
  fail "could not read the counted demo admin state after the acceptance test"
REVIEW_QUEUE="$(state_field review_queue)"
APPROVAL_ACTIONS="$(state_field approval_actions)"
CRM_ATTEMPTS="$(state_field crm_attempts)"
CRM_EFFECTS="$(state_field crm_effects)"

if [ "$MODE" = "tracer" ]; then
  [ "$REVIEW_QUEUE" -eq 1 ] ||
    fail "expected exactly one pending review after the counted tracer case, got queue=$REVIEW_QUEUE"
  [ "$APPROVAL_ACTIONS" -eq 0 ] ||
    fail "APPROVAL_ACTIONS=$APPROVAL_ACTIONS observed in tracer mode — no reviewer action exists there"
  [ "$CRM_ATTEMPTS" -eq 0 ] ||
    fail "CRM ATTEMPTS=$CRM_ATTEMPTS observed before any reviewer action — the pre-approval safety boundary is broken"
  [ "$CRM_EFFECTS" -eq 0 ] ||
    fail "CRM EFFECTS=$CRM_EFFECTS observed before any reviewer action — the pre-approval safety boundary is broken"
elif [ "$CASE_NAME" = "reviewer-gate" ]; then
  # Final counted state = the closing reject case: one staged review, zero
  # approval actions, zero CRM activity. Every negative and the approval
  # case were asserted in-count inside the suite after isolated resets.
  [ "$REVIEW_QUEUE" -eq 1 ] ||
    fail "reviewer-gate final state must hold exactly one staged review, got queue=$REVIEW_QUEUE"
  [ "$APPROVAL_ACTIONS" -eq 0 ] ||
    fail "reviewer-gate final state (reject case) must hold zero approval actions, got $APPROVAL_ACTIONS"
  [ "$CRM_ATTEMPTS" -eq 0 ] ||
    fail "CRM ATTEMPTS=$CRM_ATTEMPTS observed in the reviewer-gate case — rejection/auth failures must never reach CRM"
  [ "$CRM_EFFECTS" -eq 0 ] ||
    fail "CRM EFFECTS=$CRM_EFFECTS observed in the reviewer-gate case — rejection/auth failures must never reach CRM"
elif [ "$CASE_NAME" = "intake-idempotency" ]; then
  # Final counted state = the closing conflict case: one staged review (the
  # replays reused it), zero approvals, zero CRM activity. Replay and
  # conflict invariants were asserted in-count inside the suite after
  # isolated resets.
  [ "$REVIEW_QUEUE" -eq 1 ] ||
    fail "intake-idempotency final state must hold exactly one staged review (replays reuse it), got queue=$REVIEW_QUEUE"
  [ "$APPROVAL_ACTIONS" -eq 0 ] ||
    fail "intake-idempotency final state must hold zero approval actions — a duplicate is never approval, got $APPROVAL_ACTIONS"
  [ "$CRM_ATTEMPTS" -eq 0 ] ||
    fail "CRM ATTEMPTS=$CRM_ATTEMPTS observed in the intake-idempotency case — replay/conflict must never reach CRM"
  [ "$CRM_EFFECTS" -eq 0 ] ||
    fail "CRM EFFECTS=$CRM_EFFECTS observed in the intake-idempotency case — replay/conflict must never reach CRM"
elif [ "$CASE_NAME" = "crm-recovery" ]; then
  # Final counted state = the closing committed replay: one staged review,
  # one recorded approval, exactly two CRM attempts (the faulted first
  # invocation plus one deliberate same-key retry) and exactly one committed
  # effect. The full 1/0 → 2/1 sequence was asserted in-count inside the
  # suite after an isolated reset.
  [ "$REVIEW_QUEUE" -eq 1 ] ||
    fail "crm-recovery final state must hold exactly one staged review, got queue=$REVIEW_QUEUE"
  [ "$APPROVAL_ACTIONS" -eq 1 ] ||
    fail "crm-recovery final state must hold exactly one approval action, got $APPROVAL_ACTIONS"
  [ "$CRM_ATTEMPTS" -eq 2 ] ||
    fail "the bounded recovery promise is attempts 1/0 then 2/1 — expected exactly 2 attempts, got $CRM_ATTEMPTS"
  [ "$CRM_EFFECTS" -eq 1 ] ||
    fail "the bounded recovery promise is attempts 1/0 then 2/1 — expected exactly 1 effect, got $CRM_EFFECTS"
elif [ "$CASE_NAME" = "approval-delivery" ]; then
  # Final counted state = the closing happy path: one staged review, one
  # recorded approval, exactly one CRM attempt and one committed effect.
  # Every refusal path was asserted in-count inside the suite after isolated
  # resets.
  [ "$REVIEW_QUEUE" -eq 1 ] ||
    fail "approval-delivery final state must hold exactly one staged review, got queue=$REVIEW_QUEUE"
  [ "$APPROVAL_ACTIONS" -eq 1 ] ||
    fail "approval-delivery final state must hold exactly one approval action, got $APPROVAL_ACTIONS"
  [ "$CRM_ATTEMPTS" -eq 1 ] ||
    fail "one authorized approval must produce exactly one CRM attempt, got $CRM_ATTEMPTS"
  [ "$CRM_EFFECTS" -eq 1 ] ||
    fail "one authorized approval must commit exactly one CRM effect, got $CRM_EFFECTS"
else
  fail "unhandled case $CASE_NAME"
fi

fi # end of the single-case/tracer branch (the full matrix ran its own assertions above)

# --- 8. teardown BEFORE any PASS claim; verify every owned resource gone -----
teardown_runtime

# --- 9. post-run immutability: historical source and gated graphs unchanged --
HISTORICAL_SHA256_AFTER="$(sha256_of "$HISTORICAL_SOURCE" || true)"
INTAKE_SHA256_AFTER="$(sha256_of "$INTAKE_WORKFLOW" || true)"
REVIEWER_SHA256_AFTER="$(sha256_of "$REVIEWER_WORKFLOW" || true)"
DELIVERY_SHA256_AFTER="$(sha256_of "$DELIVERY_WORKFLOW" || true)"
[ "${#HISTORICAL_SHA256_AFTER}" -eq 64 ] && [ "${#INTAKE_SHA256_AFTER}" -eq 64 ] && [ "${#REVIEWER_SHA256_AFTER}" -eq 64 ] && [ "${#DELIVERY_SHA256_AFTER}" -eq 64 ] ||
  fail "could not re-hash sources after execution"
[ "$HISTORICAL_SHA256_AFTER" = "$EXPECTED_HISTORICAL_SHA256" ] ||
  fail "immutable historical source changed during execution ($HISTORICAL_SHA256_AFTER) — no PASS will be printed"
[ "$INTAKE_SHA256_AFTER" = "$INTAKE_SHA256" ] ||
  fail "gated intake workflow changed during execution — no PASS will be printed"
[ "$REVIEWER_SHA256_AFTER" = "$REVIEWER_SHA256" ] ||
  fail "reviewer decision workflow changed during execution — no PASS will be printed"
[ "$DELIVERY_SHA256_AFTER" = "$DELIVERY_SHA256" ] ||
  fail "approved delivery workflow changed during execution — no PASS will be printed"

# --- 10. final proof ------------------------------------------------------------
if [ "$MODE" = "full" ]; then
  log "STATIC CONTRACTS PASS: fail-closed structural invariants and mock contracts green (audit container)"
  for CASE_PASS_LINE in "${CASE_PASS_LINES[@]}"; do
    log "$CASE_PASS_LINE"
  done
  log "FULL-SUITE PASS: $FULL_TOTAL/$FULL_TOTAL case groups green on real pinned n8n $N8N_VERSION — per-case lines above carry the exact CRM ATTEMPTS and CRM EFFECTS counts"
  log "preservation: $UNRELATED_PRESERVED/$UNRELATED_COUNT unrelated containers identical (ID + running state); owned project containers/networks/volumes and the ephemeral tree (nonce, census, lock) fully removed"
  log "evidence: n8n=$N8N_VERSION (exact pin), intake id=$INTAKE_WORKFLOW_ID, reviewer id=$REVIEWER_WORKFLOW_ID, delivery id=$DELIVERY_WORKFLOW_ID, historical source sha256=$HISTORICAL_SHA256_AFTER, intake workflow sha256=$INTAKE_SHA256_AFTER, reviewer workflow sha256=$REVIEWER_SHA256_AFTER, delivery workflow sha256=$DELIVERY_SHA256_AFTER"
  log "boundaries: every approval in the matrix was SIMULATED reviewer input (a separate recorded HTTP action by the test suite — not a human review); all services and data are local fictional mocks, no live outcome is claimed; response-loss-after-commit and process-restart semantics are NOT implemented and NOT claimed"
elif [ "$MODE" = "tracer" ]; then
  log "TRACER PASS: gated intake staged pending review — queue=$REVIEW_QUEUE CRM ATTEMPTS=$CRM_ATTEMPTS CRM EFFECTS=$CRM_EFFECTS"
  log "evidence: n8n=$N8N_VERSION (exact pin), workflow id=$INTAKE_WORKFLOW_ID, historical source sha256=$HISTORICAL_SHA256_AFTER, intake workflow sha256=$INTAKE_SHA256_AFTER, fixture sha256=$FIXTURE_SHA256"
  log "no CRM attempt path exists in the intake graph; approval requires a separate reviewer action recorded outside this graph"
elif [ "$CASE_NAME" = "reviewer-gate" ]; then
  log "REVIEWER-GATE PASS: rejection and every failed authorization/decision path recorded zero CRM activity"
  log "final counted state: queue=$REVIEW_QUEUE approval_actions=$APPROVAL_ACTIONS CRM ATTEMPTS=$CRM_ATTEMPTS CRM EFFECTS=$CRM_EFFECTS"
  log "evidence: n8n=$N8N_VERSION (exact pin), intake id=$INTAKE_WORKFLOW_ID, reviewer id=$REVIEWER_WORKFLOW_ID, historical source sha256=$HISTORICAL_SHA256_AFTER, reviewer workflow sha256=$REVIEWER_SHA256_AFTER"
  log "approve/reject are separate reviewer events authorized by a consumed-once proof; queueing never increments approval actions"
elif [ "$CASE_NAME" = "crm-recovery" ]; then
  log "CRM-RECOVERY PASS: one truthful failed pre-commit attempt (1/0), one deliberate same-key retry (2/1), exactly one effect, no write on committed replay"
  log "final counted state: queue=$REVIEW_QUEUE approval_actions=$APPROVAL_ACTIONS CRM ATTEMPTS=$CRM_ATTEMPTS CRM EFFECTS=$CRM_EFFECTS"
  log "evidence: n8n=$N8N_VERSION (exact pin), intake id=$INTAKE_WORKFLOW_ID, reviewer id=$REVIEWER_WORKFLOW_ID, delivery id=$DELIVERY_WORKFLOW_ID, historical source sha256=$HISTORICAL_SHA256_AFTER, delivery workflow sha256=$DELIVERY_SHA256_AFTER"
  log "claim boundary: pre-commit application failure + deliberate state-observed retry only — response-loss-after-commit and process-restart semantics are NOT implemented and NOT claimed"
elif [ "$CASE_NAME" = "intake-idempotency" ]; then
  log "INTAKE-IDEMPOTENCY PASS: exact replay reused one review and conflicting content failed closed — zero duplicate queue/CRM writes"
  log "final counted state: queue=$REVIEW_QUEUE approval_actions=$APPROVAL_ACTIONS CRM ATTEMPTS=$CRM_ATTEMPTS CRM EFFECTS=$CRM_EFFECTS"
  log "evidence: n8n=$N8N_VERSION (exact pin), intake id=$INTAKE_WORKFLOW_ID, historical source sha256=$HISTORICAL_SHA256_AFTER, intake workflow sha256=$INTAKE_SHA256_AFTER"
  log "the graph computes the canonical payload hash in-graph; same key+hash replays the original review, same key+changed content returns a truthful 409"
elif [ "$CASE_NAME" = "approval-delivery" ]; then
  log "APPROVAL-DELIVERY PASS: one authorized approval produced exactly one CRM attempt and one committed effect"
  log "final counted state: queue=$REVIEW_QUEUE approval_actions=$APPROVAL_ACTIONS CRM ATTEMPTS=$CRM_ATTEMPTS CRM EFFECTS=$CRM_EFFECTS"
  log "evidence: n8n=$N8N_VERSION (exact pin), intake id=$INTAKE_WORKFLOW_ID, reviewer id=$REVIEWER_WORKFLOW_ID, delivery id=$DELIVERY_WORKFLOW_ID, historical source sha256=$HISTORICAL_SHA256_AFTER, delivery workflow sha256=$DELIVERY_SHA256_AFTER"
  log "every non-approved, conflicting, malformed, and error state was refused before the CRM node; committed replay returned the existing effect"
fi
