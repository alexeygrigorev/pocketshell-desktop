import { createApp } from 'vue';
import { createPinia } from 'pinia';
// Inter Variable, bundled (not fetched). Vite fingerprints the woff2 files
// into out/renderer/assets/, so the renderer never reaches the network —
// which matters because it is loaded over file:// with no connectivity
// guarantee. See docs/DESIGN.md §2.2.
import '@fontsource-variable/inter';
import App from './App.vue';
import { router } from './router';

createApp(App).use(createPinia()).use(router).mount('#app');
