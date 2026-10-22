"""One bounded read-only inventory of the existing Personal control context."""
import base64
import datetime
import json
from pathlib import Path
import shutil
import socket
import sys


assert socket.gethostname() == "personal.skyron-server"
assert Path.cwd() == Path("/home/developer/projects/aurora")
value = {
    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "host": socket.gethostname(),
    "python": sys.executable,
    "commands": {
        name: shutil.which(name)
        for name in ("waydroid", "adb", "distrobox-host-exec", "host-spawn")
    },
    "contextMarkers": {
        name: Path(name).exists()
        for name in (
            "/.dockerenv", "/run/.containerenv", "/run/host",
            "/run/host/usr/bin/waydroid", "/run/host/usr/bin/adb",
        )
    },
    "scope": "Current approved Personal shell only; paths and marker existence",
    "deviceStatusCalls": 0,
    "deviceConnectionsOrDaemonChanges": 0,
    "inferenceOrBuildCalls": 0,
    "deviceAvailabilityProven": False,
}
encoded = base64.b64encode(json.dumps(value, sort_keys=True).encode()).decode()
parts = [encoded[i:i + 1700] for i in range(0, len(encoded), 1700)]
for index, part in enumerate(parts):
    print("AURORA_ANDROID_CONTEXT_V1745 " + json.dumps({
        "seq": index, "total": len(parts), "data": part,
    }), flush=True)
