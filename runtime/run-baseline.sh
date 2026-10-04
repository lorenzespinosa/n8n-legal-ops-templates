#!/usr/bin/env bash
# One-command baseline runtime for the Flagship Intake demo.
#
#   ./runtime/run-baseline.sh            full baseline: run + verify + publish
#                                       runtime/evidence/baseline.json
#   ./runtime/run-baseline.sh --tracer   acceptance tracer only (no artifact)
#
# Proven sequence (asserted, not slept — A-04):
#   0. acquire the single-writer lock (atomic mkdir, D-17/A-01/A-05),
#      clean Compose state, record the tracked source SHA-256
#   1. derive the ephemeral runtime workflow copy + local credential import
#      file under runtime/.generated/
#   2. start mock-api on the internal-only network and wait for its health
#      endpoint
#   3. one-off setup container on the same pinned image: print the exact n8n
#      version, import the local httpHeaderAuth credential (id preserved),
#      import the derived workflow (root id injected at import time — this
#      pinned importer requires an explicit workflow id and the repo template
#      deliberately carries none), activate it
#   4. start the real n8n server, wait for /healthz, then poll the production
#      webhook with an invalid probe body until it is registered (the probe
#      takes the 400 validation path and performs zero mock writes)
#   5. reset mock counters, run the acceptance test from INSIDE the network
#      via the audit service (docker publishes no ports for containers
#      attached only to an internal network — running the audit in-network
#      keeps the egress boundary free of inbound exceptions)
#   6. on success, emit the counted mock writes; on any failure, exit non-zero
#      with an explicit reason — a failed run NEVER emits TRACER/BASELINE PASS
#   7. baseline mode only: run the independent D-06 verifier, prove denied
#      egress in-network, gather exact versions, and atomically publish the
#      machine-verifiable evidence record (temporary sibling + rename —
#      only after every assertion succeeded)
#   8. always: tear the Compose project down (-v) and delete runtime/.generated
#      (lock included). A rejected overlapping invocation owns nothing and
#      tears down nothing.
#
# Hard limits: 55-second deadline (watchdog), no image pull (digest-pinned
# cached image only), no external service contact, no simulation fallback
# (D-07/D-12). Repository-root-safe: paths resolve from git toplevel.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$ROOT"

COMPOSE_FILE="runtime/docker-compose.yml"
GENERATED_DIR="runtime/.generated"
LOCK_DIR="$GENERATED_DIR/launcher.lock"
SOURCE_WORKFLOW="workflows/client-intake-pipeline.json"
DERIVED_WORKFLOW="$GENERATED_DIR/client-intake-pipeline.runtime.json"
CREDENTIAL_FILE="$GENERATED_DIR/greenfield-local-http-header-auth.credential.json"
PINNED_IMAGE="n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec"
WORKFLOW_ID="greenfield-intake-baseline"
DEADLINE_SECONDS=55
EVIDENCE_FILE="runtime/evidence/baseline.json"
FIXTURE_FILE="payloads/intake-new-lead.json"

MODE="baseline"
if [ "$#" -eq 0 ]; then
  MODE="baseline"
elif [ "$#" -eq 1 ] && [ "$1" = "--tracer" ]; then
  MODE="tracer"
else
  printf '[baseline] FAIL: usage: ./runtime/run-baseline.sh [--tracer]\n' >&2
  exit 1
fi

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Portable host-side hashing (IN-02): `shasum` is macOS/most-desktop-Linux;
# minimal and container hosts commonly ship only `sha256sum`. Callers guard
# with a 64-char length check so a host with neither tool fails closed with
# an explicit reason instead of an aborted substitution.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f1
  else
    return 127
  fi
}

log() { printf '[baseline] %s\n' "$*"; }
fail() {
  printf '[baseline] FAIL: %s\n' "$*" >&2
  exit 1
}

