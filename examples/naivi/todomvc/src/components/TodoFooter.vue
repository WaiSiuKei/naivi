<script setup lang="ts">
import { computed } from 'vue';
import type { Todo } from './TodoItem.vue';

const props = defineProps<{
  todos: Todo[];
  filter: 'all' | 'active' | 'completed';
}>();
const emit = defineEmits<{
  (e: 'delete-completed'): void;
  (e: 'update:filter', value: 'all' | 'active' | 'completed'): void;
}>();

const remaining = computed(() => props.todos.filter(t => !t.completed).length);

function setFilter(f: 'all' | 'active' | 'completed') {
  emit('update:filter', f);
}
</script>

<template>
  <footer class="relative flex h-[40px] items-center justify-between border-t border-[#e6e6e6] px-[15px] py-[10px] text-center text-[15px]" v-show="todos.length > 0">
    <span class="shrink-0 text-left">
      <strong class="font-light">{{ remaining }}</strong> {{ remaining === 1 ? 'item' : 'items' }} left
    </span>
    <ul class="m-0 flex list-none gap-0 p-0">
      <!-- Box styling (border/margin/padding) lives on the <li> (block-level flex
           item) because blitz treats plain inline <a> as text-only style spans:
           border/margin/padding on inline elements are not laid out or rendered.
           The <a> keeps only text styling (color, underline). -->
      <li :data-selected="filter === 'all' ? 'true' : 'false'" class="m-[3px] list-none rounded-[3px] border border-transparent hover:border-[#DB7676] data-[selected=true]:border-[#CE4646]"><a class="block px-[7px] py-[3px] text-inherit no-underline" href="#" @click.prevent="setFilter('all')">All</a></li>
      <li :data-selected="filter === 'active' ? 'true' : 'false'" class="m-[3px] list-none rounded-[3px] border border-transparent hover:border-[#DB7676] data-[selected=true]:border-[#CE4646]"><a class="block px-[7px] py-[3px] text-inherit no-underline" href="#" @click.prevent="setFilter('active')">Active</a></li>
      <li :data-selected="filter === 'completed' ? 'true' : 'false'" class="m-[3px] list-none rounded-[3px] border border-transparent hover:border-[#DB7676] data-[selected=true]:border-[#CE4646]"><a class="block px-[7px] py-[3px] text-inherit no-underline" href="#" @click.prevent="setFilter('completed')">Completed</a></li>
    </ul>
    <button
      class="shrink-0 cursor-pointer leading-[19px] no-underline hover:underline"
      v-show="todos.some(t => t.completed)"
      @click="$emit('delete-completed')"
    >Clear completed</button>
  </footer>
</template>
