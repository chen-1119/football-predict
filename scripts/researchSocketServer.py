"""Fixed root-owned Unix socket transport for the signed research broker.

The installed binding and service are supplied by the signed installer. No
request can choose a command, environment, user, socket or database. This
listener does not implement research, collection or automatic publication.
"""
import hashlib
import importlib.util
import json
import os
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

BASE = "/usr/local/libexec/football-research-broker"
CONFIG = BASE + "/runtime-binding.json"
SOCKET = "/run/football-research-broker/submit.sock"
NODE = "/opt/node-v22.22.1/bin/node"
APP = "/opt/football-predict"
LOCK = "/run/lock/football-release.lock"
MAX_REQUEST = 1024 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
FRAME_SECONDS = 8
COMMAND_SECONDS = 65


def fail(code):
    raise ValueError(code)


def trusted_read(filename, maximum):
    for item in [filename] + list(ancestors(filename)):
        before = os.lstat(item)
        if stat.S_ISLNK(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022:
            fail("RESEARCH_SOCKET_ROOT_IDENTITY")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    fd = os.open(filename, flags)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or opened.st_size > maximum:
            fail("RESEARCH_SOCKET_SOURCE_BOUND")
        data = os.read(fd, maximum + 1)
        end = os.fstat(fd)
        after = os.lstat(filename)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(data) != opened.st_size or identity(opened) != identity(end) or identity(end) != identity(after):
            fail("RESEARCH_SOCKET_SOURCE_CHANGED")
        return data
    finally:
        os.close(fd)


def ancestors(filename):
    item = os.path.dirname(filename)
    while True:
        yield item
        if item == "/":
            break
        item = os.path.dirname(item)


def installed_binding():
    raw = trusted_read(CONFIG, 16384)
    binding = json.loads(raw.decode("utf-8", errors="strict"))
    transport, service = binding.get("transport", {}), binding.get("socketService", {})
    if binding.get("version") != "research-broker-binding-v1" or transport.get("version") != "research-unix-socket-v1" \
            or service.get("version") != "research-root-socket-service-v1":
        fail("RESEARCH_SOCKET_BINDING")
    uid, gid = transport.get("footballUid"), transport.get("footballGid")
    if any(not isinstance(i, int) or isinstance(i, bool) or i < 1 for i in (uid, gid)):
        fail("RESEARCH_SOCKET_BINDING")
    paths = [(BASE + "/researchSocketServer.py", service.get("listenerSha")),
             (BASE + "/researchSocketPeer.py", transport.get("peerSourceSha")),
             (APP + "/scripts/researchReleaseBroker.cjs", service.get("brokerSourceSha")),
             (NODE, binding.get("nodeSha"))]
    for filename, expected in paths:
        if not isinstance(expected, str) or len(expected) != 64 or hashlib.sha256(trusted_read(filename, 128 * 1024 * 1024)).hexdigest() != expected:
            fail("RESEARCH_SOCKET_BINDING_SOURCE")
    platform_raw = trusted_read(BASE + "/platform.json", 1024 * 1024)
    if hashlib.sha256(platform_raw).hexdigest() != service.get("platformSha256"):
        fail("RESEARCH_SOCKET_PLATFORM_BINDING")
    platform = json.loads(platform_raw)
    if platform.get("version") != "research-platform-runtime-v1" or not isinstance(platform.get("files"), list) \
            or not 5 <= len(platform["files"]) <= 512:
        fail("RESEARCH_SOCKET_PLATFORM_BINDING")
    for row in platform["files"]:
        filename = row.get("path", "")
        if not (filename.startswith("/usr/lib/python3.12/") or filename in \
                ("/usr/bin/python3.12", "/usr/bin/flock", "/usr/bin/systemctl", "/usr/sbin/runuser", NODE)):
            fail("RESEARCH_SOCKET_PLATFORM_PATH")
        if hashlib.sha256(trusted_read(filename, 128 * 1024 * 1024)).hexdigest() != row.get("sha256"):
            fail("RESEARCH_SOCKET_PLATFORM_CHANGED")
    bound_paths = {row["path"] for row in platform["files"]}
    # These two application sources were checked above against their separate
    # signed hashes. /usr/local is not part of the Python standard library.
    # Admit only these exact files, never an arbitrary sibling or base prefix.
    signed_source_paths = {filename for filename, _ in paths[:2]}
    for module in tuple(sys.modules.values()):
        filename = getattr(module, "__file__", None)
        if filename and filename.startswith("/usr/") and os.path.realpath(filename) not in bound_paths | signed_source_paths:
            fail("RESEARCH_SOCKET_UNBOUND_PYTHON_MODULE")
        cached = getattr(module, "__cached__", None)
        if cached and cached.startswith("/usr/") and os.path.isfile(cached) and os.path.realpath(cached) not in bound_paths:
            fail("RESEARCH_SOCKET_UNBOUND_PYTHON_CACHE")
    return binding, hashlib.sha256(raw).hexdigest()


def load_peer_module():
    # Isolated Python does not include the script directory on sys.path. Load
    # only this already hash-verified root-owned module, not a request path.
    filename = BASE + "/researchSocketPeer.py"
    spec = importlib.util.spec_from_file_location("football_research_socket_peer", filename)
    module = importlib.util.module_from_spec(spec)
    # -B suppresses cache writes but does not suppress cache reads. Compile the
    # already verified source directly so a pre-existing .pyc cannot replace it.
    exec(compile(trusted_read(filename, 1024 * 1024), filename, "exec", dont_inherit=True), module.__dict__)
    return module


def receive_exact(connection, size, deadline):
    chunks, left = [], size
    while left:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail("RESEARCH_SOCKET_BODY_TIMEOUT")
        connection.settimeout(remaining)
        chunk = connection.recv(left)
        if not chunk:
            fail("RESEARCH_SOCKET_TRUNCATED")
        chunks.append(chunk)
        left -= len(chunk)
    return b"".join(chunks)


def receive_frame(connection):
    deadline = time.monotonic() + FRAME_SECONDS
    length = struct.unpack("!I", receive_exact(connection, 4, deadline))[0]
    if length < 2 or length > MAX_REQUEST:
        fail("RESEARCH_REQUEST_BOUND")
    body = receive_exact(connection, length, deadline)
    # The API half-closes its sending side. Reject extra/truncated frames.
    connection.settimeout(max(0.001, deadline - time.monotonic()))
    if connection.recv(1):
        fail("RESEARCH_SOCKET_EXTRA_BYTES")
    return body


def broker_command():
    return ["/usr/bin/flock", "--no-fork", "--exclusive", "--nonblock", "--conflict-exit-code", "75",
            LOCK, NODE, APP + "/scripts/researchReleaseBroker.cjs"]


def run_broker(body):
    # Same systemd cgroup, no detached process/session. Inherited flock remains
    # held by the actual Node/runuser/database child until that child exits.
    child = subprocess.Popen(broker_command(), cwd=APP, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             close_fds=True, start_new_session=False)
    try:
        stdout, stderr = child.communicate(body, timeout=COMMAND_SECONDS)
    except subprocess.TimeoutExpired:
        # Do not kill only the root parent and return success. Terminate the
        # service through systemd's control-group cleanup, preserving intents.
        fail("RESEARCH_SOCKET_CHILD_TIMEOUT")
    if len(stdout) > MAX_RESPONSE or len(stderr) > 16384 or stderr or child.returncode != 0:
        fail("RESEARCH_SOCKET_UNCONFIRMED_READ_FIRST")
    return stdout


def serve_connection(connection, binding, binding_hash, peer_module):
    uid, gid = binding["transport"]["footballUid"], binding["transport"]["footballGid"]
    before = peer_module.api_peer_snapshot(connection, uid, gid)
    body = receive_frame(connection)
    if peer_module.api_peer_snapshot(connection, uid, gid) != before:
        fail("RESEARCH_API_PROCESS_CHANGED")
    if installed_binding()[1] != binding_hash:
        fail("RESEARCH_SOCKET_BINDING_CHANGED")
    answer = run_broker(body)
    if peer_module.api_peer_snapshot(connection, uid, gid) != before:
        fail("RESEARCH_API_PROCESS_CHANGED")
    connection.settimeout(8)
    connection.sendall(struct.pack("!I", len(answer)) + answer)


def main():
    verify_only = sys.argv[1:] == ["--verify-binding"]
    if sys.platform != "linux" or os.getuid() != 0 or not sys.flags.isolated or not sys.flags.no_site or not sys.flags.dont_write_bytecode \
            or (len(sys.argv) != 1 and not verify_only) or os.path.realpath(sys.argv[0]) != BASE + "/researchSocketServer.py":
        fail("RESEARCH_FIXED_ROOT_SOCKET_REQUIRED")
    binding, fingerprint = installed_binding()
    peer = load_peer_module()
    if installed_binding()[1] != fingerprint:
        fail("RESEARCH_SOCKET_BINDING_CHANGED")
    if verify_only:
        print(json.dumps({"verified": True, "releaseSha": binding["releaseSha"],
                          "bindingSha256": fingerprint, "listenerStarted": False, "productionWrites": 0}))
        return
    directory = os.lstat(os.path.dirname(SOCKET))
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_gid != binding["transport"]["footballGid"] \
            or stat.S_IMODE(directory.st_mode) != 0o750:
        fail("RESEARCH_SOCKET_DIRECTORY_IDENTITY")
    if os.path.lexists(SOCKET):
        # RuntimeDirectoryPreserve=no removes this only after the service and
        # all its children stop. Never unlink an unknown/live socket here.
        fail("RESEARCH_SOCKET_ALREADY_PRESENT")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(SOCKET)
        os.chown(SOCKET, 0, binding["transport"]["footballGid"])
        os.chmod(SOCKET, 0o660)
        listener.listen(4)
        while True:
            connection, _ = listener.accept()
            with connection:
                try:
                    serve_connection(connection, binding, fingerprint, peer)
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    if str(error) == "RESEARCH_SOCKET_CHILD_TIMEOUT":
                        # KillMode=control-group removes every descendant before
                        # restart. No subsequent command starts in this process.
                        raise
                    print(json.dumps({"ok": False, "error": "RESEARCH_SOCKET_REQUEST_REFUSED", "retryWriteAutomatically": False}), file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
