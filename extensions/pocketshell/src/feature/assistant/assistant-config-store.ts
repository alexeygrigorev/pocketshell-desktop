/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type {
	AssistantProvider,
	AssistantProviderConfig,
} from '../../backend/assistant/llm-types';
import {
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_ANTHROPIC_MODEL,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENAI_MODEL,
	DEFAULT_PROVIDER,
	DEFAULT_ZAI_BASE_URL,
	DEFAULT_ZAI_MODEL,
	providerFromName,
} from '../../backend/assistant/llm-types';

/**
 * SecretStorage-backed assistant config (orchestrator decision #3).
 *
 * The API key flows ONLY `vscode.SecretStorage` -> in-memory -> Authorization
 * header; it is NEVER logged, NEVER written to plaintext settings /
 * OutputChannel / trace events. Provider + baseUrl + model live in
 * `vscode.workspace.getConfiguration('pocketshell')` under the `assistant`
 * category (display-safe, non-secret).
 *
 * This is the desktop analog of the app's `AndroidKeystoreAssistantConfigStore`
 * — deliberately NOT repeating the dictation key's plaintext-settings weakness.
 *
 * Lives in the feature layer (NOT mirrored): it depends on vscode.SecretStorage.
 */

const SECRET_KEY_OPENAI = 'pocketshell.assistant.openaiApiKey';
const SECRET_KEY_ANTHROPIC = 'pocketshell.assistant.anthropicApiKey';
const SECRET_KEY_ZAI = 'pocketshell.assistant.zaiApiKey';

const CONFIG_CATEGORY = 'pocketshell';
const CONFIG_SECTION = 'assistant';

/** Display-safe (non-secret) per-provider settings. */
export interface AssistantSettings {
	readonly provider: AssistantProvider;
	readonly openAiBaseUrl: string;
	readonly openAiModel: string;
	readonly anthropicBaseUrl: string;
	readonly anthropicModel: string;
	readonly zaiBaseUrl: string;
	readonly zaiModel: string;
}

export const AssistantSettings = {
	defaults(): AssistantSettings {
		return {
			provider: DEFAULT_PROVIDER,
			openAiBaseUrl: DEFAULT_OPENAI_BASE_URL,
			openAiModel: DEFAULT_OPENAI_MODEL,
			anthropicBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
			anthropicModel: DEFAULT_ANTHROPIC_MODEL,
			zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
			zaiModel: DEFAULT_ZAI_MODEL,
		};
	},
};

/** Read display-safe settings from the vscode config. */
export function loadAssistantSettings(): AssistantSettings {
	const config = vscode.workspace.getConfiguration(CONFIG_CATEGORY);
	const provider = providerFromName(config.get<string>(`${CONFIG_SECTION}.provider`));
	const readString = (key: string, fallback: string): string => {
		const v = config.get<string>(key);
		return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
	};
	return {
		provider,
		openAiBaseUrl: readString(`${CONFIG_SECTION}.openAiBaseUrl`, DEFAULT_OPENAI_BASE_URL),
		openAiModel: readString(`${CONFIG_SECTION}.openAiModel`, DEFAULT_OPENAI_MODEL),
		anthropicBaseUrl: readString(`${CONFIG_SECTION}.anthropicBaseUrl`, DEFAULT_ANTHROPIC_BASE_URL),
		anthropicModel: readString(`${CONFIG_SECTION}.anthropicModel`, DEFAULT_ANTHROPIC_MODEL),
		zaiBaseUrl: readString(`${CONFIG_SECTION}.zaiBaseUrl`, DEFAULT_ZAI_BASE_URL),
		zaiModel: readString(`${CONFIG_SECTION}.zaiModel`, DEFAULT_ZAI_MODEL),
	};
}

function secretKeyFor(provider: AssistantProvider): string {
	switch (provider) {
		case 'openai':
			return SECRET_KEY_OPENAI;
		case 'anthropic':
			return SECRET_KEY_ANTHROPIC;
		case 'zai':
			return SECRET_KEY_ZAI;
	}
}

/**
 * Load the resolved provider config (API key + baseUrl + model) for the active
 * provider, or null if no key is stored yet. The returned key is a transient
 * string — the caller (the client) builds the Authorization header from it and
 * drops the reference. Returns null (not throws) so the caller can route the
 * user through key entry.
 */
export async function loadProviderConfig(
	context: vscode.ExtensionContext,
	settings?: AssistantSettings,
): Promise<AssistantProviderConfig | null> {
	const s = settings ?? loadAssistantSettings();
	const apiKey = await context.secrets.get(secretKeyFor(s.provider));
	if (!apiKey || apiKey.length === 0) {
		return null;
	}
	return configFor(s.provider, s, apiKey);
}

/** Store the API key for `provider` in SecretStorage. */
export async function saveApiKey(
	context: vscode.ExtensionContext,
	provider: AssistantProvider,
	key: string,
): Promise<void> {
	await context.secrets.store(secretKeyFor(provider), key);
}

/** Remove the API key for `provider`. */
export async function clearApiKey(
	context: vscode.ExtensionContext,
	provider: AssistantProvider,
): Promise<void> {
	await context.secrets.delete(secretKeyFor(provider));
}

/** Build a AssistantProviderConfig from the active settings + a key. */
function configFor(
	provider: AssistantProvider,
	settings: AssistantSettings,
	apiKey: string,
): AssistantProviderConfig {
	switch (provider) {
		case 'openai':
			return { apiKey, baseUrl: settings.openAiBaseUrl, model: settings.openAiModel };
		case 'anthropic':
			return { apiKey, baseUrl: settings.anthropicBaseUrl, model: settings.anthropicModel };
		case 'zai':
			return { apiKey, baseUrl: settings.zaiBaseUrl, model: settings.zaiModel };
	}
}
