// Bind final evidence to the exact committed bytes of every reviewed
// deliverable file, and disclosure-scan the phase delta (PACK-02).
//
//   node runtime/scripts/evidence-manifest.mjs bind
//     Print {head, files:[{path, sha256}]} over the fixed nine-file allowlist
//     (working-tree bytes). The generalization of runtime/scripts/provenance.mjs
//     (which stays untouched — the Phase 1 regression gate binds it): the same
//     HEAD-pin + committed-bytes + working-bytes discipline, without the
//     two-file allowlist limitation.
//
//   node runtime/scripts/evidence-manifest.mjs verify <manifest-file>
//     Recompute `git rev-parse HEAD` and, for every allowlisted file, compare
//     the sha256 of `git show <head>:<path>` bytes AND working-tree bytes to
//     the recorded value — any drift (moved HEAD, mutated file, file missing
//     from git) fails closed naming the offending path. Committed bytes equal
//     working bytes equal recorded bytes: evidence binds the reviewed tree,
//     and post-run drift blocks acceptance (no stale PASS, T-03-04).
//
//   node runtime/scripts/evidence-manifest.mjs scan-diff --base <ref>
//     Disclosure scan over the phase delta (T-03-05): every tracked new/changed
//     text file since <ref> (committed planning docs included) plus every
//     untracked non-ignored path OUTSIDE the declared tool-own prefixes. For
//     each file: the DISCLOSURE_PATTERNS imported from final-evidence.mjs, the
//     CI credential-grep patterns from .github/workflows/validate-json.yml
//     (JSON files, as CI scopes them), and a fixture-literal scan (each
//     email/phone/contact-name value from payloads/intake-new-lead.json — the
//     fictional firm name is exempt). Any hit exits non-zero naming file and
//     pattern; a hit is waived ONLY when its own line carries the explicit
//     marker `disclosure-waiver:` WITH a substantive justification (≥10
//     non-trivial chars) AND the exact line is one of the fingerprinted known
//     synthetic test fixtures (KNOWN_SYNTHETIC_WAIVERS) — an auditable,
//     line-scoped, greppable, curated waiver, never a silent skip.
//
// Scope, declared by design (never convenience): gitignored runtime-ephemeral
// trees (runtime/demo/.generated, runtime/demo/.census-forensics) and untracked
// tool-own working state under .gsd/ and .planning/ (state.json, intel/,
// untracked phase working docs) are live-mutating operational files whose bytes
// this phase does not control; committed .planning/ docs still enter via the
// tracked delta, so acceptance keys deterministically on deliverable bytes.
//
// Zero dependencies: Node standard library only (T-03-SC).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { DISCLOSURE_PATTERNS } from './final-evidence.mjs';

// The fixed nine-file allowlist (sorted): the three gated workflows, the
// intake fixture, the historical source, the committed baseline evidence
// (whose embedded derived-workflow hash d24fe091 is thereby transitively
// cited, honoring the Phase 01 STATE decision), the launcher, the compose
// file, and the mock server.
export const MANIFEST_ALLOWLIST = Object.freeze([
  'payloads/intake-new-lead.json',
  'runtime/demo/docker-compose.yml',
  'runtime/demo/mocks/server.mjs',
  'runtime/demo/workflows/approved-delivery.json',
  'runtime/demo/workflows/intake-stage.json',
  'runtime/demo/workflows/reviewer-decision.json',
  'runtime/evidence/baseline.json',
  'runtime/run-gated-demo.sh',
  'workflows/client-intake-pipeline.json',
]);

// Declared out-of-scope prefixes for UNTRACKED paths in scan-diff: live-mutating
// tool-own working state, never deliverable bytes.
export const TOOL_OWN_UNTRACKED_PREFIXES = Object.freeze(['.gsd/', '.planning/']);

// The explicit line-scoped waiver marker. A disclosure hit is waived only when
// its own physical line carries this marker; waived hits stay visible in the
// scan output and the full waiver set is greppable in one place.
export const DISCLOSURE_WAIVER_MARKER = 'disclosure-waiver:';

// WR-04: a marker alone is NOT a waiver. A hit line is waived only when BOTH
// hold: (1) the text after the marker carries a substantive justification of
// at least WAIVER_JUSTIFICATION_MIN_CHARS non-trivial characters, and (2) the
// exact line (sha256 of its trimmed bytes) is fingerprinted below at its
// sanctioned file — the curated list of the exact known synthetic test
// fixture lines. An arbitrary credential-bearing line carrying the marker —
// even with a justification — is NOT waived and additionally produces an
// explicit invalid-waiver hit.
export const WAIVER_JUSTIFICATION_MIN_CHARS = 10;
const WAIVER_JUSTIFICATION_RE = /disclosure-waiver:[ \t]*\S[^\n]{9,}/;

