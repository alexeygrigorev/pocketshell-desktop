/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure state for the Jobs webview panel (feature parity with the PocketShell
 * Android app's RecurringJobs screen). Mirrors the app's per-job row layout:
 * a status dot (enabled/paused — here running/queued vs completed/failed),
 * the job detail, the schedule line (`session | status | startedAt`), and a
 * cancel action.
 *
 * Kept free of vscode imports so it is unit-testable in isolation.
 */

import type { AgentJob, JobStatus } from '../../jobs/types';

/**
 * Tone for the status pill, aligned with the app's StatusDot vocabulary.
 * Active jobs (running/queued) read as "active"; terminal-failed as "error";
 * clean terminal states as "idle".
 */
export type JobCardStatus = 'active' | 'idle' | 'error';

export interface JobsPanelRow {
	/** Stable key for keyed rendering. */
	rowId: string;
	/** Job id. */
	id: string;
	/** Agent engine the job runs under. */
	agentType: string;
	/** Lifecycle status from the helper. */
	status: JobStatus;
	/** Derived card tone for the status pill. */
	cardStatus: JobCardStatus;
	/** Description of what the job is doing. */
	command: string;
	/** Optional originating session. */
	sessionId?: string;
	/** ms epoch the job started. */
	startedAt: number;
	/** Optional ms epoch the job completed. */
	completedAt?: number;
	/** Optional exit code. */
	exitCode?: number;
	/** Optional working directory. */
	cwd?: string;
}

export interface JobsPanelModel {
	title: string;
	hostName: string;
	rows: JobsPanelRow[];
	/** Status banner, if any. */
	status?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string };
	/** True while a load/mutation is in flight. */
	loading: boolean;
	/** Whether the underlying SSH connection is live. */
	connected: boolean;
	emptyText: string;
}

export interface JobsPanelStateInput {
	hostName: string;
	jobs: readonly AgentJob[];
	connected: boolean;
	loading?: boolean;
	status?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string };
}

/**
 * Map a lifecycle status to the app's card tone. Exported for unit testing.
 */
export function jobCardStatus(status: JobStatus): JobCardStatus {
	switch (status) {
		case 'running':
		case 'queued':
			return 'active';
		case 'failed':
		case 'cancelled':
			return 'error';
		case 'completed':
		default:
			return 'idle';
	}
}

/**
 * Build the panel model from raw jobs. Pure function.
 */
export function buildJobsPanelModel(input: JobsPanelStateInput): JobsPanelModel {
	const rows: JobsPanelRow[] = [...input.jobs]
		// Newest/most-relevant first: running > queued > failed > cancelled > completed,
		// then by most recent startedAt.
		.sort((a, b) => {
			const ra = rankStatus(a.status);
			const rb = rankStatus(b.status);
			if (ra !== rb) {
				return ra - rb;
			}
			return b.startedAt - a.startedAt;
		})
		.map((job) => ({
			rowId: job.id,
			id: job.id,
			agentType: job.agentType,
			status: job.status,
			cardStatus: jobCardStatus(job.status),
			command: job.command,
			sessionId: job.sessionId,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
			exitCode: job.exitCode,
			cwd: job.cwd,
		}));

	return {
		title: `Jobs — ${input.hostName}`,
		hostName: input.hostName,
		rows,
		status: input.status,
		loading: input.loading ?? false,
		connected: input.connected,
		emptyText: rows.length === 0
			? 'No agent jobs on this host yet. Jobs surfaced here are recurring tmux-send schedules.'
			: '',
	};
}

function rankStatus(status: JobStatus): number {
	switch (status) {
		case 'running':
			return 0;
		case 'queued':
			return 1;
		case 'failed':
			return 2;
		case 'cancelled':
			return 3;
		case 'completed':
		default:
			return 4;
	}
}
