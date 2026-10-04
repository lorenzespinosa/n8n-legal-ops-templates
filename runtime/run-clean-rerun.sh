#!/usr/bin/env bash
# Verified clean-sandbox rerun driver for the Flagship Intake demo (PACK-02).
#
#   ./runtime/run-clean-rerun.sh [--phase-base <ref>]
#
# VERIFICATION-ONLY (RR-03-A/RR-03-C): proves the full suite repeated from a
# VERIFIED clean sandbox reproduces the accepted matrix identically — and
# NEVER writes the canonical runtime/evidence/final-evidence-log.json. The
# fresh record is staged as a candidate, compared, and discarded; the
# canonical record's byte-identity is itself a gate before the terminal PASS.
# An ordinary reproduction therefore leaves the committed record and the
# buyer-docs contract untouched. Republishing accepted evidence is an explicit
# standalone ./runtime/run-final-evidence.sh action (a future-release
# decision), never a rerun side effect.
#
# Proven sequence (each step blocks the next):
#   1. record RUN_BASE (git HEAD) and require an empty tracked-delta tree
#      (`git status --porcelain --untracked-files=no`) so evidence binds a
#      reviewed committed tree; record UNTRACKED_BASE, the sorted set of
#      untracked non-ignored paths outside the tool-own prefixes (.gsd/,
#      .planning/) — untracked GSD working state is live-mutating operational
#      state, out of scope by design (deliverable byte-drift is enforced by
#      step 6's manifest verify, not by untracked listings)
#   2. verified-clean-sandbox pre-checks, ALL fail-closed BEFORE any Docker
#      mutation: no containers, networks, or volumes labeled
#      com.docker.compose.project=flagship-intake-gated-demo (the same filters
#      the launcher itself uses), runtime/demo/.generated absent,
#      runtime/demo/.census-forensics absent, no launcher lock, and no stale
#      candidate evidence file from an interrupted run (WR-03)
#   3. copy the current accepted runtime/evidence/final-evidence-log.json to a
#      mktemp location as the prior record
#   4. ./runtime/run-final-evidence.sh --compare-with <prior-copy>
#      --clean-sandbox-checks <names> --phase-base <frozen-sha>
#      --output <candidate> — a full real suite run whose record is STAGED at
#      runtime/evidence/.clean-rerun-candidate.json: the canonical log is
#      never a destination; the builder verifies the prior record and compares
#      every measured case before even the candidate is written, and only on
#      identity attaches run.rerun (per_case_identical, clean_sandbox_checks,
#      phase_base)
#   5. node runtime/scripts/final-evidence.mjs compare <prior-copy>
#      <candidate> must print the RERUN COMPARISON PASS line
#   6. node runtime/scripts/evidence-manifest.mjs bind then verify — HEAD must
#      equal RUN_BASE and every allowlisted byte unchanged
#   7. node runtime/scripts/evidence-manifest.mjs scan-diff --base <phase-base>
#      must pass clean
#   8. regression gates, each blocking: host suite, baseline tracer, baseline
#      evidence verification, CR-01 (-T on every compose run in
#      run-baseline.sh), byte-identity of the historical workflow and baseline
#      evidence against the phase base
#   9. verification-only closure (RR-03-A): verify the staged candidate one
#      final time (git-bound), require the canonical log to STILL be
#      byte-identical to the preserved prior record (cmp), then DISCARD the
#      candidate — nothing is published by an ordinary rerun
#  10. end-state tree verification: the tracked delta must be EMPTY (the
#      canonical record was not written) and the untracked non-ignored set
#      outside the tool-own prefixes must equal UNTRACKED_BASE
#  11. only after every gate, print exactly one CLEAN-RERUN PASS terminal line
#
# Hard limits: no image pull (digest-pinned cached image only), no external
# service contact, no simulation fallback. Repository-root-safe: paths
# resolve from the git toplevel.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$ROOT"

COMPOSE_FILE="runtime/demo/docker-compose.yml"
COMPOSE_PROJECT="flagship-intake-gated-demo"
GENERATED_DIR="runtime/demo/.generated"
CENSUS_FORENSICS_DIR="runtime/demo/.census-forensics"
EVIDENCE_LOG="runtime/evidence/final-evidence-log.json"
# WR-03: the rerun's candidate record is staged INSIDE runtime/evidence/ — the
# same filesystem as the canonical log — so publishing is a single atomic
# rename (mv) that can only happen after every gate passed.
CANDIDATE="runtime/evidence/.clean-rerun-candidate.json"
PINNED_IMAGE="n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec"
# The phase base commit (WR-02): the FROZEN release boundary — the committed
# fictional baseline on this sanitized public-base branch.
# An override must name this same commit (any ref form is resolved to its
# full 40-hex SHA); HEAD, the current tip, another ancestor, or a short
# form fails closed below, before any Docker mutation.
PHASE_BASE_FROZEN="4fe6c13d35c0ad47158178420a4333e2408f1ad5"
PHASE_BASE="$PHASE_BASE_FROZEN"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --phase-base)
      [ "$#" -ge 2 ] || { printf '[rerun] FAIL: --phase-base requires a value\n' >&2; exit 1; }
      PHASE_BASE="$2"; shift 2 ;;
    *)
      printf '[rerun] FAIL: unknown argument: %s (supported: --phase-base <ref>)\n' "$1" >&2
      exit 1 ;;
  esac
