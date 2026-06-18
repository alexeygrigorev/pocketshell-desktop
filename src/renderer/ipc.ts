/**
 * Typed wrapper around the preload-exposed `window.api`.
 *
 * The renderer imports `api` from here instead of touching `window` directly,
 * so the IPC surface is type-checked at compile time and grep-friendly.
 */
import type { Api } from '../preload';

declare global {
  interface Window {
    api: Api;
  }
}

export const api: Api = window.api;
