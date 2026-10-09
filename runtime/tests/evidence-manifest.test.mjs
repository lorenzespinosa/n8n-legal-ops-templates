// Task 1 (03-02) contract tests for the Phase 3 evidence manifest and
// phase-delta disclosure scan (PACK-02):
//
// runtime/scripts/evidence-manifest.mjs must export:
//   MANIFEST_ALLOWLIST      the fixed nine-file allowlist (sorted)
//   bindManifest({root})    {head, files:[{path, sha256}]} over working bytes
//   verifyManifest({root, manifest})
//                           HEAD pinned; per file git-show bytes hash ==
//                           working bytes hash == recorded sha256; fails
//                           closed naming the offending path
//   scanDiff({root, base, fixtureValues})
//                           disclosure scan over the tracked phase delta plus
//                           untracked non-ignored files outside the declared
//                           tool-own prefixes; every hit is reported, a hit
//                           is waived ONLY by an explicit line-scoped marker
//
// The module is loaded lazily so the TDD RED run fails on an explicit
// assertion for the missing feature instead of an import error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MANIFEST_CLI = path.join(ROOT, 'runtime', 'scripts', 'evidence-manifest.mjs');

// The fixed nine-file allowlist (sorted) the manifest binds — the three gated
// workflows, the intake fixture, the historical source, the committed baseline
// evidence (which transitively cites the Phase 01 derived-copy hash), the
// launcher, the compose file, and the mock server.
export const EXPECTED_ALLOWLIST = [
  'payloads/intake-new-lead.json',
  'runtime/demo/docker-compose.yml',
  'runtime/demo/mocks/server.mjs',
  'runtime/demo/workflows/approved-delivery.json',
  'runtime/demo/workflows/intake-stage.json',
  'runtime/demo/workflows/reviewer-decision.json',
  'runtime/evidence/baseline.json',
  'runtime/run-gated-demo.sh',
  'workflows/client-intake-pipeline.json',
];

const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

async function loadManifestModule() {
  try {
    return await import('../scripts/evidence-manifest.mjs');
  } catch {
    return null;
  }
}

/** A temp git repo containing exactly the allowlisted files, all committed. */
function makeManifestRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'evidence-manifest-'));
  for (const relative of EXPECTED_ALLOWLIST) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `# fictional committed bytes for ${relative}\n`);
  }
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fictional Tester');
  git(root, 'config', 'user.email', 'tester@example.com'); // disclosure-waiver: synthetic temp-repo git identity (fictional), not real contact data
  git(root, 'add', ...EXPECTED_ALLOWLIST);
  git(root, 'commit', '-qm', 'fictional manifest fixture');
  return root;
}

