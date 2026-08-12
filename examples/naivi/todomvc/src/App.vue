<script setup lang="ts">
import TodosView from './views/TodosView.vue';
</script>

<template>
  <div class="flex h-full w-full flex-col items-center bg-[#f5f5f5] text-[#111] text-[14px] leading-[1.4em] font-light">
    <div class="relative my-[130px_40px] flex w-[550px] flex-col bg-white shadow-[0_2px_4px_0_rgba(0,0,0,0.2),0_25px_50px_0_rgba(0,0,0,0.1)]">
      <TodosView />
    </div>
    <footer class="mt-[65px] text-center text-[11px] text-[#4d4d4d]">
      <p class="leading-none">Double-click to edit a todo</p>
      <p class="leading-none">Created by the TodoMVC Team</p>
    </footer>
  </div>
</template>

