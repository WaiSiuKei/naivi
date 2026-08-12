// Shared compile pipeline (U6): collects the project's CSS text — SFC
// `<style>` blocks plus standalone CSS files — and writes
// `node_modules/.naive/styles.css`. The runtime injects that text as a stylo
// author stylesheet (`add_stylesheet`), so class / tag / `:hover` / `:checked`
// selectors are matched natively by blitz's engine.
//
// The old naive rule-table pipeline (Tailwind + the Rust `naive-css` binary →
// `styles.json`) is removed: naivi's AOT CSS output is plain CSS text (KTD4).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseSfc } from '@vue/compiler-sfc';

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
        // Monorepo root: a Cargo workspace that contains the naive-host crate
        // (upstream naive repo) or the naivi-dom crate (this blitz repo).
        if (raw.includes('[workspace]') && (raw.includes('naive-host') || raw.includes('naivi-dom'))) {
          return dir;
        }
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

/** Recursively find `.vue` files under `dir` (excluding node_modules/dist). */
function findVueFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      results.push(...findVueFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.vue')) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

/** Extract the raw CSS text of every `<style>` block in a `.vue` source. */
function extractSfcStyles(source: string, filePath: string): string {
  try {
    const { descriptor } = parseSfc(source);
    return descriptor.styles.map((s) => s.content).join('\n');
  } catch (error) {
    console.warn(C.warn(`Failed to parse SFC styles in ${filePath}: ${(error as Error).message}`));
    return '';
  }
}

/** Compile the project's CSS text into `node_modules/.naive/styles.css`. */
export async function compileIfNeeded(targetDir: string): Promise<string> {
  const naiveDir = join(targetDir, 'node_modules', '.naive');
  mkdirSync(naiveDir, { recursive: true });

  const parts: string[] = [];

  // Standalone CSS entry points (main.css, src/main.css, …).
  for (const cssFile of findCSSFiles(targetDir)) {
    try {
      parts.push(readFileSync(cssFile, 'utf8'));
    } catch { /* skip */ }
  }

  // SFC `<style>` blocks (AOT CSS text — U6).
  const srcDir = join(targetDir, 'src');
  for (const vueFile of findVueFiles(srcDir)) {
    try {
      const styles = extractSfcStyles(readFileSync(vueFile, 'utf8'), vueFile);
      if (styles.trim()) {
        parts.push(`/* ${relative(targetDir, vueFile)} */\n${styles}`);
      }
    } catch { /* skip */ }
  }

  const css = parts.filter((p) => p.trim()).join('\n\n');
  const outFile = join(naiveDir, 'styles.css');
  writeFileSync(outFile, css);
  console.log(
    css.trim()
      ? C.ok(`Compiled author CSS (${css.length} chars) → ${outFile}`)
      : C.dim('No author CSS to compile (empty styles.css)'),
  );
  return outFile;
}
