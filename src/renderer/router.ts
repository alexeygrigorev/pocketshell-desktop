import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router';
import HostPickerView from './views/HostPickerView.vue';
import HostWorkspaceView from './views/HostWorkspaceView.vue';

// Memory history (not hash/history) — Electron loads a single file, and we
// navigate within the window without touching a real URL bar.
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'hosts', component: HostPickerView },
  { path: '/host/:name', name: 'host', component: HostWorkspaceView, props: true },
];

export const router = createRouter({
  history: createMemoryHistory(),
  routes,
});
