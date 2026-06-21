/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSpec } from './llm-types';

/**
 * The tool catalog the assistant offers the model, plus the mutating/auto
 * classification that drives the confirm-or-correct gate.
 *
 * Ported verbatim from the Android app's `AssistantTools.kt`. Each entry is a
 * ToolSpec with a JSON-Schema parameter block (raw string, per the contract —
 * the provider clients forward it to OpenAI `parameters` / Anthropic
 * `input_schema`). The names match the dispatch in `assistant-agent-loop.ts`.
 *
 * Mutating tools (MUTATING_TOOLS) generate a candidate and route through the
 * confirm-or-correct gate before AssistantActions is touched. Inspect and
 * navigation tools auto-run. `resolve_folder` is read-only but gets bespoke
 * dispatch (an AMBIGUOUS result suspends on the ChoiceGate).
 *
 * Kept pure / vscode-free so the mirror is byte-identical (lesson #19).
 */
export const GET_CONTEXT = 'get_context';
export const LIST_HOSTS = 'list_hosts';
export const LIST_FOLDERS = 'list_folders';
export const RESOLVE_FOLDER = 'resolve_folder';
export const LIST_SESSIONS = 'list_sessions';
export const LIST_DIRECTORY = 'list_directory';
export const READ_FILE = 'read_file';
export const LIST_REPOS = 'list_repos';

export const OPEN_FOLDER = 'open_folder';
export const OPEN_SESSION = 'open_session';
export const OPEN_SCREEN = 'open_screen';

export const START_SESSION = 'start_session';
export const SEND_PROMPT_TO_SESSION = 'send_prompt_to_session';
export const CREATE_PROJECT = 'create_project';
export const RUN_COMMAND = 'run_command';
export const CREATE_FILE = 'create_file';
export const CLONE_REPO = 'clone_repo';

/** Tools that mutate remote/nav state and must pass the confirm gate. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set<string>([
	START_SESSION,
	SEND_PROMPT_TO_SESSION,
	CREATE_PROJECT,
	RUN_COMMAND,
	CREATE_FILE,
	CLONE_REPO,
]);

export function isMutating(toolName: string): boolean {
	return MUTATING_TOOLS.has(toolName);
}

const NO_ARGS = '{"type":"object","properties":{},"additionalProperties":false}';

/**
 * The full 17-tool catalog. Shipped in Dispatch 1 so Dispatch 2 only fills in
 * the 6 mutating action implementations (the specs themselves don't change).
 */
