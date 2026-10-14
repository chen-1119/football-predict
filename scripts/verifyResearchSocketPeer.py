"""Disposable Linux socket/process tests. Does not touch production units/paths."""
import copy
import json
import os
import socket
import subprocess
import sys
import tempfile
from researchSocketPeer import peer_credentials, process_identity, match_peer, NODE, APP, CGROUP


def verify():
    if sys.platform != "linux":
        raise RuntimeError("Explicit Linux verifier required")
    checks = 0
    with tempfile.TemporaryDirectory(prefix="football-peer-verify-") as directory:
        name = os.path.join(directory, "fixture.sock")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(name)
            listener.listen(1)
            listener.settimeout(5)
            code = "import socket,sys; s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.connect(sys.argv[1]); s.sendall(b'fixture'); s.recv(1); s.close()"
            child = subprocess.Popen([sys.executable, "-c", code, name])
            try:
                connection, _ = listener.accept()
                with connection:
                    peer = peer_credentials(connection)
                    assert peer == {"pid": child.pid, "uid": os.getuid(), "gid": os.getgid()}
                    actual = process_identity(child.pid)
                    assert actual["pid"] == child.pid and actual["uids"] == (os.getuid(),) * 4 and actual["startTicks"] > 0
                    assert actual == process_identity(child.pid)
                    checks += 3
                    fixture = {**actual, "uids": (999,) * 4, "gids": (999,) * 4, "noNewPrivileges": 1,
                               "executable": NODE, "cmdline": (NODE + "\0" + APP + "/server/index.cjs\0").encode(),
                               "cgroup": ("0::" + CGROUP + "\n").encode()}
                    expected = {"pid": child.pid, "uid": 999, "gid": 999}
                    synthetic_peer = {"pid": child.pid, "uid": 999, "gid": 999}
                    assert match_peer(synthetic_peer, fixture, expected)["startTicks"] == actual["startTicks"]
                    checks += 1
                    for field, value in (("pid", child.pid + 1), ("uids", (999, 0, 999, 999)), ("gids", (998,) * 4),
                                         ("noNewPrivileges", 0), ("executable", "/tmp/node"), ("cmdline", b"node\0unknown\0"),
                                         ("cgroup", b"0::/system.slice/other.service\n"), ("startTicks", 0)):
                        wrong = copy.deepcopy(fixture)
                        wrong[field] = value
                        try:
                            match_peer(synthetic_peer, wrong, expected)
                            raise AssertionError("unsafe caller accepted: " + field)
                        except ValueError:
                            checks += 1
                    for wrong_peer in ({**synthetic_peer, "pid": os.getpid()}, {**synthetic_peer, "uid": 0}, {**synthetic_peer, "gid": 998}):
                        try:
                            match_peer(wrong_peer, fixture, expected)
                            raise AssertionError("unsafe peer accepted")
                        except ValueError:
                            checks += 1
                    connection.sendall(b"x")
                child.wait(timeout=5)
                assert child.returncode == 0
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as datagram:
        try:
            peer_credentials(datagram)
            raise AssertionError("datagram accepted")
        except ValueError:
            checks += 1
    return {"ok": True, "checks": checks, "scope": "isolated-linux-unix-socket",
            "kernelPeerPidUidGid": True, "realProcessStartIdentity": True,
            "productionCommandAndCgroupComparisonsUseFixture": True,
            "actualProductionApiUnitVerified": False, "rootSocketServiceInstalled": False, "productionWrites": 0}


if __name__ == "__main__":
    print(json.dumps(verify()))
