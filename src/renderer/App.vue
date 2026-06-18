<script setup lang="ts">
// Root component: just the router-outlet. All views (HostPicker,
// HostWorkspace) are routed. Global theme vars live in <style>.
</script>

<template>
  <router-view />
</template>

<style>
:root {
  --bg: #1e1e2e;
  --fg: #cdd6f4;
  --muted: #7f849c;
  --accent: #89b4fa;
  --error: #f38ba8;
  --border: #313244;
}
* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
}
</style>
