// naivi counter demo entry (U4) — mounts the counter SFC through the
// dual-mode `@naivi/runtime/vue-vapor` runtime. `naivi web` runs the pure
// Vite passthrough (web fallback, plain `createApp(App).mount('#app')`).
// `naivi wasm --release` builds this module into the guest bundle served by
// trunk in `examples/naivi/counter-wasm`; the cli-emitted `guest.js` wrapper
// sets `__NAIVE_MODE = "wasm"` before this module runs, so the runtime takes
// its wasm branch (bind U4 exports → mirror tree → blitz).
import { mount } from '@naivi/runtime/vue-vapor';
import App from './App.vue';

mount(App);
