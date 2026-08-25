/**
 * LanguageId -> a CodeMirror language extension, loaded on demand.
 *
 * ## Why every entry is a dynamic `import()`
 *
 * The renderer bundle is already large enough that Vite warns about it, and a
 * language grammar is the definition of code you almost never need: opening one
 * `.py` file must not cost the user the Rust, PHP and SQL parsers as well.
 * Written this way, Rollup emits each grammar as its own chunk beside
 * `index-*.js` and the initial bundle grows only by CodeMirror's core.
 *
 * This is safe in the PACKAGED app specifically, and that was checked rather
 * than assumed. The built renderer is loaded with `loadFile`, so it runs from a
 * `file://` document whose CSP is `default-src 'self'; script-src 'self'`
 * (src/renderer/index.html). A dynamic `import()` of a sibling chunk resolves
 * against the document URL and loads; what that CSP *does* block is a worker
 * created from a `blob:` URL, which is the mechanism a Monaco integration would
 * have needed. See the note at the top of CodeEditor.vue.
 *
 * ## Why so many of these are StreamLanguage modes
 *
 * The `@codemirror/lang-*` packages are real Lezer grammars and are used
 * wherever one exists. The rest come from `@codemirror/legacy-modes`, which are
 * the old CodeMirror 5 tokenisers run through `StreamLanguage`. They are
 * line-oriented and produce a flatter tree, so they highlight well and indent
 * badly — which is the right trade for the files this list covers (shell
 * scripts, Dockerfiles, nginx configs), where highlighting is the whole ask.
 */
import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { PLAIN_TEXT, type LanguageId } from './codeLanguage';

/** A legacy CodeMirror 5 mode, wrapped so the table below stays one-liners. */
async function stream(load: () => Promise<Record<string, unknown>>, name: string): Promise<Extension> {
  const mod = await load();
  return StreamLanguage.define(mod[name] as Parameters<typeof StreamLanguage.define>[0]);
}

/**
 * The loader table. `plaintext` is absent on purpose: it is not "a language
 * that does nothing", it is the absence of one, and {@link loadLanguage}
 * returns null for it so the caller adds no extension at all.
 */
const LOADERS: Readonly<Partial<Record<LanguageId, () => Promise<Extension>>>> = {
  // The JS grammar is one package serving four ids; the flags pick the dialect.
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),

  json: async () => (await import('@codemirror/lang-json')).json(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-vue')).vue(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  // One grammar for both: the Lezer C++ grammar parses C, and shipping a
  // separate C mode to gain nothing but a name would be pure weight.
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),

  shell: () => stream(() => import('@codemirror/legacy-modes/mode/shell'), 'shell'),
  toml: () => stream(() => import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  ini: () => stream(() => import('@codemirror/legacy-modes/mode/properties'), 'properties'),
  dockerfile: () => stream(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile'),
  nginx: () => stream(() => import('@codemirror/legacy-modes/mode/nginx'), 'nginx'),
  diff: () => stream(() => import('@codemirror/legacy-modes/mode/diff'), 'diff'),
  ruby: () => stream(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby'),
  perl: () => stream(() => import('@codemirror/legacy-modes/mode/perl'), 'perl'),
  lua: () => stream(() => import('@codemirror/legacy-modes/mode/lua'), 'lua'),
  powershell: () => stream(() => import('@codemirror/legacy-modes/mode/powershell'), 'powerShell'),
  r: () => stream(() => import('@codemirror/legacy-modes/mode/r'), 'r'),
  swift: () => stream(() => import('@codemirror/legacy-modes/mode/swift'), 'swift'),
  groovy: () => stream(() => import('@codemirror/legacy-modes/mode/groovy'), 'groovy'),
  haskell: () => stream(() => import('@codemirror/legacy-modes/mode/haskell'), 'haskell'),
  clojure: () => stream(() => import('@codemirror/legacy-modes/mode/clojure'), 'clojure'),
  scheme: () => stream(() => import('@codemirror/legacy-modes/mode/scheme'), 'scheme'),
  cmake: () => stream(() => import('@codemirror/legacy-modes/mode/cmake'), 'cmake'),
  protobuf: () => stream(() => import('@codemirror/legacy-modes/mode/protobuf'), 'protobuf'),
  tcl: () => stream(() => import('@codemirror/legacy-modes/mode/tcl'), 'tcl'),
  pascal: () => stream(() => import('@codemirror/legacy-modes/mode/pascal'), 'pascal'),
  fortran: () => stream(() => import('@codemirror/legacy-modes/mode/fortran'), 'fortran'),
  erlang: () => stream(() => import('@codemirror/legacy-modes/mode/erlang'), 'erlang'),
  elm: () => stream(() => import('@codemirror/legacy-modes/mode/elm'), 'elm'),
};

/** Language ids that resolve to a grammar — everything except plain text. */
export function supportedLanguageIds(): LanguageId[] {
  return Object.keys(LOADERS) as LanguageId[];
}

/**
 * Load the extension for `id`, or null when the file gets no highlighting.
 *
 * A failed load is null too, not a throw. A missing grammar chunk means an
 * uncoloured file; it must never mean an unopenable one, because the point of
 * this editor is saving the file back over SFTP.
 */
export async function loadLanguage(id: LanguageId): Promise<Extension | null> {
  if (id === PLAIN_TEXT) return null;
  const loader = LOADERS[id];
  if (!loader) return null;
  try {
    return await loader();
  } catch (e) {
    console.warn(`[CodeEditor] no grammar for "${id}":`, e);
    return null;
  }
}
