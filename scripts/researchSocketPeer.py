"""Linux peer admission candidate; no listener, launcher or installer here.

The later signed root socket service must call this before and after receiving
the body, compare both identities, then use the original fixed release broker.
This module does not authorize research quality or mutate any database.
"""
import os
import re
import socket
import struct
import subprocess

NODE = "/opt/node-v22.22.1/bin/node"
APP = "/opt/football-predict"
UNIT = "football-predict.service"
CGROUP = "/system.slice/football-predict.service"


def fail(code):
    raise ValueError(code)


def peer_credentials(connection):
    if connection.family != socket.AF_UNIX or connection.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM:
        fail("RESEARCH_UNIX_STREAM_REQUIRED")
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", raw)
    if pid < 2 or uid < 0 or gid < 0:
        fail("RESEARCH_KERNEL_PEER_REQUIRED")
    return {"pid": pid, "uid": uid, "gid": gid}


def process_identity(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < 2:
        fail("RESEARCH_PROCESS_IDENTITY")
    base = f"/proc/{pid}"
    with open(base + "/stat", "rb") as source:
        fields = source.read(16385)
    if len(fields) > 16384:
        fail("RESEARCH_PROCESS_BOUND")
    tail = fields[fields.rfind(b")") + 2:].split()
    if len(tail) < 20 or tail[0] in (b"Z", b"X") or not tail[19].isdigit():
        fail("RESEARCH_PROCESS_IDENTITY")
    values = {}
    for name, maximum in (("status", 16384), ("cgroup", 4096), ("cmdline", 4096)):
        with open(base + "/" + name, "rb") as source:
            raw = source.read(maximum + 1)
        if len(raw) > maximum:
            fail("RESEARCH_PROCESS_BOUND")
        values[name] = raw
    ids = []
    for name in (b"Uid", b"Gid"):
        match = re.search(rb"^" + name + rb":\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", values["status"], re.M)
        if not match:
            fail("RESEARCH_PROCESS_IDENTITY")
        ids.append(tuple(int(value) for value in match.groups()))
    nnp = re.search(rb"^NoNewPrivs:\s+(\d+)\s*$", values["status"], re.M)
    return {"pid": pid, "startTicks": int(tail[19]), "uids": ids[0], "gids": ids[1],
            "noNewPrivileges": int(nnp.group(1)) if nnp else None,
            "cgroup": values["cgroup"], "cmdline": values["cmdline"], "executable": os.readlink(base + "/exe")}


def match_peer(peer, observed, expected):
    """Pure comparison; expected is root-observed installer/unit context, never request JSON."""
    uid, gid, pid = expected["uid"], expected["gid"], expected["pid"]
    if uid < 1 or gid < 1 or pid < 2 or peer != {"pid": pid, "uid": uid, "gid": gid}:
        fail("RESEARCH_API_PEER_MISMATCH")
    if observed["pid"] != pid or observed["uids"] != (uid,) * 4 or observed["gids"] != (gid,) * 4:
        fail("RESEARCH_API_PROCESS_MISMATCH")
    if observed["startTicks"] < 1 or observed["noNewPrivileges"] != 1 or observed["executable"] != NODE:
        fail("RESEARCH_API_PROCESS_MISMATCH")
    if observed["cmdline"] != (NODE + "\0" + APP + "/server/index.cjs\0").encode():
        fail("RESEARCH_API_COMMAND_MISMATCH")
    if observed["cgroup"] != ("0::" + CGROUP + "\n").encode():
        fail("RESEARCH_API_CGROUP_MISMATCH")
    return {"pid": pid, "uid": uid, "gid": gid, "startTicks": observed["startTicks"]}


def api_peer_snapshot(connection, uid, gid):
    if os.getuid() != 0:
        fail("RESEARCH_ROOT_PEER_GATE_REQUIRED")
    names = ("MainPID", "ActiveState", "SubState", "ControlPID", "Job", "User", "Group",
             "WorkingDirectory", "ControlGroup", "InvocationID", "NoNewPrivileges", "RestrictSUIDSGID")
    answer = subprocess.run(["/usr/bin/systemctl", "show", "--all", "--property=" + ",".join(names), UNIT],
                            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8, check=True)
    if len(answer.stdout) > 8192 or answer.stderr:
        fail("RESEARCH_API_UNIT_UNAVAILABLE")
    unit = {}
    for line in answer.stdout.decode("utf-8", errors="strict").splitlines():
        key, sep, value = line.partition("=")
        if not sep or key not in names or key in unit:
            fail("RESEARCH_API_UNIT_UNAVAILABLE")
        unit[key] = value
    if set(unit) != set(names) or unit["ActiveState"] != "active" or unit["SubState"] != "running" \
            or unit["ControlPID"] != "0" or unit["Job"] != "" or unit["User"] != "football" or unit["Group"] != "football" \
            or unit["WorkingDirectory"] != APP or unit["ControlGroup"] != CGROUP \
            or unit["NoNewPrivileges"] != "yes" or unit["RestrictSUIDSGID"] != "yes" \
            or not re.fullmatch(r"[a-f0-9]{32}", unit["InvocationID"]) or not re.fullmatch(r"[1-9][0-9]*", unit["MainPID"]):
        fail("RESEARCH_API_UNIT_MISMATCH")
    peer = peer_credentials(connection)
    before = process_identity(peer["pid"])
    identity = match_peer(peer, before, {"pid": int(unit["MainPID"]), "uid": uid, "gid": gid})
    if before != process_identity(peer["pid"]):
        fail("RESEARCH_API_PROCESS_CHANGED")
    return {**identity, "invocationId": unit["InvocationID"]}
