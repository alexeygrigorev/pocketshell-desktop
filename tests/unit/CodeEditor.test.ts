// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { EditorView } from '@codemirror/view';
import CodeEditor from '../../src/renderer/components/CodeEditor.vue';

/**
 * The editor component's CONTRACT, tested directly rather than through
 * FilesView.
 *
 * What is asserted here is exactly what a drop-in replacement has to promise,
 * because it is what the `<textarea>` it replaces already did:
 *   - the value prop is what you see;
 *   - typing emits the whole new document as a string, once per change;
 *   - a value arriving from outside (a different file opened, a save) replaces
 *     the document WITHOUT bouncing back as another emit — an echo there marks
 *     a freshly-opened file dirty and lights the Save button on a file nobody
 *     touched;
 *   - Ctrl/Cmd-S reaches the parent, since FilesView owns that chord.
 *
 * ## The shims
 *
 * jsdom implements no layout: every rect is zero and `Range.getClientRects`
 * does not exist. CodeMirror measures constantly, so without the stubs below it
 * throws on mount. They are enough for the model-level behaviour above, and
 * deliberately not enough to make assertions about what is PAINTED — viewport
 * contents, token colours and scroll position are not testable in jsdom at any
 * price, which is why the highlighting itself is verified headlessly in
 * codeEditorLanguages.test.ts and visually in the built app.
 */
