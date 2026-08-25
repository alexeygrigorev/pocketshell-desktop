/**
 * Filename -> language id, and the "is this worth highlighting at all?" gate.
 *
 * This module is deliberately pure: no DOM, no CodeMirror import, no dynamic
 * import. It is the part of the editor that has interesting rules and edge
 * cases (dotfiles, compound extensions, extensionless build files), so it is
 * the part that must be unit-testable without a browser environment. The
 * component that turns an id into a CodeMirror extension lives next door in
 * `codeEditorLanguages.ts`, which is where the async/bundler-shaped concerns
 * are allowed to live.
 *
 * The ids are OUR names, not CodeMirror's. Keeping an indirection here means
 * the tests below describe a product decision ("a `.zshrc` is a shell script")
 * rather than a library detail, and swapping a language package — the legacy
 * StreamLanguage modes are the likeliest to be replaced by real Lezer grammars
 * over time — never touches this file or its tests.
 */

/** Every language the editor can highlight, plus the fallback. */
export type LanguageId =
  | 'plaintext'
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'json'
  | 'python'
  | 'markdown'
  | 'html'
  | 'vue'
  | 'css'
  | 'xml'
  | 'yaml'
  | 'toml'
  | 'ini'
  | 'shell'
  | 'dockerfile'
  | 'nginx'
  | 'diff'
  | 'sql'
  | 'rust'
  | 'go'
  | 'java'
  | 'cpp'
  | 'c'
  | 'php'
  | 'ruby'
  | 'perl'
  | 'lua'
  | 'powershell'
  | 'r'
  | 'swift'
  | 'groovy'
  | 'haskell'
  | 'clojure'
  | 'scheme'
  | 'cmake'
  | 'protobuf'
  | 'tcl'
  | 'pascal'
  | 'fortran'
  | 'erlang'
  | 'elm';

/** What an unrecognised file gets: an editor, just without colours. */
export const PLAIN_TEXT: LanguageId = 'plaintext';

/**
 * Extension -> language, lower-cased and WITHOUT the leading dot.
 *
 * Longest-match-first is applied by {@link languageIdForFilename}, so multi-dot
 * keys such as `d.ts` may appear here alongside their shorter forms.
 */
const BY_EXTENSION: Readonly<Record<string, LanguageId>> = {
  // --- web / JS family ---
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  'd.ts': 'typescript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  map: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  svg: 'xml',
  plist: 'xml',
  // --- config / markup ---
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  // The rarer spellings, added when markdown gained a preview: every extension
  // MARKDOWN_EXTENSIONS (src/main/preview/previewPaths.ts) offers a Preview tab
  // for has to highlight on the Source tab beside it, or the toggle reads as
  // half-implemented on exactly the files that are unusual enough to notice.
  mdown: 'markdown',
  mkd: 'markdown',
  mkdn: 'markdown',
  mdtext: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'ini',
  diff: 'diff',
  patch: 'diff',
  // --- shells and ops ---
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  // --- general purpose ---
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  sql: 'sql',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'java', // no Lezer Kotlin grammar; Java's is the closest honest match
  kts: 'java',
  scala: 'java',
  groovy: 'groovy',
  gradle: 'groovy',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  m: 'cpp',
  mm: 'cpp',
  cs: 'cpp', // clike family; C#'s shape is close enough to be useful
  php: 'php',
  php3: 'php',
  php4: 'php',
  php5: 'php',
  phtml: 'php',
  swift: 'swift',
  r: 'r',
  hs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  scm: 'scheme',
  ss: 'scheme',
  el: 'scheme', // elisp is a lisp; the scheme mode reads it acceptably
  cmake: 'cmake',
  proto: 'protobuf',
  tcl: 'tcl',
  pas: 'pascal',
  f: 'fortran',
  f90: 'fortran',
  for: 'fortran',
  erl: 'erlang',
  hrl: 'erlang',
  elm: 'elm',
};

/**
 * Whole filenames that carry no extension (or whose extension lies).
 *
 * Compared lower-cased. `Makefile` has no CodeMirror mode of its own and is
 * NOT mapped to shell: a makefile's recipe lines are shell but its rule syntax
 * is not, and mis-highlighting the majority of the file to colour the minority
 * is worse than leaving it plain.
 */
const BY_FILENAME: Readonly<Record<string, LanguageId>> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.bash_logout': 'shell',
  '.zshrc': 'shell',
  '.zshenv': 'shell',
  '.zprofile': 'shell',
  '.profile': 'shell',
  '.inputrc': 'shell',
  '.xinitrc': 'shell',
  '.gitconfig': 'ini',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
  '.env': 'ini',
  '.dockerignore': 'ini',
  'nginx.conf': 'nginx',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'cargo.lock': 'toml',
  'pipfile': 'toml',
};

