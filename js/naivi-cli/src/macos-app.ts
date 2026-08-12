// macOS `.app` bundle assembly for `naive desktop --release` (plan 044, U2;
// plan 045, U3).
//
// The assembler is a pure, unit-testable function: it takes the monorepo root
// (source of the release binary and default icon), the project dir (source of
// the compiled styles, main/page bundles, and index.html; destination of
// `release/`), and the package name, and produces a standard bundle layout:
//
//   release/<AppName>.app/
//     Contents/
//       Info.plist
//       MacOS/<AppName>          (release binary, renamed to match CFBundleExecutable)
//       Resources/
//         main-bundle.js         (desktop main-process entry, plan 045)
//         page-bundle.js         (page Vue entry, plan 045)
//         styles.json
//         index.html             (page HTML for loadFile, KTD12)
//         <AppName>.icns         (non-fatal: omitted on missing icon / tool failure)

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** iconset sizes iconutil accepts (name, width, height). */
const ICON_SIZES: ReadonlyArray<readonly [string, number, number]> = [
  ['icon_16x16.png', 16, 16],
  ['icon_16x16@2x.png', 32, 32],
  ['icon_32x32.png', 32, 32],
  ['icon_32x32@2x.png', 64, 64],
  ['icon_128x128.png', 128, 128],
  ['icon_128x128@2x.png', 256, 256],
  ['icon_256x256.png', 256, 256],
  ['icon_256x256@2x.png', 512, 512],
  ['icon_512x512.png', 512, 512],
  ['icon_512x512@2x.png', 1024, 1024],
];

export interface AssembleAppOptions {
  /** naive monorepo root: source of `target/release/naive-guest-quickjs` and `assets/icon.png`. */
  root: string;
  /** project dir: source of `node_modules/.naive` outputs; `release/` is created here. */
  cwd: string;
  /** package.json `name` — the `.app` directory and `Contents/MacOS` binary name, as-is. */
  appName: string;
  /** display name (`CFBundleName`). Defaults to `appName` (plan 046, KTD6). */
  displayName?: string;
  /** version for Info.plist (default "0.1.0"). */
  version?: string;
}

export interface AssembleAppResult {
  /** Absolute path to `<cwd>/release/<appName>.app`. */
  appDir: string;
  /** Display name (CFBundleName). */
  displayName: string;
}

/** Generate `<AppName>.icns` from the naive default icon. Non-fatal (KTD10). */
function maybeWriteIcon(iconSrc: string, resourcesDir: string, appName: string): string | null {
  if (!existsSync(iconSrc)) {
    console.warn('[naive] assets/icon.png not found — packaging without an app icon');
    return null;
  }
  const iconset = join(resourcesDir, `${appName}.iconset`);
  try {
    mkdirSync(iconset, { recursive: true });
    for (const [name, width, height] of ICON_SIZES) {
      execFileSync('sips', ['-z', String(height), String(width), iconSrc, '--out', join(iconset, name)], {
        stdio: 'pipe',
      });
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(resourcesDir, `${appName}.icns`)], {
      stdio: 'pipe',
    });
    return `${appName}.icns`;
  } catch (error) {
    console.warn(
      `[naive] icon generation failed — packaging without an app icon (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  } finally {
    rmSync(iconset, { recursive: true, force: true });
  }
}

function buildInfoPlist(display: string, executable: string, iconFile: string | null, version: string): string {
  const iconEntry = iconFile ? `  <key>CFBundleIconFile</key>\n  <string>${iconFile}</string>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${display}</string>
  <key>CFBundleDisplayName</key>
  <string>${display}</string>
  <key>CFBundleIdentifier</key>
  <string>com.naive.${executable}</string>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
${iconEntry}  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
`;
}

/** Assemble `release/<AppName>.app` from the release binary, bundle, styles, and icon. */
export function assembleApp(options: AssembleAppOptions): AssembleAppResult {
  const { root, cwd, appName, version = '0.1.0' } = options;
  const displayName = options.displayName ?? appName;

  const appDir = join(cwd, 'release', `${appName}.app`);
  const contents = join(appDir, 'Contents');
  const macosDir = join(contents, 'MacOS');
  const resourcesDir = join(contents, 'Resources');

  // Required inputs fail with a descriptive error instead of a raw ENOENT
  // (plan 044, U2; plan 045, U3). The icon is the only non-fatal input (KTD10).
  const required: ReadonlyArray<readonly [string, string]> = [
    ['release binary', join(root, 'target', 'release', 'naive-guest-quickjs')],
    ['main-bundle.js', join(cwd, 'node_modules', '.naive', 'main-bundle.js')],
    ['page-bundle.js', join(cwd, 'node_modules', '.naive', 'page-bundle.js')],
    ['styles.json', join(cwd, 'node_modules', '.naive', 'styles.json')],
    ['index.html', join(cwd, 'index.html')],
  ];
  for (const [label, path] of required) {
    if (!existsSync(path)) {
      throw new Error(
        `naive desktop --release: ${label} not found at ${path} — run cargo build --release -p naive-guest-quickjs first`,
      );
    }
  }

  // Replace a stale bundle.
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  cpSync(required[0][1], join(macosDir, appName));
  cpSync(required[1][1], join(resourcesDir, 'main-bundle.js'));
  cpSync(required[2][1], join(resourcesDir, 'page-bundle.js'));
  cpSync(required[3][1], join(resourcesDir, 'styles.json'));
  cpSync(required[4][1], join(resourcesDir, 'index.html'));

  const iconFile = maybeWriteIcon(join(root, 'assets', 'icon.png'), resourcesDir, appName);

  writeFileSync(join(contents, 'Info.plist'), buildInfoPlist(displayName, appName, iconFile, version));

  return { appDir, displayName };
}
