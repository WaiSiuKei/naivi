// Build the GitHub Pages site for the naivi WASM demos.
//
// Each demo (`examples/naivi/<name>`) is built STANDALONE with the published
// @naivi/* packages (no monorepo, no trunk, no Rust): its sources are copied
// into a temp project OUTSIDE the repo (so `nv wasm` can't find the blitz
// monorepo root and uses @naivi/wasm-host), deps are installed from npm, and
// `nv wasm --release` produces a self-contained static site. The sites are
// collected under `_site/<demo>/` with a landing page at `_site/index.html`.
//
//   node scripts/pages-build.mjs
//
// Output: `<repo>/_site/` — deploy this directory to GitHub Pages.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, '_site');
const buildRoot = join(tmpdir(), 'naivi-pages'); // OUTSIDE the repo → standalone mode

// Published @naivi/* versions the standalone demos install (kept in sync
// with npmjs; bump when releasing new versions).
const NAIVI_VERSIONS = {
  '@naivi/cli': '^0.0.5',
  '@naivi/runtime': '^0.0.2',
};

const DEMOS = [
  { dir: 'counter', title: 'Counter', desc: 'A minimal Vue counter' },
  { dir: 'todomvc', title: 'TodoMVC', desc: 'The classic todo list app' },
];

/** Derive a standalone package.json from the demo's own (replace workspace:*
 * @naivi/* deps with the published versions). */
function standalonePackageJson(demoDir) {
  const pkg = JSON.parse(readFileSync(join(demoDir, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(NAIVI_VERSIONS)) {
    if (pkg.dependencies?.[name] === 'workspace:*') pkg.dependencies[name] = version;
    if (pkg.devDependencies?.[name] === 'workspace:*') pkg.devDependencies[name] = version;
  }
  pkg.private = true;
  return JSON.stringify(pkg, null, 2);
}

function buildDemo({ dir, title }) {
  const src = join(repoRoot, 'examples', 'naivi', dir);
  const build = join(buildRoot, dir);
  const dest = join(outDir, dir);

  console.log(`\n=== Building demo: ${title} (${dir}) ===`);
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });

  // Copy the demo's sources (single source of truth in the repo).
  cpSync(join(src, 'src'), join(build, 'src'), { recursive: true });
  if (existsSync(join(src, 'app'))) cpSync(join(src, 'app'), join(build, 'app'), { recursive: true });
  cpSync(join(src, 'index.html'), join(build, 'index.html'));
  cpSync(join(src, 'naivi.config.ts'), join(build, 'naivi.config.ts'));
  if (existsSync(join(src, 'tsconfig.json'))) {
    cpSync(join(src, 'tsconfig.json'), join(build, 'tsconfig.json'));
  }
  writeFileSync(join(build, 'package.json'), standalonePackageJson(src));

  // Install + build standalone. --legacy-peer-deps: @naivi/runtime depends on
  // vue@rc, which @vitejs/plugin-vue's peer range excludes (npm is strict).
  execSync('npm install --legacy-peer-deps --no-audit --no-fund', { cwd: build, stdio: 'inherit' });
  execSync('npx nv wasm --release', { cwd: build, stdio: 'inherit' });

  // Collect the self-contained static site.
  mkdirSync(outDir, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(build, 'dist'), dest, { recursive: true });
  console.log(`→ ${dest}`);
}

function landingPage() {
  const items = DEMOS.map(
    (d) =>
      `    <li><a href="./${d.dir}/"><strong>${d.title}</strong><span class="desc"> — ${d.desc}</span></a></li>`,
  ).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>naivi — WASM demos</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #111; }
    h1 { font-size: 28px; }
    .desc { color: #666; font-size: 14px; }
    ul { list-style: none; padding: 0; }
    a { display: flex; justify-content: space-between; align-items: baseline; padding: 16px; margin: 8px 0; border: 1px solid #ddd; border-radius: 8px; text-decoration: none; color: #111; }
    a:hover { border-color: #b83f45; }
    a strong { font-size: 18px; }
    .foot { color: #999; font-size: 13px; margin-top: 32px; }
  </style>
</head>
<body>
  <h1>naivi — WASM demos</h1>
  <p class="desc">Vue Vapor apps rendered by the blitz engine (WebAssembly).</p>
  <ul>
${items}
  </ul>
  <p class="foot">naivi — a Vue Vapor AOT frontend for <a href="https://github.com/DioxusLabs/blitz">blitz</a>.</p>
</body>
</html>
`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
rmSync(buildRoot, { recursive: true, force: true });

for (const demo of DEMOS) buildDemo(demo);

writeFileSync(join(outDir, 'index.html'), landingPage());
console.log(`\n✓ Pages site → ${outDir}`);
console.log(`  ${outDir}/index.html`);
for (const d of DEMOS) console.log(`  ${outDir}/${d.dir}/`);