export const ASSISTANT_TOOLS: readonly ToolSpec[] = [
	{
		name: GET_CONTEXT,
		description:
			'Inspect the current screen, host, session, and working directory. ' +
			'Call this FIRST to resolve references like "this folder", "this dir", ' +
			'"here", or "it" before acting.',
		parametersJsonSchema: NO_ARGS,
	},
	{
		name: LIST_HOSTS,
		description: 'List the saved SSH hosts the user can connect to.',
		parametersJsonSchema: NO_ARGS,
	},
	{
		name: LIST_FOLDERS,
		description: 'List the tmux session folders (working directories) on a host.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"host":{"type":"string","description":"Saved host name."}' +
			'},"required":["host"],"additionalProperties":false}',
	},
	{
		name: RESOLVE_FOLDER,
		description:
			'Resolve a fuzzy, spoken folder name to an exact working directory on a ' +
			'host BEFORE starting a session. Call this when the user names a folder loosely ' +
			'(e.g. "the workshops folder") instead of giving an absolute path. It searches ' +
			'the full set of known folders on the host and returns one of: a single confident ' +
			'match (use its cwd in start_session), an ambiguous result (the user is asked which ' +
			'one and the chosen cwd is returned to you — then call start_session with it), or no ' +
			'match (tell the user it wasn\'t found and list the nearest folders). Never invent a ' +
			'cwd; always resolve it through this tool first. If get_context happens to show a ' +
			'matching path for a spoken project name, still call this tool before acting.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"host":{"type":"string","description":"Saved host name."},' +
			'"query":{"type":"string","description":"The fuzzy folder name the user said."}' +
			'},"required":["host","query"],"additionalProperties":false}',
	},
	{
		name: LIST_SESSIONS,
		description: 'List the tmux sessions on a host.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"host":{"type":"string","description":"Saved host name."}' +
			'},"required":["host"],"additionalProperties":false}',
	},
	{
		name: LIST_DIRECTORY,
		description: 'List the contents of a directory on the active host.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"path":{"type":"string","description":"Absolute or ~-relative directory path."}' +
			'},"required":["path"],"additionalProperties":false}',
	},
	{
		name: READ_FILE,
		description: 'Read the beginning of a text file on the active host.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"path":{"type":"string","description":"Absolute or ~-relative file path."}' +
			'},"required":["path"],"additionalProperties":false}',
	},
	{
		name: LIST_REPOS,
		description:
			'List the user\'s GitHub repositories (and which are already cloned ' +
			'on the active host) via the server-side pocketshell repos CLI.',
		parametersJsonSchema: NO_ARGS,
	},
	{
		name: OPEN_FOLDER,
		description:
			'Open / navigate to a folder (working directory) on a host. ' +
			'This is a navigation action and runs without confirmation.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"host":{"type":"string","description":"Saved host name."},' +
			'"path":{"type":"string","description":"Absolute folder path on the host."}' +
			'},"required":["host","path"],"additionalProperties":false}',
	},
	{
		name: OPEN_SESSION,
		description:
			'Open / attach to an existing tmux session by name on the active host. ' +
			'Navigation action; runs without confirmation.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"session_name":{"type":"string","description":"Existing tmux session name."}' +
			'},"required":["session_name"],"additionalProperties":false}',
	},
	{
		name: OPEN_SCREEN,
		description:
			'Navigate to a named app screen. Allowed: hosts, settings, usage, ' +
			'ai_costs, crash_reports.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"destination":{"type":"string","description":"Screen name.",' +
			'"enum":["hosts","settings","usage","ai_costs","crash_reports"]}' +
			'},"required":["destination"],"additionalProperties":false}',
	},
	{
		name: START_SESSION,
		description:
			'Start a new tmux session on a host in a working directory, launching ' +
			'an agent CLI. MUTATING: the user confirms the candidate before it runs.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"host":{"type":"string","description":"Saved host name."},' +
			'"cwd":{"type":"string","description":"Absolute working-directory path."},' +
			'"agent":{"type":"string","description":"Agent to launch.",' +
			'"enum":["claude","codex","opencode","shell"]}' +
			'},"required":["host","cwd","agent"],"additionalProperties":false}',
	},
	{
		name: SEND_PROMPT_TO_SESSION,
		description:
			'Send a task prompt to an agent session after it has been started or opened. ' +
			'Use this for action sequences like: resolve a project, start a Codex session in it, ' +
			'then send the user\'s requested task prompt to that session. MUTATING: the user ' +
			'confirms the exact target session and prompt before it runs. Preserve the user\'s ' +
			'language in the prompt; normalize obvious dictation typos but do not translate it.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"session_name":{"type":"string","description":"Target tmux session name returned by start_session or listed by list_sessions."},' +
			'"prompt":{"type":"string","description":"The exact task prompt to send to the agent session."}' +
			'},"required":["session_name","prompt"],"additionalProperties":false}',
	},
	{
		name: CREATE_PROJECT,
		description:
			'Create an empty project folder under a configured workspace root on ' +
			'a host. MUTATING: the user confirms the parent path and folder name before it runs.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"host":{"type":"string","description":"Saved host name."},' +
			'"parent_path":{"type":"string","description":"Absolute or ~-relative parent directory."},' +
			'"folder_name":{"type":"string","description":"New project folder name."}' +
			'},"required":["host","parent_path","folder_name"],"additionalProperties":false}',
	},
	{
		name: RUN_COMMAND,
		description:
			'Run a single shell command in the active terminal (also handles ' +
			'"cd to ..."). MUTATING: the user confirms the exact command before it runs. ' +
			'Dangerous commands (sudo, rm -rf, shutdown, dd, mkfs, writes to raw block ' +
			'devices) are blocked. Do not use run_command to perform code-editing tasks in a ' +
			'named project; resolve the project, start an agent session, and send the task ' +
			'prompt to that session instead.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"command":{"type":"string","description":"The exact shell command to run."}' +
			'},"required":["command"],"additionalProperties":false}',
	},
	{
		name: CREATE_FILE,
		description:
			'Create a file with the given contents on the active host. ' +
			'MUTATING: the user confirms before it runs.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"path":{"type":"string","description":"Absolute or ~-relative file path."},' +
			'"content":{"type":"string","description":"File contents."}' +
			'},"required":["path","content"],"additionalProperties":false}',
	},
	{
		name: CLONE_REPO,
		description:
			'Clone a GitHub repository onto the active host via the server-side ' +
			'pocketshell repos CLI (no client-side GitHub credentials). MUTATING: the user ' +
			'confirms before it runs. After a successful clone you may open the new folder ' +
			'or start a session in it.',
		parametersJsonSchema:
			'{"type":"object","properties":{' +
			'"full_name":{"type":"string","description":"owner/repo full name."},' +
			'"folder":{"type":"string","description":"Optional clone root directory."}' +
			'},"required":["full_name"],"additionalProperties":false}',
	},
];

