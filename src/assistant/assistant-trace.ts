/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structured trace emission types for assistant tool dispatches (issue #270
 * contract, consumed by the agent loop).
 *
 * Ported from the Android app's `AssistantTraceSink.kt`. Every tool dispatch —
 * especially every mutating action — emits a trace event of shape:
 *
 * ```
 * {ts, source=desktop, kind=agent_action, action, target_host, cwd?,
 *  args(REDACTED), result, install_id, session_id?}
 * ```
 *
 * Secret hygiene: this layer never puts raw secret values into `args`. The loop
 * redacts secret-bearing fields (file contents, env values) to `<redacted>`
 * before building the event. The desktop-only SSH-piping sink (pipes JSON to
 * `pocketshell logs ingest -` over SSH, no-op on failure) lives in the feature
 * layer; the NoOp sink here is used when no host is connected and in tests.
 *
 * Kept pure / vscode-free so the mirror is byte-identical (lesson #19).
 */

/** A single agent-action trace event. `args` is already redacted by the caller. */
export interface AssistantTraceEvent {
	readonly action: string;
	readonly targetHost: string | null;
	readonly cwd: string | null;
	/** Already redacted — secret values must never reach this object. */
	readonly args: Record<string, string>;
	readonly result: string;
	readonly installId: string;
	readonly sessionId: string | null;
	readonly timestampMillis?: number;
}

/** Trace sink seam. The loop owns no SSH types — it only calls emit(). */
export interface AssistantTraceSink {
	emit(event: AssistantTraceEvent): void;
}

/** A trace sink that drops every event — used when no host is connected. */
export const NOOP_TRACE_SINK: AssistantTraceSink = {
	emit() {
		/* no-op */
	},
};

/** Sentinel redaction token, matching the app. */
export const REDACTED = '<redacted>';

/**
 * Serialize to the #270 ingest JSON shape. `ts` is epoch millis; `source` is
 * `desktop` on the desktop port (the app uses `phone`); `kind` is fixed.
 */
export function traceEventToJson(event: AssistantTraceEvent): string {
	const ts = event.timestampMillis ?? Date.now();
	const args: Record<string, string> = {};
	for (const [k, v] of Object.entries(event.args)) args[k] = v;
	return JSON.stringify({
		ts,
		source: 'desktop',
		kind: 'agent_action',
		action: event.action,
		target_host: event.targetHost ?? null,
		cwd: event.cwd ?? null,
		args,
		result: event.result,
		install_id: event.installId,
		session_id: event.sessionId ?? null,
	});
}
