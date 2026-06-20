/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure state for the Logs webview panel. This is a desktop-only diagnostic
 * surface (the Android app consumes `logs ingest`/`logs tail` server-side but
 * has no standalone Logs screen). Designed as a bounded streaming tail: the
 * panel keeps the most recent `maxEntries` lines and the webview auto-scrolls
 * to the bottom on new data.
 *
 * Kept free of vscode imports so it is unit-testable in isolation.
 */

import type { LogEntry, LogLevel } from '../../integrations/logs/types';

/** Tone for a log level, mapped to vscode status colors. */
export type LogLineTone = 'debug' | 'info' | 'warn' | 'error';

export interface LogsPanelLine {
	/** Stable monotonic sequence (assigned by the panel, not the entry). */
	seq: number;
	/** ms epoch from the entry. */
	timestamp: number;
	level: LogLevel;
	tone: LogLineTone;
	message: string;
	/** Originating component, if available. */
	source?: string;
}

export interface LogsPanelModel {
	title: string;
	hostName: string;
	lines: LogsPanelLine[];
	/** True while connected and tailing. */
	tailing: boolean;
	/** Whether the underlying SSH connection is live. */
	connected: boolean;
	/** Count of lines dropped from the head to honour the bound. */
	dropped: number;
	/** Total lines seen this session (before bounding). */
	totalSeen: number;
	emptyText: string;
	/** Status banner, if any. */
	status?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string };
}

export interface LogsPanelStateInput {
	hostName: string;
	/** Entries to render (already bounded by the caller if desired). */
	entries: readonly LogEntry[];
	/** Cap on retained lines; older entries beyond this are dropped. */
	maxEntries: number;
	connected: boolean;
	tailing: boolean;
	/** Running totals carried across renders (dropped + totalSeen). */
	previousDropped?: number;
	previousTotalSeen?: number;
	/** Starting sequence for newly added entries. */
	startSeq?: number;
	status?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string };
}

/**
 * Map a log level to a render tone. Exported for unit testing.
 */
export function logLineTone(level: LogLevel): LogLineTone {
	return level;
}

/**
 * Build a bounded panel model from raw entries. Entries are sorted ascending
 * by timestamp (oldest first, matching tail output order) and capped to
 * `maxEntries`; the count of dropped head entries is reported back. Pure
 * function.
 */
export function buildLogsPanelModel(input: LogsPanelStateInput): LogsPanelModel {
	const maxEntries = Math.max(0, input.maxEntries);
	const startSeq = input.startSeq ?? 0;
	const previousTotalSeen = input.previousTotalSeen ?? 0;

	// Stable order: by timestamp ascending; entries are assumed already in
	// arrival order from the tail, so we preserve input order on ties.
	const sorted = [...input.entries].sort((a, b) => a.timestamp - b.timestamp);
	const totalSeen = previousTotalSeen + sorted.length;

	// Bound: keep the most recent `maxEntries`. Head entries beyond the cap
	// accumulate into `dropped`.
	let dropped = input.previousDropped ?? 0;
	let bounded = sorted;
	let firstSeq = startSeq;
	if (sorted.length > maxEntries) {
		const overflow = sorted.length - maxEntries;
		dropped += overflow;
		bounded = sorted.slice(sorted.length - maxEntries);
		firstSeq = startSeq + overflow;
	}

	const lines: LogsPanelLine[] = bounded.map((entry, index) => ({
		seq: firstSeq + index,
		timestamp: entry.timestamp,
		level: entry.level,
		tone: logLineTone(entry.level),
		message: entry.message,
		source: entry.source,
	}));

	return {
		title: `Logs — ${input.hostName}`,
		hostName: input.hostName,
		lines,
		tailing: input.tailing,
		connected: input.connected,
		dropped,
		totalSeen,
		emptyText: lines.length === 0
			? 'No log entries yet. Logs surface the remote `pocketshell logs` trace stream.'
			: '',
		status: input.status,
	};
}