/**
 * Filename prefixes for the "same base, environment suffix" convention —
 * `.env.local`, `nginx.conf.d`, `Dockerfile.dev`. Matched only after the exact
 * and extension lookups both miss, so `Dockerfile` itself never reaches here.
 */
const BY_FILENAME_PREFIX: readonly (readonly [string, LanguageId])[] = [
  ['dockerfile.', 'dockerfile'],
  ['.env.', 'ini'],
  ['nginx.conf.', 'nginx'],
];

/**
 * Strip directories from a remote path.
 *
 * The remote is always POSIX (an SFTP channel talks to a unix box even when
 * the client is Windows), but backslashes are split on too: a filename is only
 * ever used here to pick colours, and being lenient costs nothing while being
 * strict would mis-read a Windows path that reached us by some other route.
 */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The language to highlight `path` as, or {@link PLAIN_TEXT} when unknown.
 *
 * Resolution order, and the reason for each step:
 *   1. Exact filename — `Dockerfile` and `.bashrc` have no usable extension,
 *      and `.gitignore` would otherwise read as "a file whose extension is
 *      gitignore".
 *   2. Longest extension first — `index.d.ts` is TypeScript either way, but
 *      the ordering is what would let `tar.gz`-shaped keys work, and it makes
 *      the table's behaviour independent of key insertion order.
 *   3. Filename prefix — `Dockerfile.dev`, `.env.local`.
 * Anything still unmatched is plain text, which is a real answer: a plain
 * editor over an unknown file is correct, and guessing is not.
 */
export function languageIdForFilename(path: string | null | undefined): LanguageId {
  if (path == null) return PLAIN_TEXT;
  const name = basename(path).toLowerCase();
  if (name === '') return PLAIN_TEXT;

  const exact = BY_FILENAME[name];
  if (exact) return exact;

  // A leading dot is part of the NAME, not the start of an extension, so it is
  // skipped before splitting: `.gitignore` has no extension, `.env.local` has
  // one called `local`.
  const searchFrom = name.startsWith('.') ? 1 : 0;
  let dot = name.indexOf('.', searchFrom);
  while (dot !== -1) {
    const ext = name.slice(dot + 1);
    const hit = BY_EXTENSION[ext];
    if (hit) return hit;
    dot = name.indexOf('.', dot + 1);
  }

  for (const [prefix, id] of BY_FILENAME_PREFIX) {
    if (name.startsWith(prefix)) return id;
  }

  return PLAIN_TEXT;
}

/**
 * Above this many characters, the file opens as plain text regardless of its
 * name.
 *
 * CodeMirror itself is fine with a multi-megabyte document — the view is
 * virtualised and the Lezer parser works to a per-frame time budget, so it
 * degrades to "highlighting trails behind you" rather than to a freeze. The
 * cost that does NOT degrade gracefully is the parse tree's memory, which is
 * proportional to the whole document however little of it is on screen. 1 MiB
 * is well above anything hand-editable over SFTP (a 1 MiB source file is a
 * generated one) and well below the size at which the tree starts to matter.
 */
export const HIGHLIGHT_MAX_CHARS = 1024 * 1024;

/**
 * Above this, a single line is treated as "not really source".
 *
 * Long-line cost is the one real cliff in CodeMirror: line wrapping has to lay
 * out the entire logical line to place the cursor, so one 200k-character line —
 * a minified bundle, a base64 payload, a JSON dump with no newlines — is slow
 * to edit whether or not it is highlighted. Highlighting it makes it worse and
 * buys nothing, since the file is not being read by a human anyway.
 */
export const HIGHLIGHT_MAX_LINE_CHARS = 10_000;

/**
 * Whether `content` should get a language attached at all.
 *
 * Kept here, beside the mapping and away from the view, because it is the same
 * kind of decision — a pure predicate over a file — and because a perf guard
 * that lives only inside a component is a perf guard nobody can test.
 */
export function shouldHighlight(content: string): boolean {
  if (content.length > HIGHLIGHT_MAX_CHARS) return false;
  // Scanning line by line rather than splitting: `split('\n')` on a few MB
  // allocates a second copy of the whole document to answer a yes/no question.
  let start = 0;
  for (;;) {
    const nl = content.indexOf('\n', start);
    const end = nl === -1 ? content.length : nl;
    if (end - start > HIGHLIGHT_MAX_LINE_CHARS) return false;
    if (nl === -1) return true;
    start = nl + 1;
  }
}
