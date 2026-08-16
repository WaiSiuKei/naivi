// Build the @naivi/wasm-host package: copy the trunk-built host site
// (packages/naivi-wasm/dist) into ./dist, stripping the per-demo guest —
// the CLI (`nv wasm`) injects each demo's guest at build time, so a stale
// one must never ship in the package.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(fileURLToPath(import.meta.url)); // js/naivi-wasm-host/scripts
const pkgRoot = join(pkgDir, '..');
const repoRoot = join(pkgRoot, '..', '..');
const src = join(repoRoot, 'packages', 'naivi-wasm', 'dist');
const out = join(pkgRoot, 'dist');

if (!cpSync) throw new Error('unreachable'); // keep node:fs import honest

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });

// Per-demo guest — injected by `nv wasm`; never ship a stale copy.
rmSync(join(out, 'assets', 'guest'), { recursive: true, force: true });

console.log(`@naivi/wasm-host: host site → ${out} (guest stripped)`);
