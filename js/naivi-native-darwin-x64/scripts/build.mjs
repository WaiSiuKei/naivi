// Build the @naivi/native-darwin-x64 package: copy the release-built
// `naivi-native` binary (target/release/naivi-native) into the package root.
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(fileURLToPath(import.meta.url)); // js/naivi-native-darwin-x64/scripts
const pkgRoot = join(pkgDir, '..');
const repoRoot = join(pkgRoot, '..', '..');
const src = join(repoRoot, 'target', 'release', 'naivi-native');
const out = join(pkgRoot, 'naivi-native');

mkdirSync(pkgRoot, { recursive: true });
copyFileSync(src, out);
chmodSync(out, 0o755);

console.log(`@naivi/native-darwin-x64: binary → ${out}`);
