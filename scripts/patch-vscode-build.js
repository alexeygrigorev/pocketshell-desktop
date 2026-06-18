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
  // Normalize CRLF -> LF. On Windows, git's autocrlf checks the vendored VS
  // Code source out with \r\n, but the patch targets use \n (literal string
  // includes/replace). Without normalization, multi-line string targets (e.g.
  // patchActivityBarViewContainers) fail to match on Windows and break the
  // build. On linux/mac the source is already LF, so this is a no-op there.
  // gulp/tsc compile LF source fine on every platform, and the vendored tree
  // is ephemeral (cloned per CI run, never committed), so writing LF back is
  // safe.
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function writeIfChanged(file, next) {
  const current = read(file);
  if (current === next) {
    return false;
  }
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

// Like String.replace, but throws a clear error when the target is not present
// in the file. This makes build-time patches fail loudly when upstream VS Code
// source drifts, instead of silently no-op-ing.
//
// IDEMPOTENT: if the replacement is already present in the content (the patch
// was applied on a prior run — e.g. prepare-base baked it into the cached
// vendor tree, then the build job re-applied it), the call is a no-op instead
// of throwing "Patch target not found". This lets the same patcher run in both
// prepare-base (pre-compile, the load-bearing run) and the build job (a safety
// net) without the second run exploding on already-patched source.
function replaceRequired(content, target, replacement, label) {
  // Idempotency short-circuit (string target + string replacement only): if the
  // FULL replacement is already in the content, the patch was applied on a prior
  // run (e.g. prepare-base baked it into the cached vendor tree, then the build
  // job re-ran the patcher). Return unchanged instead of throwing "Patch target
  // not found". We require the FULL replacement (not a substring marker) because
  // patches commonly reuse lines from the original target, so any partial marker
  // would false-positive on pristine source and silently skip the patch.
  if (typeof target === 'string' && typeof replacement === 'string' && replacement.length > 0 && content.includes(replacement)) {
    return content;
  }
  if (typeof target === 'string') {
    if (!content.includes(target)) {
      throw new Error(`Patch target not found${label ? ` for ${label}` : ''}: ${target.split('\n')[0]}`);
    }
  } else if (!target.test(content)) {
    throw new Error(`Patch pattern not found${label ? ` for ${label}` : ''}: ${target}`);
  }
  return content.replace(target, replacement);
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

// Built-in view containers that must NOT appear in PocketShell's activity bar.
// Only the PocketShell view container ('workbench.view.extension.pocketshell')
// should remain. 'workbench.panel.chat' is Copilot's chat container (registered
// in the auxiliary bar) and is stripped here too.
const HIDDEN_VIEW_CONTAINER_IDS = [
  'workbench.view.explorer',
  'workbench.view.search',
  'workbench.view.scm',
  'workbench.view.debug',
  'workbench.view.extensions',
  'workbench.panel.chat',
];

// Issue #87: Strip the activity bar down to PocketShell-only. PaneCompositeBar
// powers every activity-bar/auxiliary-bar composite strip and asks
// `getViewContainers()` for the list of containers to render. We filter the
// built-in VS Code containers (Explorer, Search, SCM, Run and Debug, Extensions)
// and the Copilot chat container out of that list so only the PocketShell view
// container survives. Because this is the single chokepoint used by both the
// primary activity bar (Sidebar) and the secondary side bar (AuxiliaryBar),
// one patch covers both locations.
function patchActivityBarViewContainers() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'browser', 'parts', 'paneCompositeBar.ts');
  let content = read(file);
  const original = '\tprivate getViewContainers(): readonly ViewContainer[] {\n\t\treturn this.viewDescriptorService.getViewContainersByLocation(this.location);\n\t}';
  const hiddenArray = HIDDEN_VIEW_CONTAINER_IDS.map((id) => `'${id}'`).join(', ');
  const replacement = '\tprivate getViewContainers(): readonly ViewContainer[] {\n\t\tconst hiddenPocketShellContainers = new Set<string>([' + hiddenArray + ']);\n\t\treturn this.viewDescriptorService.getViewContainersByLocation(this.location).filter(viewContainer => !hiddenPocketShellContainers.has(viewContainer.id));\n\t}';
  content = replaceRequired(content, original, replacement, 'patchActivityBarViewContainers getViewContainers');
  if (writeIfChanged(file, content)) {
    log('patched paneCompositeBar to hide built-in view containers');
  }
}