DEADLINE_PID=""
OWNS_LOCK=0
TEARDOWN_DONE=0
# Ownership-guarded cleanup (A-01/A-05): only the invocation that owns the
# lock may tear the runtime down — a rejected overlapping invocation must
# never destroy the owner's lock, Compose project, or evidence.
cleanup() {
  local rc=$?
  local teardown_failed=0
  # Keep the watchdog alive throughout Docker teardown. If `compose down`
  # blocks, its escalation must still terminate the stuck child and launcher.
  if [ "$OWNS_LOCK" -eq 1 ] && [ "$TEARDOWN_DONE" -eq 0 ]; then
    if ! compose down -v --remove-orphans >/dev/null 2>&1; then teardown_failed=1; fi
  fi
  if [ -n "$DEADLINE_PID" ]; then
    kill -KILL "$DEADLINE_PID" 2>/dev/null || true
    wait "$DEADLINE_PID" 2>/dev/null || true
  fi
  if [ "$OWNS_LOCK" -eq 1 ]; then
    if ! rm -rf "$GENERATED_DIR"; then rc=1; fi
    if ! rm -f "$(dirname "$EVIDENCE_FILE")/.$(basename "$EVIDENCE_FILE").tmp-"* 2>/dev/null; then rc=1; fi
  fi
  if [ "$teardown_failed" -ne 0 ]; then
    printf '[baseline] FAIL: Compose teardown failed — sandbox residue may remain; no successful cleanup is claimed\n' >&2
    rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 1' TERM INT

# A successful command must not publish evidence (or print PASS) until the
# uniquely owned Compose project is actually gone. The EXIT trap retries a
# failed teardown, but cannot turn that failed run into accepted evidence.
teardown_runtime() {
  compose down -v --remove-orphans >/dev/null 2>&1 ||
    fail "final Compose teardown failed — evidence will not be published"
  local remaining_containers remaining_networks
  remaining_containers="$(docker ps --filter 'label=com.docker.compose.project=flagship-intake-baseline' --format '{{.ID}}')" ||
    fail "could not verify final Compose container teardown"
  remaining_networks="$(docker network ls --filter 'label=com.docker.compose.project=flagship-intake-baseline' --format '{{.Name}}')" ||
    fail "could not verify final Compose network teardown"
  [ -z "$remaining_containers" ] && [ -z "$remaining_networks" ] ||
    fail "Compose returned success but project containers or networks remain — evidence will not be published"
  TEARDOWN_DONE=1
}

# --- 0a. single-writer lock: atomic mkdir rejects overlap BEFORE any
# mutation (D-17/A-01/A-05). The lock lives in the launcher-owned ephemeral
# directory and is removed by cleanup on every exit path. Ownership (PID +
# hostname) is recorded inside the lock dir so a later invocation can tell a
# live owner from a stale lock left by a hard kill (WR-06).
mkdir -p "$GENERATED_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Liveness diagnostics (WR-06): SIGKILL, OOM, or a host crash mid-run can
  # leave this directory behind with no live owner, permanently blocking
  # every future invocation. When the recorded PID is provably dead, fail
  # with the manual recovery command instead of a generic overlap message.
  # Recovery stays manual on purpose — an automated rm -rf against a
  # directory a live run on another host may own is exactly the silent
  # destruction this project forbids.
  STALE_OWNER_PID="$(sed -n 's/^pid=//p' "$LOCK_DIR/owner" 2>/dev/null | tail -1)"
  if [ -n "$STALE_OWNER_PID" ] && ! ps -p "$STALE_OWNER_PID" >/dev/null 2>&1; then
    STALE_OWNER_HOST="$(sed -n 's/^host=//p' "$LOCK_DIR/owner" 2>/dev/null | tail -1)"
    fail "stale lock: $LOCK_DIR was left behind by dead PID $STALE_OWNER_PID (host: ${STALE_OWNER_HOST:-unknown}) — no live baseline owns it. Recover manually with: rm -rf $LOCK_DIR — then rerun. See runtime/README.md (stale-lock recovery)."
  fi
  fail "another baseline invocation owns $LOCK_DIR — overlapping runs are rejected (D-17/A-01/A-05); single writer, sequential execution only"
fi
OWNS_LOCK=1
printf 'pid=%s\nhost=%s\n' "$$" "$(hostname)" > "$LOCK_DIR/owner" ||
  fail "could not record lock ownership in $LOCK_DIR/owner"

# --- hard deadline: no result may be reported after this (D-07/D-12) ---------
# The watchdog signals the launcher's whole process group (or, when the
# launcher is not a group leader, each live descendant) so a blocked
# foreground docker/node child is actually interrupted — then escalates to
# SIGKILL for anything still alive 5s later (WR-01).
node runtime/scripts/deadline-watchdog.mjs "$$" "$DEADLINE_SECONDS" & DEADLINE_PID=$!

RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="baseline-$(date -u +%Y%m%dT%H%M%SZ)"

# --- 0b. preconditions (read-only; no pull ever) ------------------------------
docker info >/dev/null 2>&1 || fail "Docker daemon unavailable — real-runtime blocker (D-07/D-12)"
docker image inspect "$PINNED_IMAGE" >/dev/null 2>&1 ||
  fail "pinned image $PINNED_IMAGE not cached locally and pulling is forbidden — real-runtime blocker (D-07)"

SOURCE_COMMIT="$(git rev-parse HEAD)"
SOURCE_SHA256="$(sha256_of "$SOURCE_WORKFLOW" || true)"
FIXTURE_SHA256="$(sha256_of "$FIXTURE_FILE" || true)"
[ "${#SOURCE_SHA256}" -eq 64 ] && [ "${#FIXTURE_SHA256}" -eq 64 ] ||
  fail "could not hash the tracked source and fictional fixture (needs shasum or sha256sum on PATH)"
node runtime/scripts/provenance.mjs verify "$ROOT" "$SOURCE_COMMIT" \
  "$SOURCE_WORKFLOW" "$SOURCE_SHA256" "$FIXTURE_FILE" "$FIXTURE_SHA256" >/dev/null ||
  fail "source or fixture bytes do not match the recorded commit before execution"

compose down -v --remove-orphans >/dev/null 2>&1 || true

# --- 1. derive runtime copy + ephemeral credential import file ---------------
node runtime/scripts/derive-runtime-workflow.mjs "$SOURCE_WORKFLOW" "$DERIVED_WORKFLOW" >/dev/null ||
  fail "workflow derivation failed (fail-closed mapper)"
cat > "$CREDENTIAL_FILE" <<'JSON'
[{
  "id": "greenfield-local-http-header-auth",
  "name": "Greenfield Local HTTP Header Auth",
  "type": "httpHeaderAuth",
  "data": { "name": "X-Greenfield-Local", "value": "greenfield-local-only" }
}]
JSON

# --- 2. mock service up + explicit health signal -----------------------------
compose up -d mock-api >/dev/null

# --- 2a. machine-check the egress enforcement itself (WR-02/D-08/D-12) --------
# `internal: true` in docker-compose.yml is the actual enforcement. A TCP
# probe to RFC 5737 TEST-NET-1 alone cannot distinguish deliberate denial
# from inherent unroutability, so the launcher asserts the network property
# host-side and fails closed unless Docker itself reports Internal=true.
# The in-network probe further below is supplementary defense-in-depth.
RUNTIME_NET_NAME="$(docker network ls \
  --filter "label=com.docker.compose.project=flagship-intake-baseline" \
  --filter "label=com.docker.compose.network=runtime-net" \
  --format '{{.Name}}' | head -1)"
[ -n "$RUNTIME_NET_NAME" ] ||
  fail "runtime-net was not created — egress enforcement unproven, failing closed (D-08/D-12)"
RUNTIME_NET_INTERNAL="$(docker network inspect "$RUNTIME_NET_NAME" --format '{{.Internal}}')"
[ "$RUNTIME_NET_INTERNAL" = "true" ] ||
  fail "runtime-net is NOT internal ($RUNTIME_NET_NAME reports Internal=$RUNTIME_NET_INTERNAL) — egress enforcement missing, failing closed (D-08/D-12)"
log "egress enforcement machine-checked: $RUNTIME_NET_NAME Internal=true"
for _ in $(seq 1 60); do
  if compose exec -T mock-api node -e "fetch('http://127.0.0.1:9090/admin/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
compose exec -T mock-api node -e "fetch('http://127.0.0.1:9090/admin/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null ||
  fail "mock-api health endpoint never became ready"

# --- 3. one-off setup container: version, credential import, workflow import, activate
SETUP_OUTPUT="$(compose run --rm -T --no-deps --entrypoint sh n8n -c '
  set -e
  node -e "const p=require(\"/usr/local/lib/node_modules/n8n/package.json\");console.log(\"N8N_VERSION=\" + p.version)"
  n8n import:credentials --input=/import/greenfield-local-http-header-auth.credential.json --include=id,name,type,data
  node -e "const fs=require(\"fs\");const w=JSON.parse(fs.readFileSync(\"/import/client-intake-pipeline.runtime.json\",\"utf8\"));w.id=\"'"$WORKFLOW_ID"'\";fs.writeFileSync(\"/tmp/import-workflow.json\",JSON.stringify(w,null,2))"
  n8n import:workflow --input=/tmp/import-workflow.json
  echo "IMPORTED_WORKFLOW_ID='"$WORKFLOW_ID"'"
  n8n update:workflow --id='"$WORKFLOW_ID"' --active=true
' 2>&1)" || fail "n8n import/activation failed — real-runtime blocker (D-07). Output: $(printf '%s' "$SETUP_OUTPUT" | tail -n 5)"

N8N_VERSION="$(printf '%s\n' "$SETUP_OUTPUT" | sed -n 's/^N8N_VERSION=//p' | tail -1)"
# Defense in depth (CR-01): strip any carriage return a TTY line discipline
# may still have left behind — evidence verification requires an exact pin.
N8N_VERSION="${N8N_VERSION%$'\r'}"
[ -n "$N8N_VERSION" ] || fail "could not read the pinned n8n version"
log "real n8n runtime version: $N8N_VERSION"

# IN-03: the setup container echoes IMPORTED_WORKFLOW_ID=… — assert the
# import actually landed under the id the rest of the run targets, instead
# of letting the echo masquerade as a verification step. The nested quoting
# of the sh -c script means the echoed line carries NO quotes; strip
# quote/CR characters anyway so any variant parses.
IMPORTED_WORKFLOW_ID_PARSED="$(printf '%s\n' "$SETUP_OUTPUT" | sed -n 's/^IMPORTED_WORKFLOW_ID=//p' | tr -d "\"\r'" | tail -1)"
[ "$IMPORTED_WORKFLOW_ID_PARSED" = "$WORKFLOW_ID" ] ||
  fail "setup container did not confirm the imported workflow id (expected '$WORKFLOW_ID', got '${IMPORTED_WORKFLOW_ID_PARSED:-<absent>}') — the activation below may have targeted nothing"

