import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../../src/main/preview/markdownDocument';
import {
  PALETTE_TOKENS,
  markdownStylesheet,
  sanitiseAppearance,
  sanitisePalette,
  type PaletteToken,
} from '../../src/main/preview/previewStyle';

/**
 * What the converter is ALLOWED TO EMIT.
 *
 * That is the whole of the markdown preview's new security surface, and it is
 * the reason this file exists as its own suite rather than as three cases in
 * HtmlPreviewService.test.ts. Everything else about a markdown preview —
 * sandbox, CSP, containment, revocation, budgets — is the HTML preview's
 * machinery unchanged and is tested there; converting in main was chosen partly
 * so that would be true.
 *
 * So the assertions below fall into three groups:
 *
 *  1. the conversion is real markdown (headings, GFM tables, fences), because a
 *     preview that quietly drops a table is a worse answer than no preview;
 *  2. raw HTML is passed through DELIBERATELY — the decision argued at length
 *     in markdownDocument.ts — and this is where that decision is pinned, so
 *     that flipping it is a test change someone has to justify rather than a
 *     silent behavioural drift;
 *  3. nothing the app itself interpolates can escape its context: the palette
 *     cannot break out of the `<style>` block, and a filename cannot break out
 *     of the `<title>`.
 */

const STYLE = {
  palette: sanitisePalette({}),
  appearance: 'dark' as const,
};

function render(markdown: string): string {
  return markdownToHtml(markdown, { title: 'README.md', style: STYLE });
}

/** The `<body>`, without the document shell and stylesheet around it. */
function body(html: string): string {
  return html.slice(html.indexOf('<main class="md">'));
}

