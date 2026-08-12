// DevServer — Vite dev server for the `naive wasm` pipeline.
//
// Vue mounts through a naive createRenderer (packages/runtime) that renders
// into the WASM-backed DOM facade directly — no global `document` patching or
// source-level `document` replacement is needed. The only HTML-time injection
// is the WASM-mode flag.

import { createServer, type ViteDevServer } from 'vite';
import { loadPageViteConfig, pageSizeOf, resolveNaiveViteConfig } from './vite-config.ts';

export type ChangeCallback = (filePath: string) => void;

export class DevServer {
  private port: number;
  private root: string;
  private devtools: boolean;
  private vite: ViteDevServer | null = null;
  private onChange: ChangeCallback | null = null;

  constructor(port: number, root: string, devtools = false) {
    this.port = port;
    this.root = root;
    this.devtools = devtools;
  }

  onFileChange(cb: ChangeCallback) { this.onChange = cb; }

  log(msg: string) {
    console.log(`\x1b[2m[${new Date().toLocaleTimeString()}]\x1b[0m ${msg}`);
  }

  async start() {
    const onChange = this.onChange;
    const page = await loadPageViteConfig(this.root, 'naive wasm');
    const config = await resolveNaiveViteConfig({
      cwd: this.root,
      pageViteConfig: page.vite,
      pageSize: pageSizeOf(page),
      devtools: this.devtools,
      onStylesChange: (filePath) => {
        if (onChange) onChange(filePath);
      },
    });

    this.vite = await createServer({
      ...config,
      // The user config is already loaded and merged by resolveNaiveViteConfig.
      configFile: false,
      server: {
        // Preserve the merged `server` options (incl. the CLI-managed
        // `fs.allow` for the js/ toolchain sources); only port + watch are
        // forced by the CLI.
        ...(config.server ?? {}),
        port: this.port,
        watch: { ignored: ['**/pkg/**', '**/node_modules/**'] },
      },
    });

    await this.vite.listen();
    const addr = this.vite.config.server.port ?? this.port;
    this.log(`Dev server running at http://localhost:${addr}`);
  }

  broadcast(msg: string) {
    if (this.vite) this.vite.ws.send(msg);
  }
}