# --- 4. start n8n, wait for healthz, then wait for webhook registration ------
compose up -d n8n >/dev/null
compose exec -T n8n node -e '
(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch("http://127.0.0.1:5678/healthz"); if (r.ok) process.exit(0); } catch {}
    await new Promise((res) => setTimeout(res, 250));
  }
  process.exit(1);
})();
' >/dev/null || fail "n8n /healthz never became ready — real-runtime blocker (D-07)"

# Invalid-body probe: n8n answers 404 until the production webhook is
# registered; once registered the probe takes the 400 validation path, which
# performs zero mock writes (counters are reset again below regardless).
compose exec -T n8n node -e '
(async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch("http://127.0.0.1:5678/webhook/intake-webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (r.status !== 404) process.exit(0);
    } catch {}
    await new Promise((res) => setTimeout(res, 250));
  }
  process.exit(1);
})();
' >/dev/null || fail "production webhook never registered — real-runtime blocker (D-07)"

# --- 5. clean counters, run the acceptance test from inside the network -------
compose exec -T mock-api node -e 'fetch("http://127.0.0.1:9090/admin/reset",{method:"POST"})' >/dev/null

log "running pinned-runtime acceptance test (n8n $N8N_VERSION, workflow id $WORKFLOW_ID)"
if ! compose run --rm -T \
    -e N8N_BASE_URL=http://n8n:5678 \
    -e MOCK_BASE_URL=http://mock-api:9090 \
    -e "BASELINE_SOURCE_SHA256=$SOURCE_SHA256" \
    -e "BASELINE_IMPORTED_WORKFLOW_ID=$WORKFLOW_ID" \
    audit --test runtime/tests/baseline.e2e.test.mjs; then
  fail "acceptance test failed against the real pinned runtime — NOT a simulation, NOT a pass (D-07)"
