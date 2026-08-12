<script setup>
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <div class="counter">
    <p>Count: {{ count }}</p>
    <button @click="count++">Click Me</button>
  </div>
</template>

<style>
.counter {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 1.25rem;
  color: #0f172a;
}
button {
  padding: 0.5rem 1.5rem;
  border: none;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}
button:hover {
  background: #1d4ed8;
}
</style>