/** A temp git repo whose tracked delta and/or untracked set scanDiff probes. */
function makeScanRepo({ deltaFiles = {}, untrackedFiles = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'evidence-scan-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'base.md'), 'fictional base content\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fictional Tester');
  git(root, 'config', 'user.email', 'tester@example.com'); // disclosure-waiver: synthetic temp-repo git identity (fictional), not real contact data
  git(root, 'add', 'docs/base.md');
  git(root, 'commit', '-qm', 'fictional scan base');
  const base = git(root, 'rev-parse', 'HEAD');
  const tracked = Object.keys(deltaFiles);
  if (tracked.length > 0) {
    for (const [relative, content] of Object.entries(deltaFiles)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(root, 'add', ...tracked);
    git(root, 'commit', '-qm', 'fictional scan delta');
  }
  for (const [relative, content] of Object.entries(untrackedFiles)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, base };
}

// Synthetic negative fixtures. Each source line whose bytes themselves trip a
// disclosure pattern carries the explicit line-scoped waiver marker — the same
// mechanism the scanner offers to committed artifacts, applied to this test
// file so the phase delta stays scan-clean without hiding the literals.
const SYNTHETIC_BEARER = 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // disclosure-waiver: synthetic negative-test fixture (bearer shape)
const SYNTHETIC_PHONE = '+15555550123'; // disclosure-waiver: synthetic negative-test fixture (E.164 shape)
const SYNTHETIC_FIXTURE_EMAIL = 'aria.mercado@fictional.invalid'; // disclosure-waiver: synthetic negative-test fixture (fixture-literal shape)

// The canonical rendered waiver-fixture line (as it exists inside a scanned
// temp repo at tests/negative.md): a known synthetic bearer hit plus the
// explicit marker plus a substantive justification. WR-04 requires this exact
// line to be fingerprint-allowlisted for the waiver to count.
const WAIVED_FIXTURE_LINE = `waived line ${SYNTHETIC_BEARER} <!-- disclosure-waiver: intentional negative-test fixture -->`;

test('bindManifest hashes the fixed nine-file allowlist over working bytes; verifyManifest passes an untouched tree and names the offending path on any drift', async () => {
  const manifestModule = await loadManifestModule();
  assert.ok(
    manifestModule,
    'runtime/scripts/evidence-manifest.mjs must export the manifest contract (MANIFEST_ALLOWLIST, bindManifest, verifyManifest, scanDiff)'
  );
  assert.deepEqual(
    manifestModule.MANIFEST_ALLOWLIST,
    EXPECTED_ALLOWLIST,
    'the allowlist must be exactly the nine reviewed files, sorted'
  );

  const root = makeManifestRepo();
  try {
    const commit = git(root, 'rev-parse', 'HEAD');
    const manifest = manifestModule.bindManifest({ root });
    assert.equal(manifest.head, commit, 'bind records the repo HEAD');
    assert.deepEqual(
      manifest.files.map((entry) => entry.path),
      EXPECTED_ALLOWLIST,
      'bind covers exactly the allowlisted files'
    );
    for (const entry of manifest.files) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.path} must carry a sha256 over its working bytes`);
    }
    assert.doesNotThrow(() => manifestModule.verifyManifest({ root, manifest }), 'an untouched tree verifies');

    // Mutating one allowlisted file fails verification naming that file.
    const target = 'runtime/demo/docker-compose.yml';
    writeFileSync(path.join(root, target), 'services: {mutated: true}\n');
    assert.throws(
      () => manifestModule.verifyManifest({ root, manifest }),
      new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'a mutated allowlisted file must fail verify naming it'
    );
    writeFileSync(path.join(root, target), `# fictional committed bytes for ${target}\n`);

    // Moving HEAD fails verification (evidence must bind the reviewed commit).
    git(root, 'commit', '--allow-empty', '-qm', 'head moved mid-run');
    assert.throws(
      () => manifestModule.verifyManifest({ root, manifest }),
      /HEAD|commit/i,
      'a moved HEAD cannot verify against the recorded manifest head'
    );

    // A file missing from git fails verification even though it exists on disk.
    const partial = mkdtempSync(path.join(tmpdir(), 'evidence-manifest-missing-'));
    try {
      for (const relative of EXPECTED_ALLOWLIST) {
        const target2 = path.join(partial, relative);
        mkdirSync(path.dirname(target2), { recursive: true });
        writeFileSync(target2, `# fictional bytes for ${relative}\n`);
      }
      git(partial, 'init', '-q');
      git(partial, 'config', 'user.name', 'Fictional Tester');
      git(partial, 'config', 'user.email', 'tester@example.com'); // disclosure-waiver: synthetic temp-repo git identity (fictional), not real contact data
      git(partial, 'add', ...EXPECTED_ALLOWLIST.filter((entry) => entry !== 'runtime/run-gated-demo.sh'));
      git(partial, 'commit', '-qm', 'fictional repo missing one allowlisted file in git');
      const partialManifest = manifestModule.bindManifest({ root: partial });
      assert.throws(
        () => manifestModule.verifyManifest({ root: partial, manifest: partialManifest }),
        /run-gated-demo\.sh/,
        'a file present on disk but missing from git must fail verify naming it'
      );
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanDiff flags secrets, raw contact shapes, fixture literals, and CI-grep keys in the tracked delta; a clean delta passes', async () => {
  const manifestModule = await loadManifestModule();
  assert.ok(manifestModule, 'runtime/scripts/evidence-manifest.mjs must export scanDiff');

  // Bearer-shaped token in a committed delta file.
  const bearer = makeScanRepo({
    deltaFiles: { 'notes/delta.md': `token line: ${SYNTHETIC_BEARER}\n` },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: bearer.root, base: bearer.base, fixtureValues: [] });
    assert.equal(verdict.ok, false, 'a bearer-shaped token must fail the scan');
    assert.ok(
      verdict.hits.some((hit) => hit.file === 'notes/delta.md' && /bearer/i.test(hit.message)),
      'the hit must name the file and the bearer rule'
    );
  } finally {
    rmSync(bearer.root, { recursive: true, force: true });
  }

  // Raw E.164 phone in a committed delta file.
  const phone = makeScanRepo({
    deltaFiles: { 'notes/phone.md': `call ${SYNTHETIC_PHONE} now\n` },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: phone.root, base: phone.base, fixtureValues: [] });
    assert.equal(verdict.ok, false, 'a raw E.164 phone must fail the scan');
    assert.ok(verdict.hits.some((hit) => hit.file === 'notes/phone.md' && /phone|E\.164/i.test(hit.message)));
  } finally {
    rmSync(phone.root, { recursive: true, force: true });
  }

  // A fixture contact-field literal copied into a committed delta file — the
  // fixture-literal scan (values passed in by the caller) must name it even
  // though the shape is also caught by the generic email rule.
  const fixture = makeScanRepo({
    deltaFiles: {
      'notes/contact.md': `reach ${SYNTHETIC_FIXTURE_EMAIL} please\n`, // disclosure-waiver: synthetic negative-test fixture (fixture-literal shape)
    },
  });
  try {
    const verdict = manifestModule.scanDiff({
      root: fixture.root,
      base: fixture.base,
      fixtureValues: [SYNTHETIC_FIXTURE_EMAIL],
    });
    assert.equal(verdict.ok, false, 'a copied fixture contact literal must fail the scan');
    assert.ok(
      verdict.hits.some((hit) => hit.file === 'notes/contact.md' && /fixture/i.test(hit.message)),
      'the hit must be attributed to the fixture-literal scan'
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  // A JSON delta file containing a CI-grep key.
  const ciKey = makeScanRepo({
    deltaFiles: { 'data/config.json': '{"token": "fictional"}\n' },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: ciKey.root, base: ciKey.base, fixtureValues: [] });
    assert.equal(verdict.ok, false, 'a CI-grep key in a JSON delta file must fail the scan');
    assert.ok(
      verdict.hits.some((hit) => hit.file === 'data/config.json' && /CI|token/i.test(hit.message)),
      'the hit must name the CI credential-grep rule'
    );
  } finally {
    rmSync(ciKey.root, { recursive: true, force: true });
  }

  // A clean delta passes with zero hits.
  const clean = makeScanRepo({
    deltaFiles: { 'notes/clean.md': 'fictional notes with no secrets\n' },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: clean.root, base: clean.base, fixtureValues: [] });
    assert.equal(verdict.ok, true, 'a clean delta must pass');
    assert.deepEqual(verdict.hits, [], 'a clean delta reports no hits');
    assert.ok(verdict.files_scanned >= 1, 'the scan must report the files it scanned');
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
  }
});

test('scanDiff skips untracked tool-own working state by declared prefix (not convenience) while flagging the same content at a deliverable path', async () => {
  const manifestModule = await loadManifestModule();
  assert.ok(manifestModule, 'runtime/scripts/evidence-manifest.mjs must export scanDiff');

  const secret = `token line: ${SYNTHETIC_BEARER}\n`; // disclosure-waiver: synthetic negative-test fixture (bearer shape)
  const scenario = makeScanRepo({ untrackedFiles: { '.planning/state.json': secret } });
  try {
    const skipped = manifestModule.scanDiff({ root: scenario.root, base: scenario.base, fixtureValues: [] });
    assert.equal(skipped.ok, true, 'untracked tool-own .planning/ working state is out of scope by declared design');
    assert.ok(
      (skipped.skipped ?? []).some((entry) => entry.file === '.planning/state.json'),
      'the skip must be recorded and attributed to the tool-own prefix, never silent'
    );

    mkdirSync(path.join(scenario.root, 'notes'), { recursive: true });
    writeFileSync(path.join(scenario.root, 'notes', 'leak.txt'), secret);
    const flagged = manifestModule.scanDiff({ root: scenario.root, base: scenario.base, fixtureValues: [] });
    assert.equal(flagged.ok, false, 'the same content at an untracked deliverable path must be flagged');
    assert.ok(flagged.hits.some((hit) => hit.file === 'notes/leak.txt' && /bearer/i.test(hit.message)));
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('a disclosure hit is waived only by the explicit line-scoped marker: waived hits are listed, unwaived hits fail, and the marker alone never silences other lines', async () => {
  const manifestModule = await loadManifestModule();
  assert.ok(manifestModule, 'runtime/scripts/evidence-manifest.mjs must export scanDiff');

  const marked = makeScanRepo({
    deltaFiles: {
      'tests/negative.md': `clean line\n${WAIVED_FIXTURE_LINE}\n`, // disclosure-waiver: synthetic negative-test fixture (bearer shape)
    },
  });
  const unmarked = makeScanRepo({
    deltaFiles: {
      'tests/negative2.md': `waived line ${SYNTHETIC_BEARER} on one line\n<!-- disclosure-waiver: marker on a DIFFERENT line -->\n`, // disclosure-waiver: synthetic negative-test fixture (bearer shape)
    },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: marked.root, base: marked.base, fixtureValues: [] });
    assert.equal(verdict.ok, true, 'a line carrying the explicit waiver marker passes while remaining visible');
    assert.equal(verdict.hits.length, 1, 'the waived hit is still reported, never silently dropped');
    assert.equal(verdict.hits[0].waived, true, 'the hit is marked waived');
    assert.equal(verdict.hits[0].file, 'tests/negative.md');

    const verdict2 = manifestModule.scanDiff({ root: unmarked.root, base: unmarked.base, fixtureValues: [] });
    assert.equal(verdict2.ok, false, 'a marker on a different line cannot waive the hit');
    assert.ok(verdict2.hits.some((hit) => hit.waived === false));
  } finally {
    rmSync(marked.root, { recursive: true, force: true });
    rmSync(unmarked.root, { recursive: true, force: true });
  }
});

test('a disclosure waiver requires a known synthetic fixture fingerprint AND a substantive justification (WR-04)', async () => {
  const manifestModule = await loadManifestModule();
  assert.ok(manifestModule, 'runtime/scripts/evidence-manifest.mjs must export the manifest contract');
  assert.ok(
    Array.isArray(manifestModule.KNOWN_SYNTHETIC_WAIVERS),
    'evidence-manifest.mjs must export KNOWN_SYNTHETIC_WAIVERS — the curated file+line fingerprints of the exact known synthetic fixture lines (WR-04)'
  );

  const { createHash } = await import('node:crypto');
  const lineHash = (value) => createHash('sha256').update(value.trim()).digest('hex');

  // Sync guard 1: every entry is a well-formed {file, lineSha256} pair.
  for (const entry of manifestModule.KNOWN_SYNTHETIC_WAIVERS) {
    assert.match(entry.file, /^[A-Za-z0-9/._-]+$/, `allowlist entry file must be a repo-relative path (got ${entry.file})`);
    assert.match(entry.lineSha256, /^[0-9a-f]{64}$/, `allowlist entry for ${entry.file} must carry a full sha256 line fingerprint`);
  }

  // Sync guard 2: entries naming repository files match an ACTUAL line in
  // that file (no stale fingerprints); the temp-fixture entry matches the
  // canonical rendered fixture line exactly.
  for (const entry of manifestModule.KNOWN_SYNTHETIC_WAIVERS) {
    const absolute = path.join(ROOT, entry.file);
    if (!existsSync(absolute)) continue; // temp-repo fixture paths are validated below
    const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
    assert.ok(
      lines.some((line) => lineHash(line) === entry.lineSha256),
      `allowlist entry for ${entry.file} matches no line in the committed file — a stale or invented fingerprint`
    );
  }
  assert.ok(
    manifestModule.KNOWN_SYNTHETIC_WAIVERS.some(
      (entry) => entry.file === 'tests/negative.md' && entry.lineSha256 === lineHash(WAIVED_FIXTURE_LINE)
    ),
    'the canonical rendered waiver fixture (tests/negative.md) must be allowlisted'
  );

  // (1) A bare/empty-justification marker over a real hit FAILS, with an
  // explicit invalid-waiver hit naming the problem.
  const bare = makeScanRepo({
    deltaFiles: { 'notes/bare.md': `token line: Bearer ${'b'.repeat(40)} <!-- disclosure-waiver: -->\n` },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: bare.root, base: bare.base, fixtureValues: [] });
    assert.equal(verdict.ok, false, 'a bare marker must not waive a credential-shaped hit');
    assert.ok(
      verdict.hits.some((hit) => hit.waived === false && /disclosure-waiver/.test(hit.message) && /justification/i.test(hit.message)),
      'the failure must carry an explicit invalid-waiver hit naming the missing justification'
    );
  } finally {
    rmSync(bare.root, { recursive: true, force: true });
  }

  // (2) An arbitrary credential-bearing line with a GOOD justification still
  // FAILS — justification alone is not a waiver; the exact line must be a
  // known synthetic fixture fingerprint.
  const arbitrary = makeScanRepo({
    deltaFiles: {
      'notes/arb.md': `token line: Bearer ${'c'.repeat(40)} <!-- disclosure-waiver: ops note honestly explaining this token for this line -->\n`,
    },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: arbitrary.root, base: arbitrary.base, fixtureValues: [] });
    assert.equal(verdict.ok, false, 'an arbitrary credential line with a justified marker must still fail');
    assert.ok(
      verdict.hits.some((hit) => hit.waived === false && /fingerprint|known synthetic|allowlist/i.test(hit.message)),
      'the failure must name the missing fingerprint'
    );
  } finally {
    rmSync(arbitrary.root, { recursive: true, force: true });
  }

  // (3) The known fingerprinted fixture with its justification still passes,
  // with the hit visible and waived (never silently dropped).
  const sanctioned = makeScanRepo({
    deltaFiles: { 'tests/negative.md': `clean line\n${WAIVED_FIXTURE_LINE}\n` },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: sanctioned.root, base: sanctioned.base, fixtureValues: [] });
    assert.equal(verdict.ok, true, 'the fingerprinted fixture with a substantive justification must still waive');
    assert.equal(verdict.hits.length, 1, 'the waived hit remains visible');
    assert.equal(verdict.hits[0].waived, true);
  } finally {
    rmSync(sanctioned.root, { recursive: true, force: true });
  }

  // (4) The same fingerprinted line MOVED to a different path fails — the
  // fingerprint is file-scoped, so a copied waiver cannot travel.
  const moved = makeScanRepo({
    deltaFiles: { 'notes/copied.md': `${WAIVED_FIXTURE_LINE}\n` },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: moved.root, base: moved.base, fixtureValues: [] });
    assert.equal(verdict.ok, false, 'a fingerprinted line outside its sanctioned file must not waive');
  } finally {
    rmSync(moved.root, { recursive: true, force: true });
  }

  // (5) The fingerprinted line with its justification stripped below the
  // substantive threshold fails.
  const stripped = makeScanRepo({
    deltaFiles: { 'tests/negative.md': `waived line ${SYNTHETIC_BEARER} <!-- disclosure-waiver: nope -->\n` },
  });
  try {
    const verdict = manifestModule.scanDiff({ root: stripped.root, base: stripped.base, fixtureValues: [] });
    assert.equal(verdict.ok, false, 'a sub-threshold justification must not waive');
  } finally {
    rmSync(stripped.root, { recursive: true, force: true });
  }
});

