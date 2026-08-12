<script setup>
// Official TodoFooter uses vue-router RouterLink for the filters; naivi has no
// router (and blitz navigates `<a href>` clicks), so the filters are buttons
// that keep the official `.selected` styling.
import { computed } from 'vue';

const props = defineProps(['todos', 'filter']);
const emit = defineEmits(['delete-completed', 'filter-change']);

const remaining = computed(() => props.todos.filter((todo) => !todo.completed).length);
const hasCompleted = computed(() => props.todos.some((todo) => todo.completed));

function setFilter(value) {
  emit('filter-change', value);
}
</script>

<template>
  <footer class="footer" v-show="todos.length > 0">
    <span class="todo-count">
      <strong>{{ remaining }}</strong> {{ remaining === 1 ? 'item' : 'items' }} left
    </span>
    <ul class="filters">
      <li>
        <button class="filter-link" :class="{ selected: filter === 'all' }"
                @click="setFilter('all')">All</button>
      </li>
      <li>
        <button class="filter-link" :class="{ selected: filter === 'active' }"
                @click="setFilter('active')">Active</button>
      </li>
      <li>
        <button class="filter-link" :class="{ selected: filter === 'completed' }"
                @click="setFilter('completed')">Completed</button>
      </li>
    </ul>
    <button class="clear-completed" v-show="hasCompleted"
            @click="$emit('delete-completed')">Clear completed</button>
  </footer>
</template>
