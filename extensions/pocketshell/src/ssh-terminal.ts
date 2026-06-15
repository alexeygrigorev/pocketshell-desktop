/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SshTerminalBackend } from './backend/terminal/ssh-terminal-backend';
import type { SshConnection } from './backend/ssh/connection/ssh-client';
import type { DiagnosticRecordInput } from './backend/diagnostics';
import type { TerminalOptions } from './backend/terminal/types';

/**
 * VS Code Pseudoterminal backed by an SSH session.
 *
 * Bridges VS Code's terminal widget with the PocketShell SshTerminalBackend,
 * forwarding keystrokes to the remote PTY and rendering remote output in the
 * VS Code terminal panel.
 */
export class SshPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	private backend: SshTerminalBackend | undefined;

	readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
	readonly onDidClose: vscode.Event<number> = this.closeEmitter.event;

	constructor(
		private readonly connection: SshConnection,
		private readonly hostName: string,
		private readonly diagnostics?: (input: DiagnosticRecordInput) => void,
		private readonly options: Pick<TerminalOptions, 'cwd' | 'initialCommand'> = {},
	) {}

	/**
	 * Called by VS Code when the terminal is opened.
	 *
	 * Creates and starts the SSH terminal backend, wiring up events.
	 */
	async open(_initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
		this.diagnostics?.({
			category: 'ssh',
			name: 'terminal_start_started',
			metadata: {
				hostname: this.hostName,
				cols: _initialDimensions?.columns ?? null,
				rows: _initialDimensions?.rows ?? null,
			},
		});
		this.backend = new SshTerminalBackend(this.connection, {
			name: this.hostName,
			cwd: this.options.cwd,
			initialCommand: this.options.initialCommand,
			cols: _initialDimensions?.columns,
			rows: _initialDimensions?.rows,
		});

		// Wire backend output -> VS Code terminal
		this.backend.onData((data: string) => {
			this.writeEmitter.fire(data);
		});

		// Wire backend exit -> VS Code terminal close
		this.backend.onExit(({ exitCode }: { exitCode: number }) => {
			this.diagnostics?.({
				category: 'ssh',
				name: 'terminal_exited',
				metadata: { hostname: this.hostName, exitCode },
			});
			this.closeEmitter.fire(exitCode);
		});

		try {
			await this.backend.start();
			this.diagnostics?.({
				category: 'ssh',
				name: 'terminal_start_succeeded',
				metadata: { hostname: this.hostName },
			});
		} catch (err) {
			this.diagnostics?.({
				category: 'ssh',
				name: 'terminal_start_failed',
				metadata: {
					hostname: this.hostName,
					error: err instanceof Error ? err.message : String(err),
				},
			});
			this.writeEmitter.fire(`\r\n\x1b[31mFailed to start SSH terminal: ${err}\x1b[0m\r\n`);
			this.closeEmitter.fire(1);
		}
	}

	/**
	 * Called by VS Code when the terminal is closed by the user.
	 */
	close(): void {
		if (this.backend) {
			this.backend.kill();
			this.backend = undefined;
		}
	}

	/**
	 * Called by VS Code when the user types in the terminal.
	 */
	handleInput(data: string): void {
		if (this.backend) {
			this.backend.write(data);
		}
	}

	/**
	 * Called by VS Code when the terminal is resized.
	 */
	setDimensions(dimensions: vscode.TerminalDimensions): void {
		if (this.backend) {
			this.backend.resize(dimensions.columns, dimensions.rows);
		}
	}
}