fi

# --- 6. counted mock writes ----------------------------------------------------
COUNTERS="$(compose exec -T mock-api node -e 'fetch("http://127.0.0.1:9090/admin/state").then((r)=>r.json()).then((s)=>console.log(JSON.stringify(s.counters)))')"
counter() { printf '%s' "$COUNTERS" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{console.log(JSON.parse(d)["'"$1"'"]??0)})'; }
CRM_WRITES="$(counter lawmatics_contacts_post)"
QUEUE_WRITES="$(counter airtable_queue_post)"
APPROVAL_ACTIONS="$(counter approval_actions)"
[ "$CRM_WRITES" -ge 1 ] || fail "no mock CRM write observed — the baseline defect was not demonstrated"
[ "$APPROVAL_ACTIONS" -eq 0 ] || fail "approval actions observed ($APPROVAL_ACTIONS) — the baseline premise (zero approvals) was violated"

if [ "$MODE" = "tracer" ]; then
  teardown_runtime
  log "TRACER PASS: real n8n execution; CRM writes=$CRM_WRITES"
  log "evidence: n8n=$N8N_VERSION queue writes=$QUEUE_WRITES crm writes=$CRM_WRITES source sha256=$SOURCE_SHA256"
  exit 0
fi

# --- 7. independent verification of the derived copy (D-06 allowlist) ---------
VERIFIER_OUTPUT="$(node runtime/scripts/verify-runtime-workflow.mjs "$SOURCE_WORKFLOW" "$DERIVED_WORKFLOW")"
verifier_field() { printf '%s' "$VERIFIER_OUTPUT" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(String(r["'"$1"'"]??""))})'; }
[ "$(verifier_field ok)" = "true" ] || fail "independent verifier rejected the derived copy — real-runtime blocker. Report: $(printf '%s' "$VERIFIER_OUTPUT" | tail -c 400)"
DERIVED_SHA256="$(verifier_field derivedSha256)"
ALLOWED_DIFFERENCES="$(printf '%s' "$VERIFIER_OUTPUT" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const r=JSON.parse(d);const v=r.allowedDifferences;console.log(Array.isArray(v)?v.length:String(v??""))})')"
[ -n "$DERIVED_SHA256" ] || fail "verifier did not report the derived copy hash"
[ "$ALLOWED_DIFFERENCES" -eq 12 ] || fail "verifier reported $ALLOWED_DIFFERENCES allowed differences, expected the frozen 12-entry D-06 allowlist"
# WR-04: the verifier's full JSON report is forwarded to the evidence CLI so
# the published trust claims come from the verifier itself, not from
# self-attested constants.

