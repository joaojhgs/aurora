"""aiortc answerer for the native WebRTC interop lane.

Mirrors the Python mesh node's stack, which is the pairing the mobile native
transport depends on. Echoes every data-channel message verbatim so the Rust
peer can assert byte equality and ordering.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sys

from aiortc import RTCPeerConnection, RTCSessionDescription


async def main(binary: str) -> int:
    proc = await asyncio.create_subprocess_exec(
        binary, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE
    )
    pc = RTCPeerConnection()

    @pc.on("datachannel")
    def on_datachannel(channel):  # noqa: ANN001
        @channel.on("message")
        def on_message(message):  # noqa: ANN001
            channel.send(message)

    result = None
    assert proc.stdout is not None and proc.stdin is not None
    while True:
        raw = await proc.stdout.readline()
        if not raw:
            break
        line = raw.decode().strip()
        if line.startswith("OFFER "):
            offer = json.loads(line[len("OFFER ") :])
            await pc.setRemoteDescription(RTCSessionDescription(sdp=offer["sdp"], type="offer"))
            await pc.setLocalDescription(await pc.createAnswer())
            payload = json.dumps({"type": "answer", "sdp": pc.localDescription.sdp})
            proc.stdin.write(f"ANSWER {payload}\n".encode())
            await proc.stdin.drain()
        elif line.startswith("RESULT "):
            result = json.loads(line[len("RESULT ") :])
            break

    await pc.close()
    with contextlib.suppress(ProcessLookupError):
        proc.kill()

    if result is None:
        print(json.dumps({"lane": "aiortc", "pass": False, "error": "no result"}))
        return 1
    ok = bool(
        result.get("orderedExactEcho")
        and result.get("largePayloadOk")
        and result.get("echoed") == result.get("expected")
    )
    print(json.dumps({"lane": "aiortc", **result, "pass": ok}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1])))
