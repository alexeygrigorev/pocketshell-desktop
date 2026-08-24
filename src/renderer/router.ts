import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router';
import HostPickerView from './views/HostPickerView.vue';
import HostWorkspaceView from './views/HostWorkspaceView.vue';
import SessionPlaceholderView from './views/SessionPlaceholderView.vue';
import SessionWorkspaceView from './views/SessionWorkspaceView.vue';

// Memory history (not hash/history) — Electron loads a single file, and we
// navigate within the window without touching a real URL bar.
//
// Three levels, each with a route so "back" is a real navigation:
//   hosts          -> pick a host
//   host-sessions  -> connected host, no session picked yet. The session panel
//                     is part of the host shell, so this route only supplies
//                     the right pane's empty state.
//   session        -> one session's workspace (Terminal/Conversation/Files)
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'hosts', component: HostPickerView },
  {
    path: '/host/:name',
    component: HostWorkspaceView,
    children: [
      { path: '', name: 'host-sessions', component: SessionPlaceholderView },
      {
        path: 'session/:session',
        name: 'session',
        component: SessionWorkspaceView,
      },
    ],
  },
];

export const router = createRouter({
  history: createMemoryHistory(),
  routes,
});