export const KNOWN_SYNTHETIC_WAIVERS = Object.freeze([
  // runtime/tests/evidence-manifest.test.mjs — the synthetic negative-test
  // literals and the temp-repo git identity lines (identical line appears
  // twice; one fingerprint covers both occurrences).
  Object.freeze({
    file: 'runtime/tests/evidence-manifest.test.mjs',
    lineSha256: 'ed19699b1cfef44a62e1e818b2c91f153385868f1788db1653b13bc6c51fa4a2',
  }),
  Object.freeze({
    file: 'runtime/tests/evidence-manifest.test.mjs',
    lineSha256: 'b7bd514f6150510580379e2fa6b387620dd14bbbbb28931d5160931cb66bc712',
  }),
  Object.freeze({
    file: 'runtime/tests/evidence-manifest.test.mjs',
    lineSha256: '8f9c0c8261a4ebe8a518d5b05f1dbb95c270a1a906f3924671530a3a18ad521d',
  }),
  Object.freeze({
    file: 'runtime/tests/evidence-manifest.test.mjs',
    lineSha256: 'b0e182b7caa147c599867e83f0264f82dcafc04992c3863e4c36c1814c12189e',
  }),
  Object.freeze({
    file: 'runtime/tests/evidence-manifest.test.mjs',
    lineSha256: '41bf8aa78b7bd76bbe8721e77d07c9c9c14e63e78ead87ff62e1930a2224b90a',
  }),
  // runtime/tests/final-evidence.test.mjs — the temp-provenance-repo git
  // identity line and the two negative-test fixture comment lines, plus the
  // RR-03-A driver-fixture temp-repo git identity line.
  Object.freeze({
    file: 'runtime/tests/final-evidence.test.mjs',
    lineSha256: '05b12cdd3da7b6c160fa47c583eacc8633ac1be371c37861ce3af1b315a6a565',
  }),
  Object.freeze({
    file: 'runtime/tests/final-evidence.test.mjs',
    lineSha256: '20bdd9ddda08bb36fc95993d135c9973e974f69d4b02d6e9e866b9c456ba1124',
  }),
  Object.freeze({
    file: 'runtime/tests/final-evidence.test.mjs',
    lineSha256: '4f81ce09d0d78060fdff358ba58095fa1ab96dbfd2b601d30ef1f91b16b7d8aa',
  }),
  Object.freeze({
    file: 'runtime/tests/final-evidence.test.mjs',
    lineSha256: '30c86bc6170871184b97e4d2f8e5c246b0c9e2105755dccd6a1119f7804fab4b',
  }),
  // The canonical rendered waiver fixture as it exists inside a scanned temp
  // repo (tests/negative.md in the waiver contract test).
  Object.freeze({
    file: 'tests/negative.md',
    lineSha256: 'b491b7e691dffb4545e6b449e753e819ad3043ddfcd8853bf128f5406ad989bd',
  }),
]);

const isKnownSyntheticWaiverLine = (relative, line) =>
  KNOWN_SYNTHETIC_WAIVERS.some((entry) => entry.file === relative && entry.lineSha256 === sha256(Buffer.from(line.trim(), 'utf8')));

