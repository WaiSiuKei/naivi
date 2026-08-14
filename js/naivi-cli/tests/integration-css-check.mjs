#!/usr/bin/env node
// Durable integration verification for plan 073 U3 — the wasm/desktop CSS
// subset check gate (ce-code-review 073 R2). Previously this was a manual
// CLI exercise captured only in commit prose; this script makes the plan's
// U3 scenarios repeatable:
//   1. a fixture copy of the counter demo with an injected unsupported
//      declaration (`float: left`) fails `nv wasm --release` (report +
//      non-zero exit, no Vite build)
//   2. the same fixture fails `nv desktop` before any window/guest launch
//   3. the clean counter demo passes `nv wasm --release` (exit 0)
// The fixture is a same-depth copy inside the repo (findRoot walks up from
// cwd; the copied node_modules symlinks stay valid) and is removed on exit.
//
// Usage: pnpm --filter @naivi/cli test:integration   (or from js/naivi-cli:
//        node tests/integration-css-check.mjs)

import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testsDir = dirname(fileURLToPath(import.meta.url)); // js/naivi-cli/tests
const pkgDir = join(testsDir, '..'); // js/naivi-cli
const root = join(pkgDir, '..', '..'); // repo root
const demoDir = join(root, 'examples', 'naivi', 'counter');
const fixtureDir = join(root, 'examples', 'naivi', 'css-check-fixture');
const cli = join(pkgDir, 'bin', 'nv.mjs');

/** Run the naivi CLI in `cwd`; returns { status, out }. */
function run(cwd, ...args) {
  const res = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

let failed = 0;
function check(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? `\n${detail}` : ''}`);
  }
}

try {
  // Fixture: copy of the counter demo at the same depth (node_modules
  // symlinks remain valid) plus an injected unsupported declaration.
  rmSync(fixtureDir, { recursive: true, force: true });
  cpSync(demoDir, fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'src', 'main.css'), '.x { float: left; }\n');

  console.log('== nv wasm --release on a fixture with an unsupported hit ==');
  let r = run(fixtureDir, 'wasm', '--release');
  check(r.status !== 0, 'non-zero exit', `exit=${r.status}`);
  check(r.out.includes('KC1101'), 'report contains KC1101', r.out);
  check(!r.out.includes('✓ built in'), 'Vite build did not run (fail-fast)', r.out);

  console.log('== nv desktop on the same fixture (fails before any window) ==');
  r = run(fixtureDir, 'desktop');
  check(r.status !== 0, 'non-zero exit', `exit=${r.status}`);
  check(r.out.includes('KC1101'), 'report contains KC1101', r.out);
  check(!r.out.includes('Running guest'), 'aborted before the guest launch', r.out);
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

console.log('== nv wasm --release on the clean counter demo ==');
const r = run(demoDir, 'wasm', '--release');
check(r.status === 0, 'zero exit', `exit=${r.status}`);
check(r.out.includes('100% supported'), 'check line', r.out);

if (failed > 0) {
  console.error(`\nintegration-css-check: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nintegration-css-check: all checks passed');
