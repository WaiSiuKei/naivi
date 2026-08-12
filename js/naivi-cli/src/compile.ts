// Shared compile pipeline: collects the project's CSS, runs it through the
// Tailwind + naive-css AOT pipeline, and writes `node_modules/.naive/styles.json`.
// Used by both `naive wasm` (cli.ts) and `naive desktop` (desktop.ts).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { compileTailwindCSS } from './tailwind.ts';

const C = {
  ok:   (s: string) => `\x1b[32m✓\x1b[0m ${s}`,
  dim:  (s: string) => `\x1b[2m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m⚠\x1b[0m ${s}`,
};

// ── find the naive monorepo root ────────────────────────────────────

export function findRoot(from = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    const cargo = join(dir, 'Cargo.toml');
    if (existsSync(cargo)) {
      try {
        const raw = readFileSync(cargo, 'utf8');
        // Monorepo root: a Cargo workspace that contains the naive-host crate.
        if (raw.includes('[workspace]') && raw.includes('naive-host')) return dir;
      } catch { /* file exists but can't be read — skip */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Find CSS files in the project and resolve @import chains. */
function findCSSFiles(targetDir: string): string[] {
  const results: string[] = [];

  // Check common CSS entry points
  const entryPoints = [
    join(targetDir, 'main.css'),
    join(targetDir, 'src', 'assets', 'main.css'),
    join(targetDir, 'src', 'main.css'),
  ];

  const resolved = new Set<string>();

  function addFile(f: string) {
    if (!existsSync(f) || resolved.has(f)) return;
    resolved.add(f);
    results.push(f);
  }

  function resolveImports(cssFile: string) {
    try {
      const source = readFileSync(cssFile, 'utf8');
      const importRe = /@import\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(source)) !== null) {
        const importPath = match[1];
        // Resolve relative to the CSS file's directory or from node_modules
        const fromDir = resolve(dirname(cssFile), importPath);
        if (existsSync(fromDir)) {
          addFile(fromDir);
        } else {
          // Try node_modules in the target dir
          const fromNM = join(targetDir, 'node_modules', importPath);
          if (existsSync(fromNM)) addFile(fromNM);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  for (const entry of entryPoints) {
    addFile(entry);
  }

  // Follow @import directives from all found files
  // (iterate by index since results grow during iteration)
  for (let i = 0; i < results.length; i++) {
    resolveImports(results[i]);
  }

  return results;
}

/** Newest mtime (ms) among the naive-css source files (crates/naive-css/src, all .rs) plus Cargo.toml, or 0 if unknown. */
function naiveCSSSourceNewestMtime(naiveRoot: string): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.rs')) {
        try {
          const m = statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch { /* ignore */ }
      }
    }
  };
  const srcDir = join(naiveRoot, 'crates', 'naive-css', 'src');
  if (existsSync(srcDir)) walk(srcDir);
  try {
    const m = statSync(join(naiveRoot, 'crates', 'naive-css', 'Cargo.toml')).mtimeMs;
    if (m > newest) newest = m;
  } catch { /* ignore */ }
  return newest;
}

/** Resolve (or build) an up-to-date Rust naive-css binary, or null. */
function resolveNaiveCSSBinary(targetDir: string): string | null {
  try {
    const naiveRoot = findRoot(targetDir) || process.cwd();
    const possiblePaths = [
      join(naiveRoot, 'target', 'release', 'naive-css'),
      join(naiveRoot, 'target', 'debug', 'naive-css'),
    ];

    // Prefer an up-to-date binary. A leftover `target/{debug,release}/naive-css`
    // from an older checkout silently produces wrong output (e.g. `font-size:
    // 1.25rem` emitted as 1.25 instead of 20px), so rebuild whenever the Rust
    // source is newer than every existing binary.
    const srcNewest = naiveCSSSourceNewestMtime(naiveRoot);
    let binaryPath = '';
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        try {
          if (statSync(p).mtimeMs >= srcNewest) {
            binaryPath = p;
            break;
          }
        } catch { /* ignore */ }
      }
    }

    if (!binaryPath) {
      // No up-to-date binary: build (or rebuild) the debug one.
      console.log(C.dim('[naive] Building Rust AOT CSS compiler (first run or stale)...'));
      execSync('cargo build -p naive-css 2>&1', { cwd: naiveRoot, stdio: 'pipe', timeout: 120000 });
      binaryPath = join(naiveRoot, 'target', 'debug', 'naive-css');
    }

    if (!existsSync(binaryPath)) return null;
    return binaryPath;
  } catch {
    return null;
  }
}

/**
 * Run the Rust naive-css binary for the runtime rule table. Returns the
 * parsed `{ rules: [...] }` object, or null when unavailable. Selector
 * hard-fails are rethrown (same policy as the class table).
 */
function tryRunNaiveCSSRuleTable(css: string, targetDir: string): { rules: unknown[] } | null {
  try {
    const naiveRoot = findRoot(targetDir) || process.cwd();
    const binaryPath = resolveNaiveCSSBinary(targetDir);
    if (!binaryPath) return null;

    const tmpCSS = join(targetDir, 'node_modules', '.naive', '_compile.css');
    mkdirSync(dirname(tmpCSS), { recursive: true });
    writeFileSync(tmpCSS, css);

    const result = execSync(`"${binaryPath}" --rule-table "${tmpCSS}"`, {
      cwd: naiveRoot,
      stdio: 'pipe',
      timeout: 30000,
    });
    return JSON.parse(result.toString('utf8')) as { rules: unknown[] };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (stderr.includes('Error compiling CSS')) {
      throw err;
    }
    return null;
  }
}

/** Compile the project's CSS into `node_modules/.naive/styles.json`. */
export async function compileIfNeeded(targetDir: string): Promise<string> {
  const naiveDir = join(targetDir, 'node_modules', '.naive');
  mkdirSync(naiveDir, { recursive: true });

  // Collect all CSS to compile
  let allCSS = '';
  const cssFiles = findCSSFiles(targetDir);
  for (const cssFile of cssFiles) {
    try {
      allCSS += readFileSync(cssFile, 'utf8') + '\n';
    } catch { /* skip */ }
  }

  // Let the project's own tailwindcss dependency generate the full utility
  // CSS, then pre-parse it into the single CompiledStyleSheet (plan 062).
  const tailwindCSS = await compileTailwindCSS(targetDir, allCSS);
  if (tailwindCSS) {
    allCSS = tailwindCSS;
    console.log(C.ok('Generated Tailwind CSS via tailwindcss'));
  }

  // Rust AOT is the only compile path: pre-parse into a single
  // CompiledStyleSheet ({ rules: [...] } with specificity/order).
  const ruleTable = tryRunNaiveCSSRuleTable(allCSS, targetDir);
  if (!ruleTable || !Array.isArray(ruleTable.rules)) {
    throw new Error('Rust AOT stylesheet compile failed — no rules emitted');
  }
  console.log(C.ok(`Compiled CSS rules → ${ruleTable.rules.length} rules`));

  const outFile = join(naiveDir, 'styles.json');
  writeFileSync(outFile, JSON.stringify({ rules: ruleTable.rules }));
  return outFile;
}