// Issue #88(a): Hide the remote-window status indicator. PocketShell uses the
// remote-window machinery internally but must not SHOW the indicator in the
// status bar. There is no configuration setting for this, so we stop the
// RemoteStatusIndicator workbench contribution from being registered.
function patchRemoteIndicator() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'contrib', 'remote', 'browser', 'remote.contribution.ts');
  let content = read(file);
  content = replaceRequired(
    content,
    "registerWorkbenchContribution2(RemoteStatusIndicator.ID, RemoteStatusIndicator, WorkbenchPhase.BlockStartup);\n",
    '// PocketShell: remote-window indicator hidden (uses the machinery, must not display it).\n',
    'patchRemoteIndicator RemoteStatusIndicator registration'
  );
  // The registration above was the only use of the RemoteStatusIndicator import
  // in this file; drop it so tsgo/noUnusedLocals does not flag the patched file.
  content = replaceRequired(
    content,
    "import { RemoteStatusIndicator } from './remoteIndicator.js';\n",
    '// PocketShell: RemoteStatusIndicator import removed (registration stripped).\n',
    'patchRemoteIndicator RemoteStatusIndicator import'
  );
  if (writeIfChanged(file, content)) {
    log('disabled remote status indicator contribution');
  }
}

// Issue #88(b) + #88(c): Hide the Accounts menu and the Manage (gear) menu.
// GlobalCompositeBar drives both icons in the activity bar; isAccountsActionVisible()
// is also consulted by the title bar tile code. We (1) make the gear never push
// into the activity bar, (2) force isAccountsActionVisible() to false so neither
// the activity bar nor the title bar renders the Accounts icon. There are no
// configuration settings for either of these.
function patchGlobalCompositeBar() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'browser', 'parts', 'globalCompositeBar.ts');
  let content = read(file);

  // Do not push the Manage (gear) action into the activity bar.
  content = replaceRequired(
    content,
    '\n\t\tthis.globalActivityActionBar.push(this.globalActivityAction);\n',
    '\n\t\t// PocketShell: Manage (gear) action removed from the activity bar.\n',
    'patchGlobalCompositeBar globalActivityAction push'
  );

  // The gear field above was its only consumer; drop the now-unused field so
  // tsgo/noUnusedLocals does not flag the patched file. GLOBAL_ACTIVITY_ID (the
  // id constant) is still used elsewhere in this file, so its import stays.
  content = replaceRequired(
    content,
    '\tprivate readonly globalActivityAction = this._register(new Action(GLOBAL_ACTIVITY_ID));\n',
    '\t// PocketShell: globalActivityAction field removed (Manage gear stripped).\n',
    'patchGlobalCompositeBar globalActivityAction field'
  );

  // Force the Accounts icon to never be visible in any host (activity bar or
  // title bar). isAccountsActionVisible() guards both render paths.
  content = replaceRequired(
    content,
    'export function isAccountsActionVisible(storageService: IStorageService): boolean {\n\treturn storageService.getBoolean(AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY, StorageScope.PROFILE, true);\n}',
    'export function isAccountsActionVisible(storageService: IStorageService): boolean {\n\t// PocketShell: Accounts menu hidden.\n\treturn false;\n}',
    'patchGlobalCompositeBar isAccountsActionVisible'
  );

  if (writeIfChanged(file, content)) {
    log('disabled Accounts and Manage (gear) composite bar entries');
  }
}

