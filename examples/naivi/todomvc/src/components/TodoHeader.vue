<script setup lang="ts">
const emit = defineEmits<{
  (e: 'add-todo', value: string): void;
}>();

function onEnter(event: KeyboardEvent) {
  const target = event.target as HTMLInputElement;
  const text = target.value.trim();
  if (text.length === 0) return;
  emit('add-todo', text);
  target.value = '';
}
</script>

<template>
  <header>
    <h1 class="absolute -top-[120px] w-full text-center text-[80px] font-[200] leading-none text-[#b83f45]">todos</h1>
    <input
      class="relative h-[65px] w-full border-none bg-[rgba(0,0,0,0.003)] py-4 pl-[60px] pr-4 text-[24px] leading-[1.4em] text-inherit shadow-[inset_0_-2px_1px_rgba(0,0,0,0.03)] placeholder:italic placeholder:font-[400] placeholder:text-[rgba(0,0,0,0.4)]"
      autofocus
      autocomplete="off"
      placeholder="What needs to be done?"
      @keyup.enter="onEnter"
    />
  </header>
</template>
