"""Read-only inventory of the fixed isolated Python runtime and OS programs."""
import hashlib
import importlib.util
import json
import os
import re
import signal
import socket
import stat
import struct
import subprocess
import sys
import time


def collect():
    if sys.platform != "linux" or not sys.flags.isolated or not sys.flags.no_site or not sys.flags.dont_write_bytecode:
        raise ValueError("RESEARCH_PLATFORM_FIXED_RUNTIME")
    paths = {"/usr/bin/python3.12", "/usr/bin/flock", "/usr/bin/systemctl", "/usr/sbin/runuser",
             "/opt/node-v22.22.1/bin/node"}
    for module in tuple(sys.modules.values()):
        filename = getattr(module, "__file__", None)
        if filename and filename.startswith("/usr/"):
            paths.add(os.path.realpath(filename))
            cached = getattr(module, "__cached__", None)
            if cached and os.path.isfile(cached):
                paths.add(os.path.realpath(cached))
    files = []
    for filename in sorted(paths):
        before = os.lstat(filename)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022 or before.st_nlink != 1:
            raise ValueError("RESEARCH_PLATFORM_FILE_IDENTITY")
        with open(filename, "rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        after = os.lstat(filename)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != \
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("RESEARCH_PLATFORM_FILE_CHANGED")
        files.append({"path": filename, "bytes": before.st_size, "sha256": digest})
    return {"version": "research-platform-runtime-v1", "pythonVersion": sys.version,
            "pythonFlags": {"isolated": True, "noSite": True, "noBytecodeWrite": True}, "files": files}


if __name__ == "__main__":
    print(json.dumps(collect(), separators=(",", ":")))
