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
  background: '#2563eb',
  color: '#fff',
  fontSize: '1rem',
  cursor: 'pointer',
};
</script>

<template>
  <div class="counter" :style="rootStyle">
    <p>Count: {{ count }}</p>
    <button :style="buttonStyle" @click="count++">Click Me</button>
  </div>
</template>

<style>
/* Author styles — compiled by the U6 styles path (AOT CSS). Not applied in
   U4 (the runtime tolerates the absent styles path); kept for parity with
   the hello demo. */
.counter {
  font-family: system-ui, -apple-system, sans-serif;
}
button {
  cursor: pointer;
}
</style>
