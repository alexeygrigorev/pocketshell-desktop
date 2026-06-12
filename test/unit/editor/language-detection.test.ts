/**
 * Unit tests for language detection.
 */

import { describe, it, expect } from 'vitest';
import { detectLanguage } from '../../../src/editor/language-detection';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
  describe('extension-based detection', () => {
    it('detects TypeScript from .ts', () => {
      const result = detectLanguage('/home/user/app.ts');
      expect(result.languageId).toBe('typescript');
      expect(result.confidence).toBe(1.0);
    });

    it('detects TypeScript from .tsx', () => {
      const result = detectLanguage('/home/user/component.tsx');
      expect(result.languageId).toBe('typescript');
      expect(result.confidence).toBe(1.0);
    });

    it('detects JavaScript from .js', () => {
      const result = detectLanguage('/home/user/index.js');
      expect(result.languageId).toBe('javascript');
      expect(result.confidence).toBe(1.0);
    });

    it('detects JavaScript from .jsx', () => {
      const result = detectLanguage('/home/user/Component.jsx');
      expect(result.languageId).toBe('javascript');
    });

    it('detects Python from .py', () => {
      const result = detectLanguage('/home/user/script.py');
      expect(result.languageId).toBe('python');
      expect(result.confidence).toBe(1.0);
    });

    it('detects Rust from .rs', () => {
      const result = detectLanguage('/home/user/main.rs');
      expect(result.languageId).toBe('rust');
    });

    it('detects Go from .go', () => {
      const result = detectLanguage('/home/user/main.go');
      expect(result.languageId).toBe('go');
    });

    it('detects Markdown from .md', () => {
      const result = detectLanguage('/home/user/README.md');
      expect(result.languageId).toBe('markdown');
    });

    it('detects JSON from .json', () => {
      const result = detectLanguage('/home/user/package.json');
      expect(result.languageId).toBe('json');
    });

    it('detects YAML from .yaml', () => {
      const result = detectLanguage('/home/user/config.yaml');
      expect(result.languageId).toBe('yaml');
    });

    it('detects YAML from .yml', () => {
      const result = detectLanguage('/home/user/config.yml');
      expect(result.languageId).toBe('yaml');
    });

    it('detects Shell from .sh', () => {
      const result = detectLanguage('/home/user/setup.sh');
      expect(result.languageId).toBe('shell');
    });

    it('detects Shell from .bash', () => {
      const result = detectLanguage('/home/user/init.bash');
      expect(result.languageId).toBe('shell');
    });

    it('detects CSS from .css', () => {
      const result = detectLanguage('/home/user/style.css');
      expect(result.languageId).toBe('css');
    });

    it('detects HTML from .html', () => {
      const result = detectLanguage('/home/user/page.html');
      expect(result.languageId).toBe('html');
    });

    it('detects SQL from .sql', () => {
      const result = detectLanguage('/home/user/query.sql');
      expect(result.languageId).toBe('sql');
    });

    it('detects C from .c', () => {
      const result = detectLanguage('/home/user/main.c');
      expect(result.languageId).toBe('c');
    });

    it('detects C from .h', () => {
      const result = detectLanguage('/home/user/header.h');
      expect(result.languageId).toBe('c');
    });

    it('detects C++ from .cpp', () => {
      const result = detectLanguage('/home/user/app.cpp');
      expect(result.languageId).toBe('cpp');
    });

    it('detects Java from .java', () => {
      const result = detectLanguage('/home/user/App.java');
      expect(result.languageId).toBe('java');
    });

    it('detects Ruby from .rb', () => {
      const result = detectLanguage('/home/user/app.rb');
      expect(result.languageId).toBe('ruby');
    });

    it('detects PHP from .php', () => {
      const result = detectLanguage('/home/user/index.php');
      expect(result.languageId).toBe('php');
    });

    it('detects TOML from .toml', () => {
      const result = detectLanguage('/home/user/Cargo.toml');
      expect(result.languageId).toBe('toml');
    });

    it('detects XML from .xml', () => {
      const result = detectLanguage('/home/user/config.xml');
      expect(result.languageId).toBe('xml');
    });
  });

  describe('filename-based detection', () => {
    it('detects Dockerfile from filename', () => {
      const result = detectLanguage('/home/user/Dockerfile');
      expect(result.languageId).toBe('dockerfile');
      expect(result.confidence).toBe(1.0);
    });

    it('detects Makefile from filename', () => {
      const result = detectLanguage('/home/user/Makefile');
      expect(result.languageId).toBe('makefile');
      expect(result.confidence).toBe(1.0);
    });

    it('detects dockerfile case-insensitively', () => {
      const result = detectLanguage('/home/user/dockerfile');
      expect(result.languageId).toBe('dockerfile');
    });
  });

  describe('shebang detection', () => {
    it('detects Shell from #!/bin/bash', () => {
      const content = '#!/bin/bash\necho hello\n';
      const result = detectLanguage('/home/user/script', content);
      expect(result.languageId).toBe('shell');
      expect(result.confidence).toBe(0.8);
    });

    it('detects Shell from #!/bin/sh', () => {
      const content = '#!/bin/sh\necho hello\n';
      const result = detectLanguage('/home/user/script', content);
      expect(result.languageId).toBe('shell');
    });

    it('detects Python from #!/usr/bin/env python3', () => {
      const content = '#!/usr/bin/env python3\nprint("hello")\n';
      const result = detectLanguage('/home/user/script', content);
      expect(result.languageId).toBe('python');
      expect(result.confidence).toBe(0.8);
    });

    it('detects Python from #!/usr/bin/python3', () => {
      const content = '#!/usr/bin/python3\nprint("hello")\n';
      const result = detectLanguage('/home/user/script', content);
      expect(result.languageId).toBe('python');
    });

    it('detects JavaScript from #!/usr/bin/env node', () => {
      const content = '#!/usr/bin/env node\nconsole.log("hi");\n';
      const result = detectLanguage('/home/user/script', content);
      expect(result.languageId).toBe('javascript');
    });

    it('detects Ruby from #!/usr/bin/env ruby', () => {
      const content = '#!/usr/bin/env ruby\nputs "hi"\n';
      const result = detectLanguage('/home/user/script', content);
      expect(result.languageId).toBe('ruby');
    });
  });

  describe('unknown files', () => {
    it('returns plain text for unknown extensions', () => {
      const result = detectLanguage('/home/user/data.xyz');
      expect(result.languageId).toBe('plaintext');
      expect(result.confidence).toBe(0.0);
    });

    it('returns plain text for files with no extension', () => {
      const result = detectLanguage('/home/user/README');
      expect(result.languageId).toBe('plaintext');
      expect(result.confidence).toBe(0.0);
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase extensions', () => {
      const result = detectLanguage('/home/user/SCRIPT.PY');
      expect(result.languageId).toBe('python');
      expect(result.confidence).toBe(1.0);
    });

    it('handles mixed-case extensions', () => {
      const result = detectLanguage('/home/user/app.Ts');
      expect(result.languageId).toBe('typescript');
      expect(result.confidence).toBe(1.0);
    });
  });
});
