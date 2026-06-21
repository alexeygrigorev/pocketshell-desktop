/**
 * Pure-helper unit tests for the action-assistant mutating tools (Dispatch 2).
 *
 * These cover the validation / command-building helpers that the 6 mutating
 * actions delegate to: agent-name → SessionKind mapping, path-traversal /
 * safe-folder-name rejection, mkdir / clone-target / clone-url construction,
 * and the collision-guarded create_file heredoc.
 *
 * The helpers are pure (no vscode / SSH / tmux), so these run without the
 * extension host. Mirrored from src/assistant/mutating-helpers.ts (lesson #19).
 */

import { describe, it, expect } from 'vitest';
import {
	mapAgentNameToSessionKind,
	hasPathTraversal,
	isSafeFolderName,
	shellQuote,
	joinPath,
	buildMkdirCommand,
	buildCreatedPath,
	buildCloneTarget,
	repoNameFromFullName,
	buildCloneUrl,
	buildCreateFileHeredoc,
	CREATE_FILE_HEREDOC_DELIMITER,
} from '../../../src/assistant/mutating-helpers';

describe('mapAgentNameToSessionKind', () => {
	it('maps the four valid agent names (case-insensitive)', () => {
		expect(mapAgentNameToSessionKind('claude')).toBe('claude');
		expect(mapAgentNameToSessionKind('codex')).toBe('codex');
		expect(mapAgentNameToSessionKind('opencode')).toBe('opencode');
		expect(mapAgentNameToSessionKind('shell')).toBe('shell');
		expect(mapAgentNameToSessionKind('CODEX')).toBe('codex');
		expect(mapAgentNameToSessionKind('  Claude  ')).toBe('claude');
	});

	it('rejects unknown agents with null', () => {
		expect(mapAgentNameToSessionKind('gemini')).toBeNull();
		expect(mapAgentNameToSessionKind('')).toBeNull();
		expect(mapAgentNameToSessionKind('claude-code')).toBeNull();
	});
});

describe('hasPathTraversal', () => {
	it('flags a leading .. segment', () => {
		expect(hasPathTraversal('../etc/passwd')).toBe(true);
	});

	it('flags a mid-path .. segment', () => {
		expect(hasPathTraversal('/home/user/../../etc')).toBe(true);
	});

	it('flags backslash-separated .. (Windows-style on a POSIX target)', () => {
		expect(hasPathTraversal('..\\etc\\passwd')).toBe(true);
	});

	it('allows absolute paths without ..', () => {
		expect(hasPathTraversal('/home/user/project')).toBe(false);
	});

	it('allows tilde-relative paths', () => {
		expect(hasPathTraversal('~/projects/foo')).toBe(false);
		expect(hasPathTraversal('~')).toBe(false);
	});

	it('does not false-positive on a folder named "..foo" (not a real traversal)', () => {
		// "..foo" is a single segment that is not exactly ".." — safe.
		expect(hasPathTraversal('/home/user/..foo')).toBe(false);
	});
});

describe('isSafeFolderName', () => {
	it('accepts a plain single-component name', () => {
		expect(isSafeFolderName('my-project')).toBe(true);
		expect(isSafeFolderName('foo_bar')).toBe(true);
	});

	it('rejects empty / whitespace names', () => {
		expect(isSafeFolderName('')).toBe(false);
		expect(isSafeFolderName('   ')).toBe(false);
	});

	it('rejects . and ..', () => {
		expect(isSafeFolderName('.')).toBe(false);
		expect(isSafeFolderName('..')).toBe(false);
	});

	it('rejects names with separators (no nested paths from the model)', () => {
		expect(isSafeFolderName('a/b')).toBe(false);
		expect(isSafeFolderName('a\\b')).toBe(false);
	});

	it('rejects a leading dash (could be mistaken for a flag)', () => {
		expect(isSafeFolderName('-rf')).toBe(false);
	});
});

describe('shellQuote', () => {
	it("wraps a plain value in single quotes", () => {
		expect(shellQuote('hello')).toBe("'hello'");
	});

	it("escapes embedded single-quotes (POSIX ''')", () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
	});

	it('leaves $, backticks, and backslashes untouched (single-quote is literal)', () => {
		const q = shellQuote('$(rm -rf /)`cmd`\\$HOME');
		expect(q).toBe("'$(rm -rf /)`cmd`\\$HOME'");
	});
});

