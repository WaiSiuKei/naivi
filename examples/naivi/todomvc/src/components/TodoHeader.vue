<script setup>
// Official TodoHeader adds via @keyup.enter reading event.target.value. The
// blitz engine channels (wasm/native) have no keyboard events, so the input
// is also v-model bound and an "Add" button emits add-todo — TodosComponent
// generates a title when the text is empty on engine channels.
import { ref } from 'vue';

const emit = defineEmits(['add-todo']);
const newTodo = ref('');

function onAdd() {
  const text = newTodo.value.trim();
  emit('add-todo', text); // empty allowed — TodosComponent decides (engine Add)
  newTodo.value = '';
}
</script>

<template>
  <header class="header">
    <h1>todos</h1>
    <div class="new-row">
      <input
        type="text"
        class="new-todo"
        v-model="newTodo"
        autocomplete="off"
        placeholder="What needs to be done?"
        @keyup.enter="onAdd"
      />
      <button class="add-btn" @click="onAdd">Add</button>
    </div>
  </header>
</template>