// The CI credential-grep patterns (validate-json.yml "Check for credential
// leaks"), scoped to *.json exactly as CI scopes them. Kept as [regex, message]
// pairs in the DISCLOSURE_PATTERNS shape.
const CI_JSON_PATTERNS = [
  [/"apiKey"/, 'delta JSON must not contain the CI-grep key "apiKey"'],
  [/"Authorization"/, 'delta JSON must not contain the CI-grep key "Authorization"'],
  [/"Bearer /, 'delta JSON must not contain a CI-grep "Bearer " value'],
  [/"token"/, 'delta JSON must not contain the CI-grep key "token"'],
  [/meta\.instanceId/, 'delta JSON must not contain meta.instanceId'],
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
}

function requireRepoRoot(root) {
  if (!path.isAbsolute(root)) {
    throw new Error('the manifest tools require an absolute repository root');
  }
}

/**
 * Bind the manifest: HEAD plus sha256 over the WORKING-tree bytes of every
 * allowlisted file. The recorded head is the commit the evidence is attributed
 * to; verify re-derives everything from git + disk so bind alone proves
 * nothing until verify passes.
 *
 * @param {{root: string}} input
 * @returns {{head: string, files: {path: string, sha256: string}[]}}
 */
export function bindManifest({ root }) {
  requireRepoRoot(root);
  const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (!HEX40.test(head)) {
    throw new Error(`could not resolve a full 40-hex HEAD in ${root} (got ${JSON.stringify(head)})`);
  }
  const files = MANIFEST_ALLOWLIST.map((relative) => ({
    path: relative,
    sha256: sha256(readFileSync(path.join(root, relative))),
  }));
  return { head, files };
}

/**
 * Fail-closed verification of a manifest: the recorded head must be the
 * CURRENT HEAD, and for every allowlisted file the sha256 of the bytes
 * committed at that head AND of the current working-tree bytes must equal the
 * recorded value. Any drift throws naming the offending path.
 *
 * @param {{root: string, manifest: object}} input
 * @returns {{ok: true, head: string, files: number}}
 */
export function verifyManifest({ root, manifest }) {
  requireRepoRoot(root);
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('verifyManifest requires a manifest object produced by bindManifest');
  }
  if (typeof manifest.head !== 'string' || !HEX40.test(manifest.head)) {
    throw new Error('manifest.head must be a full 40-hex commit recorded by bindManifest');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== MANIFEST_ALLOWLIST.length) {
    throw new Error(
      `manifest.files must carry exactly ${MANIFEST_ALLOWLIST.length} entries (the fixed allowlist) — got ${Array.isArray(manifest.files) ? manifest.files.length : 0}`
    );
  }
  const recorded = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const entry of manifest.files) {
    if (!MANIFEST_ALLOWLIST.includes(entry.path)) {
      throw new Error(`manifest.files carries a non-allowlisted path ${entry.path}`);
    }
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) {
      throw new Error(`manifest entry ${entry.path} must carry a 64-hex sha256`);
    }
  }
  if (recorded.size !== MANIFEST_ALLOWLIST.length) {
    throw new Error('manifest.files carries duplicate paths — each allowlisted file appears exactly once');
  }

  const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (head !== manifest.head) {
    throw new Error(`HEAD moved since the manifest was bound: manifest records ${manifest.head}, HEAD is ${head}`);
  }
  for (const relative of MANIFEST_ALLOWLIST) {
    const expected = recorded.get(relative);
    let committed;
    try {
      committed = git(root, ['show', `${manifest.head}:${relative}`]);
    } catch {
      throw new Error(`${relative} is missing from git at ${manifest.head} — evidence cannot bind bytes that were never committed`);
    }
    if (sha256(committed) !== expected) {
      throw new Error(`${relative}: committed bytes at ${manifest.head} do not match the manifest sha256 — the manifest does not describe the recorded commit`);
    }
    const working = sha256(readFileSync(path.join(root, relative)));
    if (working !== expected) {
      throw new Error(`${relative}: working-tree bytes drifted from the manifest sha256 — post-run drift blocks acceptance (no stale PASS)`);
    }
  }
  return { ok: true, head: manifest.head, files: MANIFEST_ALLOWLIST.length };
}

/** Untracked non-ignored paths (relative, NUL-safe), outside the repo's own tooling noise. */
function untrackedPaths(root) {
  const raw = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8');
  return raw.split('\0').filter((entry) => entry !== '');
}

/** Tracked new/changed paths since base (relative, NUL-safe), working tree vs base. */
function trackedDeltaPaths(root, base) {
  git(root, ['rev-parse', '--verify', `${base}^{commit}`]); // fail closed on an unknown base
  const raw = git(root, ['diff', '--name-only', '-z', base]).toString('utf8');
  return raw.split('\0').filter((entry) => entry !== '');
}

const isToolOwnUntracked = (relative) => TOOL_OWN_UNTRACKED_PREFIXES.some((prefix) => relative === prefix.slice(0, -1) || relative.startsWith(prefix));

/**
 * Disclosure scan over the phase delta (T-03-05).
 *
 * Scans every tracked new/changed text file since <base> plus every untracked
 * non-ignored path outside the declared tool-own prefixes, applying per line:
 * the DISCLOSURE_PATTERNS (all files), the CI credential-grep patterns (JSON
 * files, as CI scopes them), and the caller-supplied fixture literal values
 * (substring match — the caller loads them from the fixture so this function
 * stays free of fixture I/O and host-testable).
 *
 * A hit is waived ONLY when its own line carries the explicit marker
 * `disclosure-waiver:` with a substantive justification AND the exact line is
 * a fingerprinted known synthetic fixture (WR-04); waived hits remain visible
 * in the result, and an invalid marker over real hits produces its own
 * unwaived hit. ok is true only when every hit is waived.
 *
 * @param {{root: string, base: string, fixtureValues: string[]}} input
 * @returns {{ok: boolean, files_scanned: number, hits: object[],
 *           skipped: {file: string, reason: string}[]}}
 */
