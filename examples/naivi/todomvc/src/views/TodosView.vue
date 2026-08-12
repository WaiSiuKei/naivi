<script setup lang="ts">
import { ref, computed } from 'vue';
import TodoHeader from '../components/TodoHeader.vue';
import TodoFooter from '../components/TodoFooter.vue';
import TodoItem from '../components/TodoItem.vue';
import type { Todo } from '../components/TodoItem.vue';

const todos = ref<Todo[]>([]);
const filter = ref<'all' | 'active' | 'completed'>('all');

function uuid(): string {
  let uuid = '';
  for (let i = 0; i < 32; i++) {
    const random = (Math.random() * 16) | 0;
    if (i === 8 || i === 12 || i === 16 || i === 20) uuid += '-';
    uuid += (i === 12 ? '4' : i === 16 ? ((random & 3) | 8).toString(16) : random.toString(16));
  }
  return uuid;
}

const activeTodos = computed(() => todos.value.filter(t => !t.completed));
const completedTodos = computed(() => todos.value.filter(t => t.completed));
const filteredTodos = computed(() => {
  switch (filter.value) {
    case 'active': return activeTodos.value;
    case 'completed': return completedTodos.value;
    default: return todos.value;
  }
});

const toggleAllModel = computed({
  get() {
    return activeTodos.value.length === 0 && todos.value.length > 0;
  },
  set(value: boolean) {
    todos.value.forEach(t => (t.completed = value));
  },
});

function addTodo(value: string) {
  todos.value.push({ completed: false, title: value, id: uuid() });
}

function deleteTodo(todo: Todo) {
  todos.value = todos.value.filter(t => t !== todo);
}

function toggleTodo(todo: Todo, value: boolean) {
  todo.completed = value;
}

function editTodo(todo: Todo, value: string) {
  todo.title = value;
}

function deleteCompleted() {
  todos.value = todos.value.filter(t => !t.completed);
}
</script>

<template>
  <TodoHeader @add-todo="addTodo" />
  <main class="relative z-[2] flex flex-col border-t border-[#e6e6e6]" v-show="todos.length > 0">
    <div class="toggle-all-container">
      <input type="checkbox" id="toggle-all-input" class="absolute bottom-full right-full h-px w-px border-none opacity-0" v-model="toggleAllModel" />
      <label
        class="absolute -top-[65px] left-0 flex h-[65px] w-[45px] items-center justify-center text-[0px] before:inline-block before:px-[27px] before:py-[10px] before:text-[22px] before:text-[#949494] before:rotate-90 before:content-['❯'] data-[checked=true]:before:text-[#484848]"
        :data-checked="toggleAllModel ? 'true' : 'false'"
        for="toggle-all-input"
      >Toggle All Input</label>
    </div>
    <ul class="m-0 flex list-none flex-col p-0">
      <TodoItem
        v-for="todo in filteredTodos"
        :key="todo.id"
        :todo="todo"
        @delete-todo="deleteTodo"
        @edit-todo="editTodo"
        @toggle-todo="toggleTodo"
      />
    </ul>
  </main>
  <TodoFooter :todos="todos" :filter="filter" @update:filter="filter = $event" @delete-completed="deleteCompleted" />
</template>
