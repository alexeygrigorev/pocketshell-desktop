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
    //
    // `marked` is here for exactly the same reason and it is not a style
    // choice: since v5 the package ships ESM only (`exports: { '.': './lib/
    // marked.esm.js' }`, no CJS entry), and Electron 33 is Node 20, which
    // predates `require(esm)`. Left external, the markdown preview would throw
    // ERR_REQUIRE_ESM the first time anyone opened a `.md` — in a code path
    // that no unit test reaches, because unit tests run under Vitest's ESM
    // loader where the import works fine. Bundling also keeps the installer
    // honest: 45 KB of transpiled parser in main's chunk rather than the
    // package's 480 KB of sources, maps and `.d.ts` copied into the asar.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store', 'marked'] })],
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
