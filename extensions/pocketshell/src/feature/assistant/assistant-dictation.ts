/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { randomBytes } from 'crypto';
import * as https from 'https';
import {
	createPromptComposerDictationProvider,
	getPromptComposerDictationAvailability,
	readPromptComposerDictationConfig,
	type PromptComposerDictationConfig,
	type PromptComposerDictationRequest,
} from '../../backend/agents/prompt-composer';

/**
 * Voice/dictation reuse for the action assistant (Dispatch 3, piece C).
 *
 * The prompt composer already has a working transcription pipeline
 * (`src/agents/prompt-composer/dictation.ts` + the OpenAI/command transports
 * wired in `prompt-composer-commands.ts`). This module reuses that pipeline to
 * obtain a transcript that feeds straight into the assistant agent loop — it
 * does NOT rebuild transcription. It shares the same dictation config keys
 * (`promptComposerDictation*`) and the same OpenAI dictation key, so the user
 * configures dictation once for both features.
 *
 * The transcription transports (the `exec`-backed local/system command runner
 * and the `https`-backed OpenAI Whisper caller) are the same implementations
 * the prompt composer uses, duplicated here as pure functions because the
 * composer's copies are private to its command module. Keeping them local
 * avoids coupling the two feature modules' command wiring.
 */

/**
 * Read the shared dictation config from vscode settings + the environment
 * (same source the prompt composer reads).
 */
function readDictationConfig(): PromptComposerDictationConfig {
	const config = vscode.workspace.getConfiguration('pocketshell');
	return readPromptComposerDictationConfig(
		{
			promptComposerDictationProvider: config.get<string>('promptComposerDictationProvider'),
			promptComposerDictationCommand: config.get<string>('promptComposerDictationCommand'),
			promptComposerDictationOpenAiApiKey: config.get<string>('promptComposerDictationOpenAiApiKey'),
			promptComposerDictationOpenAiModel: config.get<string>('promptComposerDictationOpenAiModel'),
			promptComposerDictationLanguage: config.get<string>('promptComposerDictationLanguage'),
		},
		process.env,
	);
}

/**
 * Whether dictation is available (a provider other than `none` is configured
 * and the required command/key is present). The assistant's "Dictate..."
 * affordance is only offered when this returns true.
 */
export function assistantDictationAvailable(): boolean {
	return getPromptComposerDictationAvailability(readDictationConfig()).enabled;
}

/**
 * Run the dictation pipeline and return the transcript, or undefined on
 * failure / no transcript (the error is surfaced to the user via a
 * notification). Reuses `createPromptComposerDictationProvider` so behavior
 * matches the prompt composer exactly.
 */
export async function assistantDictate(): Promise<string | undefined> {
	const config = readDictationConfig();
	const provider = createPromptComposerDictationProvider(config, {
		runCommand: runDictationCommand,
		transcribeOpenAi: transcribeOpenAiAudio,
	});
	if (!provider) {
		const availability = getPromptComposerDictationAvailability(config);
		void vscode.window.showWarningMessage(
			vscode.l10n.t(availability.reason ?? 'Dictation is not configured.'),
		);
		return undefined;
	}

	try {
		const transcript = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Transcribing dictation...'),
				cancellable: false,
			},
			() => provider.transcribe(),
		);
		if (!transcript.trim()) {
			void vscode.window.showWarningMessage(
				vscode.l10n.t('Dictation did not return any transcript text.'),
			);
			return undefined;
		}
		return transcript;
	} catch (err) {
		void vscode.window.showErrorMessage(
			vscode.l10n.t('Dictation failed: {0}', err instanceof Error ? err.message : String(err)),
		);
		return undefined;
	}
}

async function runDictationCommand(command: string, request?: PromptComposerDictationRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(command, {
			env: {
				...process.env,
				...(request?.audioPath ? { PROMPT_COMPOSER_DICTATION_AUDIO_PATH: request.audioPath } : {}),
			},
			maxBuffer: 10 * 1024 * 1024,
		}, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || error.message));
				return;
			}
			resolve(stdout);
		});
	});
}