// Issue #88(c): Hide the Manage (gear) menu from the title bar as well. When
// the activity bar is relocated to the top/bottom, the global-activity tile
// action is rendered in the title bar; strip that push.
function patchTitleBarGlobalActivityTile() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'browser', 'parts', 'titlebar', 'titlebarPart.ts');
  let content = read(file);
  content = replaceRequired(
    content,
    '\n\t\t\t\tactions.primary.push(GLOBAL_ACTIVITY_TITLE_ACTION);\n',
    '\n\t\t\t\t// PocketShell: Manage (gear) tile action removed from the title bar.\n',
    'patchTitleBarGlobalActivityTile GLOBAL_ACTIVITY_TITLE_ACTION'
  );
  // The push above was the only use of GLOBAL_ACTIVITY_TITLE_ACTION in this
  // file; drop it from the import so tsgo/noUnusedLocals does not flag the file.
  content = replaceRequired(
    content,
    "import { ACCOUNTS_ACTIVITY_TILE_ACTION, GLOBAL_ACTIVITY_TITLE_ACTION, TitleBarLeadingActionsGroup } from './titlebarActions.js';\n",
    "import { ACCOUNTS_ACTIVITY_TILE_ACTION, TitleBarLeadingActionsGroup } from './titlebarActions.js';\n",
    'patchTitleBarGlobalActivityTile import'
  );
  if (writeIfChanged(file, content)) {
    log('disabled Manage (gear) title bar tile action');
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

// Issue #100: Kill the "Open in Agents Window" surface entirely. VS Code's chat
// contrib registers a title-bar widget ("Open in Agents"), a command palette
// action, a title-bar toggle setting, and an input-handoff tip — none of which
// PocketShell ships. We remove the registerAction2 / registerWorkbenchContribution2
// calls (and the now-unused import) from the chat electron-browser contribution.
// The action/contribution classes themselves stay defined (removing them would
// require touching many call sites); only their REGISTRATION is stripped, so the
// UI never appears and the commands are unreachable.
function patchOpenInAgents() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'contrib', 'chat', 'electron-browser', 'chat.contribution.ts');
  let content = read(file);

  // Remove the four agents-window action registrations.
  content = replaceRequired(
    content,
    "registerAction2(OpenWorkspaceInAgentsWindowAction);\nregisterAction2(ToggleOpenInAgentsWindowTitleBarAction);\nregisterAction2(OpenAgentsWindowAction);\nregisterAction2(OpenChatSessionInAgentsWindowAction);\n",
    '// PocketShell: "Open in Agents Window" actions removed.\n',
    'patchOpenInAgents action registrations'
  );

  // Remove the title-bar widget contribution + the handoff-tip contribution.
  content = replaceRequired(
    content,
    "registerWorkbenchContribution2(OpenWorkspaceInAgentsContribution.ID, OpenWorkspaceInAgentsContribution, WorkbenchPhase.BlockRestore);\nregisterWorkbenchContribution2(AgentsHandoffInputTipContribution.ID, AgentsHandoffInputTipContribution, WorkbenchPhase.Eventually);\n",
    '// PocketShell: "Open in Agents Window" contributions removed.\n',
    'patchOpenInAgents contribution registrations'
  );

  // Drop the now-unused import so tsc does not flag it as an unused import
  // (noUnusedLocals). Keep the rest of the import line intact.
  content = replaceRequired(
    content,
    "import { OpenWorkspaceInAgentsWindowAction, OpenWorkspaceInAgentsContribution, OpenAgentsWindowAction, OpenChatSessionInAgentsWindowAction, AgentsHandoffInputTipContribution, ToggleOpenInAgentsWindowTitleBarAction } from './agentSessions/agentSessionsActions.js';\n",
    '// PocketShell: agents-window actions import removed (registrations stripped).\n',
    'patchOpenInAgents import'
  );

  if (writeIfChanged(file, content)) {
    log('removed "Open in Agents Window" actions and contributions');
  }
}

// Issue #100: Remove the sidebar / panel / auxiliary-bar toggle buttons from the
// title-bar layout control. These inline toggle buttons are shown when
// `workbench.layoutControl.type` is 'toggles' or 'both' (the upstream default is
// 'both'). Switching the default to 'menu' makes the layout control render only
// a single dropdown button — the toggle buttons (and their `when` clauses in
// layoutActions.ts / panelActions.ts / auxiliaryBarActions.ts) never match, so
// they are gone from the shipped UI. The underlying toggle ACTIONS and their
// keybindings (Ctrl+B / Ctrl+J) are left intact; only the buttons are removed.
function patchLayoutControlDefault() {
  const file = path.join(vscodeDir, 'src', 'vs', 'workbench', 'browser', 'workbench.contribution.ts');
  let content = read(file);
  content = replaceRequired(
    content,
    "\t\t\t'workbench.layoutControl.type': {\n\t\t\t\t'type': 'string',\n\t\t\t\t'enum': ['menu', 'toggles', 'both'],\n",
    "\t\t\t'workbench.layoutControl.type': {\n\t\t\t\t'type': 'string',\n\t\t\t\t// PocketShell: 'menu' removes the sidebar/panel/auxiliary toggle buttons.\n\t\t\t\t'enum': ['menu', 'toggles', 'both'],\n",
    'patchLayoutControlDefault enum block'
  );
  content = replaceRequired(
    content,
    "\t\t\t\t'default': 'both',\n\t\t\t\t'description': localize('layoutControlType', \"Controls whether the layout control in the custom title bar is displayed as a single menu button or with multiple UI toggles.\"),\n",
    "\t\t\t\t'default': 'menu',\n\t\t\t\t'description': localize('layoutControlType', \"Controls whether the layout control in the custom title bar is displayed as a single menu button or with multiple UI toggles.\"),\n",
    'patchLayoutControlDefault default value'
  );
  if (writeIfChanged(file, content)) {
    log('set workbench.layoutControl.type default to menu (removes toggle buttons)');
  }
}

