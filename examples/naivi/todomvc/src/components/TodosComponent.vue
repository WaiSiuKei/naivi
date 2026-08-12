<script setup>
// The stateful container — equivalent to blitz's examples/todomvc (Dioxus)
// and the official TodoMVC Vue example: owns the todos list (starts empty),
// filtering, toggle-all, and the add/delete/toggle/edit handlers; renders
// TodoHeader / TodoItem / TodoFooter inside `section.todoapp`.
//
// Engine-channel adaptations (wasm/native have pointer events only):
// - No vue-router: `filter` is a local ref.
// - `addTodo` receives the raw input text; on engine channels an empty text
//   still adds a generated "Task N" (the Add button has no keyboard input to
//   type into — examples/todomvc's Enter-to-add needs a keyboard).
// - Toggle / toggle-all are driven by :checked + @click (no `change` event).
import { computed, ref } from 'vue';
import TodoFooter from './TodoFooter.vue';
import TodoHeader from './TodoHeader.vue';
import TodoItem from './TodoItem.vue';

const isEngineChannel =
  (globalThis).__NAIVE_MODE === 'wasm' || typeof window === 'undefined';

// Starts empty, like examples/todomvc (`HashMap::new()`).
const todos = ref([]);
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
  if (title === null) return; // web: empty input = no-op
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
  <section class="todoapp">
    <TodoHeader @add-todo="addTodo" />

    <section class="main" v-if="todos.length > 0">
      <input type="checkbox" id="toggle-all" class="toggle-all"
             :checked="toggleAllChecked" />
      <label for="toggle-all" @click="toggleAll">❯</label>
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
    </section>

    <TodoFooter
      :todos="todos"
      :filter="filter"
      @filter-change="setFilter"
      @delete-completed="deleteCompleted"
    />
  </section>
</template>