describe('joinPath / buildMkdirCommand / buildCreatedPath', () => {
	it('joins with exactly one slash, dropping a trailing slash on the parent', () => {
		expect(joinPath('/home/user', 'proj')).toBe('/home/user/proj');
		expect(joinPath('/home/user/', 'proj')).toBe('/home/user/proj');
	});

	it('buildMkdirCommand quotes the joined path', () => {
		expect(buildMkdirCommand('/home/user', 'proj')).toBe("mkdir -p '/home/user/proj'");
	});

	it('buildMkdirCommand escapes quotes inside the path', () => {
		expect(buildMkdirCommand("/home/u'ser", 'proj')).toBe("mkdir -p '/home/u'\\''ser/proj'");
	});

	it('buildCreatedPath returns the unquoted joined path for the model', () => {
		expect(buildCreatedPath('/home/user', 'proj')).toBe('/home/user/proj');
	});
});

describe('buildCloneTarget / repoNameFromFullName / buildCloneUrl', () => {
	it('uses the model folder when non-empty', () => {
		expect(buildCloneTarget('owner/repo', '/custom/root', '/default')).toBe('/custom/root');
	});

	it('falls back to defaultRoot/repoName when folder is null/empty', () => {
		expect(buildCloneTarget('owner/repo', null, '/home/user/git')).toBe('/home/user/git/repo');
		expect(buildCloneTarget('owner/repo', '', '/home/user/git')).toBe('/home/user/git/repo');
		expect(buildCloneTarget('owner/repo', '   ', '/home/user/git')).toBe('/home/user/git/repo');
	});

	it('strips a trailing slash on the default root', () => {
		expect(buildCloneTarget('owner/repo', null, '/home/user/git/')).toBe('/home/user/git/repo');
	});

	it('repoNameFromFullName parses the segment after the last slash', () => {
		expect(repoNameFromFullName('owner/repo')).toBe('repo');
		expect(repoNameFromFullName('org/sub/repo')).toBe('repo');
		expect(repoNameFromFullName('solo')).toBe('solo');
	});

	it('buildCloneUrl produces the github URL, trimming a leading slash', () => {
		expect(buildCloneUrl('owner/repo')).toBe('https://github.com/owner/repo');
		expect(buildCloneUrl('/owner/repo')).toBe('https://github.com/owner/repo');
	});
});

describe('buildCreateFileHeredoc', () => {
	it('builds a quoted-delimiter heredoc with the path shell-quoted', () => {
		const out = buildCreateFileHeredoc('/tmp/file.txt', 'hello world');
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.command).toBe(
			"cat > '/tmp/file.txt' <<'POCKETSHELL_EOF'\n" +
			'hello world\n' +
			'POCKETSHELL_EOF\n',
		);
	});

	it('ensures a trailing newline before the closing delimiter', () => {
		const out = buildCreateFileHeredoc('/tmp/f', 'line\n');
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		// Content already ends in \n — must not be doubled.
		expect(out.command).toBe("cat > '/tmp/f' <<'POCKETSHELL_EOF'\nline\nPOCKETSHELL_EOF\n");
	});

	it('leaves shell metacharacters in the content untouched (quoted heredoc = no expansion)', () => {
		const content = 'echo $HOME `whoami` $(id) "hi" \\n';
		const out = buildCreateFileHeredoc('/tmp/f', content);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		// The content must appear VERBATIM — no expansion, no escaping.
		expect(out.command).toContain(content + '\n');
	});

	it('quotes a path containing single-quotes', () => {
		const out = buildCreateFileHeredoc("/tmp/it's.txt", 'x');
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.command.startsWith("cat > '/tmp/it'\\''s.txt' <<'")).toBe(true);
	});

	it('REJECTS content containing a line equal to the delimiter (collision guard)', () => {
		// A line equal to the delimiter would close the heredoc early.
		const out = buildCreateFileHeredoc('/tmp/f', `before\n${CREATE_FILE_HEREDOC_DELIMITER}\nafter`);
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.error).toContain('heredoc delimiter');
	});

	it('does not false-positive on content that merely mentions the delimiter inline', () => {
		// The delimiter as a SUBSTRING of a longer line is safe (only an exact
		// full-line match closes the heredoc).
		const out = buildCreateFileHeredoc('/tmp/f', `text ${CREATE_FILE_HEREDOC_DELIMITER}-inline`);
		expect(out.ok).toBe(true);
	});
});
