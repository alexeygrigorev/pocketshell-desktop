import { describe, expect, it } from 'vitest';
import {
  REMOTE_FILE_IMAGE_PREVIEW_LIMIT,
  REMOTE_FILE_TEXT_PREVIEW_LIMIT,
  buildRemoteFileReviewPrompt,
  classifyRemoteFilePreview,
  looksLikeBinarySample,
} from '../../../src/files/remote-file-preview';

describe('remote file preview classification', () => {
  it('classifies source text files with a language id', () => {
    const plan = classifyRemoteFilePreview({
      path: '/home/alice/project/app.ts',
      size: 128,
      isFile: true,
    });

    expect(plan.kind).toBe('text');
    expect(plan.languageId).toBe('typescript');
    expect(plan.previewLimit).toBe(REMOTE_FILE_TEXT_PREVIEW_LIMIT);
    expect(plan.canCreateReviewPrompt).toBe(true);
  });

  it('classifies markdown files separately', () => {
    const plan = classifyRemoteFilePreview({
      path: '/home/alice/README.md',
      size: 1024,
      isFile: true,
    });

    expect(plan.kind).toBe('markdown');
    expect(plan.languageId).toBe('markdown');
  });

  it('classifies supported image files with media type', () => {
    const plan = classifyRemoteFilePreview({
      path: '/home/alice/screenshot.png',
      size: 2048,
      isFile: true,
    });

    expect(plan.kind).toBe('image');
    expect(plan.mediaType).toBe('image/png');
    expect(plan.previewLimit).toBe(REMOTE_FILE_IMAGE_PREVIEW_LIMIT);
  });

  it('returns a clear large state for oversized text files', () => {
    const plan = classifyRemoteFilePreview({
      path: '/var/log/app.log',
      size: REMOTE_FILE_TEXT_PREVIEW_LIMIT + 1,
      isFile: true,
    });

    expect(plan.kind).toBe('large');
    expect(plan.reason).toMatch(/too large/i);
    expect(plan.previewLimit).toBe(REMOTE_FILE_TEXT_PREVIEW_LIMIT);
  });

  it('returns a clear large state for oversized images', () => {
    const plan = classifyRemoteFilePreview({
      path: '/home/alice/huge.jpg',
      size: REMOTE_FILE_IMAGE_PREVIEW_LIMIT + 1,
      isFile: true,
    });

    expect(plan.kind).toBe('large');
    expect(plan.reason).toMatch(/image file is too large/i);
    expect(plan.previewLimit).toBe(REMOTE_FILE_IMAGE_PREVIEW_LIMIT);
  });

  it('returns unsupported for known binary extensions', () => {
    const plan = classifyRemoteFilePreview({
      path: '/tmp/archive.zip',
      size: 4096,
      isFile: true,
    });

    expect(plan.kind).toBe('unsupported');
    expect(plan.reason).toMatch(/binary/i);
  });

  it('returns unsupported for non-file entries', () => {
    const plan = classifyRemoteFilePreview({
      path: '/tmp/socket',
      size: 0,
      isFile: false,
    });

    expect(plan.kind).toBe('unsupported');
    expect(plan.reason).toMatch(/regular files/i);
  });
});

describe('remote file binary sniffing', () => {
  it('detects nul bytes as binary content', () => {
    expect(looksLikeBinarySample(new Uint8Array([65, 0, 66]))).toBe(true);
  });

  it('keeps ordinary utf-8 text previewable', () => {
    expect(looksLikeBinarySample(Buffer.from('hello\nworld\n', 'utf8'))).toBe(false);
  });
});

describe('remote file review prompt', () => {
  it('builds a composer-ready review prompt for the selected file', () => {
    const prompt = buildRemoteFileReviewPrompt({
      hostLabel: 'host7',
      path: '/home/alice/project/app.ts',
      size: 1536,
      previewKind: 'text',
    });

    expect(prompt).toContain('Please review the remote file on host7');
    expect(prompt).toContain('Path: /home/alice/project/app.ts');
    expect(prompt).toContain('Size: 1.5 KB');
    expect(prompt).toContain('Preview type: text');
    expect(prompt).toContain('inspect the path directly on the connected host');
  });

  it('includes unsupported preview notes in review prompts', () => {
    const prompt = buildRemoteFileReviewPrompt({
      path: '/tmp/archive.zip',
      size: 4096,
      previewKind: 'unsupported',
      reason: 'Binary file type is not supported for preview.',
    });

    expect(prompt).toContain('Preview note: Binary file type is not supported for preview.');
  });
});
