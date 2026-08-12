<script setup>
// Official TodoItem toggles via @change on the checkbox; the engine has no
// change event, so the toggle is wired to @click (checked state is driven by
// :checked reactively). Editing needs a keyboard to commit, so it is kept for
// web only (startEdit is a no-op on engine channels). The destroy button
// carries the × glyph as text (generated ::after content is not rendered).
import { ref, nextTick } from 'vue';

const props = defineProps(['todo']);
const emit = defineEmits(['delete-todo', 'edit-todo', 'toggle-todo']);

const isEngineChannel =
  (globalThis).__NAIVE_MODE === 'wasm' || typeof window === 'undefined';

const editing = ref(false);
const editInput = ref(null);
const draft = ref('');

function onToggle() {
  emit('toggle-todo', props.todo, !props.todo.completed);
}
function startEdit() {
  if (isEngineChannel) return; // no keyboard to commit on wasm/native
  draft.value = props.todo.title;
  editing.value = true;
  nextTick(() => editInput.value?.focus());
}
function commitEdit() {
  if (!editing.value) return;
  editing.value = false;
  const text = draft.value.trim();
  if (text.length === 0) emit('delete-todo', props.todo);
  else emit('edit-todo', props.todo, text);
}
function cancelEdit() {
  editing.value = false;
  draft.value = props.todo.title;
}
function deleteTodo() {
  emit('delete-todo', props.todo);
}
</script>

<template>
  <li :class="{ completed: todo.completed, editing }">
    <div class="view">
      <input type="checkbox" class="toggle" :checked="todo.completed" @click="onToggle" />
      <label @dblclick="startEdit">{{ todo.title }}</label>
      <button class="destroy" @click.prevent="deleteTodo">×</button>
    </div>
    <input
      v-if="editing"
      ref="editInput"
      type="text"
      class="edit"
      aria-label="Edit todo"
      v-model="draft"
      @keyup.enter="commitEdit"
      @keyup.escape="cancelEdit"
      @blur="commitEdit"
    />
  </li>
</template>
