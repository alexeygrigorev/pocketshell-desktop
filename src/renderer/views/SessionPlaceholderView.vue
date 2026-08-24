<script setup lang="ts">
// SessionPlaceholderView: what the right pane shows before a session is
// picked. The session panel on the left stays visible, so this is an empty
// state rather than a screen of its own.
</script>

<template>
  <div class="session-placeholder">
    <p class="muted">select a session to attach</p>
  </div>
</template>

<style scoped>
.session-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.muted {
  color: var(--muted);
}
</style>
