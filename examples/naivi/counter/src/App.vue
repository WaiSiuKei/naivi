<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);

// Inline styles keep U4 rendering correct (set_style → blitz stylo). The
// author-stylesheet path (class → stylo) is the U6 styles work; the `class`
// attribute is still written via set_attr so U6 can pick it up.
const rootStyle: Record<string, string> = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1rem',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: '1.25rem',
  color: '#0f172a',
};
const buttonStyle: Record<string, string> = {
  padding: '0.5rem 1.5rem',
  border: 'none',
  borderRadius: '8px',
  fontSize: '1rem',
  cursor: 'pointer',
  // background / color live in the author stylesheet below (U6), so the
  // `button:hover` rule can be verified through a pure author cascade
  // (inline `:style` would otherwise override the author rule).
};
</script>

<template>
  <div class="counter" :style="rootStyle">
    <p>Count: {{ count }}</p>
    <button :style="buttonStyle" @click="count++">Click Me</button>
  </div>
</template>

<style>
/* Author styles — compiled by the U6 styles path (AOT CSS → stylo author
   stylesheet via add_stylesheet). Class / tag / :hover selectors are matched
   natively by blitz's style engine; inline `:style` bindings win the cascade.
   The background / radius / shadow / :hover color make U6 visually verifiable. */
.counter {
  font-family: system-ui, -apple-system, sans-serif;
  background: #f8fafc;
  border-radius: 16px;
  box-shadow: 0 4px 24px rgba(15, 23, 42, 0.06);
}
button {
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}
button:hover {
  background: #1d4ed8;
}
</style>
