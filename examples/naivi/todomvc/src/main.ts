// naivi todomvc demo entry — mounts the todomvc SFC through the dual-mode
// `@naivi/runtime/vue-vapor` runtime. `naivi web` runs the pure Vite
// passthrough (web fallback). `naivi wasm --release` builds this module into
// the guest bundle served by trunk in `examples/naivi/todomvc-wasm`; `naivi
// desktop` bundles it for the native rquickjs guest.
import { mount } from '@naivi/runtime/vue-vapor';
import App from './App.vue';

mount(App);