export function scanDiff({ root, base, fixtureValues = [] }) {
  requireRepoRoot(root);
  if (typeof base !== 'string' || base.trim() === '') {
    throw new Error('scanDiff requires --base <ref> (the phase base commit)');
  }
  const literals = fixtureValues.filter((value) => typeof value === 'string' && value !== '');

  const tracked = trackedDeltaPaths(root, base);
  const untracked = untrackedPaths(root);
  const skipped = [];
  const scanTargets = [];
  const seen = new Set();
  for (const relative of [...tracked, ...untracked]) {
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (isToolOwnUntracked(relative) && !tracked.includes(relative)) {
      skipped.push({
        file: relative,
        reason: 'untracked tool-own working state (live-mutating GSD operational file, out of scope by declared design)',
      });
      continue;
    }
    scanTargets.push(relative);
  }

  const hits = [];
  const patterns = DISCLOSURE_PATTERNS.map(([pattern, message]) => ({ pattern, message, family: 'disclosure' }));
  for (const relative of scanTargets) {
    const isJson = relative.endsWith('.json');
    const filePatterns = isJson ? [...patterns, ...CI_JSON_PATTERNS.map(([pattern, message]) => ({ pattern, message, family: 'ci-credential-grep' }))] : patterns;
    let content;
    try {
      content = readFileSync(path.join(root, relative));
    } catch {
      skipped.push({ file: relative, reason: 'listed in the delta but absent from the working tree (deleted)' });
      continue;
    }
    if (content.includes(0)) {
      hits.push({
        file: relative,
        line: null,
        family: 'binary',
        message: 'binary file in the phase delta — the disclosure review assumes text artifacts only',
        waived: false,
      });
      continue;
    }
    const lines = content.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched = [];
      for (const { pattern, message, family } of filePatterns) {
        if (pattern.test(line)) matched.push({ message, family });
      }
      for (const literal of literals) {
        if (literal !== '' && line.includes(literal)) {
          matched.push({ message: `line contains a raw fixture contact-field literal (${literal.length} chars)`, family: 'fixture-literal' });
        }
      }
      // WR-04: the marker waives the line's hits only with a substantive
      // justification AND a known synthetic fixture fingerprint for this
      // exact line at this exact file. Anything else that carries hits and a
      // marker produces an explicit invalid-waiver hit and fails the scan.
      const marked = line.includes(DISCLOSURE_WAIVER_MARKER);
      let waived = false;
      let waiverProblem = null;
      if (marked && matched.length > 0) {
        const justified = WAIVER_JUSTIFICATION_RE.test(line);
        const fingerprinted = isKnownSyntheticWaiverLine(relative, line);
        waived = justified && fingerprinted;
        if (!justified) {
          waiverProblem = `disclosure-waiver marker carries no substantive justification (at least ${WAIVER_JUSTIFICATION_MIN_CHARS} non-trivial chars required after the marker) — not a valid waiver`;
        } else if (!fingerprinted) {
          waiverProblem = 'justified disclosure-waiver marker on a line that is not a known synthetic fixture (no file+line fingerprint in the curated allowlist) — not a valid waiver';
        }
      }
      for (const match of matched) {
        hits.push({
          file: relative,
          line: index + 1,
          family: match.family,
          message: `${match.message}${waived ? ` — waived by explicit ${DISCLOSURE_WAIVER_MARKER} marker on this known synthetic fixture line` : ''}`,
          waived,
        });
      }
      if (waiverProblem !== null) {
        hits.push({
          file: relative,
          line: index + 1,
          family: 'disclosure',
          message: `invalid waiver: ${waiverProblem}`,
          waived: false,
        });
      }
    }
  }

  return {
    ok: hits.every((hit) => hit.waived),
    files_scanned: scanTargets.length,
    hits,
    skipped,
  };
}

/** The fixture contact-field literal values scan-diff greps for (firm name exempt). */
export function fixtureContactLiterals(fixture) {
  const contact = typeof fixture === 'object' && fixture !== null ? fixture.contact ?? {} : {};
  return [contact.email, contact.phone, contact.first_name, contact.last_name].filter(
    (value) => typeof value === 'string' && value !== ''
  );
}

