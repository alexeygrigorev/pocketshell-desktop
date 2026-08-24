import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// electron-vite builds three targets: main, preload (Node), and renderer (browser).
// The renderer is sandboxed (contextIsolation: true, nodeIntegration: false),
// so only the preload may bridge to Node via contextBridge.
export default defineConfig({
  main: {
    // ssh2, ssh2-sftp-client and keytar are native/CJS deps consumed only in
    // the main process, and must stay external.
    //
    // electron-store MUST NOT. It is pure ESM (`"type": "module"` since v9),
    // while electron-vite emits CJS for main, so leaving it external makes the
    // bundle `require()` an ES module and Electron dies at startup with
    // ERR_REQUIRE_ESM before a window ever opens. Excluding it from
    // externalisation lets Vite transpile it into the CJS output.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
