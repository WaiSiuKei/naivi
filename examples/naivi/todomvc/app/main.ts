// nv desktop main entry — mirrors naive's todomvc demo (`app/main.ts`).
// The CLI bundles this as `main-bundle.js` with `@naivi/runtime` aliased to
// the desktop-main API, so `app.whenReady()` + `NaiveWindow` drive window
// creation and page loading (`loadFile('index.html')` evals the page bundle).
// Not part of the demo's `tsconfig` `include` (web/wasm don't need it).
import { app, NaiveWindow } from '@naivi/runtime';

function createWindow() {
  const win = new NaiveWindow({ page: 'index.html' });
  win.load();
}

app.whenReady().then(createWindow);