# --- 8. denied-egress proof: host-side network inspect (primary, step 2a
# above) plus a supplementary in-network probe (D-08/D-12) ---------------------
EGRESS_PROBE='const net = require("net");
(async () => {
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    try { const r = await fetch("http://mock-api:9090/admin/health"); if (r.ok) healthy = true; } catch {}
    if (!healthy) await new Promise((res) => setTimeout(res, 250));
  }
  if (!healthy) { console.error("MOCK_UNREACHABLE"); process.exit(2); }
  const outcome = await new Promise((resolve) => {
    const socket = net.connect({ host: "192.0.2.1", port: 80 });
    const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 500);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.on("error", (err) => { clearTimeout(timer); resolve("error:" + (err.code || err.message)); });
  });
  if (outcome === "connected") { console.error("EGRESS_CONNECTED to RFC 5737 TEST-NET address"); process.exit(3); }
  console.log("EGRESS_DENIED:" + outcome);
})();'
EGRESS_OUTPUT="$(compose run --rm -T --no-deps audit -e "$EGRESS_PROBE")" ||
  fail "in-network egress probe could not run — unproven egress denial is a blocker, not a pass (D-08)"
case "$EGRESS_OUTPUT" in
  *EGRESS_CONNECTED*) fail "external egress was POSSIBLE from the runtime network — hard safety failure (D-08/D-12)" ;;
