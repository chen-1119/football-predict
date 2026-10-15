"""Actual isolated Python entrypoint verification in a root-owned test layout.

The fixture is a unique temporary sibling of the production application path.
It starts no listener or systemd service and accesses no production database.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import py_compile
import subprocess
import sys
import tempfile


def verify():
    if sys.platform != "linux" or os.getuid() != 0 or not sys.flags.isolated \
            or not sys.flags.no_site or not sys.flags.dont_write_bytecode:
        raise RuntimeError("Root Linux Python with -I -S -B is required for this filesystem fixture")
    source_root = pathlib.Path(__file__).resolve().parent
    python = os.path.realpath(sys.executable)
    spec = importlib.util.spec_from_file_location("platform_fixture", source_root / "researchBrokerPlatform.py")
    platform_module = importlib.util.module_from_spec(spec)
    # The fixed Node image is represented by the real isolated Python image in
    # this test layout only. No production caller/Node identity is asserted.
    platform_code = (source_root / "researchBrokerPlatform.py").read_text().replace(
        '"/opt/node-v22.22.1/bin/node"', repr(python))
    exec(compile(platform_code, str(source_root / "researchBrokerPlatform.py"), "exec"), platform_module.__dict__)
    platform = platform_module.collect()
    digest = lambda raw: hashlib.sha256(raw).hexdigest()
    pathlib.Path("/usr/local/libexec").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="football-research-binding-verify-", dir="/usr/local/libexec") as folder:
        base = pathlib.Path(folder)
        app = base / "app"
        (app / "scripts").mkdir(parents=True)
        broker = app / "scripts" / "researchReleaseBroker.cjs"
        broker.write_bytes(b"// isolated source identity fixture\n")
        peer = base / "researchSocketPeer.py"
        peer_original = (source_root / peer.name).read_bytes()
        peer.write_bytes(peer_original)
        listener = base / "researchSocketServer.py"
        listener_original = (source_root / listener.name).read_text().replace(
            'BASE = "/usr/local/libexec/football-research-broker"', "BASE = " + repr(str(base))).replace(
            'APP = "/opt/football-predict"', "APP = " + repr(str(app))).replace(
            'NODE = "/opt/node-v22.22.1/bin/node"', "NODE = " + repr(python))
        platform_raw = json.dumps(platform).encode()
        (base / "platform.json").write_bytes(platform_raw)
        binding = {"version": "research-broker-binding-v1", "releaseSha": "a" * 64,
                   "nodeSha": digest(pathlib.Path(python).read_bytes()),
                   "transport": {"version": "research-unix-socket-v1", "footballUid": 999,
                                 "footballGid": 999, "peerSourceSha": digest(peer_original)},
                   "socketService": {"version": "research-root-socket-service-v1",
                                     "brokerSourceSha": digest(broker.read_bytes()),
                                     "platformSha256": digest(platform_raw)}}

        def configure(code=listener_original):
            listener.write_text(code)
            binding["socketService"]["listenerSha"] = digest(listener.read_bytes())
            (base / "runtime-binding.json").write_text(json.dumps(binding))
            for file in [listener, peer, broker, base / "platform.json", base / "runtime-binding.json"]:
                file.chmod(0o444)

        def run(expected=None, extra=()):
            result = subprocess.run([python, "-I", "-S", "-B", str(listener), "--verify-binding", *extra],
                                    env={"PATH": "/usr/bin:/bin"}, capture_output=True, timeout=20, text=True)
            if expected:
                assert result.returncode != 0 and expected in result.stderr, result.stderr
            else:
                assert result.returncode == 0, result.stderr
                value = json.loads(result.stdout)
                assert value["verified"] and value["releaseSha"] == "a" * 64
                assert value["listenerStarted"] is False and value["productionWrites"] == 0
                assert value["bindingSha256"] == digest((base / "runtime-binding.json").read_bytes())

        configure()
        assert str(listener).startswith("/usr/local/") and str(listener) not in {r["path"] for r in platform["files"]}
        run()  # Real __main__.__file__ previously triggered UNBOUND_PYTHON_MODULE.
        sibling = base / "unsigned_sibling.py"
        sibling.write_text("VALUE = 'unsigned'\n")
        injected = listener_original.replace('\nBASE = ',
            "\n_spec = importlib.util.spec_from_file_location('unsigned_sibling', " + repr(str(sibling)) + ")\n"
            "_module = importlib.util.module_from_spec(_spec)\nsys.modules['unsigned_sibling'] = _module\n"
            "_spec.loader.exec_module(_module)\nBASE = ", 1)
        configure(injected)
        run("RESEARCH_SOCKET_UNBOUND_PYTHON_MODULE")
        configure()
        peer.write_bytes(peer_original + b"\n# altered source\n")
        run("RESEARCH_SOCKET_BINDING_SOURCE")
        peer.write_bytes(peer_original)
        # A valid timestamp cache containing hostile code must not replace the
        # signed source. -B alone would still permit reading this cache.
        hostile = base / "cache_only.py"
        hostile.write_text("raise RuntimeError('UNSIGNED_BYTECODE_EXECUTED')\n")
        cache = pathlib.Path(importlib.util.cache_from_source(str(peer)))
        cache.parent.mkdir()
        py_compile.compile(str(hostile), cfile=str(cache), dfile=str(peer), doraise=True)
        raw = cache.read_bytes()
        info = peer.stat()
        cache.write_bytes(raw[:8] + int(info.st_mtime).to_bytes(4, "little") + info.st_size.to_bytes(4, "little") + raw[16:])
        run()
        run("RESEARCH_FIXED_ROOT_SOCKET_REQUIRED", ("--arbitrary",))
        return {"ok": True, "checks": 5, "actualIsolatedEntrypointUnderUsrLocal": True,
                "unsignedSiblingRefused": True, "changedSignedPeerRefused": True,
                "unsignedPeerBytecodeNotExecuted": True, "productionServicesStarted": 0,
                "productionApiCallerVerified": False, "productionWrites": 0}


if __name__ == "__main__":
    print(json.dumps(verify()))
