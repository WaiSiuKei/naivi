// naivi hello demo entry (U2) — mounts the counter SFC through the dual-mode
// `@naivi/runtime/vue-vapor` runtime. `nv web` runs the pure Vite
// passthrough (no __NAIVE_MODE injection), so the runtime takes its web
// fallback branch: plain `createApp(App).mount('#app')`.
import { mount } from '@naivi/runtime/vue-vapor';
import App from './App.vue';

mount(App);
