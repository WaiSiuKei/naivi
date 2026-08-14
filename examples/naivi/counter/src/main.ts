// naivi counter demo entry (U4) — mounts the counter SFC through the
// dual-mode `@naivi/runtime/vue-vapor` runtime. `nv web` runs the pure
// Vite passthrough (web fallback, plain `createApp(App).mount('#app')`).
// `nv wasm --release` builds this module into the guest bundle served by
// trunk from the shared host `packages/naivi-wasm`; the cli-emitted `guest.js`
// wrapper sets `__NAIVE_MODE = "wasm"` before this module runs, so the runtime
// takes its wasm branch (bind U4 exports → mirror tree → blitz).
import { mount } from '@naivi/runtime/vue-vapor';
import App from './App.vue';

mount(App);