/**
 * The system prompt, ported verbatim from `AssistantAgentLoop.SYSTEM_PROMPT`.
 * The desktop adaptation note: the prompt is unchanged; the desktop-only
 * "active session" concept is surfaced through get_context (the desktop action
 * resolves the last-active PocketShell terminal).
 */
export const SYSTEM_PROMPT =
	'You are PocketShell\'s in-app action assistant. The user dictates or types a ' +
	'request; you inspect app state and perform actions through the provided tools. ' +
	'Resolve references like "this folder", "here", or "it" by calling ' +
	'get_context FIRST. When the user names a folder loosely instead of giving an ' +
	'absolute path (e.g. "open Claude in the workshops folder"), call resolve_folder ' +
	'to turn it into an exact cwd before using that project path in any other tool, ' +
	'even if get_context lists a likely matching path — never invent or copy a path ' +
	'for a spoken project name. If resolve_folder reports a confident match or the ' +
	'user has picked one, call start_session with that cwd; if it finds no match, ' +
	'tell the user and stop. ' +
	'Prefer inspect tools before acting. Mutating tools ' +
	'(run_command, create_file, start_session, send_prompt_to_session, ' +
	'create_project, clone_repo) are confirmed by the user ' +
	'before they run; if the user corrects you, revise the candidate and try again. ' +
	'For requests to start an agent in a project and give it a task, produce the ' +
	'structured sequence: inspect/resolve the project, start_session with the chosen ' +
	'cwd and agent, then send_prompt_to_session with the user\'s task prompt. ' +
	'Treat code-editing tasks that name a project the same way: do not use ' +
	'list_directory, read_file, run_command, or create_file to perform the edit ' +
	'yourself. Resolve the project, start a coding agent there, and send the user\'s ' +
	'task prompt to that agent. Default to the codex agent when the user does not ' +
	'specify an agent. Normalize obvious speech ' +
	'recognition typos in the prompt sent to the agent without changing the task. ' +
	'Preserve the user\'s language in prompts sent to agent sessions; do not translate ' +
	'or paraphrase them. ' +
	'Keep shell commands short and non-interactive. When the task is complete, reply ' +
	'with a brief confirmation and stop calling tools.';
