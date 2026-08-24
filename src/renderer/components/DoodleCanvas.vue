<script setup lang="ts">
/**
 * DoodleCanvas: draw a quick illustration, or annotate an image, and attach
 * the result to the prompt as a PNG.
 *
 * Why this exists at all: the agent on the other end reads images off disk
 * (AttachmentStager uploads bytes and folds the remote path into the prompt),
 * so "circle the broken button and send it" was already possible — but only
 * by leaving the app, opening an editor, saving, and dragging the file back.
 * This closes that loop without adding a single main-process code path: the
 * canvas produces PNG bytes, and `{kind:'bytes'}` staging already accepts
 * exactly that.
 *
 * ## The stroke list is the document, not the pixels
 *
 * Strokes are kept as geometry and the canvas is repainted from them on every
 * change. The obvious alternative — draw straight to the context and snapshot
 * with getImageData for undo — costs a full-frame copy per stroke and cannot
 * survive a resize or a late-loading backdrop, both of which happen here. The
 * repaint is bounded by the stroke count, which for a doodle is tens.
 *
 * ## Colour comes from the DOM, not from this file
 *
 * A canvas context needs a resolved colour string; `var(--accent)` means
 * nothing to it. Rather than hard-code the palette (which the design gate in
 * tests/unit/designGates.test.ts rightly forbids in a .vue file, and which
 * would silently drift from DESIGN.md), the pens name tokens and resolve them
 * from computed style at paint time. Change the token, the pen follows.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { AppIconName } from './AppIcon.vue';

const props = withDefaults(
  defineProps<{
    /**
     * The image to annotate, as a `data:` URL, or null for a blank canvas.
     *
     * A data URL specifically, not an object URL: the renderer's CSP allows
     * `data:` under img-src, and routing every source (clipboard, local file,
     * remote file) through the same form means the backdrop path does not care
     * where the image came from.
     */
    backdrop?: string | null;
    /** Original filename of the backdrop, used to name the attachment. */
    backdropName?: string | null;
  }>(),
  { backdrop: null, backdropName: null },
);

const emit = defineEmits<{
  commit: [{ data: Uint8Array; dataUrl: string; name: string }];
  close: [];
}>();

// ---------------------------------------------------------------------------
// Tools and pens
// ---------------------------------------------------------------------------

type Tool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse';

const TOOLS: { id: Tool; icon: AppIconName; label: string }[] = [
  { id: 'pen', icon: 'edit-2', label: 'Draw' },
  { id: 'line', icon: 'minus', label: 'Line' },
  { id: 'arrow', icon: 'arrow-right', label: 'Arrow' },
  { id: 'rect', icon: 'square', label: 'Rectangle' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse' },
];

/**
 * The pen palette, as token NAMES.
 *
 * These six are the status/accent tokens that already carry meaning in this
 * UI, so an annotation drawn in `--error` reads the same way an error does
 * everywhere else. No new token is introduced for drawing.
 */
const PENS = ['--error', '--warning', '--success', '--accent', '--agent', '--fg'] as const;
type Pen = (typeof PENS)[number];

/** Logical stroke widths. Scaled with the canvas, so they hold at any zoom. */
const WIDTHS = [3, 6, 12] as const;

const tool = ref<Tool>('pen');
const pen = ref<Pen>('--error');
const width = ref<number>(WIDTHS[1]);

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}
interface Stroke {
  tool: Tool;
  pen: Pen;
  width: number;
  points: Point[];
}

/**
 * shallowRef: strokes accumulate hundreds of points while the pointer is down.
 * Deep reactivity would make Vue walk every point on every move event to no
 * purpose — the canvas is repainted explicitly, not by a template binding.
 */
const strokes = shallowRef<Stroke[]>([]);
const drawing = ref<Stroke | null>(null);

