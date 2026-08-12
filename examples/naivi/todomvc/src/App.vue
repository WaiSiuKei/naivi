<script setup lang="ts">
// naivi TodoMVC — root shell + author CSS (U6). The component tree follows
// the official TodoMVC Vue example
// (github.com/tastejs/todomvc/tree/gh-pages/examples/vue): TodosComponent
// renders `.todoapp > header/main/footer` via TodoHeader / TodoItem /
// TodoFooter. Engine-channel adaptations are documented in each component.
import TodosComponent from './components/TodosComponent.vue';

// Inline styles: only the viewport-filling shell — the rest lives in the
// author stylesheet below (U6 AOT CSS → stylo).
const shellStyle: Record<string, string> = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 0',
};
</script>

<template>
  <div class="todomvc" :style="shellStyle">
    <TodosComponent />
  </div>
</template>

<style>
/* Author styles — U6 AOT CSS → stylo author stylesheet (add_stylesheet).
   Faithful to the official todomvc-app-css look with engine-supported
   properties (class / tag / compound / :hover / :checked selectors). */
.todomvc {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  background: #f5f5f5;
  color: #4d4d4d;
  box-sizing: border-box;
}
/* The official `.todoapp h1` (inside .header) — big, thin, light-red. */
.header h1 {
  margin: 1.5rem 0 0.5rem;
  font-size: 5rem;
  font-weight: 100;
  line-height: 1;
  color: rgba(175, 47, 47, 0.15);
  text-align: center;
}
.todoapp {
  width: 92%;
  max-width: 550px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), 0 25px 50px rgba(0, 0, 0, 0.1);
}
.new-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-right: 1rem;
}
.new-todo {
  flex: 1;
  min-width: 0;
  padding: 16px 16px 16px 24px;
  border: none;
  background: rgba(0, 0, 0, 0.003);
  box-shadow: inset 0 -2px 1px rgba(0, 0, 0, 0.03);
  font-family: inherit;
  font-size: 1.4rem;
  line-height: 1.4;
  color: inherit;
}
.add-btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  background: #b83f45;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}
.main {
  border-top: 1px solid #e6e6e6;
}
.toggle-all-container {
  display: flex;
  align-items: center;
  padding-left: 8px;
}
.toggle-all {
  width: 1px;
  height: 1px;
  opacity: 0;
}
.toggle-all-label {
  width: 60px;
  height: 34px;
  font-size: 22px;
  line-height: 34px;
  color: #e6e6e6;
  cursor: pointer;
}
.toggle-all-label:hover {
  color: #737373;
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.todo-list li {
  display: flex;
  align-items: center;
  font-size: 1.4rem;
  border-bottom: 1px solid #ededed;
}
.todo-list li:last-child {
  border-bottom: none;
}
.view {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}
.toggle {
  width: 34px;
  height: 34px;
  margin: 0 12px;
  border: 1px solid #d9d9d9;
  border-radius: 50%;
  background: #fff;
  cursor: pointer;
}
.todo-list li.completed .toggle {
  border-color: #5dc2af;
}
.todo-list li label {
  flex: 1;
  min-width: 0;
  padding: 15px 15px 15px 0;
  color: #4d4d4d;
  word-break: break-all;
}
.todo-list li.completed label {
  color: #d9d9d9;
  text-decoration: line-through;
}
.destroy {
  width: 40px;
  height: 40px;
  margin-right: 10px;
  border: none;
  background: transparent;
  color: #cc9a9a;
  font-size: 30px;
  line-height: 1;
  opacity: 0;
  cursor: pointer;
}
.todo-list li:hover .destroy {
  opacity: 1;
}
.destroy:hover {
  color: #af5b5e;
}
.edit {
  flex: 1;
  margin: 0 0 0 8px;
  padding: 15px 15px 15px 24px;
  font-family: inherit;
  font-size: 1.4rem;
  color: inherit;
  border: 1px solid #999;
  border-radius: 4px;
  box-shadow: inset 0 -1px 5px rgba(0, 0, 0, 0.2);
}
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 10px 15px;
  font-size: 0.875rem;
  color: #777;
  border-top: 1px solid #e6e6e6;
}
.todo-count strong {
  font-weight: 300;
}
.filters {
  list-style: none;
  display: flex;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
}
.filter-link {
  margin: 3px;
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}
.filter-link:hover {
  border-color: rgba(175, 47, 47, 0.1);
}
.filter-link.selected {
  border-color: rgba(175, 47, 47, 0.2);
}
.clear-completed {
  border: none;
  background: none;
  color: #777;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}
.clear-completed:hover {
  color: #af5b5e;
}
button {
  font-family: inherit;
}
</style>
