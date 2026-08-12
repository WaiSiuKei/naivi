// Vue-reactive E2E entry for the naive-host page (plan 037, U3).
//
// Binds the page's wasm exports, installs the DOM facade, and mounts a Vue
// component through a naive renderer (createRenderer) whose reactive
// text/style/structure updates flow through the batched bridge into the
// already-running WebRunner scene.

import { h, ref } from "vue";
import { bindWasm } from "./native-tree.js";
import { initNaiveDocument, getNaiveDocument } from "./naive-dom.js";
import { createNaiveRenderer } from "./naive-renderer.js";
import { flush as flushBatch } from "./batched-bridge.js";

export async function startVueE2E(): Promise<void> {
  const wasm = (globalThis as { __naiveWasm?: unknown }).__naiveWasm;
  if (!wasm) throw new Error("vue-e2e: __naiveWasm not ready");
  bindWasm(wasm as never);
  initNaiveDocument();

  const doc = getNaiveDocument();
  if (!doc) throw new Error("vue-e2e: naive document not installed");
  const renderer = createNaiveRenderer(doc);

  const count = ref(0);
  const show = ref(true);
  const items = ref(["a", "b"]);

  const App = {
    setup() {
      return () =>
        h("div", [
          h("p", "count:" + count.value),
          show.value ? h("p", "visible") : null,
          show.value
            ? h("div", {
                style: "width:60px;height:60px;background-color:#ff0000",
              })
            : null,
          h("ul", items.value.map((item) => h("li", item))),
        ]);
    },
  };

  const root = doc.createElement("div") as never;
  (root as { setAttribute(name: string, value: string): void }).setAttribute(
    "style",
    "width:100%;height:100%;cursor:pointer",
  );
  (doc.body as unknown as { appendChild(child: unknown): void }).appendChild(root);
  // Resolve install-time nodes before Vue mounts so the mount batch can
  // address existing parents by id (alias/appendId) instead of stale refs.
  flushBatch();
  renderer.createApp(App).mount(root);
  (root as { addEventListener(type: string, handler: () => void): void }).addEventListener(
    "click",
    () => {
      (globalThis as Record<string, unknown>).__vueRootClicked = true;
    },
  );
  (globalThis as Record<string, unknown>).__vueRootId = (root as { _mirror: { wasmId: bigint } })
    ._mirror.wasmId;

  (globalThis as Record<string, unknown>).__vueProbe = {
    get count() {
      return count.value;
    },
    increment() {
      count.value += 1;
    },
    toggle() {
      show.value = !show.value;
    },
    addItem() {
      items.value.push("c");
    },
  };
}