const canvasEl = ref<HTMLCanvasElement | null>(null);
const frameEl = ref<HTMLDivElement | null>(null);
const backdropImage = shallowRef<HTMLImageElement | null>(null);
const loadError = ref<string | null>(null);
const busy = ref(false);

/** Logical canvas size. A blank sheet gets a 16:10 field; an image gets its own. */
const size = ref({ w: 1024, h: 640 });

const isEmpty = computed(() => strokes.value.length === 0 && drawing.value === null);
const canUndo = computed(() => strokes.value.length > 0);

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Resolve a token to the concrete colour the canvas context needs. */
function resolve(token: Pen): string {
  const host = canvasEl.value ?? document.documentElement;
  const value = getComputedStyle(host).getPropertyValue(token).trim();
  // A token that fails to resolve means the stylesheet is not attached — draw
  // something visible rather than throwing away the stroke.
  return value === '' ? 'white' : value;
}

function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const { points } = stroke;
  if (points.length === 0) return;

  ctx.strokeStyle = resolve(stroke.pen);
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  const first = points[0];
  const last = points[points.length - 1];

  if (stroke.tool === 'pen') {
    // Quadratic through the midpoints: joining the raw samples with straight
    // segments makes a slow hand look faceted, because pointer events arrive
    // far apart in screen space when the pointer moves slowly.
    ctx.moveTo(first.x, first.y);
    if (points.length === 1) {
      // A tap is a dot, not nothing.
      ctx.lineTo(first.x + 0.01, first.y);
    }
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const next = points[i + 1];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
    }
    if (points.length > 1) ctx.lineTo(last.x, last.y);
    ctx.stroke();
    return;
  }

  if (stroke.tool === 'line' || stroke.tool === 'arrow') {
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    if (stroke.tool === 'arrow') drawArrowHead(ctx, first, last, stroke.width);
    return;
  }

  const x = Math.min(first.x, last.x);
  const y = Math.min(first.y, last.y);
  const w = Math.abs(last.x - first.x);
  const h = Math.abs(last.y - first.y);

  if (stroke.tool === 'rect') {
    ctx.rect(x, y, w, h);
  } else {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
}

