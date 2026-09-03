// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The preload bridge's wiring, walked exhaustively.
 *
 * The preload is a pure typed forwarding surface — value in, `ipcRenderer.
 * invoke(channel, ...)` out — which makes its one failure mode silent and
 * therefore test-worthy: a typo'd or drifted channel name compiles fine and
 * fails only at runtime, when main answers "no handler for channel". So this
 * suite walks EVERY method on the exposed `api` object, derives the channel
 * it MUST use from `shared/channels.ts`, invokes the method with dummy args,
 * and asserts the channel that actually crossed the bridge.
 *
 * Three shapes exist, and the walker handles each:
 *   - `invoke`  — the default; last invoke's first arg is the channel.
 *   - `send`    — fire-and-forget (win.setTitle); same assertion on `send`.
 *   - `on*`     — subscriptions; the channel goes to `ipcRenderer.on`, and
 *                 the returned unsubscribe must remove the same listener.
 * Everything else that is NOT a forward (`win.setZoom` computes locally
 * through `webFrame`) is listed in LOCAL with the assertion it does own.
 */

const invoke = vi.fn();
const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
const setZoomFactor = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      (globalThis as Record<string, unknown>).__exposedApi = api;
    },
  },
  ipcRenderer: { invoke, send, on, removeListener },
  webFrame: { setZoomFactor, getZoomFactor: () => 1 },
}));

const { ipc } = await import('../../src/shared/channels');
// The preload takes its contextIsolation branch at import time; in a test
// process the flag is unset, so arm it before the module loads or it installs
// onto `window` instead of calling exposeInMainWorld.
process.contextIsolated = true;
await import('../../src/preload/index');

const api = (globalThis as Record<string, unknown>).__exposedApi as Record<
  string,
  Record<string, (...args: never[]) => unknown>
>;

/** Methods that do not forward, with the assertion each one does own. */
const LOCAL: Record<string, (args: unknown[]) => void> = {
  'win.setZoom': (args) => expect(setZoomFactor).toHaveBeenCalledWith(args[0]),
};

/** Channels subscribed rather than invoked; key is the api path. */
function isSubscription(group: string, key: string): boolean {
  return key.startsWith('on');
}

/** Dummy args good enough for every forward: preload validates nothing. */
const DUMMY = [1, 'a', { x: 1 }, ['y'], true, null, undefined];

beforeEach(() => {
  invoke.mockClear();
  send.mockClear();
  on.mockClear();
  removeListener.mockClear();
  setZoomFactor.mockClear();
});

describe('preload bridge — every method speaks its declared channel', () => {
  it('exposes exactly the channel groups the shared contract declares', () => {
    expect(Object.keys(api).sort()).toEqual(Object.keys(ipc).sort());
  });

  for (const [group, methods] of Object.entries(ipc)) {
    for (const key of Object.keys(methods)) {
      const path = `${group}.${key}`;
      const expected = (ipc as unknown as Record<string, Record<string, string>>)[group][key];

      it(`${path} -> ${expected}`, () => {
        const fn = api[group]?.[key];
        // Receive-only channels (main -> renderer events) have no api method;
        // their renderer half is the derived on<Name> subscription, which the
        // next branch asserts against the same channel.
        if (typeof fn !== 'function') {
          const subKey = 'on' + key[0].toUpperCase() + key.slice(1);
          expect(api[group]?.[subKey], `api.${group}.${subKey} exists`).toBeTypeOf('function');
          return;
        }

        if (path === 'win.setZoom') {
          fn(1.5);
          expect(invoke).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
          LOCAL[path]([1.5]);
          return;
        }

        if (isSubscription(group, key)) {
          const handler = vi.fn();
          const unsubscribe = fn(handler) as () => void;
          expect(on).toHaveBeenCalledWith(expected, expect.any(Function));
          // The listener must hand the PAYLOAD through, not the event.
          const registered = on.mock.calls.at(-1)![1] as (e: unknown, payload: unknown) => void;
          registered({ cue: 'event' }, { cue: 'payload' });
          expect(handler).toHaveBeenCalledWith({ cue: 'payload' });
          expect(handler).not.toHaveBeenCalledWith({ cue: 'event' }, { cue: 'payload' });
          unsubscribe();
          expect(removeListener).toHaveBeenCalledWith(expected, registered);
          return;
        }

        fn(...(DUMMY as never[]));
        // The contract under test is the CHANNEL, so assert the first argument
        // rather than the arg count — plenty of forwards take none.
        // SEND-style are the fire-and-forget forwards (setTitle; a diag report
        // already in a failed state; a preview capability handback) — they
        // must never be able to reject, so they ride `send`.
        const sendStyle = ['win.setTitle', 'diag.log', 'preview.release'].includes(path);
        const transport = sendStyle ? send : invoke;
        expect(transport.mock.calls.at(-1)?.[0]).toBe(expected);
        const other = sendStyle ? invoke : send;
        expect(other).not.toHaveBeenCalled();
      });
    }
  }
});
