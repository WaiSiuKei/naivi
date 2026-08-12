<script setup>
// Equivalent to examples/todomvc's ListFooter: todo-count, filters as
// `<a href="#/...">` with the `.selected` class, and Clear completed. The
// hash hrefs are same-document fragments (blitz scrolls to a matching id;
// none exists, so no navigation) and @click.prevent still drives the filter.
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
  <footer class="footer" v-if="todos.length > 0">
    <span class="todo-count">
      <strong>{{ remaining }} </strong><span>{{ remaining === 1 ? 'item' : 'items' }}</span> left
    </span>
    <ul class="filters">
      <li>
        <a href="#/" :class="{ selected: filter === 'all' }"
           @click.prevent="setFilter('all')">All</a>
      </li>
      <li>
        <a href="#/active" :class="{ selected: filter === 'active' }"
           @click.prevent="setFilter('active')">Active</a>
      </li>
      <li>
        <a href="#/completed" :class="{ selected: filter === 'completed' }"
           @click.prevent="setFilter('completed')">Completed</a>
      </li>
    </ul>
    <button class="clear-completed" v-if="hasCompleted"
            @click="$emit('delete-completed')">Clear completed</button>
  </footer>
</template>