/** A filled head, sized off the stroke so it stays in proportion at any width. */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  lineWidth: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < 1) return;
  const head = Math.min(lineWidth * 4, length);
  const spread = Math.PI / 7;

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - spread), to.y - head * Math.sin(angle - spread));
  ctx.lineTo(to.x - head * Math.cos(angle + spread), to.y - head * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

function repaint(): void {
  const canvas = canvasEl.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const image = backdropImage.value;
  if (image) {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  } else {
    // A blank doodle is exported as a real PNG, so it needs an opaque ground —
    // transparent strokes on transparent would arrive as an invisible image on
    // whatever the agent's viewer happens to composite it against.
    ctx.fillStyle = getSurface();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  for (const stroke of strokes.value) strokePath(ctx, stroke);
  if (drawing.value) strokePath(ctx, drawing.value);
}

/** The blank-sheet ground, taken from the same token the app paints panels with. */
function getSurface(): string {
  const host = canvasEl.value ?? document.documentElement;
  const value = getComputedStyle(host).getPropertyValue('--surface-2').trim();
  return value === '' ? 'black' : value;
}

// ---------------------------------------------------------------------------
// Pointer input
// ---------------------------------------------------------------------------

/** Map a pointer event to logical canvas coordinates. */
function pointFrom(e: PointerEvent): Point {
  const canvas = canvasEl.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  // The canvas is CSS-scaled to fit the frame, so screen pixels are not
  // logical pixels; divide through by the displayed size, not by DPR.
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const canvas = canvasEl.value;
  if (!canvas) return;
  // Capture so a stroke that leaves the canvas keeps tracking, and so the
  // matching up event is delivered here even if it happens over the toolbar.
  canvas.setPointerCapture(e.pointerId);
  drawing.value = {
    tool: tool.value,
    pen: pen.value,
    width: width.value,
    points: [pointFrom(e)],
  };
  repaint();
}

function onPointerMove(e: PointerEvent): void {
  const stroke = drawing.value;
  if (!stroke) return;
  const point = pointFrom(e);
  if (stroke.tool === 'pen') {
    stroke.points.push(point);
  } else {
    // Every other tool is defined by two corners; dragging moves the second.
    stroke.points = [stroke.points[0], point];
  }
  repaint();
}

function onPointerUp(e: PointerEvent): void {
  const stroke = drawing.value;
  if (!stroke) return;
  canvasEl.value?.releasePointerCapture(e.pointerId);
  drawing.value = null;
  // A click with no drag leaves a shape of zero extent; only the pen means
  // anything by a single point.
  const degenerate =
    stroke.tool !== 'pen' &&
    stroke.points.length === 2 &&
    Math.hypot(
      stroke.points[1].x - stroke.points[0].x,
      stroke.points[1].y - stroke.points[0].y,
    ) < 2;
  if (!degenerate) strokes.value = [...strokes.value, stroke];
  repaint();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function undo(): void {
  strokes.value = strokes.value.slice(0, -1);
  repaint();
}

function clear(): void {
  strokes.value = [];
  drawing.value = null;
  repaint();
}

function onKeydown(e: KeyboardEvent): void {
  // Ctrl/Cmd+Z only. Escape is the overlay's to handle, and it already does.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && canUndo.value) {
    e.preventDefault();
    undo();
  }
}

function attachmentName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  const source = props.backdropName?.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-');
  return source ? `annotated-${source}-${stamp}.png` : `doodle-${stamp}.png`;
}

async function commit(): Promise<void> {
  const canvas = canvasEl.value;
  if (!canvas || busy.value) return;
  busy.value = true;
  try {
    const blob = await new Promise<Blob | null>((resolve_) =>
      canvas.toBlob(resolve_, 'image/png'),
    );
    if (!blob) {
      loadError.value = 'Could not encode the drawing.';
      return;
    }
    emit('commit', {
      data: new Uint8Array(await blob.arrayBuffer()),
      // The tile preview is a data URL because the CSP allows `data:` for
      // img-src; it is never persisted, exactly like the other tile previews.
      dataUrl: canvas.toDataURL('image/png'),
      name: attachmentName(),
    });
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Backdrop loading
// ---------------------------------------------------------------------------

async function loadBackdrop(source: string | null): Promise<void> {
  backdropImage.value = null;
  loadError.value = null;
  if (!source) {
    size.value = { w: 1024, h: 640 };
    await nextTick();
    repaint();
    return;
  }

  const image = new Image();
  await new Promise<void>((done) => {
    image.onload = () => done();
    image.onerror = () => {
      loadError.value = 'That image could not be opened.';
      done();
    };
    image.src = source;
  });

  if (loadError.value === null && image.naturalWidth > 0) {
    // Cap the working resolution. A phone screenshot is ~1179x2556 and a
    // desktop capture can be 5K; annotating at full native size costs memory
    // and export bytes for detail no one is going to look at, and the strokes
    // scale with the image anyway.
    const MAX = 2048;
    const scale = Math.min(1, MAX / Math.max(image.naturalWidth, image.naturalHeight));
    size.value = {
      w: Math.round(image.naturalWidth * scale),
      h: Math.round(image.naturalHeight * scale),
    };
    backdropImage.value = image;
  }
  await nextTick();
  repaint();
}

watch(() => props.backdrop, loadBackdrop);

onMounted(async () => {
  document.addEventListener('keydown', onKeydown);
  await loadBackdrop(props.backdrop);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="doodle">
    <div class="toolbar" role="toolbar" aria-label="Drawing tools">
      <div class="group" role="group" aria-label="Tool">
        <button
          v-for="t in TOOLS"
          :key="t.id"
          class="tool-btn"
          :class="{ active: tool === t.id }"
          :title="t.label"
          :aria-label="t.label"
          :aria-pressed="tool === t.id"
          @click="tool = t.id"
        >
          <AppIcon :name="t.icon" :size="14" />
        </button>
      </div>

      <div class="sep" />

      <div class="group" role="group" aria-label="Colour">
        <button
          v-for="p in PENS"
          :key="p"
          class="pen-btn"
          :class="{ active: pen === p }"
          :style="{ '--pen': `var(${p})` }"
          :title="p.replace('--', '')"
          :aria-label="p.replace('--', '')"
          :aria-pressed="pen === p"
          @click="pen = p"
        >
          <span class="swatch" />
        </button>
      </div>

      <div class="sep" />

      <div class="group" role="group" aria-label="Stroke width">
        <button
          v-for="w in WIDTHS"
          :key="w"
          class="width-btn"
          :class="{ active: width === w }"
          :title="`${w}px`"
          :aria-label="`Stroke ${w} pixels`"
          :aria-pressed="width === w"
          @click="width = w"
        >
          <span class="width-dot" :style="{ '--dot': `${Math.round(w / 1.5) + 2}px` }" />
        </button>
      </div>

      <div class="spacer" />

      <button class="tool-btn" :disabled="!canUndo" title="Undo" @click="undo">
        <AppIcon name="rotate-ccw" :size="14" />
      </button>
      <button class="tool-btn" :disabled="isEmpty" title="Clear" @click="clear">
        <AppIcon name="trash-2" :size="14" />
      </button>
    </div>

    <div ref="frameEl" class="frame">
      <canvas
        ref="canvasEl"
        class="sheet"
        :width="size.w"
        :height="size.h"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>

    <footer class="actions">
      <p v-if="loadError" class="error">{{ loadError }}</p>
      <p v-else class="hint">{{ backdropName || 'Blank sheet' }}</p>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn primary" :disabled="busy" @click="commit">Attach</button>
    </footer>
  </div>
</template>

<style scoped>
.doodle {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

/* ---- Toolbar ------------------------------------------------------------ */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  flex-wrap: wrap;
}
.group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sep {
  width: 1px;
  align-self: stretch;
  margin: 0 var(--sp-1);
  background: var(--border);
}
.spacer {
  flex: 1 1 auto;
}

.tool-btn,
.pen-btn,
.width-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tool-btn:hover:not(:disabled),
.pen-btn:hover,
.width-btn:hover {
  background: var(--state-hover);
  color: var(--fg);
}
.tool-btn.active,
.width-btn.active {
  background: var(--state-selected);
  border-color: var(--accent-dim);
  color: var(--accent);
}
.tool-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.tool-btn:focus-visible,
.pen-btn:focus-visible,
.width-btn:focus-visible,
.btn:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

/* The swatch IS the affordance, so it carries the selected state as a ring
   rather than a fill — a filled background behind a colour chip reads as a
   second, competing colour. */
.swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--pen);
}
.pen-btn.active {
  border-color: var(--fg);
}

.width-dot {
  width: var(--dot);
  height: var(--dot);
  border-radius: 50%;
  background: currentColor;
}

/* ---- Sheet -------------------------------------------------------------- */
.frame {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: var(--sp-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
/* Fit the sheet inside the overlay without ever scaling it up: an 800px-wide
   screenshot blown up to fill a 960px panel would be annotated against soft
   pixels. */
.sheet {
  max-width: 100%;
  max-height: 56vh;
  object-fit: contain;
  border-radius: var(--r-sm);
  cursor: crosshair;
  touch-action: none;
}

/* ---- Footer ------------------------------------------------------------- */
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.hint,
.error {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
.error {
  color: var(--error);
}
.btn {
  height: var(--control-h);
  padding: 0 var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  font-size: var(--fs-200);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: var(--state-hover);
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-semibold);
}
.btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
</style>
