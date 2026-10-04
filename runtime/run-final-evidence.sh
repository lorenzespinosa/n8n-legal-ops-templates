#!/usr/bin/env bash
# One-command PACK-01 final-evidence driver for the Flagship Intake demo.
#
#   ./runtime/run-final-evidence.sh
#   ./runtime/run-final-evidence.sh --compare-with <prior-record> \
#       --clean-sandbox-checks <a,b,...> --phase-base <ref> \
#       [--output <candidate-path>]   # WR-03: stage for run-clean-rerun.sh
#
# Executes the REAL pinned-runtime full suite — the UNCHANGED launcher
# ./runtime/run-gated-demo.sh (never a duplicate) — tees its genuine combined
# stdout+stderr to a driver-owned capture file OUTSIDE the launcher's
# ephemeral tree (runtime/demo/.generated is created, used, and removed by
# the launcher itself), then builds, verifies, and atomically publishes the
# machine-verified evidence record at runtime/evidence/final-evidence-log.json.
#
# The optional rerun flags (all three or none) forward the prior PACK-01
# record FILE plus the clean-rerun driver's verified pre-check names and
# phase base to the builder: it verifies the prior record, compares every
# measured case BEFORE any publication, and only on identical counted states
# attaches the run.rerun section (per_case_identical, clean_sandbox_checks,
# phase_base). On divergence the existing canonical evidence log stays
# byte-unchanged and no success marker is emitted.
#
# Proven sequence (fail-closed at every step; nothing is simulated):
#   1. preflight (read-only): the tracked tree is clean at HEAD (git status
#      --porcelain --untracked-files=no — evidence must bind a reviewed
#      committed tree; CR-02), Docker daemon reachable, pinned image cached
#      locally via docker image inspect (a pull is NEVER attempted), working
#      directory is the repository root
#   1b. capture the exact version strings (`docker --version`,
#      `docker compose version`) and the head commit (git rev-parse HEAD)
#      and pass them to the builder via flags — the builder itself stays
#      free of Docker and git side effects
#   2. create the capture file under a driver-owned mktemp directory that
#      lives OUTSIDE runtime/demo/.generated and is removed on every exit
#   3. run ./runtime/run-gated-demo.sh teeing combined stdout+stderr to the
#      capture; ANY non-zero launcher exit aborts with nothing published
#   4. re-check HEAD is still the pre-run commit (CR-02), bind the evidence
#      manifest over the allowlisted deliverable bytes, then
#      node runtime/scripts/final-evidence.mjs build --capture <file>
#      --output <INVOCATION-OWNED mktemp candidate allocated next to the
#      requested output> (parser, fail-closed builder, verify-then-atomic-
#      stage; RR-03-A: the requested output is never the build destination;
#      FD-03-A: the candidate is never a fixed sibling path — it is created
#      exclusively by this invocation via mktemp, so a preexisting file at
#      any neighboring path is never built over nor trap-deleted)
#   5. EVERY check runs against the staged candidate BEFORE promotion:
#      evidence-manifest verify (no deliverable drifted during the run; CR-02)
#      and final-evidence.mjs verify <candidate> must print ok:true (verify
#      also binds provenance head + hashes to actual git bytes: CR-01). A
#      failure here leaves the requested output byte-unchanged.
#   6. atomically PROMOTE the candidate (same-filesystem mv) to the requested
#      output — the only write to the output, with nothing fallible between
#      the promotion and the success line
#   7. print exactly one terminal success line
#      "FINAL-EVIDENCE PASS: 5/5 cases captured; record verified and
#       published to runtime/evidence/final-evidence-log.json"
#      — only after steps 3–6 all succeeded
#   8. remove the mktemp capture directory (and any never-promoted candidate)
#
# Hard limits: no image pull (digest-pinned cached image only), no external
# service contact, no simulation fallback — if real n8n execution proves
# impossible, this driver fails and reports the blocker. Repository-root-safe:
# paths resolve from the git toplevel.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$ROOT"

PINNED_IMAGE="n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec"
OUTPUT="runtime/evidence/final-evidence-log.json"

log() { printf '[final] %s\n' "$*"; }
fail() {
  printf '[final] FAIL: %s\n' "$*" >&2
  exit 1
}

# Optional rerun-comparison pass-through flags (all three or none) — forwarded
# verbatim to the builder, which owns the verify/compare/publish ordering.
# --output <path> directs the ATOMIC PROMOTION destination: the record is
# built into a SIBLING candidate of the output, every check runs against the
# candidate, and only then is it promoted (RR-03-A) — used by
# run-clean-rerun.sh to direct the record at its staging path.
COMPARE_WITH=""
CLEAN_SANDBOX_CHECKS=""
PHASE_BASE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --compare-with)
      [ "$#" -ge 2 ] || fail "flag --compare-with requires a value"
      COMPARE_WITH="$2"; shift 2 ;;
    --clean-sandbox-checks)
      [ "$#" -ge 2 ] || fail "flag --clean-sandbox-checks requires a value"
      CLEAN_SANDBOX_CHECKS="$2"; shift 2 ;;
    --phase-base)
      [ "$#" -ge 2 ] || fail "flag --phase-base requires a value"
      PHASE_BASE="$2"; shift 2 ;;
    --output)
      [ "$#" -ge 2 ] || fail "flag --output requires a value"
      OUTPUT="$2"; shift 2 ;;
    *)
      fail "unknown argument: $1 (supported: --compare-with <file> --clean-sandbox-checks <a,b,...> --phase-base <ref> --output <path>)" ;;
  esac
