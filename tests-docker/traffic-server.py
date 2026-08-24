#!/usr/bin/env python3
"""Deterministic traffic responder for the port-forwarding tests.

Every other listener the fixture stands up is IDLE: something binds a port,
nothing ever moves bytes through it. That made the port panel's In/Out
columns permanently read "0 B", so neither the byte counters
(`Forwarder.bytesIn`/`bytesOut`) nor the derived rate had ever been observed
doing real work, and a counting or rate bug would have been invisible.

This server exists so a test can push an EXACT, KNOWN number of bytes in each
direction and assert the counters against real numbers rather than `> 0`.

Wire protocol (one request per connection, then the server closes):

    <up> <down> [chunk] [gap_ms]\\n     <up> bytes of padding

  up      bytes the client will send after the header. The server reads
          exactly this many and discards them. No half-close needed, so the
          test does not depend on EOF propagating through the SSH channel.
  down    bytes the server writes back, exactly.
  chunk   write size for the response (default 65536).
  gap_ms  sleep between response chunks (default 0). Pacing is what makes a
          rate assertion possible: without it a megabyte over loopback lands
          faster than the sampler's minimum window and every rate reads 0.

The two directions are deliberately independent so a test can request
different magnitudes each way -- equal counts would not catch In/Out being
swapped.

Usage: traffic-server.py [PORT]      (default 8021)
"""

import socket
import socketserver
import sys
import time

DEFAULT_PORT = 8021
DEFAULT_CHUNK = 65536
# Cap so a malformed or hostile header cannot make the fixture write forever.
MAX_BYTES = 256 * 1024 * 1024
HEADER_LIMIT = 64


class TrafficHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        read = self._read_header()
        if read is None:
            return
        header, leftover = read
        fields = header.split()
        try:
            up = int(fields[0])
            down = int(fields[1])
            chunk = int(fields[2]) if len(fields) > 2 else DEFAULT_CHUNK
            gap_ms = int(fields[3]) if len(fields) > 3 else 0
        except (IndexError, ValueError):
            return

        up = max(0, min(up, MAX_BYTES))
        down = max(0, min(down, MAX_BYTES))
        chunk = max(1, min(chunk, DEFAULT_CHUNK))
        gap_ms = max(0, min(gap_ms, 5000))

        self._drain(up - len(leftover))
        self._respond(down, chunk, gap_ms)

    def _read_header(self):
        """Read up to the first newline.

        Returns `(header, leftover)`, where `leftover` is everything already
        received PAST the newline. Handing that back is not tidiness: TCP is
        a stream, so the client's separate header and padding writes routinely
        arrive in one segment (all the more so once they have been through an
        SSH channel). Dropping the tail here and then waiting for `up` further
        bytes deadlocks the connection, which is exactly what happened the
        first time this ran.

        None when the peer gave up before sending a complete header.
        """
        buf = b""
        while b"\n" not in buf and len(buf) < HEADER_LIMIT:
            piece = self.request.recv(HEADER_LIMIT - len(buf))
            if not piece:
                return None
            buf += piece
        if b"\n" not in buf:
            return None
        header, leftover = buf.split(b"\n", 1)
        return header.decode("ascii", "replace"), leftover

    def _drain(self, count: int) -> None:
        """Read exactly `count` more bytes of padding and throw them away."""
        remaining = count
        while remaining > 0:
            piece = self.request.recv(min(remaining, DEFAULT_CHUNK))
            if not piece:
                return
            remaining -= len(piece)

    def _respond(self, count: int, chunk: int, gap_ms: int) -> None:
        block = b"x" * chunk
        remaining = count
        first = True
        while remaining > 0:
            if gap_ms and not first:
                time.sleep(gap_ms / 1000.0)
            first = False
            take = min(remaining, chunk)
            try:
                self.request.sendall(block[:take])
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            remaining -= take


class TrafficServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    address_family = socket.AF_INET


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    # Bind loopback only: the forward reaches it via `forwardOut` to
    # 127.0.0.1 inside the container, and the port scanner reads
    # `127.0.0.1:PORT` out of `ss -tln` just fine.
    with TrafficServer(("127.0.0.1", port), TrafficHandler) as server:
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
