/**
 * Language detection for remote files.
 *
 * Maps file extensions and shebang lines to Monaco language IDs.
 * Pure functions with no side effects.
 */

import type { LanguageDetection } from './types';

// ---------------------------------------------------------------------------
// Extension-to-language mapping
// ---------------------------------------------------------------------------

const EXTENSION_MAP: ReadonlyMap<string, string> = new Map([
  // TypeScript / JavaScript
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],

  // Web
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.css', 'css'],
  ['.scss', 'css'],
  ['.less', 'css'],

  // Data / config
  ['.json', 'json'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.toml', 'toml'],
  ['.xml', 'xml'],

  // Scripting
  ['.py', 'python'],
  ['.pyw', 'python'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],

  // Systems
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hxx', 'cpp'],
  ['.java', 'java'],

  // Query
  ['.sql', 'sql'],

  // Markup
  ['.md', 'markdown'],
  ['.mdx', 'markdown'],
]);

/**
 * Special filenames that map to specific languages regardless of extension.
 * Keys are lowercased for case-insensitive matching.
 */
const FILENAME_MAP: ReadonlyMap<string, string> = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['gnumakefile', 'makefile'],
  ['cmakelists.txt', 'cmake'],
  ['rakefile', 'ruby'],
  ['gemfile', 'ruby'],
  ['vagrantfile', 'ruby'],
]);

// ---------------------------------------------------------------------------
// Shebang detection
// ---------------------------------------------------------------------------

/**
 * Map of shebang interpreter names (the last path component after any flags)
 * to Monaco language IDs.
 */
const SHEBANG_MAP: ReadonlyMap<string, string> = new Map([
  ['python', 'python'],
  ['python3', 'python'],
  ['node', 'javascript'],
  ['bash', 'shell'],
  ['sh', 'shell'],
  ['zsh', 'shell'],
  ['ruby', 'ruby'],
  ['perl', 'perl'],
  ['php', 'php'],
]);

/**
 * Extract the interpreter name from a shebang line.
 *
 * Handles:
 *   #!/usr/bin/env python3
 *   #!/usr/bin/python3
 *   #!/usr/bin/env -S python3 -u
 */
function parseShebang(firstLine: string): string | null {
  const match = firstLine.match(/^#!\s*(.*)/);
  if (!match) return null;

  const shebang = match[1].trim();

  // Handle `env` style: /usr/bin/env python3  or  /usr/bin/env -S python3 -u
  const envMatch = shebang.match(/\benv\s+(?:-[a-zA-Z]+\s+)*(\S+)/);
  if (envMatch) {
    return envMatch[1];
  }

  // Direct path: extract the last component
  const parts = shebang.split('/');
  const interpreter = parts[parts.length - 1];
  // Strip version suffixes like python3.9 -> python3 is already handled by the map
  return interpreter || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the Monaco language ID for a remote file.
 *
 * Resolution order:
 * 1. Exact filename match (e.g. "Makefile", "Dockerfile")
 * 2. File extension match (case-insensitive)
 * 3. Shebang detection from content (if provided)
 * 4. Fallback to "plaintext"
 *
 * @param path    Remote file path (e.g. "/home/user/script.py")
 * @param content Optional file content, used for shebang detection
 * @returns Language detection result
 */
export function detectLanguage(path: string, content?: string): LanguageDetection {
  // 1. Exact filename match
  const basename = path.split('/').pop() ?? '';
  const lowerBasename = basename.toLowerCase();

  const filenameLang = FILENAME_MAP.get(lowerBasename);
  if (filenameLang) {
    return { languageId: filenameLang, confidence: 1.0 };
  }

  // 2. Extension match
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex >= 0) {
    const ext = basename.slice(dotIndex).toLowerCase();
    const extLang = EXTENSION_MAP.get(ext);
    if (extLang) {
      return { languageId: extLang, confidence: 1.0 };
    }
  }

  // 3. Shebang detection
  if (content) {
    const firstLine = content.split('\n', 1)[0] ?? '';
    const interpreter = parseShebang(firstLine);
    if (interpreter) {
      // Check direct match
      const lang = SHEBANG_MAP.get(interpreter);
      if (lang) {
        return { languageId: lang, confidence: 0.8 };
      }

      // Check prefix match (e.g. "python3.9" -> "python3" -> "python")
      for (const [key, value] of SHEBANG_MAP) {
        if (interpreter.startsWith(key)) {
          return { languageId: value, confidence: 0.7 };
        }
      }
    }
  }

  // 4. Fallback
  return { languageId: 'plaintext', confidence: 0.0 };
}