done
RERUN_FLAG_COUNT=0
[ -n "$COMPARE_WITH" ] && RERUN_FLAG_COUNT=$((RERUN_FLAG_COUNT + 1))
[ -n "$CLEAN_SANDBOX_CHECKS" ] && RERUN_FLAG_COUNT=$((RERUN_FLAG_COUNT + 1))
[ -n "$PHASE_BASE" ] && RERUN_FLAG_COUNT=$((RERUN_FLAG_COUNT + 1))
[ "$RERUN_FLAG_COUNT" -eq 0 ] || [ "$RERUN_FLAG_COUNT" -eq 3 ] ||
  fail "--compare-with, --clean-sandbox-checks, and --phase-base must be passed together (all three or none)"
[ -z "$COMPARE_WITH" ] || [ -f "$COMPARE_WITH" ] ||
  fail "prior record $COMPARE_WITH does not exist — a rerun comparison needs the prior record FILE (an id alone cannot prove equality)"

# --- 1. fail-closed preflight (read-only; no pull ever) ------------------------
# CR-02: the tracked tree must be clean BEFORE any Docker contact — evidence
# attributing a commit must bind the bytes actually executed, and a dirty
# working tree would let uncommitted mutations ride a clean commit's name.
TRACKED_DRIFT="$(git status --porcelain --untracked-files=no)"
[ -z "$TRACKED_DRIFT" ] ||
  fail "tracked tree is dirty at HEAD — commit first; evidence must bind a reviewed committed tree (got: $(printf '%s' "$TRACKED_DRIFT" | tr '\n' '; '))"
docker info >/dev/null 2>&1 || fail "Docker daemon unavailable — real-runtime blocker"
docker image inspect "$PINNED_IMAGE" >/dev/null 2>&1 ||
  fail "pinned image $PINNED_IMAGE not cached locally and pulling is forbidden — real-runtime blocker"
[ "$(pwd)" = "$ROOT" ] || fail "working directory must be the repository root ($ROOT)"

# --- 1b. capture the exact version strings and head commit for the record --------
# The recorded commands are exactly `docker --version` and
# `docker compose version`; the builder receives the parsed exact version
# strings via flags and performs no Docker or git side effects itself.
DOCKER_CLIENT_VERSION="$(docker --version | grep -oE '[0-9]+([.][0-9]+)+' | head -1)" ||
  fail "could not capture the exact docker client version — exact versions are mandatory"
DOCKER_COMPOSE_VERSION="$(docker compose version | grep -oE '[0-9]+([.][0-9]+)+' | head -1)" ||
  fail "could not capture the exact docker compose version — exact versions are mandatory"
[ -n "$DOCKER_CLIENT_VERSION" ] || fail "docker --version produced no parseable exact version"
[ -n "$DOCKER_COMPOSE_VERSION" ] || fail "docker compose version produced no parseable exact version"
HEAD_COMMIT="$(git rev-parse HEAD)" ||
  fail "could not capture the head commit for provenance"

# --- 2. driver-owned capture directory outside the launcher ephemeral tree -----
# The launcher owns runtime/demo/.generated (census, lock, proofs) and removes
# it on teardown; the capture must survive that removal, so it lives in a
# mktemp directory this driver owns and cleans on every exit path. The staging
# candidate lives in the SAME directory as the requested output (RR-03-A), so
# promotion is a single same-filesystem atomic rename that can only happen
# after every check passed; a failure anywhere leaves the output byte-unchanged.
# FD-03-A: the candidate is allocated EXCLUSIVELY by this invocation —
# `mktemp` in the output directory yields a unique 0600 file this run owns —
# never a FIXED sibling path: a fixed name could collide with a preexisting
# file this run never created, and the EXIT trap must only ever remove a
# candidate provably allocated by THIS invocation.
CAPTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/final-evidence.XXXXXX")" ||
  fail "could not create the driver-owned capture directory"
OUTPUT_DIR="$(dirname "$OUTPUT")"
OUTPUT_BASE="$(basename "$OUTPUT")"
[ -d "$OUTPUT_DIR" ] ||
  fail "output directory $OUTPUT_DIR does not exist — the invocation-owned candidate must be allocatable next to the output (same filesystem)"
CANDIDATE="$(mktemp "$OUTPUT_DIR/.${OUTPUT_BASE}.candidate.XXXXXX")" ||
  fail "could not allocate the invocation-owned staging candidate in $OUTPUT_DIR"