async function transcribeOpenAiAudio(
	request: PromptComposerDictationRequest,
	config: PromptComposerDictationConfig,
): Promise<string> {
	const audio = request.audioData
		? Buffer.from(request.audioData)
		: await readDictationAudioFile(request.audioPath);
	const filename = request.fileName ?? basenameFromPath(request.audioPath) ?? 'dictation.wav';
	const mimeType = request.mimeType ?? mimeTypeFromAudioFileName(filename);
	const body = buildOpenAiTranscriptionBody({
		audio,
		filename,
		mimeType,
		model: config.openAiModel ?? 'whisper-1',
		language: config.language,
	});
	const response = await postOpenAiTranscription(body, config.openAiApiKey ?? '');
	const transcript = parseOpenAiTranscript(response);
	if (!transcript) {
		throw new Error('OpenAI transcription response did not include text');
	}
	return transcript;
}

async function readDictationAudioFile(audioPath?: string): Promise<Buffer> {
	const path = audioPath ?? await pickDictationAudioPath();
	const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
	return Buffer.from(data);
}

async function pickDictationAudioPath(): Promise<string> {
	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		openLabel: vscode.l10n.t('Transcribe'),
		title: vscode.l10n.t('Select audio file for dictation'),
		filters: {
			Audio: ['wav', 'mp3', 'm4a', 'mp4', 'mpeg', 'mpga', 'webm'],
		},
	});
	if (!uris?.[0]) {
		throw new Error('No audio file selected');
	}
	return uris[0].fsPath;
}

function buildOpenAiTranscriptionBody(options: {
	audio: Buffer;
	filename: string;
	mimeType: string;
	model: string;
	language?: string;
}): { body: Buffer; boundary: string } {
	const boundary = `----pocketshell-${randomBytes(12).toString('hex')}`;
	const parts: Buffer[] = [
		multipartField(boundary, 'model', options.model),
	];
	if (options.language) {
		parts.push(multipartField(boundary, 'language', options.language));
	}
	parts.push(Buffer.from(
		`--${boundary}\r\n`
		+ `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(options.filename)}"\r\n`
		+ `Content-Type: ${options.mimeType}\r\n\r\n`,
		'utf8',
	));
	parts.push(options.audio);
	parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
	return { body: Buffer.concat(parts), boundary };
}

function multipartField(boundary: string, name: string, value: string): Buffer {
	return Buffer.from(
		`--${boundary}\r\n`
		+ `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n`
		+ `${value}\r\n`,
		'utf8',
	);
}

async function postOpenAiTranscription(
	payload: { body: Buffer; boundary: string },
	apiKey: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': `multipart/form-data; boundary=${payload.boundary}`,
				'Content-Length': payload.body.length,
			},
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
					reject(new Error(`OpenAI transcription failed (${res.statusCode ?? 'unknown'}): ${body}`));
					return;
				}
				resolve(body);
			});
		});
		req.on('error', reject);
		req.write(payload.body);
		req.end();
	});
}

function parseOpenAiTranscript(body: string): string {
	try {
		const parsed = JSON.parse(body) as { text?: unknown };
		return typeof parsed.text === 'string' ? parsed.text.trim() : '';
	} catch {
		return '';
	}
}

function basenameFromPath(path: string | undefined): string | undefined {
	return path?.split(/[\\/]/).filter(Boolean).pop();
}

function mimeTypeFromAudioFileName(filename: string): string {
	const ext = filename.split('.').pop()?.toLowerCase();
	if (ext === 'mp3' || ext === 'mpeg' || ext === 'mpga') {
		return 'audio/mpeg';
	}
	if (ext === 'm4a' || ext === 'mp4') {
		return 'audio/mp4';
	}
	if (ext === 'webm') {
		return 'audio/webm';
	}
	return 'audio/wav';
}

function escapeMultipartValue(value: string): string {
	return value.replace(/["\r\n]/g, '_');
}
