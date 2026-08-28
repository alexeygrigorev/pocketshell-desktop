import { createApp } from 'vue';
import { createPinia } from 'pinia';
// Inter Variable, bundled (not fetched). Vite fingerprints the woff2 files
// into out/renderer/assets/, so the renderer never reaches the network —
// which matters because it is loaded over file:// with no connectivity
// guarantee. See docs/DESIGN.md §2.2.
import '@fontsource-variable/inter';
import App from './App.vue';
import { router } from './router';
import { recordDiagError } from './diag';

/**
 * The three nets under "an unhandled renderer error must be visible".
 *
 * `errorHandler` covers Vue's own pipeline — lifecycle hooks, watchers, and
 * RENDER FUNCTIONS, which is where the usage panel's blank-panel bug lived: a
 * throw mid-render used to abort the patch and leave the screen empty, with
 * the error going nowhere a packaged app could read. The two window listeners
 * cover everything outside Vue's knowledge: unhandled promise rejections
 * (`errorHandler` does not see them) and window-level `error` events, gated on
 * `e.error` because resource-load errors fire the same event with no error
 * object and no useful message.
 *
 * All three land in `recordDiagError`, which forwards to the desktop log and
 * raises the app-wide strip. None rethrows: the app continues past a failed
 * component rather than dying with it.
 */
const app = createApp(App);
app.config.errorHandler = (err): void => {
  recordDiagError('render', err);
};
window.addEventListener('unhandledrejection', (e) => {
  recordDiagError('unhandledrejection', e.reason);
});
window.addEventListener('error', (e) => {
  if (e.error) recordDiagError('error', e.error);
});

app.use(createPinia()).use(router).mount('#app');
