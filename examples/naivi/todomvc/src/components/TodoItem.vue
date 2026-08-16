<script setup lang="ts">
import { ref, nextTick } from 'vue';

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

const props = defineProps<{ todo: Todo }>();
const emit = defineEmits<{
  (e: 'delete-todo', todo: Todo): void;
  (e: 'edit-todo', todo: Todo, value: string): void;
  (e: 'toggle-todo', todo: Todo, value: boolean): void;
}>();

const editing = ref(false);
const editInput = ref<HTMLInputElement | null>(null);
const draft = ref('');

function onToggle(event: Event) {
  const target = event.target as HTMLInputElement;
  emit('toggle-todo', props.todo, target.checked);
}

function startEdit() {
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
  <li class="group relative border-b border-[#ededed] text-[24px] last:border-b-0 data-[editing=true]:border-b-0 data-[editing=true]:p-0" :data-editing="editing ? 'true' : 'false'">
    <div class="data-[editing=true]:hidden" :data-editing="editing ? 'true' : 'false'">
      <input type="checkbox" class="absolute inset-y-0 my-auto z-10 w-[40px] appearance-none border-none text-center opacity-0" :checked="todo.completed" @change="onToggle" />
      <label
        class="block break-words py-[15px] pl-[60px] pr-[15px] font-[400] leading-[1.2] text-[#484848] transition-colors duration-[0.4s] before:absolute before:left-[15px] before:top-1/2 before:h-[34px] before:w-[34px] before:-translate-y-1/2 before:rounded-full before:border before:border-[#949494] data-[completed=true]:text-[#949494] data-[completed=true]:line-through data-[completed=true]:before:border-[#59a193] data-[completed=true]:before:bg-[#3ea390] data-[completed=true]:before:flex data-[completed=true]:before:items-center data-[completed=true]:before:justify-center data-[completed=true]:before:text-white data-[completed=true]:before:content-['✓']"
        :data-completed="todo.completed ? 'true' : 'false'"
        @dblclick="startEdit"
      >{{ todo.title }}</label>
      <button
        class="absolute inset-y-0 right-[10px] my-auto hidden h-[40px] w-[40px] text-[30px] text-[#949494] transition-colors duration-200 group-hover:block hover:text-[#C18585] after:block after:h-full after:content-['×'] after:leading-[40px]"
        @click.prevent="deleteTodo"
      ></button>
    </div>
    <input
      v-if="editing"
      ref="editInput"
      type="text"
      class="relative ml-[43px] w-[calc(100%-43px)] border border-[#999] px-4 py-[12px] text-[24px] leading-[1.4em] text-inherit shadow-[inset_0_-1px_5px_0_rgba(0,0,0,0.2)]"
      aria-label="Edit todo"
      v-model="draft"
      @keyup.enter="commitEdit"
      @keyup.escape="cancelEdit"
      @blur="commitEdit"
    />
  </li>
</template>
