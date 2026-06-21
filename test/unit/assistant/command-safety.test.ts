/**
 * CommandSafety tests — the mutating-action guard.
 *
 * Validates rejectCommand against ALL 9 forbidden patterns (anchored on
 * statement boundaries so they fire mid-pipeline too) plus the edge cases
 * (empty, >500 chars, control chars). Ported to mirror the app's
 * `CommandSafety` tests.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_FORBIDDEN_PATTERNS,
	MAX_COMMAND_LENGTH,
	rejectCommand,
} from '../../../src/assistant/command-safety';

describe('CommandSafety — safe commands', () => {
	it('accepts a plain safe command', () => {
		expect(rejectCommand('ls -la')).toBeNull();
	});

	it('accepts a multi-statement payload without forbidden patterns', () => {
		expect(rejectCommand('echo hi && git status')).toBeNull();
	});

	it('accepts a pipeline without forbidden patterns', () => {
		expect(rejectCommand('cat file | grep foo')).toBeNull();
	});
});

describe('CommandSafety — all 9 forbidden patterns', () => {
	const cases: Array<{ name: string; command: string }> = [
		{ name: 'sudo', command: 'sudo rm /etc/passwd' },
		{ name: 'su', command: 'su root' },
		{ name: 'rm -rf', command: 'rm -rf /' },
		{ name: 'rm -fr (variant)', command: 'rm -fr /tmp/junk' },
		{ name: 'shutdown', command: 'shutdown -h now' },
		{ name: 'reboot', command: 'reboot' },
		{ name: 'halt', command: 'halt' },
		{ name: 'mkfs', command: 'mkfs.ext4 /dev/sda1' },
		{ name: 'mkfs (space form)', command: 'mkfs /dev/sda1' },
		{ name: 'dd', command: 'dd if=/dev/zero of=/dev/sda' },
		{ name: 'redirect to /dev/sd', command: 'echo x > /dev/sda' },
		{ name: 'redirect to /dev/nvme', command: 'echo x > /dev/nvme0n1' },
		{ name: 'redirect to /dev/mapper/', command: 'echo x > /dev/mapper/vg-root' },
	];
	for (const { name, command } of cases) {
		it(`rejects ${name}: ${command}`, () => {
			const reason = rejectCommand(command);
			expect(reason).not.toBeNull();
			expect(reason).toContain('safety rule');
		});
	}

	it('exposes exactly 9 default forbidden patterns', () => {
		expect(DEFAULT_FORBIDDEN_PATTERNS).toHaveLength(9);
	});
});

describe('CommandSafety — mid-pipeline anchoring', () => {
	// The patterns are anchored on `(^|[;&|]\s*)` so a forbidden command
	// appearing mid-pipeline is also rejected.
	const midPipelineCases: Array<{ name: string; command: string }> = [
		{ name: 'sudo after &&', command: 'echo ok && sudo rm /etc/passwd' },
		{ name: 'rm -rf after ;', command: 'echo ok; rm -rf /home' },
		{ name: 'shutdown after |', command: 'true | shutdown now' },
		{ name: 'dd after &&', command: 'cd /tmp && dd if=/dev/zero of=/dev/sda' },
		{ name: 'mkfs after ;', command: 'true; mkfs.ext4 /dev/sda1' },
	];
	for (const { name, command } of midPipelineCases) {
		it(`rejects ${name}`, () => {
			expect(rejectCommand(command)).not.toBeNull();
		});
	}
});

describe('CommandSafety — edge cases', () => {
	it('rejects an empty command', () => {
		expect(rejectCommand('')).toBe('The proposed command was empty.');
	});

	it('rejects a whitespace-only command', () => {
		expect(rejectCommand('   \t  ')).toBe('The proposed command was empty.');
	});

	it('rejects a command over the length cap', () => {
		const tooLong = 'a'.repeat(MAX_COMMAND_LENGTH + 1);
		const reason = rejectCommand(tooLong);
		expect(reason).not.toBeNull();
		expect(reason).toContain('too long');
		expect(reason).toContain(String(MAX_COMMAND_LENGTH));
	});

	it('accepts a command exactly at the length cap', () => {
		const atCap = 'a'.repeat(MAX_COMMAND_LENGTH);
		expect(rejectCommand(atCap)).toBeNull();
	});

	it('rejects a NUL control character', () => {
		expect(rejectCommand('ls\0rm')).toBe('The proposed command contained a control character.');
	});

	it('rejects a carriage return in the middle of a command', () => {
		// A trailing \r is removed by trim() before the control-char check, so
		// place it mid-command (the realistic injection vector).
		expect(rejectCommand('echo hi\recho bye')).toBe('The proposed command contained a control character.');
	});

	it('rejects a newline', () => {
		expect(rejectCommand('echo hi\nsudo rm -rf /')).toBe('The proposed command contained a control character.');
	});

	it('is case-insensitive (SUDO matches)', () => {
		expect(rejectCommand('SUDO rm /etc/passwd')).not.toBeNull();
	});

	it('does NOT reject commands that merely contain the substring (no boundary)', () => {
		// `sudo` must be anchored at start or after a statement boundary. A
		// bare word containing "sudo" as a substring without a boundary is
		// still rejected because `sudo` matches at the start of the token —
		// but `pseudo` should NOT match (it's a different word).
		expect(rejectCommand('pseudocode --run')).toBeNull();
	});
});