// --- CLI ---------------------------------------------------------------------

// RR-03-B: direct-run detection must be robust against non-canonical entry
// paths. A symlinked invocation (argv[1] is the link, import.meta.url the
// resolved module) and a file-descriptor entry (`node /dev/fd/3 … 3< this`)
// both defeated the naive `import.meta.url === pathToFileURL(argv[1]).href`
// comparison — the CLI block silently skipped and the process exited 0 with no
// output, vacating manifest verify and the disclosure scan by invocation path
// alone. Detection now: (1) fast string equality, (2) realpath equality
// (symlinked directories and links), (3) inode identity (dev+ino) via stat —
// which resolves /dev/fd/N (and /proc/self/fd/N) to the underlying file no
// matter how the descriptor path spells it. FD-loader boundary (FD-03-C):
// the fd entry path actually EXECUTES the module body on Linux — including
// the digest-pinned container, where this is behaviorally proven — and there
// the inode check detects the direct run. On macOS, Node ESM `node
// /dev/fd/3` never executes the module body at all (the extension-less ESM
// double-read over the dup-shared descriptor offset), so there is no
// fd-path direct run to detect — node itself fails before this module
// loads, and no silent exit-0 no-op exists on that platform. Any
// stat/realpath failure (e.g. argv[1] from `node -e`) means NOT a direct
// run of this module.
const isDirectRun = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let selfPath;
  try {
    selfPath = fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
  if (selfPath === argv1) return true;
  try {
    if (realpathSync(argv1) === realpathSync(selfPath)) return true;
  } catch {
    /* argv[1] may be an fd path realpath cannot resolve — inode check below */
  }
  try {
    const selfStat = statSync(selfPath);
    const argvStat = statSync(argv1);
    return selfStat.dev === argvStat.dev && selfStat.ino === argvStat.ino;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  const [verb, ...rest] = process.argv.slice(2);
  const USAGE = 'usage: evidence-manifest.mjs bind | verify <manifest-file> | scan-diff --base <ref>';
  // A missing or unrecognized verb is a usage error printed to stderr with a
  // non-zero exit — a chained consumer must never mistake a silent no-op for
  // success (RR-03-B, same convention as final-evidence.mjs IN-01).
  if (verb !== 'bind' && verb !== 'verify' && verb !== 'scan-diff') {
    process.stderr.write(`evidence-manifest: ${USAGE}\n`);
    process.exit(2);
  }
  if (verb === 'bind' && rest.length > 0) {
    process.stderr.write(`evidence-manifest: ${USAGE} (bind takes no arguments)\n`);
    process.exit(2);
  }
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    if (verb === 'bind') {
      const manifest = bindManifest({ root });
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      process.exit(0);
    }
    if (verb === 'verify') {
      const [file] = rest;
      if (typeof file !== 'string') throw new Error('usage: evidence-manifest.mjs verify <manifest-file>');
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(`unreadable manifest file ${file}: ${error.message}`);
      }
      const result = verifyManifest({ root, manifest });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    }
    if (verb === 'scan-diff') {
      const index = rest.indexOf('--base');
      if (index === -1 || typeof rest[index + 1] !== 'string') {
        throw new Error('usage: evidence-manifest.mjs scan-diff --base <ref>');
      }
      const base = rest[index + 1];
      let fixture = {};
      try {
        fixture = JSON.parse(readFileSync(path.join(root, 'payloads', 'intake-new-lead.json'), 'utf8'));
      } catch (error) {
        throw new Error(`could not read the intake fixture for the fixture-literal scan: ${error.message}`);
      }
      const verdict = scanDiff({ root, base, fixtureValues: fixtureContactLiterals(fixture) });
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: verdict.ok,
            files_scanned: verdict.files_scanned,
            unwaived_hits: verdict.hits.filter((hit) => !hit.waived).length,
            waived_hits: verdict.hits.filter((hit) => hit.waived).length,
            hits: verdict.hits,
            skipped: verdict.skipped,
          },
          null,
          2
        )}\n`
      );
      if (!verdict.ok) process.exit(1);
      process.exit(0);
    }
    throw new Error('usage: evidence-manifest.mjs bind | verify <manifest-file> | scan-diff --base <ref>');
  } catch (error) {
    process.stderr.write(`evidence-manifest: ${error.message}\n`);
    // Usage-type errors exit 2 (RR-03-B, matching final-evidence.mjs IN-01);
    // every other failure stays exit 1. Either way: never a silent exit 0.
    process.exit(/^usage:/.test(error.message) ? 2 : 1);
  }
}