describe('markdownToHtml — it is really markdown', () => {
  it('renders headings, emphasis and links', () => {
    const html = body(render('# Title\n\nSome **bold** and a [link](other.md).\n'));
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="other.md">link</a>');
  });

  it('renders GFM tables, task lists and strikethrough', () => {
    const html = body(
      render(
        ['| a | b |', '|---|---|', '| 1 | 2 |', '', '- [x] done', '- [ ] todo', '', '~~gone~~', ''].join('\n'),
      ),
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<del>gone</del>');
  });

  it('renders a fenced code block without executing or highlighting it', () => {
    const html = body(render('```js\nconst x = 1;\n```\n'));
    expect(html).toContain('<pre><code');
    expect(html).toContain('const x = 1;');
    // No highlighter is wired in, on purpose: the preview is prose, the editor
    // one click away is where code is read. What must NOT happen is the fence
    // arriving as live markup.
    expect(html).not.toContain('<script');
  });

  /**
   * `breaks: false`. A README hard-wrapped at 80 columns is one paragraph, not
   * a poem — this is the option most likely to be "helpfully" flipped, and
   * flipping it shreds every wrapped file in the repo.
   */
  it('does not turn a soft line break into a <br>', () => {
    const html = body(render('one line\nsecond line\n'));
    expect(html).not.toContain('<br');
    expect(html).toContain('one line\nsecond line');
  });

  it('escapes text that looks like markup but came from prose', () => {
    // A plain paragraph mentioning a tag is TEXT and must be escaped; the
    // pass-through decision below is about markup written AS markup.
    const html = body(render('use the `<script>` tag carefully\n'));
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('markdownToHtml — heading anchors', () => {
  it('slugs headings so in-document links work', () => {
    const html = body(render('## Getting Started!\n'));
    expect(html).toContain('<h2 id="getting-started">');
  });

  it('slugs from the TEXT of a heading, not its markup', () => {
    const html = body(render('## `install` and *setup*\n'));
    expect(html).toContain('id="install-and-setup"');
  });

  it('disambiguates repeated headings, so the first stays reachable', () => {
    const html = body(render('## Usage\n\ntext\n\n## Usage\n'));
    expect(html).toContain('id="usage"');
    expect(html).toContain('id="usage-1"');
  });

  it('gives a heading with no sluggable text an id anyway', () => {
    const html = body(render('## ***\n'));
    expect(html).toMatch(/id="section"/);
  });

  it('does not carry duplicate state from one document into the next', () => {
    // The renderer holds per-document state. A module-level `marked` would have
    // made the second file's first heading `usage-1`, and every in-page link
    // written against it would have gone nowhere.
    expect(body(render('## Usage\n'))).toContain('id="usage"');
    expect(body(render('## Usage\n'))).toContain('id="usage"');
  });
});

describe('markdownToHtml — raw HTML is passed through, deliberately', () => {
  /**
   * This is the decision, pinned.
   *
   * It is safe because of what surrounds the document, not because of what the
   * converter emits: `sandbox=""` on the frame and a CSP naming no remote
   * scheme on every response. If either is ever weakened, escaping raw HTML
   * here becomes the right change — and these tests are the place that says so.
   */
  it('keeps <details>, <img width> and <p align>, which real READMEs use', () => {
    const html = body(
      render('<details><summary>More</summary>\n\ntext\n\n</details>\n\n<p align="center">mid</p>\n'),
    );
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('<p align="center">mid</p>');
  });

  it('passes a <script> tag through as markup rather than escaping it', () => {
    // Documented rather than defended here: it is inert because the frame is
    // sandboxed with zero tokens AND the response carries `script-src 'none'`.
    // HtmlPreviewService.test.ts asserts that policy on markdown responses too.
    const html = body(render('<script>alert(1)</script>\n'));
    expect(html).toContain('<script>');
  });
});

describe('markdownToHtml — the document shell', () => {
  it('is a complete HTML document with the stylesheet inline', () => {
    const html = render('# hi\n');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<style>');
    expect(html).toContain('</main></body></html>');
  });

  it('escapes the filename in the title, which is remote-controlled text', () => {
    // The title comes from a path on someone else's machine. A file really can
    // be called `</title><script>`, and this is the one place the app itself
    // interpolates that string into markup.
    const html = markdownToHtml('# hi\n', {
      title: '</title><script>x</script>.md',
      style: STYLE,
    });
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;');
    expect(html).not.toContain('<title></title><script>');
  });
});

describe('sanitisePalette', () => {
  it('accepts the shapes real tokens take', () => {
    const out = sanitisePalette({
      '--bg': '#0d1117',
      '--fg': 'rgba(230, 237, 243, 0.9)',
      '--font-ui': "'Inter Variable', system-ui, sans-serif",
      '--font-mono': 'Consolas, ui-monospace',
    });
    expect(out['--bg']).toBe('#0d1117');
    expect(out['--fg']).toBe('rgba(230, 237, 243, 0.9)');
    expect(out['--font-ui']).toBe("'Inter Variable', system-ui, sans-serif");
  });

  it('fills every token, so a partial payload cannot leave the page unstyled', () => {
    const out = sanitisePalette({ '--bg': '#000000' });
    for (const token of PALETTE_TOKENS) {
      expect(out[token], token).toBeTruthy();
    }
  });

  it('falls back to a system colour rather than failing the preview', () => {
    const out = sanitisePalette({ '--fg': 'not a colour; }' });
    expect(out['--fg']).toBe('CanvasText');
  });

  /**
   * The values reach a `<style>` block, so every character that could end a
   * declaration, end the rule, close the element or spell a URL is refused. The
   * last one is the load-bearing case: a `url(https://…)` in an accepted value
   * would reopen the network that the frame's CSP closed.
   */
  it.each([
    ['ends the declaration', 'red; background: url(x)'],
    ['ends the rule', 'red} body{display:none'],
    ['closes the style element', 'red</style><script>x</script>'],
    ['spells a remote URL', 'url(https://evil/?leak)'],
    ['uses a CSS escape', '\\72 ed'],
    ['is absurdly long', 'a'.repeat(200)],
    ['is not a string', 42],
    ['is a nested object', { toString: () => 'red' }],
  ])('refuses a value that %s', (_why, value) => {
    const out = sanitisePalette({ '--accent': value });
    expect(out['--accent']).toBe('LinkText');
  });

  it('drops keys that are not tokens it knows', () => {
    const out = sanitisePalette({ '--evil': 'red', __proto__: { '--bg': 'red' } });
    expect(Object.keys(out).sort()).toEqual([...PALETTE_TOKENS].sort());
    expect(out['--bg']).toBe('Canvas');
  });

  it('survives a payload that is not an object at all', () => {
    for (const raw of [null, undefined, 'nope', 7, []]) {
      expect(sanitisePalette(raw)['--bg']).toBe('Canvas');
    }
  });
});

describe('sanitiseAppearance', () => {
  it('is light only when light was asked for by name', () => {
    expect(sanitiseAppearance('light')).toBe('light');
    expect(sanitiseAppearance('dark')).toBe('dark');
    expect(sanitiseAppearance('LIGHT')).toBe('dark');
    expect(sanitiseAppearance(undefined)).toBe('dark');
  });
});

describe('markdownStylesheet', () => {
  it('writes every token into :root, so the document follows the theme', () => {
    const css = markdownStylesheet({
      palette: sanitisePalette({ '--bg': '#101010', '--fg': '#f0f0f0' }),
      appearance: 'dark',
    });
    expect(css).toContain('--bg:#101010;');
    expect(css).toContain('--fg:#f0f0f0;');
    expect(css).toContain('color-scheme:dark;');
  });

  it('paints from tokens rather than from literals of its own', () => {
    const css = markdownStylesheet(STYLE);
    // Everything after the `:root` block must reference tokens. A hex appearing
    // in the rules would be a palette escaping the registry — the same rule
    // designGates.test.ts enforces on the renderer, checked here by hand
    // because that gate does not reach into main.
    const rules = css.slice(css.indexOf('}') + 1);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).toContain('var(--fg)');
    expect(rules).toContain('var(--term-bg)');
  });

  it('keeps wide content inside its own scroller', () => {
    // The failure this prevents: one long URL or one wide table pushes the
    // BODY sideways, and every line in the pane needs horizontal scrolling.
    const css = markdownStylesheet(STYLE);
    expect(css).toContain('overflow-wrap:anywhere');
    expect(css).toMatch(/pre\{[^}]*overflow-x:auto/);
    expect(css).toMatch(/table\{[^}]*overflow-x:auto/);
  });
});

/** Type-level guard: the token list and the record stay in step. */
const _tokenCheck: PaletteToken = '--bg';
void _tokenCheck;
