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
      <li><a :data-selected="filter === 'all' ? 'true' : 'false'" class="m-[3px] rounded-[3px] border border-transparent px-[7px] py-[3px] text-inherit no-underline hover:border-[#DB7676] data-[selected=true]:border-[#CE4646]" href="#" @click.prevent="setFilter('all')">All</a></li>
      <li><a :data-selected="filter === 'active' ? 'true' : 'false'" class="m-[3px] rounded-[3px] border border-transparent px-[7px] py-[3px] text-inherit no-underline hover:border-[#DB7676] data-[selected=true]:border-[#CE4646]" href="#" @click.prevent="setFilter('active')">Active</a></li>
      <li><a :data-selected="filter === 'completed' ? 'true' : 'false'" class="m-[3px] rounded-[3px] border border-transparent px-[7px] py-[3px] text-inherit no-underline hover:border-[#DB7676] data-[selected=true]:border-[#CE4646]" href="#" @click.prevent="setFilter('completed')">Completed</a></li>
    </ul>
    <button
      class="shrink-0 cursor-pointer leading-[19px] no-underline hover:underline"
      v-show="todos.some(t => t.completed)"
      @click="$emit('delete-completed')"
    >Clear completed</button>
  </footer>
</template>
