<script setup>
// The stateful container, following the official TodosComponent: owns the
// todos list, filtering, toggle-all, and the add/delete/toggle/edit handlers;
// renders TodoHeader / TodoItem / TodoFooter inside the `.todoapp` box.
//
// Deviations from the official component (documented):
// - No vue-router: `filter` is a local ref (the official reads route.name).
// - Pre-populated seed todos (the official starts empty) so the engine
//   channels have items to toggle/delete/filter.
// - `addTodo` receives the raw input text; on engine channels an empty text
//   still adds a generated "Task N" (the Add button has no keyboard input to
//   type into).
// - Toggle-all is driven by :checked + @click (the official uses v-model).
import { computed, ref } from 'vue';
import TodoFooter from './TodoFooter.vue';
import TodoHeader from './TodoHeader.vue';
import TodoItem from './TodoItem.vue';

const isEngineChannel =
  (globalThis).__NAIVE_MODE === 'wasm' || typeof window === 'undefined';

const todos = ref([
  { id: '1', title: 'Taste JavaScript', completed: true },
  { id: '2', title: 'Buy a unicorn', completed: false },
  { id: '3', title: 'Rule the web', completed: false },
]);
const filter = ref('all');

const filters = {
  all: (list) => list,
  active: (list) => list.filter((todo) => !todo.completed),
  completed: (list) => list.filter((todo) => todo.completed),
};
const filteredTodos = computed(() => filters[filter.value](todos.value));
const activeTodos = computed(() => todos.value.filter((todo) => !todo.completed));
const toggleAllChecked = computed(() => activeTodos.value.length === 0);

function uuid() {
  let id = '';
  for (let i = 0; i < 32; i++) {
    const random = (Math.random() * 16) | 0;
    if (i === 8 || i === 12 || i === 16 || i === 20) id += '-';
    id += (i === 12 ? 4 : i === 16 ? (random & 3) | 8 : random).toString(16);
  }
  return id;
}

function addTodo(value) {
  const title =
    value.length > 0
      ? value
      : isEngineChannel
        ? `Task ${todos.value.length + 1}` // engine Add with empty input
        : null;
  if (title === null) return; // web: empty input = no-op (official behavior)
  todos.value.push({ id: uuid(), title, completed: false });
}
function deleteTodo(todo) {
  todos.value = todos.value.filter((t) => t !== todo);
}
function toggleTodo(todo) {
  todo.completed = !todo.completed;
}
function editTodo(todo, value) {
  todo.title = value;
}
function toggleAll() {
  const value = !toggleAllChecked.value;
  todos.value.forEach((todo) => {
    todo.completed = value;
  });
}
function deleteCompleted() {
  todos.value = todos.value.filter((todo) => !todo.completed);
}
function setFilter(value) {
  filter.value = value;
}
</script>

<template>
  <div class="todoapp">
    <TodoHeader @add-todo="addTodo" />

    <main class="main" v-show="todos.length > 0">
      <div class="toggle-all-container">
        <input type="checkbox" id="toggle-all-input" class="toggle-all"
               :checked="toggleAllChecked" />
        <label class="toggle-all-label" @click="toggleAll">❯</label>
      </div>
      <ul class="todo-list">
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

    <TodoFooter
      :todos="todos"
      :filter="filter"
      @filter-change="setFilter"
      @delete-completed="deleteCompleted"
    />
  </div>
</template>
