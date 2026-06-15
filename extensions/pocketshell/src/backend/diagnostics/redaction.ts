import { createHash } from 'crypto';
import type {
  DiagnosticMetadata,
  DiagnosticMetadataValue,
  DiagnosticsRedactionMode,
} from './types';

const SECRET_KEY_RE = /(secret|token|cookie|passphrase|password|api[_-]?key|private[_-]?key|credential|auth)/i;
const KEY_PATH_RE = /^(keyPath|privateKeyPath|identityFile)$/i;
const COMMAND_INPUT_KEY_RE = /^(input|keys|keystrokes|terminalContent|prompt|commandLine|command|args|argv|text|contents?)$/i;
const FINGERPRINT_KEY_RE = /(hostname|hostName|host|username|user|sessionName|tmuxSession|path|file|folder|directory|cwd|uri|storage|db)$/i;
const WINDOWS_PATH_RE = /^[a-zA-Z]:[\\/]/;
const HOST_LIKE_RE = /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$|^\d{1,3}(?:\.\d{1,3}){3}$/;
const EMBEDDED_PATH_RE = /(?:file:\/\/)?(?:~\/|\/[A-Za-z0-9._~+@%-]+|[A-Za-z]:[\\/])(?:[A-Za-z0-9._~+@%/\\:-]*[A-Za-z0-9._~+@%-])?/g;
const EMBEDDED_HOST_RE = /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\b/g;
const EMBEDDED_IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const TOKEN_LIKE_RE = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|[A-Za-z0-9_-]{32,})\b/g;

export function fingerprintDiagnosticValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function redactDiagnosticMetadata(
  metadata: DiagnosticMetadata | undefined,
  mode: DiagnosticsRedactionMode,
): DiagnosticMetadata {
  if (!metadata) {
    return {};
  }
  if (mode === 'off') {
    return cloneValue(metadata) as DiagnosticMetadata;
  }
  return redactObject(metadata, mode);
}

export function redactDiagnosticString(value: string, mode: DiagnosticsRedactionMode): string {
  if (mode === 'off') {
    return value;
  }

  let redacted = value;
  redacted = redacted.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[redacted-private-key]');
  redacted = redacted.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  redacted = redacted.replace(/(token|password|passphrase|api[_-]?key|secret|cookie|credential|authorization)\s*[:=]\s*([^\s&;,]+)/gi, '$1=[redacted]');
  redacted = redacted.replace(/\b(token|password|passphrase|api[_-]?key|secret|cookie|credential|authorization)\s+([^\s&;,]+)/gi, '$1 [redacted]');
  redacted = redacted.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]');
  redacted = redacted.replace(TOKEN_LIKE_RE, '[redacted-token]');
  redacted = redacted.replace(EMBEDDED_PATH_RE, (match) => `sha256:${fingerprintDiagnosticValue(stripFileUri(match))}`);
  redacted = redacted.replace(EMBEDDED_HOST_RE, (match) => `sha256:${fingerprintDiagnosticValue(match)}`);
  redacted = redacted.replace(EMBEDDED_IPV4_RE, (match) => `sha256:${fingerprintDiagnosticValue(match)}`);
  return redacted;
}

export function fingerprintDiagnosticPath(pathValue: string): string {
  return `sha256:${fingerprintDiagnosticValue(stripFileUri(pathValue))}`;
}

function redactObject(value: DiagnosticMetadata, mode: DiagnosticsRedactionMode): DiagnosticMetadata {
  const output: DiagnosticMetadata = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = redactValue(key, child, mode);
  }
  return output;
}

function redactValue(
  key: string,
  value: DiagnosticMetadataValue,
  mode: DiagnosticsRedactionMode,
): DiagnosticMetadataValue {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(key, entry, mode));
  }
  if (typeof value === 'object') {
    const output: Record<string, DiagnosticMetadataValue> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactValue(childKey, childValue, mode);
    }
    return output;
  }

  if (SECRET_KEY_RE.test(key) || KEY_PATH_RE.test(key)) {
    return '[redacted]';
  }
  if (COMMAND_INPUT_KEY_RE.test(key)) {
    return '[redacted]';
  }

  const sanitized = redactDiagnosticString(value, mode);
  if (mode === 'strict' || FINGERPRINT_KEY_RE.test(key) || isPathLike(value) || HOST_LIKE_RE.test(value)) {
    return `sha256:${fingerprintDiagnosticValue(value)}`;
  }
  return sanitized;
}

function stripFileUri(value: string): string {
  return value.startsWith('file://') ? value.slice('file://'.length) : value;
}

function isPathLike(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('~/')
    || value.startsWith('file:')
    || WINDOWS_PATH_RE.test(value)
    || value.includes('/.ssh/')
    || value.includes('\\.ssh\\');
}

function cloneValue(value: DiagnosticMetadataValue): DiagnosticMetadataValue {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && typeof value === 'object') {
    const output: Record<string, DiagnosticMetadataValue> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = cloneValue(child);
    }
    return output;
  }
  return value;
}
