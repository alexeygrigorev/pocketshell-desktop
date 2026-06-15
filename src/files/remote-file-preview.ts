import type { RemoteFileEntry, RemoteFileStat } from './types';

export const REMOTE_FILE_TEXT_PREVIEW_LIMIT = 1024 * 1024;
export const REMOTE_FILE_IMAGE_PREVIEW_LIMIT = 10 * 1024 * 1024;

export type RemoteFilePreviewKind = 'text' | 'markdown' | 'image' | 'unsupported' | 'large';

export interface RemoteFilePreviewInput {
  path: string;
  size: number;
  isFile?: boolean;
}

export interface RemoteFilePreviewPlan {
  kind: RemoteFilePreviewKind;
  path: string;
  size: number;
  displayName: string;
  mediaType?: string;
  languageId?: string;
  reason?: string;
  previewLimit: number;
  canCreateReviewPrompt: boolean;
}

export interface RemoteFileReviewPromptInput {
  hostLabel?: string;
  path: string;
  size: number;
  previewKind: RemoteFilePreviewKind;
  reason?: string;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkdn']);
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};
const TEXT_LANGUAGE_IDS: Record<string, string> = {
  bash: 'shellscript',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  csv: 'csv',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascriptreact',
  kt: 'kotlin',
  kts: 'kotlin',
  log: 'log',
  lua: 'lua',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescriptreact',
  txt: 'plaintext',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shellscript',
};
const TEXT_FILENAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};
const KNOWN_BINARY_EXTENSIONS = new Set([
  '7z',
  'a',
  'avi',
  'class',
  'dmg',
  'doc',
  'docx',
  'eot',
  'exe',
  'gz',
  'ico',
  'jar',
  'mov',
  'mp3',
  'mp4',
  'o',
  'otf',
  'pdf',
  'ppt',
  'pptx',
  'rar',
  'so',
  'tar',
  'ttf',
  'wasm',
  'woff',
  'woff2',
  'xls',
  'xlsx',
  'zip',
]);

export function classifyRemoteFilePreview(input: RemoteFilePreviewInput): RemoteFilePreviewPlan {
  const displayName = basename(input.path);
  const ext = extensionOf(displayName);
  const previewLimit = imageMediaType(ext)
    ? REMOTE_FILE_IMAGE_PREVIEW_LIMIT
    : REMOTE_FILE_TEXT_PREVIEW_LIMIT;

  if (input.isFile === false) {
    return unsupportedPlan(input, displayName, previewLimit, 'Only regular files can be previewed.');
  }

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return input.size > REMOTE_FILE_TEXT_PREVIEW_LIMIT
      ? largePlan(input, displayName, REMOTE_FILE_TEXT_PREVIEW_LIMIT, 'Markdown file is too large to preview.')
      : {
          kind: 'markdown',
          path: input.path,
          size: input.size,
          displayName,
          languageId: 'markdown',
          previewLimit: REMOTE_FILE_TEXT_PREVIEW_LIMIT,
          canCreateReviewPrompt: true,
        };
  }

  const mediaType = imageMediaType(ext);
  if (mediaType) {
    return input.size > REMOTE_FILE_IMAGE_PREVIEW_LIMIT
      ? largePlan(input, displayName, REMOTE_FILE_IMAGE_PREVIEW_LIMIT, 'Image file is too large to preview.')
      : {
          kind: 'image',
          path: input.path,
          size: input.size,
          displayName,
          mediaType,
          previewLimit: REMOTE_FILE_IMAGE_PREVIEW_LIMIT,
          canCreateReviewPrompt: true,
        };
  }

  const languageId = textLanguageId(displayName, ext);
  if (languageId) {
    return input.size > REMOTE_FILE_TEXT_PREVIEW_LIMIT
      ? largePlan(input, displayName, REMOTE_FILE_TEXT_PREVIEW_LIMIT, 'Text file is too large to preview.')
      : {
          kind: 'text',
          path: input.path,
          size: input.size,
          displayName,
          languageId,
          previewLimit: REMOTE_FILE_TEXT_PREVIEW_LIMIT,
          canCreateReviewPrompt: true,
        };
  }

  if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return unsupportedPlan(input, displayName, previewLimit, 'Binary file type is not supported for preview.');
  }

  return input.size > REMOTE_FILE_TEXT_PREVIEW_LIMIT
    ? largePlan(input, displayName, REMOTE_FILE_TEXT_PREVIEW_LIMIT, 'File is too large to preview as text.')
    : {
        kind: 'text',
        path: input.path,
        size: input.size,
        displayName,
        languageId: 'plaintext',
        previewLimit: REMOTE_FILE_TEXT_PREVIEW_LIMIT,
        canCreateReviewPrompt: true,
      };
}

export function classifyRemoteFileEntryPreview(entry: RemoteFileEntry): RemoteFilePreviewPlan {
  return classifyRemoteFilePreview({
    path: entry.path,
    size: entry.size,
    isFile: entry.isFile,
  });
}

export function classifyRemoteFileStatPreview(path: string, stat: RemoteFileStat): RemoteFilePreviewPlan {
  return classifyRemoteFilePreview({
    path,
    size: stat.size,
    isFile: stat.isFile(),
  });
}

export function looksLikeBinarySample(sample: Uint8Array): boolean {
  if (sample.length === 0) {
    return false;
  }
  const sampleLength = Math.min(sample.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const byte = sample[i];
    if (byte === 0) {
      return true;
    }
    if (byte < 8 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLength > 0.1;
}

export function buildRemoteFileReviewPrompt(input: RemoteFileReviewPromptInput): string {
  const hostLine = input.hostLabel ? ` on ${input.hostLabel}` : '';
  const notes = input.reason ? `\nPreview note: ${input.reason}` : '';
  return [
    `Please review the remote file${hostLine}:`,
    '',
    `Path: ${input.path}`,
    `Size: ${formatBytes(input.size)}`,
    `Preview type: ${input.previewKind}`,
    notes,
    '',
    'Focus on correctness, security, maintainability, and any behavior that could surprise users.',
    'If you need file contents, inspect the path directly on the connected host before giving findings.',
  ].filter((line) => line !== '').join('\n');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function unsupportedPlan(
  input: RemoteFilePreviewInput,
  displayName: string,
  previewLimit: number,
  reason: string,
): RemoteFilePreviewPlan {
  return {
    kind: 'unsupported',
    path: input.path,
    size: input.size,
    displayName,
    reason,
    previewLimit,
    canCreateReviewPrompt: true,
  };
}

function largePlan(
  input: RemoteFilePreviewInput,
  displayName: string,
  previewLimit: number,
  reason: string,
): RemoteFilePreviewPlan {
  return {
    kind: 'large',
    path: input.path,
    size: input.size,
    displayName,
    reason,
    previewLimit,
    canCreateReviewPrompt: true,
  };
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function extensionOf(displayName: string): string {
  const index = displayName.lastIndexOf('.');
  return index > 0 ? displayName.slice(index + 1).toLowerCase() : '';
}

function imageMediaType(ext: string): string | undefined {
  return IMAGE_MEDIA_TYPES[ext];
}

function textLanguageId(displayName: string, ext: string): string | undefined {
  const filenameLanguage = TEXT_FILENAMES[displayName.toLowerCase()];
  return filenameLanguage ?? TEXT_LANGUAGE_IDS[ext];
}
