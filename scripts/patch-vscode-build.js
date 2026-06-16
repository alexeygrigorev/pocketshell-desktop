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

function patchWelcomeOnboarding() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'contrib', 'welcomeOnboarding', 'browser', 'onboardingVariationA.ts');
  let content = read(file);
  content = content.replace(
    "import { assertDefined } from '../../../../base/common/types.js';\n",
    ''
  );
  content = content.replace(
    "assertDefined(product.defaultChatAgent, 'Onboarding requires a default chat agent product configuration.');\nconst defaultChat = product.defaultChatAgent;",
    `const defaultChat = product.defaultChatAgent ?? {
\tprovider: {
\t\tdefault: { id: 'pocketshell', name: 'PocketShell' },
\t\tenterprise: { id: 'pocketshell', name: 'PocketShell' },
\t},
\tproviderUriSetting: 'pocketshell.providerUri',
\ttermsStatementUrl: 'https://github.com/alexeygrigorev/pocketshell-desktop',
\tprivacyStatementUrl: 'https://github.com/alexeygrigorev/pocketshell-desktop',
\tpublicCodeMatchesUrl: 'https://github.com/alexeygrigorev/pocketshell-desktop',
};`
  );
  if (writeIfChanged(file, content)) {
    log('patched welcome onboarding default chat dependency');
  }
}

function patchWelcomeOnboardingContribution() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'contrib', 'welcomeOnboarding', 'browser', 'welcomeOnboarding.contribution.ts');
  let content = read(file);
  const original = `// Load styles for the remaining onboarding variant.
import './media/variationA.css';

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOnboardingService } from '../common/onboardingService.js';
import { OnboardingVariationA } from './onboardingVariationA.js';

registerSingleton(IOnboardingService, OnboardingVariationA, InstantiationType.Delayed);`;
  const replacement = `import { Event } from '../../../../base/common/event.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOnboardingService } from '../common/onboardingService.js';

class PocketShellNoopOnboardingService implements IOnboardingService {
\tdeclare readonly _serviceBrand: undefined;
\treadonly onDidComplete = Event.None;
\treadonly onDidDismiss = Event.None;
\tshow(): void {}
}

registerSingleton(IOnboardingService, PocketShellNoopOnboardingService, InstantiationType.Delayed);`;
  content = content.replace(original, replacement);
  content = content.replace(
    "\t\tconst onboardingService = accessor.get(IOnboardingService);\n\t\tonboardingService.show();",
    "\t\taccessor.get(IOnboardingService).show();"
  );
  if (writeIfChanged(file, content)) {
    log('disabled welcome onboarding contribution');
  }
}

function patchSessionsWelcome() {
  const file = path.join(vscodeDir, 'src', 'vs', 'sessions', 'browser', 'sessionsSetUpService.ts');
  let content = read(file);
  content = content.replace(
    "\t\tif (!this.productService.defaultChatAgent?.chatExtensionId) {\n\t\t\tthis.onCompleted();\n\t\t\treturn;\n\t\t}\n",
    "\t\tif (!this.productService.defaultChatAgent?.chatExtensionId || this.productService.defaultChatAgent.provider?.default?.id === 'pocketshell') {\n\t\t\tthis.onCompleted();\n\t\t\treturn;\n\t\t}\n"
  );
  if (writeIfChanged(file, content)) {
    log('patched sessions welcome for PocketShell');
  }
}

function patchAgentHostStartup() {
  const file = path.join(vscodeDir, 'src', 'vs', 'code', 'electron-main', 'app.ts');
  let content = read(file);
  content = content.replace(
    `\t\t// Agent Host
\t\tif (isAgentHostEnabled(this.configurationService)) {
\t\t\tconst agentHostStarter = new ElectronAgentHostStarter(this.configurationService, this.environmentMainService, this.lifecycleMainService, this.logService);
\t\t\tthis._register(new AgentHostProcessManager(agentHostStarter, this.logService, this.loggerService));
\t\t}
`,
    `\t\t// PocketShell does not ship VS Code's local agent host.
`
  );
  if (writeIfChanged(file, content)) {
    log('disabled Electron agent host startup');
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
patchWelcomeOnboarding();
patchWelcomeOnboardingContribution();
patchSessionsWelcome();
patchAgentHostStartup();
