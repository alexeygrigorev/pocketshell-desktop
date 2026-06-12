import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'ssh2';

/** Result of an SSH command execution. */
export interface SSHResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Execute a command over SSH using key-based authentication.
 *
 * @param host     SSH hostname
 * @param port     SSH port
 * @param user     SSH username
 * @param keyPath  Path to the private key file
 * @param command  Command to execute
 * @param timeout  Execution timeout in ms (default 15_000)
 */
export function sshExec(
  host: string,
  port: number,
  user: string,
  keyPath: string,
  command: string,
  timeout = 15_000,
): Promise<SSHResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();

    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`SSH exec timed out after ${timeout}ms: ${command}`));
    }, timeout);

    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          client.end();
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          client.end();
          resolve({ stdout, stderr, exitCode: code });
        });
      });
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Read the private key
    const key = fs.readFileSync(keyPath);

    client.connect({
      host,
      port,
      username: user,
      privateKey: key,
      readyTimeout: timeout,
      // Accept any host key (test fixture only)
      hostVerifier: () => true,
    });
  });
}

/**
 * Wait until an SSH connection is successfully established.
 * Polls at the given interval until the timeout is reached.
 *
 * @param host     SSH hostname
 * @param port     SSH port
 * @param user     SSH username
 * @param keyPath  Path to the private key file
 * @param timeout  Total timeout in ms (default 30_000)
 * @param interval Polling interval in ms (default 1_000)
 */
export async function waitForSSH(
  host: string,
  port: number,
  user: string,
  keyPath: string,
  timeout = 30_000,
  interval = 1_000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      // First, check TCP connectivity
      const tcpReachable = await checkTCP(host, port, 3_000);
      if (!tcpReachable) {
        await sleep(interval);
        continue;
      }

      // Then try SSH
      await sshExec(host, port, user, keyPath, 'true', 5_000);
      return;
    } catch {
      await sleep(interval);
    }
  }

  throw new Error(
    `SSH not reachable at ${user}@${host}:${port} after ${timeout}ms`,
  );
}

function checkTCP(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
