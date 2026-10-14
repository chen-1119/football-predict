"""Isolated stream-frame and lifecycle tests; no production service is started."""
import importlib.util
import json
import os
import socket
import struct
import sys
import threading
from unittest.mock import patch

source = os.path.join(os.path.dirname(__file__), "researchSocketServer.py")
spec = importlib.util.spec_from_file_location("listener_candidate", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def verify():
    if sys.platform != "linux":
        raise RuntimeError("Linux is required for the actual AF_UNIX stream verifier")
    checks = 0
    cases = [(struct.pack("!I", 2) + b"{}", None),
             (struct.pack("!I", 1) + b"x", "RESEARCH_REQUEST_BOUND"),
             (struct.pack("!I", module.MAX_REQUEST + 1), "RESEARCH_REQUEST_BOUND"),
             (b"\x00\x00", "RESEARCH_SOCKET_TRUNCATED"),
             (struct.pack("!I", 4) + b"{}", "RESEARCH_SOCKET_TRUNCATED"),
             (struct.pack("!I", 2) + b"{}x", "RESEARCH_SOCKET_EXTRA_BYTES")]
    for frame, error in cases:
        client, server = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.sendall(frame)
            client.shutdown(socket.SHUT_WR)
            try:
                body = module.receive_frame(server)
                assert error is None and body == b"{}"
            except ValueError as exc:
                assert str(exc) == error
            checks += 1
        finally:
            client.close()
            server.close()
    expected_command = ["/usr/bin/flock", "--no-fork", "--exclusive", "--nonblock", "--conflict-exit-code", "75",
                        "/run/lock/football-release.lock", "/opt/node-v22.22.1/bin/node",
                        "/opt/football-predict/scripts/researchReleaseBroker.cjs"]
    assert module.broker_command() == expected_command
    checks += 1
    binding = {"transport": {"footballUid": 999, "footballGid": 999}}
    for changed_peer, changed_binding in ((False, False), (True, False), (False, True)):
        client, server = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        calls, broker_calls, outcome = [], [], []
        class Peer:
            @staticmethod
            def api_peer_snapshot(connection, uid, gid):
                assert (uid, gid) == (999, 999)
                calls.append(True)
                return {"pid": 100, "startTicks": 1 + int(changed_peer and len(calls) > 1)}
        def worker():
            try:
                with patch.object(module, "installed_binding", return_value=(binding, "changed" if changed_binding else "same")), \
                        patch.object(module, "run_broker", side_effect=lambda body: broker_calls.append(body) or b"verified-result"):
                    module.serve_connection(server, binding, "same", Peer)
                outcome.append("ok")
            except ValueError as exc:
                outcome.append(str(exc))
            finally:
                server.close()
        thread = threading.Thread(target=worker)
        thread.start()
        try:
            client.sendall(struct.pack("!I", 2) + b"{}")
            client.shutdown(socket.SHUT_WR)
            received = bytearray()
            while True:
                chunk = client.recv(1024)
                if not chunk:
                    break
                received.extend(chunk)
            thread.join(timeout=5)
            assert not thread.is_alive()
            if changed_peer or changed_binding:
                assert not broker_calls and outcome[0] != "ok"
            else:
                assert broker_calls == [b"{}"] and outcome == ["ok"]
                assert bytes(received) == struct.pack("!I", 15) + b"verified-result" and len(calls) == 3
            checks += 1
        finally:
            client.close()
    return {"ok": True, "checks": checks, "scope": "isolated-unix-stream-frames",
            "fixedCommandChecked": True, "preAndPostBodyPeerRecheck": True,
            "actualProductionApiCallerVerified": False, "productionServicesStarted": 0, "productionWrites": 0}


if __name__ == "__main__":
    print(json.dumps(verify()))
