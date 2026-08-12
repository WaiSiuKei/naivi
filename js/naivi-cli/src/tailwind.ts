// Tailwind v4 build-time integration (single source of truth for class
// styles): generate the project's Tailwind CSS via its own tailwindcss
// dependency, then feed it through the CSS->style compiler.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const SOURCE_EXTENSIONS = new Set([".vue", ".tsx", ".ts", ".jsx", ".js", ".html"]);
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "pkg", ".naive", ".git", ".worktrees"]);

/** Extract Tailwind candidate class names from source text. */
export function extractClassCandidates(text: string): string[] {
  const out = new Set<string>();
  const attrRe = /(?:class|className)\s*=\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(text)) !== null) {
    for (const token of match[1].split(/\s+/)) {
      const trimmed = token.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return [...out];
}

/** Collect all Tailwind candidate class names used by the project sources. */
export function collectClassCandidates(projectRoot: string): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) walk(full);
      } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
        try {
          for (const token of extractClassCandidates(readFileSync(full, "utf8"))) {
            out.add(token);
          }
        } catch {
          /* unreadable source files are skipped */
        }
      }
    }
  };
  walk(projectRoot);
  return [...out];
}

/**
 * Compile the project CSS through Tailwind v4 and return the generated CSS.
 *
 * Returns null when the project has no usable tailwindcss dependency or the
 * compile fails; callers then fall back to the plain CSS path.
 */
export async function compileTailwindCSS(
  projectRoot: string,
  css: string,
): Promise<string | null> {
  try {
    const req = createRequire(join(projectRoot, "noop.js"));
    const pkgPath = req.resolve("tailwindcss/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      exports?: { "."?: { style?: string } };
    };
    const styleEntry = pkg.exports?.["."]?.style ?? "./index.css";
    const cssPath = join(dirname(pkgPath), styleEntry);

    const tw = req("tailwindcss") as {
      compile: (
        input: string,
        opts: object,
      ) => Promise<{ build(candidates: string[]): string }>;
    };

    const result = await tw.compile(css, {
      base: projectRoot,
      loadStylesheet: async (
        id: string,
        baseDir: string,
      ): Promise<{ path: string; base: string; content: string }> => {
        if (id === "tailwindcss") {
          return { path: cssPath, base: baseDir, content: readFileSync(cssPath, "utf8") };
        }
        const r = createRequire(join(baseDir, "noop.js"));
        const resolved = r.resolve(id);
        return { path: resolved, base: baseDir, content: readFileSync(resolved, "utf8") };
      },
    });

    const candidates = collectClassCandidates(projectRoot);
    return result.build(candidates);
  } catch {
    return null;
  }
}