beforeAll(() => {
  Range.prototype.getClientRects = function getClientRects() {
    return Object.assign([], { item: () => null });
  };
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  // CodeMirror watches its own box for size changes; jsdom has no observer.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** Mount attached to the document — CodeMirror needs a real ownerDocument. */
function mountEditor(props: { modelValue: string; filename?: string | null }): VueWrapper {
  wrapper = mount(CodeEditor, { props, attachTo: document.body });
  return wrapper;
}

/** The component's root element, typed — `VueWrapper.element` is untyped. */
function hostOf(w: VueWrapper): HTMLElement {
  return w.element as HTMLElement;
}

/**
 * The component's own EditorView.
 *
 * `findFromDOM` is CodeMirror's supported back-reference from a DOM node to the
 * view that owns it, which is what lets these tests read the real document
 * instead of scraping rendered spans — jsdom renders only whatever CodeMirror
 * believes is in the viewport, and with every rect at zero that is not a
 * quantity worth asserting on.
 */
function viewOf(w: VueWrapper): EditorView {
  const view = EditorView.findFromDOM(hostOf(w));
  expect(view, 'no EditorView mounted').not.toBeNull();
  return view!;
}

/** The CodeMirror document as a string. */
function docOf(w: VueWrapper): string {
  return viewOf(w).state.doc.toString();
}

/** Append `text` the way an edit would. */
function typeAtEnd(w: VueWrapper, text: string): void {
  const view = viewOf(w);
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

describe('CodeEditor — mounting', () => {
  it('renders the initial value as the document', () => {
    const w = mountEditor({ modelValue: 'hello\nworld\n', filename: 'notes.txt' });
    expect(docOf(w)).toBe('hello\nworld\n');
  });

  it('mounts an empty file without emitting anything', () => {
    const w = mountEditor({ modelValue: '', filename: 'empty.py' });
    expect(docOf(w)).toBe('');
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('mounts with no filename at all', () => {
    const w = mountEditor({ modelValue: 'x = 1\n' });
    expect(docOf(w)).toBe('x = 1\n');
  });

  it('renders line numbers, which the textarea never had', () => {
    const w = mountEditor({ modelValue: 'a\nb\nc\n', filename: 'a.py' });
    expect(hostOf(w).querySelector('.cm-lineNumbers')).not.toBeNull();
  });
});

describe('CodeEditor — editing', () => {
  it('emits the whole new document on a change', async () => {
    const w = mountEditor({ modelValue: 'a', filename: 'a.txt' });
    typeAtEnd(w, 'bc');
    await nextTick();
    expect(w.emitted('update:modelValue')).toEqual([['abc']]);
  });

  it('emits once per change, not once per character already present', async () => {
    const w = mountEditor({ modelValue: 'const x = 1;\n', filename: 'a.ts' });
    typeAtEnd(w, 'const y = 2;\n');
    typeAtEnd(w, 'const z = 3;\n');
    await nextTick();
    expect(w.emitted('update:modelValue')).toHaveLength(2);
  });

  /**
   * The round trip a store closes: emit -> setContent -> prop -> watcher. The
   * watcher must notice the value already matches and do nothing, or every
   * keystroke would replace the whole document and reset the selection.
   */
  it('does not re-emit when the prop echoes back the value it just emitted', async () => {
    const w = mountEditor({ modelValue: 'a', filename: 'a.txt' });
    typeAtEnd(w, 'b');
    await nextTick();
    await w.setProps({ modelValue: 'ab' });
    await nextTick();
    expect(w.emitted('update:modelValue')).toEqual([['ab']]);
    expect(docOf(w)).toBe('ab');
  });
});

describe('CodeEditor — external value changes', () => {
  it('replaces the document when a different file is opened', async () => {
    const w = mountEditor({ modelValue: 'first\n', filename: 'first.py' });
    await w.setProps({ modelValue: 'second\n', filename: 'second.rs' });
    await nextTick();
    expect(docOf(w)).toBe('second\n');
  });

  /**
   * The one that would show up as a phantom dirty flag: opening a file must
   * not look like the user edited it.
   */
  it('does not emit when the value is pushed in from outside', async () => {
    const w = mountEditor({ modelValue: 'first\n', filename: 'first.py' });
    await w.setProps({ modelValue: 'second\n', filename: 'second.rs' });
    await nextTick();
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('handles being cleared to the empty string', async () => {
    const w = mountEditor({ modelValue: 'something\n', filename: 'a.py' });
    await w.setProps({ modelValue: '' });
    await nextTick();
    expect(docOf(w)).toBe('');
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });
});

describe('CodeEditor — the save chord stays the parent’s', () => {
  /**
   * FilesView listens for Ctrl/Cmd-S on the container around this component.
   * No CodeMirror binding claims `Mod-s`, so the event has to bubble out; if a
   * future extension ever swallowed it, saving would break silently and this is
   * the test that would say so.
   */
  it('lets Ctrl+S bubble out of the editor', () => {
    const w = mountEditor({ modelValue: 'x\n', filename: 'a.py' });
    const seen: KeyboardEvent[] = [];
    document.body.addEventListener('keydown', (e) => seen.push(e));
    const content = hostOf(w).querySelector('.cm-content')!;
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.defaultPrevented).toBe(false);
  });

  it('lets Cmd+S bubble out of the editor', () => {
    const w = mountEditor({ modelValue: 'x\n', filename: 'a.py' });
    const seen: KeyboardEvent[] = [];
    document.body.addEventListener('keydown', (e) => seen.push(e));
    const content = hostOf(w).querySelector('.cm-content')!;
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.defaultPrevented).toBe(false);
  });
});

describe('CodeEditor — large files', () => {
  /**
   * The size guard is a pure function tested on its own; what matters here is
   * that a document big enough to trip it still opens, still reads back and
   * still emits. A file the editor refuses to COLOUR must never be a file the
   * editor refuses to EDIT — it is going to be written back over SFTP either
   * way.
   */
  it('opens and edits a document past the highlighting ceiling', async () => {
    const big = 'const a = 1;\n'.repeat(120_000); // ~1.5 MiB
    const w = mountEditor({ modelValue: big, filename: 'bundle.js' });
    expect(docOf(w)).toHaveLength(big.length);
    typeAtEnd(w, '// end\n');
    await nextTick();
    const emitted = w.emitted('update:modelValue') as [string][];
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.[0].endsWith('// end\n')).toBe(true);
  });

  it('opens a document that is one enormous line', () => {
    const oneLine = 'x'.repeat(200_000);
    const w = mountEditor({ modelValue: oneLine, filename: 'blob.min.js' });
    expect(docOf(w)).toHaveLength(oneLine.length);
  });
});

describe('CodeEditor — teardown', () => {
  it('destroys the view and removes its DOM on unmount', () => {
    const w = mountEditor({ modelValue: 'x\n', filename: 'a.py' });
    const host = hostOf(w);
    expect(host.querySelector('.cm-editor')).not.toBeNull();
    w.unmount();
    wrapper = null;
    expect(host.querySelector('.cm-editor')).toBeNull();
  });
});