function patchAgentHostStartup() {
  const file = path.join(vscodeDir, 'src', 'vs', 'code', 'electron-main', 'app.ts');
  let content = read(file);
  content = replaceRequired(
    content,
    `\t\t// Agent Host
\t\tif (isAgentHostEnabled(this.configurationService)) {
\t\t\tconst agentHostStarter = new ElectronAgentHostStarter(this.configurationService, this.environmentMainService, this.lifecycleMainService, this.logService);
\t\t\tthis._register(new AgentHostProcessManager(agentHostStarter, this.logService, this.loggerService));
\t\t}
`,
    `\t\t// PocketShell does not ship VS Code's local agent host.
`,
    'patchAgentHostStartup agent host block'
  );
  // The block above was the only consumer of these three imports; drop them so
  // tsgo/noUnusedLocals does not flag the patched file.
  content = replaceRequired(
    content,
    "import { ElectronAgentHostStarter } from '../../platform/agentHost/electron-main/electronAgentHostStarter.js';\nimport { AgentHostProcessManager } from '../../platform/agentHost/node/agentHostService.js';\nimport { isAgentHostEnabled } from '../../platform/agentHost/common/agentService.js';\n",
    '// PocketShell: agent-host imports removed (startup block stripped).\n',
    'patchAgentHostStartup agent host imports'
  );
  if (writeIfChanged(file, content)) {
    log('disabled Electron agent host startup');
  }
}

function main() {
  if (!fs.existsSync(vscodeDir)) {
    throw new Error(`VS Code source not found at ${vscodeDir}`);
  }

  // Split into two phases via `--core-only`:
  //
  // prepare-base (the load-bearing pre-compile run) invokes this script with
  // `--core-only`. In that job the PocketShell extension source is NOT synced
  // into vendor/vscode/extensions/pocketshell yet (the sync happens in the
  // build job), and the stock extensions have NOT been pruned yet. Running the
  // full patcher here would (a) rewrite build/gulpfile.extensions.ts's
  // compilations array to ['extensions/pocketshell/tsconfig.json'] — and since
  // pocketshell/tsconfig.json does not exist yet, `gulp compile` errors with
  // TS5058 "The specified path does not exist"; and (b) prune every stock
  // extension, leaving the (un-pruned-list-aware) extensions compile chasing
  // now-deleted tsconfig.json files. Both break prepare-base's compile.
  //
  // So `--core-only` runs ONLY the src/vs/ chrome patches (which must be baked
  // into the cached out/). The build job then runs the FULL patcher as a safety
  // net: by then pocketshell is synced and pruning is expected, so the
  // build-config + extension patches apply cleanly.
  const coreOnly = process.argv.includes('--core-only');
  if (coreOnly) {
    log('--core-only: running src/vs/ chrome patches only; skipping copilot rmrf, prune, and build-config/extension patches (deferred to the build job).');
  }

  if (!coreOnly) {
    rmrf('extensions/copilot');
    rmrf('.build/extensions/copilot');
    rmrf('out/extensions/copilot');
    pruneBundledExtensions();

    patchGulpfileVscode();
    patchExtensionGulpfile();
    patchExtensionsLib();
  }
  patchPaneCompositeBar();
  patchActivityBarViewContainers();
  patchRemoteIndicator();
  patchGlobalCompositeBar();
  patchTitleBarGlobalActivityTile();
  patchWelcomeOnboarding();
  patchWelcomeOnboardingContribution();
  patchSessionsWelcome();
  patchOpenInAgents();
  patchLayoutControlDefault();
  patchAgentHostStartup();
}

// Only run the patches when invoked directly as a script
// (`node scripts/patch-vscode-build.js`). When required from a test, exporting
// the helpers below lets us unit-test read()/replaceRequired() without mutating
// the real vendored VS Code tree.
if (require.main === module) {
  main();
}

module.exports = { read, replaceRequired };
