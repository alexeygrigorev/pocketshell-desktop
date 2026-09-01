import { afterEach, describe, expect, it } from 'vitest';
import type { SshService, CloseReason } from '../../src/main/ssh/SshService';
import { ConnectionRegistry } from '../../src/main/ssh/ConnectionRegistry';
import { ForwardService } from '../../src/main/portfwd/ForwardService';
import { MemoryBackend, PortfwdStore } from '../../src/main/portfwd/PortfwdStore';

/** Minimal SSH surface needed to let ForwardService start and suspend. */
class FakeSsh {
  private closeListener: ((connectionId: string, reason: CloseReason) => void) | null = null;

  onCloseConnection(listener: (connectionId: string, reason: CloseReason) => void): () => void {
    this.closeListener = listener;
    return () => {
      if (this.closeListener === listener) this.closeListener = null;
    };
  }

  exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return Promise.resolve({ stdout: '<<<PS_SS_TLN>>>\n', stderr: '', exitCode: 0 });
  }

  close(connectionId: string, reason: CloseReason): void {
    this.closeListener?.(connectionId, reason);
  }
}

describe('ForwardService connection lifetime', () => {
  let service: ForwardService | undefined;

  afterEach(() => {
    service?.dispose();
    service = undefined;
  });

  it('keeps the host auto-forward preference across a lost transport', () => {
    const ssh = new FakeSsh();
    const store = new PortfwdStore(new MemoryBackend());
    service = new ForwardService(
      ssh as unknown as SshService,
      new ConnectionRegistry(),
      store,
    );

    service.startAuto('conn-1');
    ssh.close('conn-1', 'lost');

    // The renderer's reconnect path reads this preference using the new
    // connection id and starts the engine before the Ports panel is opened.
    expect(store.read('conn-1').autoEnabled).toBe(true);
  });
});