esac
case "$EGRESS_OUTPUT" in
  *EGRESS_DENIED:*) log "supplementary in-network egress probe denied as expected" ;;
  *) fail "egress probe returned neither denial nor connection — unproven, failing closed (D-08): $EGRESS_OUTPUT" ;;
esac
# WR-04: forward the probe's RAW denial line (not a boolean) to the evidence
# CLI so the published egress claim traces to the probe's actual output.
EGRESS_PROBE_LINE="$(printf '%s\n' "$EGRESS_OUTPUT" | sed -n 's/^\(EGRESS_DENIED:.*\)$/\1/p')"
[ -n "$EGRESS_PROBE_LINE" ] ||
  fail "egress probe output carried no raw EGRESS_DENIED:<outcome> line — unproven, failing closed (D-08): $EGRESS_OUTPUT"

# --- 9. exact versions and provenance (D-01) -----------------------------------
DOCKER_CLIENT="$(docker version --format '{{.Client.Version}}')"
DOCKER_SERVER="$(docker version --format '{{.Server.Version}}')"
DOCKER_COMPOSE="$(docker compose version --short)"
[ -n "$DOCKER_CLIENT" ] && [ -n "$DOCKER_SERVER" ] && [ -n "$DOCKER_COMPOSE" ] ||
  fail "could not capture exact Docker/Compose versions — exact versions are mandatory (D-01)"

# No success artifact or PASS line is allowed until Docker reports the
# isolated sandbox fully removed. Keep the watchdog running during teardown.
teardown_runtime
node runtime/scripts/provenance.mjs verify "$ROOT" "$SOURCE_COMMIT" \
  "$SOURCE_WORKFLOW" "$SOURCE_SHA256" "$FIXTURE_FILE" "$FIXTURE_SHA256" >/dev/null ||
  fail "source, fixture, or HEAD changed during execution — evidence will not be published"

# --- 10. atomically publish the machine-verifiable evidence record ------------
BASELINE_RUN_ID="$RUN_ID" \
BASELINE_STARTED_AT="$RUN_STARTED_AT" \
BASELINE_SOURCE_COMMIT="$SOURCE_COMMIT" \
BASELINE_FIXTURE_SHA256="$FIXTURE_SHA256" \
BASELINE_SOURCE_SHA256="$SOURCE_SHA256" \
BASELINE_DERIVED_SHA256="$DERIVED_SHA256" \
BASELINE_VERIFIER_REPORT="$VERIFIER_OUTPUT" \
BASELINE_N8N_VERSION="$N8N_VERSION" \
BASELINE_IMAGE_REFERENCE="$PINNED_IMAGE" \
BASELINE_DOCKER_CLIENT="$DOCKER_CLIENT" \
BASELINE_DOCKER_SERVER="$DOCKER_SERVER" \
BASELINE_DOCKER_COMPOSE="$DOCKER_COMPOSE" \
BASELINE_COUNTERS_JSON="$COUNTERS" \
BASELINE_EGRESS_PROBE_LINE="$EGRESS_PROBE_LINE" \
BASELINE_NETWORK_INTERNAL="$RUNTIME_NET_INTERNAL" \
BASELINE_EGRESS_METHOD="runtime-net internal=true asserted via docker network inspect (primary enforcement); supplementary in-network RFC 5737 TEST-NET-1 TCP connect denied within 500 ms" \
  node runtime/scripts/baseline-evidence.mjs publish --from-env --output "$EVIDENCE_FILE" \
  || fail "evidence publication failed — no baseline artifact was accepted (fail-closed)"

# --- 11. final proof ------------------------------------------------------------
log "BASELINE PASS: crm_writes=$CRM_WRITES queue_writes=$QUEUE_WRITES approval_actions=$APPROVAL_ACTIONS"
log "evidence: $EVIDENCE_FILE (n8n=$N8N_VERSION, source sha256=$SOURCE_SHA256, derived sha256=$DERIVED_SHA256)"
log "the CRM write was measured on the body-adapted runtime copy; the unchanged template's prior 400 is recorded separately inside the evidence"