test('the CLI binds and verifies the real repository allowlist; the drift probe runs against a temp-repo copy, never the live deliverable (IN-05)', async () => {
  const manifestModule = await loadManifestModule();
  assert.ok(manifestModule, 'runtime/scripts/evidence-manifest.mjs must export the manifest contract');

  // IN-05: this test must never mutate a live repository deliverable — a hard
  // kill inside an old probe window used to leave runtime/demo/mocks/server.mjs
  // drifted. The drift probe below runs inside a throwaway temp repo; the
  // live tracked tree is asserted identical before and after.
  const liveStatus = () =>
    spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' });
  const liveDriftBefore = liveStatus().stdout;

  const directory = mkdtempSync(path.join(tmpdir(), 'evidence-manifest-cli-'));
  try {
    // Real repository: bind (read-only) then verify the just-bound manifest.
    const bound = spawnSync(process.execPath, [MANIFEST_CLI, 'bind'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(bound.status, 0, `bind must succeed against the real repo (stderr: ${bound.stderr})`);
    const manifest = JSON.parse(bound.stdout);
    assert.match(manifest.head, /^[0-9a-f]{40}$/, 'bind records the full head commit');
    assert.deepEqual(
      manifest.files.map((entry) => entry.path),
      EXPECTED_ALLOWLIST,
      'the real-repo manifest allowlist is exactly the nine files'
    );
    const manifestFile = path.join(directory, 'manifest.json');
    writeFileSync(manifestFile, bound.stdout);
    const verified = spawnSync(process.execPath, [MANIFEST_CLI, 'verify', manifestFile], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(verified.status, 0, `verify of the just-bound manifest must pass (stderr: ${verified.stderr})`);

    // IN-05: the drift probe runs against a temp-repo COPY of the allowlist.
    const repo = makeManifestRepo();
    try {
      const tempBound = spawnSync(process.execPath, [MANIFEST_CLI, 'bind'], { cwd: repo, encoding: 'utf8' });
      assert.equal(tempBound.status, 0, `bind must succeed against the temp repo (stderr: ${tempBound.stderr})`);
      const tempManifestFile = path.join(directory, 'temp-manifest.json');
      writeFileSync(tempManifestFile, tempBound.stdout);
      const tempVerified = spawnSync(process.execPath, [MANIFEST_CLI, 'verify', tempManifestFile], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.equal(tempVerified.status, 0, 'the just-bound temp manifest must verify');

      const target = 'runtime/demo/docker-compose.yml';
      writeFileSync(path.join(repo, target), 'services: {mutated: true}\n');
      const drifted = spawnSync(process.execPath, [MANIFEST_CLI, 'verify', tempManifestFile], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.notEqual(drifted.status, 0, 'a touched allowlisted file must fail verify');
      assert.match(drifted.stderr + drifted.stdout, /docker-compose\.yml/, 'verify must name the drifted file');

      // Restoring the bytes must verify again — still inside the temp repo.
      writeFileSync(path.join(repo, target), `# fictional committed bytes for ${target}\n`);
      const restored = spawnSync(process.execPath, [MANIFEST_CLI, 'verify', tempManifestFile], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.equal(restored.status, 0, 'restoring the bytes must verify again');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }

    // The live tracked tree is byte-identical to before the test ran.
    assert.equal(
      liveStatus().stdout,
      liveDriftBefore,
      'the drift probe must never touch the live repository deliverables (IN-05)'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI never silently no-ops: every verb fails non-zero on malformed input, and symlinked or /dev/fd entry paths still run the verbs (RR-03-B)', async (t) => {
  const manifestModule = await loadManifestModule();
  assert.ok(manifestModule, 'runtime/scripts/evidence-manifest.mjs must export the manifest contract');

  // --- malformed input: every verb must exit non-zero with a diagnostic -----
  // A chained consumer must never mistake a silent verifier no-op for PASS.
  const run = (args) => spawnSync(process.execPath, [MANIFEST_CLI, ...args], { encoding: 'utf8', cwd: ROOT });

  const noVerb = run([]);
  assert.notEqual(noVerb.status, 0, 'a missing verb must exit non-zero');
  assert.match(noVerb.stderr, /usage:/i, 'a missing verb must print usage on stderr');

  const unknownVerb = run(['frobnicate']);
  assert.notEqual(unknownVerb.status, 0, 'an unrecognized verb must exit non-zero');
  assert.match(unknownVerb.stderr, /usage:/i, 'an unrecognized verb must print usage on stderr');

  const verifyNoFile = run(['verify']);
  assert.notEqual(verifyNoFile.status, 0, 'verify without a manifest file must exit non-zero');
  assert.match(verifyNoFile.stderr, /usage:/i, 'verify without a file must print usage on stderr');

  const verifyUnreadable = run(['verify', 'definitely-not-a-manifest.json']);
  assert.notEqual(verifyUnreadable.status, 0, 'verify of an unreadable manifest must exit non-zero');
  assert.match(verifyUnreadable.stderr, /unreadable|manifest/i, 'verify of an unreadable manifest must name it');

  const scanNoBase = run(['scan-diff']);
  assert.notEqual(scanNoBase.status, 0, 'scan-diff without --base must exit non-zero');
  assert.match(scanNoBase.stderr, /usage:/i, 'scan-diff without --base must print usage on stderr');

  const bindExtra = run(['bind', 'unexpected-extra-arg']);
  assert.notEqual(bindExtra.status, 0, 'bind must reject unexpected positional arguments (strict verbs — extras are a usage error)');
  assert.match(bindExtra.stderr, /usage:/i, 'bind with extras must print usage on stderr');

  // --- symlinked entry path: the CLI must RUN (not silently exit 0) ---------
  // The naive `import.meta.url === pathToFileURL(argv[1]).href` comparison
  // fails when the entry is a symlink, silently vacating every verb.
  const linkDirectory = mkdtempSync(path.join(tmpdir(), 'evidence-manifest-link-'));
  try {
    const linked = path.join(linkDirectory, 'em-link.mjs');
    symlinkSync(MANIFEST_CLI, linked);
    const badVerbViaLink = spawnSync(process.execPath, [linked, 'frobnicate'], { encoding: 'utf8', cwd: ROOT });
    assert.notEqual(badVerbViaLink.status, 0, 'a symlinked entry path must not silently no-op the CLI');
    assert.match(badVerbViaLink.stderr, /usage:/i, 'the usage error must actually be printed through the symlink');

    const bindViaLink = spawnSync(process.execPath, [linked, 'bind'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(bindViaLink.status, 0, `bind must actually run through a symlinked entry path (stderr: ${bindViaLink.stderr})`);
    const viaLinkManifest = JSON.parse(bindViaLink.stdout);
    assert.match(viaLinkManifest.head, /^[0-9a-f]{40}$/, 'bind through the symlink must print a real manifest (40-hex head)');
  } finally {
    rmSync(linkDirectory, { recursive: true, force: true });
  }

  // --- /dev/fd entry path: verified under real Linux fd semantics ----------
  // On macOS, `node /dev/fd/3 <esm-file>` never executes the module body at
  // all (Node's extension-less ESM entry does a detection read plus a load
  // read over the dup-shared fd offset — the second read is empty), so the
  // vacuous exit-0 there is Node's loader, not something in-repo code can
  // intercept. The detection layer itself is exercised where the body DOES
  // execute through an fd path: inside the digest-pinned container (Linux
  // /proc/self/fd semantics), where the ORIGINAL naive detection was observed
  // exiting 0 silently for every verb. Skipped (with a reason) only when
  // Docker or the pinned image is unavailable — never silently.
  const PINNED_IMAGE = 'n8nio/n8n@sha256:307d6065be25619aa24cfc63a7c2f04ca56d084a08c05c8e9f189a89f353b1ec';
  const dockerUsable =
    spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0 &&
    spawnSync('docker', ['image', 'inspect', PINNED_IMAGE], { encoding: 'utf8' }).status === 0;
  if (!dockerUsable) {
    t.skip('Docker daemon or pinned image unavailable — /dev/fd execution semantics test requires the cached pinned container');
  } else {
    const tarOut = spawnSync('tar', ['-cf', '-', '-C', path.dirname(MANIFEST_CLI), 'evidence-manifest.mjs', 'final-evidence.mjs'], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(tarOut.status, 0, `could not stage the CLI scripts for the container probe: ${tarOut.stderr}`);
    const runVerbViaFd = (verb) =>
      spawnSync(
        'docker',
        [
          'run', '--rm', '-i', '--network', 'none', '--entrypoint', 'sh', PINNED_IMAGE,
          '-c',
          'mkdir -p /tmp/work && tar -xf - -C /tmp/work && cd /tmp/work && exec 3< evidence-manifest.mjs && exec node /dev/fd/3 "$0"',
          verb,
        ],
        { encoding: 'utf8', input: tarOut.stdout, maxBuffer: 16 * 1024 * 1024 }
      );
    const badVerbViaFd = runVerbViaFd('frobnicate');
    assert.notEqual(badVerbViaFd.status, 0, 'a /dev/fd entry path must not silently no-op the CLI (observed: original detection exited 0)');
    assert.match(badVerbViaFd.stderr, /usage:/i, 'the usage error must actually be printed through the /dev/fd entry');

    // A real verb through the fd entry runs loudly too: verify without a file
    // fails non-zero with a diagnostic (never a silent exit 0).
    const verifyViaFd = runVerbViaFd('verify');
    assert.notEqual(verifyViaFd.status, 0, 'verify through a /dev/fd entry must fail non-zero, not silently exit 0');
    assert.match(verifyViaFd.stderr, /evidence-manifest:|usage:/, 'verify through a /dev/fd entry must print a diagnostic');
  }
});