cleanup() {
  rm -rf "$CAPTURE_DIR"
  rm -f "$CANDIDATE"
}
trap cleanup EXIT
CAPTURE_FILE="$CAPTURE_DIR/full-suite-capture.log"

# --- 3. execute the UNCHANGED launcher with combined output captured -----------
log "running the real pinned-runtime full suite (./runtime/run-gated-demo.sh); combined output captured to $CAPTURE_FILE"
set +e
./runtime/run-gated-demo.sh 2>&1 | tee "$CAPTURE_FILE"
LAUNCHER_EXIT="${PIPESTATUS[0]}"
set -e
[ "$LAUNCHER_EXIT" -eq 0 ] ||
  fail "launcher exited $LAUNCHER_EXIT — a failed or interrupted run is not publishable evidence; nothing was published"

# --- 4. build the record into the INVOCATION-OWNED CANDIDATE (never at the output)
# CR-02: HEAD must not have moved during the launcher run — the record
# attributes its bytes to $HEAD_COMMIT; a mid-run commit would misattribute.
[ "$(git rev-parse HEAD)" = "$HEAD_COMMIT" ] ||
  fail "HEAD moved during the run — evidence would bind the wrong commit"
# CR-02: bind the evidence manifest BEFORE building (over the allowlisted
# deliverable bytes at this exact tree) and keep it for the pre-promotion
# verification below.
node runtime/scripts/evidence-manifest.mjs bind > "$CAPTURE_DIR/evidence-manifest.json" ||
  fail "could not bind the evidence manifest over the allowlisted deliverable bytes"
RERUN_ARGS=()
if [ -n "$COMPARE_WITH" ]; then
  # Verify + compare the prior record BEFORE anything is staged; only identity
  # adds run.rerun. Divergence aborts with the output byte-unchanged.
  RERUN_ARGS=(--compare-with "$COMPARE_WITH" --clean-sandbox-checks "$CLEAN_SANDBOX_CHECKS" --phase-base "$PHASE_BASE")
  log "rerun comparison armed: prior record $COMPARE_WITH (phase base $PHASE_BASE)"
fi
BUILD_OUTPUT="$(node runtime/scripts/final-evidence.mjs build \
  --capture "$CAPTURE_FILE" \
  --output "$CANDIDATE" \
  --image-reference "$PINNED_IMAGE" \
  --docker-client "$DOCKER_CLIENT_VERSION" \
  --docker-compose "$DOCKER_COMPOSE_VERSION" \
  --head-commit "$HEAD_COMMIT" \
  ${RERUN_ARGS[@]+"${RERUN_ARGS[@]}"})" ||
  fail "final evidence record was REJECTED — the capture did not prove a complete passing full suite (or the rerun comparison diverged); nothing was published (fail-closed)"
CASE_COUNT="$(printf '%s' "$BUILD_OUTPUT" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{console.log(String(JSON.parse(d).cases??""))})')"
CASE_TOTAL="$(printf '%s' "$BUILD_OUTPUT" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{console.log(String(JSON.parse(d).full_suite_total??""))})')"
[ "$CASE_COUNT" = "5" ] && [ "$CASE_TOTAL" = "5" ] ||
  fail "built record carries ${CASE_COUNT}/${CASE_TOTAL} cases, expected 5/5 — nothing was published (fail-closed)"

# --- 5. EVERY check runs against the CANDIDATE, BEFORE promotion (RR-03-A) -----
# CR-02: the allowlisted deliverable bytes must not have drifted during the
# run, and the manifest head must still be the attributed run commit.
node runtime/scripts/evidence-manifest.mjs verify "$CAPTURE_DIR/evidence-manifest.json" ||
  fail "evidence manifest verify failed — an allowlisted deliverable drifted during the run (no stale PASS; output byte-unchanged)"
# CR-01: the staged candidate itself must re-verify from disk alone, including
# its git-bound provenance (head + evidence hashes vs actual git bytes).
node runtime/scripts/final-evidence.mjs verify "$CANDIDATE" ||
  fail "staged candidate record failed independent verification — nothing is promoted and no FINAL-EVIDENCE PASS will be printed"

# --- 6. atomic promotion — the ONLY write to the output, nothing fallible after -
# Every check has passed; promote with a same-filesystem mv (atomic rename).
# A failure above leaves the output byte-unchanged; the cleanup trap removes
# the never-promoted candidate. No verification or other fallible gate runs
# between this promotion and the terminal PASS line.
mv "$CANDIDATE" "$OUTPUT" ||
  fail "could not promote the candidate evidence record (mv $CANDIDATE -> $OUTPUT) — the output keeps its prior accepted bytes"

# --- 7. exactly one terminal success line (only after 3–6 succeeded) -----------
log "FINAL-EVIDENCE PASS: ${CASE_COUNT}/${CASE_TOTAL} cases captured; record verified and published to ${OUTPUT}"
