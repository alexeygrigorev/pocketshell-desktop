#!/usr/bin/env node
/*
 * Apply PocketShell-specific patches to the vendored VS Code tree.
 *
 * Recent upstream VS Code builds include Copilot through a special build path,
 * outside the normal local-extension scan. PocketShell does not ship Copilot.
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const vscodeDir = path.join(projectRoot, 'vendor', 'vscode');
const allowedBundledExtensions = new Set([
  'markdown-basics',
  'markdown-language-features',
  'node_modules',
  'pocketshell',
  'theme-defaults',
]);

function log(message) {
  console.log(`[patch-vscode-build] ${message}`);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, next) {
  const current = read(file);
  if (current === next) {
    return false;
  }
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

function rmrf(relativePath) {
  const target = path.join(vscodeDir, relativePath);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    log(`removed ${relativePath}`);
  }
}

function pruneBundledExtensions() {
  const extensionsDir = path.join(vscodeDir, 'extensions');
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (allowedBundledExtensions.has(entry.name)) {
      continue;
    }
    rmrf(path.join('extensions', entry.name));
  }
}

function patchGulpfileVscode() {
  const file = path.join(vscodeDir, 'build', 'gulpfile.vscode.ts');
  let content = read(file);

  content = content.replace(
    'compileNonNativeExtensionsBuildTask, compileNativeExtensionsBuildTask, compileAllExtensionsBuildTask, compileExtensionMediaBuildTask, cleanExtensionsBuildTask, compileCopilotExtensionBuildTask',
    'compileNonNativeExtensionsBuildTask, compileNativeExtensionsBuildTask, compileAllExtensionsBuildTask, compileExtensionMediaBuildTask, cleanExtensionsBuildTask'
  );
  content = content.replace(
    "import { getCopilotExcludeFilter, getCopilotRuntimePrebuildFiles, getCopilotTgrepExcludeFilter, getRipgrepExcludeFilter, prepareBuiltInCopilotRipgrepShim } from './lib/copilot.ts';",
    "import { getRipgrepExcludeFilter } from './lib/copilot.ts';"
  );
  content = content.replace(
    /\n\t\tconst copilotRuntimePrebuilds = gulp\.src\(getCopilotRuntimePrebuildFiles\(platform, arch\), \{ base: '\.', dot: true, allowEmpty: true \}\);\n\t\tconst deps = es\.merge\(cleanedDeps, copilotRuntimePrebuilds\)\n\t\t\t\.pipe\(filter\(getCopilotExcludeFilter\(platform, arch\)\)\)\n\t\t\t\.pipe\(filter\(getCopilotTgrepExcludeFilter\(platform, arch\)\)\)/,
    '\n\t\tconst deps = cleanedDeps'
  );
  content = content.replace(
    "const depFilterPattern = ['**', `!**/${config.version}/**`, '!**/bin/darwin-arm64-87/**', '!**/package-lock.json', '!**/yarn.lock'];",
    "const depFilterPattern = ['**', `!**/${config.version}/**`, '!**/bin/darwin-arm64-87/**', '!**/package-lock.json', '!**/yarn.lock', '!node_modules/@github/**', '!node_modules/@anthropic-ai/**', '!node_modules/@openai/**', '!node_modules/@modelcontextprotocol/**'];"
  );
  content = content.replace(
    /\nfunction prepareCopilotRipgrepShimTask\(platform: string, arch: string, destinationFolderName: string\) \{[\s\S]*?\n\}\n\nconst buildRoot = path\.dirname\(root\);/,
    '\nconst buildRoot = path.dirname(root);'
  );
  content = content.replace(/\n\t\t\tprepareCopilotRipgrepShimTask\(platform, arch, destinationFolderName\)/, '');
  content = content.replace(/\n\t\t\t\tcompileCopilotExtensionBuildTask,/g, '');

  if (writeIfChanged(file, content)) {
    log('patched build/gulpfile.vscode.ts');
  }
}

function patchExtensionGulpfile() {
  const file = path.join(vscodeDir, 'build', 'gulpfile.extensions.ts');
  let content = read(file);
  const compilationsMatch = content.match(/^const compilations = \[$/m);
  if (!compilationsMatch) {
    throw new Error('Could not find extension compilations array');
  }
  const compilationsStart = compilationsMatch.index;
  const compilationsEnd = content.indexOf('];', compilationsStart);
  if (compilationsEnd === -1) {
    throw new Error('Could not find extension compilations array end');
  }
  const newArrayBlock = "const compilations = [\n\t'extensions/pocketshell/tsconfig.json'\n];";
  content = content.slice(0, compilationsStart) + newArrayBlock + content.slice(compilationsEnd + 2);
  if (writeIfChanged(file, content)) {
    log('patched build/gulpfile.extensions.ts');
  }
}

function patchExtensionsLib() {
  const file = path.join(vscodeDir, 'build', 'lib', 'extensions.ts');
  let content = read(file).replace(
    "gulp.src(dependenciesSrc, { base: '.' })",
    "gulp.src(dependenciesSrc, { base: '.', nodir: true })"
  );
  content = content.replace(
    /const esbuildMediaScripts: \{ script: string; tsconfig: string \}\[] = \[[\s\S]*?\n\];/,
    `const esbuildMediaScripts: { script: string; tsconfig: string }[] = [
\t{ script: 'markdown-language-features/esbuild.notebook.mts', tsconfig: 'markdown-language-features/notebook/tsconfig.json' },
\t{ script: 'markdown-language-features/esbuild.webview.mts', tsconfig: 'markdown-language-features/preview-src/tsconfig.json' },
\t{ script: 'markdown-language-features/esbuild.markdownEditor.mts', tsconfig: 'markdown-language-features/markdown-editor-src/tsconfig.json' },
];`
  );
  if (writeIfChanged(file, content)) {
    log('patched build/lib/extensions.ts');
  }
}

function patchPaneCompositeBar() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'browser', 'parts', 'paneCompositeBar.ts');
  let content = read(file);
  content = content.replace(
    "if (!cachedViewContainer) {\n\t\t\t\tthis.compositeBar.pin(viewContainer.id);\n\t\t\t}",
    "if (!cachedViewContainer && viewContainer.id === 'workbench.view.extension.pocketshell') {\n\t\t\t\tthis.compositeBar.pin(viewContainer.id);\n\t\t\t}"
  );
  if (writeIfChanged(file, content)) {
    log('patched paneCompositeBar default pins');
  }
}

if (!fs.existsSync(vscodeDir)) {
  throw new Error(`VS Code source not found at ${vscodeDir}`);
}

rmrf('extensions/copilot');
rmrf('.build/extensions/copilot');
rmrf('out/extensions/copilot');
pruneBundledExtensions();

patchGulpfileVscode();
patchExtensionGulpfile();
patchExtensionsLib();
patchPaneCompositeBar();
