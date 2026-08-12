<template>
  <div class="flex flex-col items-center justify-center gap-4 p-8">
    <span class="text-white text-2xl font-bold">Count: {{ count }}</span>
    <button class="bg-blue-500 text-white rounded-lg px-4 py-2" @click="increment">
      +1
    </button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const count = ref(0)

function increment() {
  count.value++
}
</script>
