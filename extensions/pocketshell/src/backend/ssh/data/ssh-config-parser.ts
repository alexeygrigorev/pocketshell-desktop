import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshConfigHost {
	host: string;
	patterns?: string[];
	hostname?: string;
	port?: number;
	invalidPort?: string;
	user?: string;
	identityFile?: string;
	identityFiles?: string[];
	proxyCommand?: string;
	proxyJump?: string;
	strictHostKeyChecking?: string;
	userKnownHostsFile?: string;
	extra: Record<string, string>;
}

export function parseSshConfig(configPath?: string): SshConfigHost[] {
	const resolvedPath = configPath ?? path.join(os.homedir(), '.ssh', 'config');
	if (!fs.existsSync(resolvedPath)) {
		return [];
	}
	return parseSshConfigString(fs.readFileSync(resolvedPath, 'utf-8'));
}

export function parseSshConfigString(content: string): SshConfigHost[] {
	const hosts: SshConfigHost[] = [];
	let current: SshConfigHost | null = null;

	for (const rawLine of content.split('\n')) {
		const commentIdx = rawLine.indexOf('#');
		const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
		if (line.length === 0) {
			continue;
		}

		const parsed = parseDirective(line);
		if (!parsed) {
			continue;
		}

		const { keyword, value } = parsed;
		if (keyword === 'host') {
			if (current) {
				hosts.push(current);
			}
			current = { host: value, patterns: splitHostPatterns(value), extra: {} };
			continue;
		}

		if (!current) {
			continue;
		}

		switch (keyword) {
			case 'hostname':
				current.hostname = value;
				break;
			case 'port':
				current.port = parsePort(value);
				if (current.port === undefined) {
					current.port = undefined;
					current.invalidPort = value;
				}
				break;
			case 'user':
				current.user = value;
				break;
			case 'identityfile':
				current.identityFiles = current.identityFiles ?? [];
				current.identityFiles.push(expandPath(value));
				current.identityFile = current.identityFile ?? current.identityFiles[0];
				break;
			case 'proxycommand':
				current.proxyCommand = value;
				break;
			case 'proxyjump':
				current.proxyJump = value;
				break;
			case 'stricthostkeychecking':
				current.strictHostKeyChecking = value;
				break;
			case 'userknownhostsfile':
				current.userKnownHostsFile = value;
				break;
			default:
				current.extra[keyword] = value;
				break;
		}
	}

	if (current) {
		hosts.push(current);
	}

	return hosts;
}

export function filterConcreteHosts(hosts: SshConfigHost[]): SshConfigHost[] {
	return hosts.filter((host) => !host.host.includes('*') && !host.host.includes('?'));
}

function parseDirective(line: string): { keyword: string; value: string } | null {
	const eqIdx = line.indexOf('=');
	if (eqIdx > 0) {
		const keyword = line.slice(0, eqIdx).trim().toLowerCase();
		const value = unquote(line.slice(eqIdx + 1).trim());
		if (keyword && value) {
			return { keyword, value };
		}
	}

	const spaceIdx = line.search(/\s/);
	if (spaceIdx <= 0) {
		return null;
	}

	const keyword = line.slice(0, spaceIdx).trim().toLowerCase();
	const value = unquote(line.slice(spaceIdx + 1).trim());
	if (keyword && value) {
		return { keyword, value };
	}
	return null;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}
	return value;
}

function expandPath(value: string): string {
	if (value === '~' || value.startsWith('~/')) {
		return path.join(os.homedir(), value.slice(1));
	}
	return value;
}

function splitHostPatterns(value: string): string[] {
	return value.split(/\s+/).map(pattern => pattern.trim()).filter(Boolean);
}

function parsePort(value: string): number | undefined {
	if (!/^\d+$/.test(value)) {
		return undefined;
	}
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return undefined;
	}
	return port;
}
