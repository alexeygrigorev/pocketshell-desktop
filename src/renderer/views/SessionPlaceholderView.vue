<script setup lang="ts">
// SessionPlaceholderView: what the right pane shows before a FOLDER is picked.
// The session panel on the left stays visible, so this is an empty state
// rather than a screen of its own.
//
// It names folders rather than sessions because that is what the panel's rows
// are now: a session is a tab inside a folder's
// workspace, so "select a session" would point at something the panel no
// longer offers.
</script>

<template>
  <div class="session-placeholder">
    <p class="muted">select a folder to open its sessions</p>
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
  font-size: var(--fs-300);
}
</style>