done

log() { printf '[rerun] %s\n' "$*"; }
fail() {
  printf '[rerun] FAIL: %s\n' "$*" >&2
  exit 1
}

# --- WR-02: validate and resolve the phase base BEFORE any Docker mutation ----
# base=HEAD (or anything resolving to the current tip) vacates the disclosure
# scan and the historical byte-identity gates; any base other than the frozen
# boundary is not this phase's delta. The resolved full SHA is what the rerun
# record persists as run.rerun.phase_base.
PHASE_BASE_PRE_HEAD="$(git rev-parse HEAD)" || fail "could not resolve HEAD for the phase-base check"
case "$PHASE_BASE" in
  HEAD|head)
    fail "--phase-base HEAD is not a phase boundary — base=HEAD vacates the disclosure scan and the historical byte-identity gates" ;;
esac
PHASE_BASE_SHA="$(git rev-parse --verify --quiet "$PHASE_BASE^{commit}")" ||
  fail "phase base $PHASE_BASE does not resolve to a commit in this repository"
[[ "$PHASE_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "could not resolve the phase base to a full 40-hex SHA (got $PHASE_BASE_SHA)"
if [[ "$PHASE_BASE" =~ ^[0-9a-f]{7,39}$ ]]; then
  fail "phase base must be the full 40-hex SHA or a symbolic ref — short hash forms are ambiguous (got $PHASE_BASE); use $PHASE_BASE_FROZEN"
fi
[ "$PHASE_BASE_SHA" != "$PHASE_BASE_PRE_HEAD" ] ||
  fail "--phase-base resolves to the current HEAD ($PHASE_BASE_PRE_HEAD) — base=HEAD vacates the disclosure scan and the historical byte-identity gates"
[ "$PHASE_BASE_SHA" = "$PHASE_BASE_FROZEN" ] ||
  fail "phase base must be the frozen phase boundary $PHASE_BASE_FROZEN (got $PHASE_BASE_SHA) — not just any ancestor"
PHASE_BASE="$PHASE_BASE_SHA"
log "phase base resolved to the frozen boundary $PHASE_BASE"

tool_own_or_repo() {
  # Untracked paths under the declared tool-own prefixes (.gsd/, .planning/)
  # are live-mutating GSD operational state — out of scope by design. The
  # deliverable set is everything else.
  case "$1" in
    .gsd/*|.planning/*|.gsd|.planning) return 0 ;;
    *) return 1 ;;
  esac
}

untracked_outside_tool_own() {
  git ls-files --others --exclude-standard | while IFS= read -r relative; do
    tool_own_or_repo "$relative" || printf '%s\n' "$relative"
  done | LC_ALL=C sort
}

# --- 1. tracked-clean committed tree + untracked baseline -----------------------
RUN_BASE="$(git rev-parse HEAD)" || fail "could not resolve HEAD"
TRACKED_DRIFT="$(git status --porcelain --untracked-files=no)"
[ -z "$TRACKED_DRIFT" ] ||
  fail "tracked tree is dirty at HEAD ($RUN_BASE): commit the deliverables first — evidence must bind a reviewed committed tree (got: $(printf '%s' "$TRACKED_DRIFT" | tr '\n' '; '))"
UNTRACKED_BASE="$(untracked_outside_tool_own)"
log "run base $RUN_BASE; tracked tree clean; untracked deliverable set empty by measurement: $([ -z "$UNTRACKED_BASE" ] && echo yes || echo no)"

# --- 2. verified clean sandbox, fail-closed BEFORE any Docker mutation ----------
# WR-03: a leftover candidate means an interrupted earlier rerun never
# published — fail closed so the run starts from a known staging state.
[ ! -e "$CANDIDATE" ] || fail "stale candidate $CANDIDATE exists — an earlier rerun was interrupted before publishing; remove it before rerunning"
docker info >/dev/null 2>&1 || fail "Docker daemon unavailable — real-runtime blocker"
docker image inspect "$PINNED_IMAGE" >/dev/null 2>&1 ||
  fail "pinned image $PINNED_IMAGE not cached locally and pulling is forbidden — real-runtime blocker"
CLEAN_CONTAINERS="$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.ID}}')" ||
  fail "clean-sandbox check failed: could not list owned containers (docker ps -a)"
CLEAN_NETWORKS="$(docker network ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Name}}')" ||
  fail "clean-sandbox check failed: could not list owned networks"
CLEAN_VOLUMES="$(docker volume ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Name}}')" ||
  fail "clean-sandbox check failed: could not list owned volumes"
[ -z "$CLEAN_CONTAINERS" ] ||
  fail "clean-sandbox check failed: owned containers already exist (label com.docker.compose.project=$COMPOSE_PROJECT): $(printf '%s ' $CLEAN_CONTAINERS)"
[ -z "$CLEAN_NETWORKS" ] ||
  fail "clean-sandbox check failed: owned networks already exist: $(printf '%s ' $CLEAN_NETWORKS)"
[ -z "$CLEAN_VOLUMES" ] ||
  fail "clean-sandbox check failed: owned volumes already exist: $(printf '%s ' $CLEAN_VOLUMES)"
[ ! -e "$GENERATED_DIR" ] || fail "clean-sandbox check failed: $GENERATED_DIR already exists"
[ ! -e "$CENSUS_FORENSICS_DIR" ] || fail "clean-sandbox check failed: $CENSUS_FORENSICS_DIR already exists"
# IN-03: the launcher lock lives at $GENERATED_DIR/launcher.lock, so the
# generated-dir absence check above subsumes any separate lock check (the
# recorded launcher-lock-absent check name is satisfied by that subsumption).
log "verified clean sandbox: no owned containers/networks/volumes (label $COMPOSE_PROJECT), no generated tree (hence no launcher lock), no census forensics"
CLEAN_SANDBOX_CHECKS="no-owned-containers,no-owned-networks,no-owned-volumes,generated-tree-absent,census-forensics-absent,launcher-lock-absent"

# --- 3. preserve the accepted record as the prior run ---------------------------
[ -f "$EVIDENCE_LOG" ] || fail "accepted evidence log $EVIDENCE_LOG missing — run ./runtime/run-final-evidence.sh first"
RERUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clean-rerun.XXXXXX")" ||
  fail "could not create the rerun-owned temp directory"
cleanup() {
  rm -rf "$RERUN_TMP_DIR"
  rm -f "$CANDIDATE"
}
trap cleanup EXIT
PRIOR_RECORD="$RERUN_TMP_DIR/prior-final-evidence-log.json"
cp "$EVIDENCE_LOG" "$PRIOR_RECORD" || fail "could not copy the accepted evidence log for comparison"
node runtime/scripts/final-evidence.mjs verify "$PRIOR_RECORD" >/dev/null ||
  fail "the accepted evidence log failed verification — a rerun may only compare against accepted evidence"

# --- 4. full real suite run with the comparison armed; record STAGED ----------
# The candidate path (inside runtime/evidence/, same filesystem as the
# canonical log) receives the verified record; the canonical log itself is
# NEVER a destination of this rerun (verification-only, RR-03-A/RR-03-C).
./runtime/run-final-evidence.sh \
  --compare-with "$PRIOR_RECORD" \
  --clean-sandbox-checks "$CLEAN_SANDBOX_CHECKS" \
  --phase-base "$PHASE_BASE" \
  --output "$CANDIDATE" ||
  fail "the rerun full suite or its before-publication comparison failed — nothing was presented as identical and the canonical log is untouched"
[ -f "$CANDIDATE" ] || fail "the evidence driver succeeded but staged no candidate at $CANDIDATE"

# --- 5. explicit run-vs-run comparison must pass (against the CANDIDATE) --------
node runtime/scripts/final-evidence.mjs compare "$PRIOR_RECORD" "$CANDIDATE" | tee "$RERUN_TMP_DIR/compare.out" ||
  fail "the run-vs-run comparison exited non-zero — the rerun is not proven identical (canonical log untouched)"
grep -q '^RERUN COMPARISON PASS: per-case counted states identical' "$RERUN_TMP_DIR/compare.out" ||
  fail "the run-vs-run comparison did not print its RERUN COMPARISON PASS line — the rerun is not proven identical (canonical log untouched)"

# --- 6. bind + verify the byte manifest at the run base ------------------------
MANIFEST_FILE="$RERUN_TMP_DIR/evidence-manifest.json"
node runtime/scripts/evidence-manifest.mjs bind > "$MANIFEST_FILE" ||
  fail "could not bind the evidence manifest over the allowlisted files"
MANIFEST_HEAD="$(node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{console.log(JSON.parse(d).head)})' < "$MANIFEST_FILE")"
[ "$MANIFEST_HEAD" = "$RUN_BASE" ] ||
  fail "manifest head $MANIFEST_HEAD differs from the run base $RUN_BASE — evidence would bind unreviewed bytes"
node runtime/scripts/evidence-manifest.mjs verify "$MANIFEST_FILE" ||
  fail "manifest verify failed — an allowlisted deliverable byte drifted during the run (no stale PASS)"

# --- 7. disclosure diff-scan over the phase delta -------------------------------
node runtime/scripts/evidence-manifest.mjs scan-diff --base "$PHASE_BASE" ||
  fail "disclosure diff-scan over the phase delta found unwaived secrets or raw contact data — the phase does not ship clean (canonical log untouched)"

# --- 8. regression gates, each blocking -----------------------------------------
log "running regression gates (host suite, baseline tracer, baseline evidence, CR-01, historical byte-identity)"
# IN-04: the host-suite gate runs on node alone (the previous gate shelled
# out to an undocumented interpreter whose absence misreported as a suite
# regression).
node -e 'const{readdirSync}=require("fs");const fs=readdirSync("runtime/tests").filter(f=>f.endsWith(".test.mjs")&&!f.endsWith(".e2e.test.mjs")).map(f=>"runtime/tests/"+f).sort();process.exit(require("child_process").spawnSync(process.execPath,["--test","--test-concurrency=1",...fs],{stdio:"inherit"}).status)' ||
  fail "host test suite regression gate failed (node --test exited non-zero) — canonical log untouched"
BASELINE_TRACER_OUT="$RERUN_TMP_DIR/baseline-tracer.out"
./runtime/run-baseline.sh --tracer | tee "$BASELINE_TRACER_OUT" ||
  fail "the baseline tracer exited non-zero — regression gate failure (canonical log untouched)"
grep -q 'TRACER PASS: real n8n execution' "$BASELINE_TRACER_OUT" ||
  fail "baseline tracer did not print its TRACER PASS line"
node runtime/scripts/baseline-evidence.mjs verify runtime/evidence/baseline.json >/dev/null ||
  fail "committed baseline evidence failed verification"
COMPOSE_RUN_LINES="$(grep -n 'compose run' runtime/run-baseline.sh || true)"
[ -n "$COMPOSE_RUN_LINES" ] || fail "CR-01 gate: no 'compose run' invocations found in run-baseline.sh — the gate expects the documented calls"
while IFS= read -r runline; do
  printf '%s\n' "$runline" | grep -q -- '-T' ||
    fail "CR-01 gate: a 'compose run' invocation in run-baseline.sh lacks -T (TTY allocation can corrupt capture): $runline"
done <<EOF
$COMPOSE_RUN_LINES
EOF
git diff --quiet "$PHASE_BASE" -- workflows/client-intake-pipeline.json runtime/evidence/baseline.json ||
  fail "historical artifacts drifted from the phase base: workflows/client-intake-pipeline.json and/or runtime/evidence/baseline.json must stay byte-identical (canonical log untouched)"

# --- 9. verification-only closure (RR-03-A): candidate verified + discarded ----
# The candidate record must re-verify (git-bound, CR-01); the canonical log
# must STILL be byte-identical to the preserved prior record — an ordinary
# rerun never writes it; then the candidate is discarded. Nothing is
# published: republishing accepted evidence is an explicit standalone
# ./runtime/run-final-evidence.sh decision, never a rerun side effect.
node runtime/scripts/final-evidence.mjs verify "$CANDIDATE" >/dev/null ||
  fail "the staged candidate record failed verification — nothing was presented as identical and the canonical log is untouched"
cmp -s "$PRIOR_RECORD" "$EVIDENCE_LOG" ||
  fail "the canonical evidence log is no longer byte-identical to the accepted prior record — a verification-only rerun must leave it untouched"
rm -f "$CANDIDATE" ||
  fail "could not discard the verified candidate $CANDIDATE"
log "verification-only: candidate verified against the accepted record and discarded; canonical evidence log byte-identical"

# --- 10. end-state tree check: the rerun left NOTHING behind --------------------
END_TRACKED_DRIFT="$(git status --porcelain --untracked-files=no)"
[ -z "$END_TRACKED_DRIFT" ] ||
  fail "the run leaked tracked changes (got: $(printf '%s' "$END_TRACKED_DRIFT" | tr '\n' '; ')) — a verification-only rerun must leave the committed record untouched"
UNTRACKED_END="$(untracked_outside_tool_own)"
[ "$UNTRACKED_END" = "$UNTRACKED_BASE" ] ||
  fail "the run leaked untracked files beyond the tool-own prefixes (before: [$(printf '%s' "$UNTRACKED_BASE" | tr '\n' ' ')]; after: [$(printf '%s' "$UNTRACKED_END" | tr '\n' ' ')])"

# --- 11. exactly one terminal success line (only after every gate) --------------
log "CLEAN-RERUN PASS: suite identical to accepted matrix (5/5); manifest bound to $RUN_BASE; diff scan clean; regressions green"
