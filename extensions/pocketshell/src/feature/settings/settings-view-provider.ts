/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConfigStore } from '../../backend/pocketshell-settings';
import { readSettings, writeSetting, resetSetting } from '../../backend/pocketshell-settings';
import type { SettingEntry } from '../../backend/pocketshell-settings';

/**
 * WebviewView provider backing the dedicated PocketShell Settings view.
 *
 * Renders every setting from `POCKETSHELL_SETTINGS` grouped by category,
 * with a control per type (toggle / number input / text input). Reads via
 * the pure `readSettings` model; writes round-trip back through
 * `writeSetting` (which validates before persisting) and then re-render the
 * snapshot. The webview is stateless beyond the current snapshot: every
 * edit posts a message, the extension validates+p persists, and the new
 * snapshot is pushed back.
 */
export class SettingsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'pocketshell.settings';

	private view?: vscode.WebviewView;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: ConfigStore,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [],
		};
		view.webview.html = this.renderShell();

		view.webview.onDidReceiveMessage(
			(msg) => {
				void this.handleMessage(msg);
			},
			undefined,
			this.context.subscriptions,
		);

		view.onDidDispose(() => {
			this.view = undefined;
		});

		void this.pushSnapshot();
	}

	/** Re-render the current settings into the webview. */
	async refresh(): Promise<void> {
		await this.pushSnapshot();
	}

	// -----------------------------------------------------------------------
	// Message handling
	// -----------------------------------------------------------------------

	private async handleMessage(msg: SettingsViewMessage): Promise<void> {
		if (!this.view) {
			return;
		}

		if (msg.kind === 'update') {
			const result = await writeSetting(this.store, msg.key, msg.value);
			if (!result.ok) {
				await vscode.window.showErrorMessage(result.error ?? 'Invalid setting value');
				await this.pushSnapshot(); // revert UI to the persisted value
				return;
			}
			await this.pushSnapshot();
		} else if (msg.kind === 'reset') {
			const result = await resetSetting(this.store, msg.key);
			if (!result.ok) {
				await vscode.window.showErrorMessage(result.error ?? 'Could not reset setting');
				return;
			}
			await this.pushSnapshot();
		} else if (msg.kind === 'ready') {
			await this.pushSnapshot();
		}
	}

	private async pushSnapshot(): Promise<void> {
		if (!this.view) {
			return;
		}
		const snapshot = readSettings(this.store);
		const payload = snapshot.categories.map((c) => ({
			category: c.category,
			title: c.title,
			entries: c.entries.map((e) => this.entryToWire(e)),
		}));
		await this.view.webview.postMessage({ kind: 'snapshot', categories: payload });
	}

	private entryToWire(entry: SettingEntry) {
		return {
			key: entry.def.key,
			label: entry.def.label,
			description: entry.def.description,
			type: entry.def.type,
			value: entry.value,
			enumValues: entry.def.enumValues,
			isExplicit: entry.isExplicit,
			min: entry.def.min,
			max: entry.def.max,
		};
	}

	// -----------------------------------------------------------------------
	// HTML
	// -----------------------------------------------------------------------

	private renderShell(): string {
		const nonce = getNonce();
		const csp = [
			`default-src 'none'`,
			`img-src ${this.view?.webview.cspSource ?? ''} https:`,
			`style-src 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>PocketShell Settings</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 14px 24px; }
		h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.75; margin: 18px 0 6px; border-bottom: 1px solid var(--vscode-editorWidget-border); padding-bottom: 4px; }
		.row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
		.row .meta { flex: 1; min-width: 0; }
		.row .label { font-weight: 600; }
		.row .desc { font-size: 11px; opacity: 0.75; }
		input[type=text], input[type=number], select {
			background: var(--vscode-input-background); color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px;
			min-width: 140px;
		}
		input.narrow { min-width: 90px; }
		input[type=checkbox] { width: 16px; height: 16px; }
		.explicit { opacity: 0.6; font-style: italic; }
		.controls { display: flex; gap: 6px; }
		.linkbtn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 0; }
	</style>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const root = document.getElementById('root');

		function control(entry) {
			const wrap = document.createElement('div');
			wrap.className = 'row';
			const meta = document.createElement('div');
			meta.className = 'meta';
			const label = document.createElement('div');
			label.className = 'label';
			label.textContent = entry.label + (entry.isExplicit ? '' : ' (default)');
			const desc = document.createElement('div');
			desc.className = 'desc';
			desc.textContent = entry.description;
			meta.appendChild(label);
			meta.appendChild(desc);

			const controls = document.createElement('div');
			controls.className = 'controls';
			let input;
			if (entry.type === 'boolean') {
				input = document.createElement('input');
				input.type = 'checkbox';
				input.checked = !!entry.value;
				input.addEventListener('change', () => {
					vscode.postMessage({ kind: 'update', key: entry.key, value: input.checked });
				});
				controls.appendChild(input);
			} else if (entry.type === 'number') {
				input = document.createElement('input');
				input.type = 'number';
				input.className = 'narrow';
				input.value = entry.value;
				if (entry.min !== undefined && entry.min !== null) input.min = entry.min;
				if (entry.max !== undefined && entry.max !== null) input.max = entry.max;
				input.addEventListener('change', () => {
					vscode.postMessage({ kind: 'update', key: entry.key, value: Number(input.value) });
				});
				controls.appendChild(input);
			} else if (entry.type === 'enum') {
				input = document.createElement('select');
				(entry.enumValues || []).forEach((v) => {
					const opt = document.createElement('option');
					opt.value = v; opt.textContent = v;
					if (v === entry.value) opt.selected = true;
					input.appendChild(opt);
				});
				input.addEventListener('change', () => {
					vscode.postMessage({ kind: 'update', key: entry.key, value: input.value });
				});
				controls.appendChild(input);
			} else {
				input = document.createElement('input');
				input.type = 'text';
				input.value = entry.value;
				input.addEventListener('change', () => {
					vscode.postMessage({ kind: 'update', key: entry.key, value: input.value });
				});
				controls.appendChild(input);
			}

			const reset = document.createElement('button');
			reset.className = 'linkbtn';
			reset.textContent = 'reset';
			reset.title = 'Restore default value';
			reset.disabled = !entry.isExplicit;
			if (!entry.isExplicit) reset.style.visibility = 'hidden';
			reset.addEventListener('click', () => {
				vscode.postMessage({ kind: 'reset', key: entry.key });
			});
			controls.appendChild(reset);

			wrap.appendChild(meta);
			wrap.appendChild(controls);
			return wrap;
		}

		function render(categories) {
			root.innerHTML = '';
			if (!categories.length) {
				root.textContent = 'No settings available.';
				return;
			}
			categories.forEach((cat) => {
				const h = document.createElement('h2');
				h.textContent = cat.title;
				root.appendChild(h);
				cat.entries.forEach((entry) => root.appendChild(control(entry)));
			});
		}

		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg && msg.kind === 'snapshot') {
				render(msg.categories);
			}
		});
		vscode.postMessage({ kind: 'ready' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/** Messages sent from the webview to the extension host. */
type SettingsViewMessage =
	| { kind: 'ready' }
	| { kind: 'update'; key: string; value: unknown }
	| { kind: 'reset'; key: string };
