#!/usr/bin/env python3
"""C01 isolated subtitle validation. Offline by default; live fails closed.
Tool probes are not caption extraction. No video/audio/ASR/Cookie operation.
"""
import argparse
import json
import math
import os
import threading
import time
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

PIN = "2026.08.19"
EJS_PIN = "0.8.0"
LANGUAGE = re.compile(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*")


OUTPUT_LIMIT = 64 * 1024
SUBTITLE_LIMIT = 2 * 1024 * 1024
BASE = Path(__file__).resolve().parent


def isolated_env():
    keys = ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR"]
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env.update(PIP_CONFIG_FILE=os.devnull, PYTHONNOUSERSITE="1", NO_PROXY="*")
    return env


def bounded_process(argv, timeout=45):
    # Only local interpreter/version probes call this helper. Live extractor
    # execution requires the separately reviewed per-request network guard.
    process = subprocess.Popen(argv, shell=False, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=isolated_env(),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    outputs = [bytearray(), bytearray()]
    oversized = threading.Event()

    def drain(stream, index):
        while chunk := stream.read(4096):
            room = OUTPUT_LIMIT - len(outputs[index])
            outputs[index].extend(chunk[:room])
            if len(chunk) > room:
                oversized.set()

    readers = [threading.Thread(target=drain, args=(stream, i), daemon=True)
        for i, stream in enumerate([process.stdout, process.stderr])]
    for reader in readers:
        reader.start()
    start = time.monotonic()
    error_code = ""
    try:
        while process.poll() is None:
            if oversized.is_set() or time.monotonic() - start >= min(timeout, 45):
                error_code = "output_limit" if oversized.is_set() else "timeout"
                process.kill()
                break
            time.sleep(0.01)
        process.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=5)
        if oversized.is_set():
            error_code = "output_limit"
        if not error_code and process.returncode:
            error_code = "process_failed"
        return {"exit_code": process.returncode, "error_code": error_code,
                "stdout": outputs[0].decode("utf-8", "replace"),
                "duration_ms": round((time.monotonic() - start) * 1000)}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


def write_report(path, report):
    if path:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        temporary.replace(destination)


def probe_tools(node_path):
    node = Path(node_path)
    if not node.is_absolute() or not node.is_file():
        raise ValueError("invalid_node_executable")
    code = "import json,sys; from importlib import metadata; print(json.dumps({'python':sys.version.split()[0], 'yt_dlp':metadata.version('yt-dlp'), 'yt_dlp_ejs':metadata.version('yt-dlp-ejs')}))"
    probes = [bounded_process([sys.executable, "-I", "-c", code]),
              bounded_process([str(node), "--version"]),
              bounded_process(command("https://www.youtube.com/watch?v=QRS8MkLhQmM", str(node))[:-2] + ["--version"])]
    # --version exits before URL extraction: no sample URL is passed here.
    if any(probe["error_code"] for probe in probes):
        raise ValueError(next(probe["error_code"] for probe in probes if probe["error_code"]))
    installed = json.loads(probes[0]["stdout"])
    runtime = probes[1]["stdout"].strip()
    cli = probes[2]["stdout"].strip()
    if (installed["yt_dlp"] != "2026.8.19" or installed["yt_dlp_ejs"] != EJS_PIN
            or cli != PIN or tuple(map(int, installed["python"].split(".")[:2])) < (3, 10)
            or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", runtime)
            or int(runtime.split(".")[0][1:]) < 22):
        raise ValueError("tool_prerequisite_mismatch")
    return {"mode": "tool_probe", "tool_preconditions": "passed", "installed_versions": installed,
            "cli_version": cli, "node_runtime": {"path": str(node), "version": runtime},
            "step_duration_ms": [probe["duration_ms"] for probe in probes],
            "real_requests": 0, "live_gate": "pending"}


def video_id(raw):
    if not isinstance(raw, str) or len(raw) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in raw):
        raise ValueError("invalid_youtube_url")
    parsed = urlsplit(raw)
    if (parsed.scheme != "https" or parsed.hostname not in {"www.youtube.com", "youtube.com"}
            or parsed.username or parsed.password or parsed.port or parsed.fragment
            or parsed.path != "/watch"):
        raise ValueError("invalid_youtube_url")
    query = parse_qs(parsed.query, keep_blank_values=True)
    values = query.get("v", [])
    if set(query) != {"v"} or len(values) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{11}", values[0]):
        raise ValueError("invalid_youtube_id")
    if raw != "https://" + parsed.hostname + "/watch?v=" + values[0]:
        raise ValueError("noncanonical_youtube_url")
    return values[0]


def command(url, node_path, language=None, output=None):
    video_id(url)
    args = [sys.executable, "-I", "-m", "yt_dlp", "--ignore-config", "--no-playlist",
            "--skip-download", "--no-cache-dir", "--no-plugin-dirs", "--no-remote-components",
            "--socket-timeout", "10", "--retries", "0", "--extractor-retries", "0",
            "--fragment-retries", "0", "--file-access-retries", "0", "--no-progress",
            "--no-js-runtimes", "--js-runtimes", "node:" + node_path]
    if language is None:
        args += ["--list-subs", "--dump-single-json"]
    else:
        if not LANGUAGE.fullmatch(language) or not output:
            raise ValueError("invalid_language_or_output")
        args += ["--write-subs", "--write-auto-subs", "--sub-format", "json3",
                 "--sub-langs", language, "--output", output]
    return args + ["--", url]


def select_kind(metadata, language):
    # A missing/malformed inventory is an upstream failure, never no captions.
    if (not isinstance(metadata, dict)
            or not isinstance(metadata.get("subtitles"), dict)
            or not isinstance(metadata.get("automatic_captions"), dict)):
        raise ValueError("invalid_subtitle_inventory")
    for field, kind in [("subtitles", "manual"), ("automatic_captions", "automatic")]:
        tracks = metadata[field].get(language, [])
        if not isinstance(tracks, list) or any(not isinstance(track, dict) for track in tracks):
            raise ValueError("invalid_subtitle_inventory")
        if tracks:
            if not any(track.get("ext") == "json3" for track in tracks):
                raise ValueError("json3_unavailable")
            return kind
    return "none"  # Target-language absence only; scope is recorded separately.


def validate_json3(data):
    if len(json.dumps(data, ensure_ascii=False).encode("utf-8")) > SUBTITLE_LIMIT:
        raise ValueError("subtitle_too_large")
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        raise ValueError("invalid_json3")
    text = []
    previous = -1
    for event in data["events"]:
        if not isinstance(event, dict):
            raise ValueError("invalid_json3")
        if "segs" not in event:  # Style/control events are not spoken text.
            continue
        start, duration = event.get("tStartMs"), event.get("dDurationMs", 0)
        if (isinstance(start, bool) or isinstance(duration, bool)
                or not isinstance(start, (int, float)) or not isinstance(duration, (int, float))
                or not math.isfinite(start) or not math.isfinite(duration)
                or start < 0 or duration < 0 or start < previous):
            raise ValueError("invalid_timeline")
        previous = start
        if not isinstance(event["segs"], list) or any(not isinstance(s, dict) or not isinstance(s.get("utf8"), str) for s in event["segs"]):
            raise ValueError("invalid_segments")
        text.append("".join(s["utf8"] for s in event["segs"]))
    result = "\n".join(text).strip()
    if not result:
        raise ValueError("empty_subtitles")
    return len(result)


def replay(fixtures_path, output_path=None):
    with open(fixtures_path, encoding="utf-8-sig") as handle:
        fixture_doc = json.load(handle)
    assert fixture_doc["origin"] == "synthetic_offline_fixtures_not_live_sample_evidence"
    rows = []
    for case in fixture_doc["cases"]:
        start = time.monotonic()
        row = {"case": case["name"], "tool_version": None, "language": case["language"],
               "kind": None, "status": "error", "chars": None, "error_code": ""}
        try:
            if case.get("extractor_error"):
                raise ValueError(case["extractor_error"])
            if not case.get("inventory_complete", True):
                raise ValueError("incomplete_subtitle_inventory")
            metadata = case.get("metadata")
            kind = select_kind(metadata, case["language"])
            row["kind"] = kind
            if kind == "none":
                other_tracks = any(v for field in ["subtitles", "automatic_captions"] for v in metadata[field].values())
                row.update(status="no_subtitles", error_code="no_target_language_subtitles" if other_tracks else "no_subtitles")
            else:
                caption = case["caption"]
                row.update(status="ok", chars=validate_json3(caption))
        except ValueError as error:
            row["error_code"] = str(error)
        row["duration_ms"] = round((time.monotonic() - start) * 1000)
        assert row["kind"] == case["expected_kind"], row
        assert row["status"] == case["expected_status"], row
        assert row["error_code"] == case["expected_error"], row
        rows.append(row)
    report = {"mode": "offline_replay", "offline_acceptance": "passed", "live_gate": "pending",
              "live_requests": 0, "observed_public_subtitle_samples": 0, "rows": rows}
    write_report(output_path, report)
    print(json.dumps({"mode": "offline_replay", "cases_passed": len(rows), "live_gate": "pending", "live_requests": 0}))


def report_row(sample):
    video_id(sample["url"])
    if not LANGUAGE.fullmatch(sample["language"]):
        raise ValueError("invalid_language")
    return {"url": sample["url"], "tool_version": None, "kind": None,
            "language": sample["language"], "status": "pending", "chars": None,
            "duration_ms": 0, "error_code": "guarded_transport_pending"}


def self_check():
    sample = {"url": "https://www.youtube.com/watch?v=QRS8MkLhQmM", "language": "en"}
    assert video_id(sample["url"]) == "QRS8MkLhQmM"
    for bad in ["https://evil.example/watch?v=QRS8MkLhQmM", "https://user:pass@www.youtube.com/watch?v=QRS8MkLhQmM",
                sample["url"] + "&list=PLfoo", sample["url"] + "&v=8YoUxe5ncPo", sample["url"] + "#foo",
                "https://www.youtube.com/watch?v=yt-tmp-001", "http://www.youtube.com/watch?v=QRS8MkLhQmM",
                sample["url"] + "&", sample["url"] + "\n", sample["url"].replace("Q", "%51", 1)]:
        try:
            video_id(bad)
            raise AssertionError("unsafe URL accepted")
        except ValueError:
            pass
    args = command(sample["url"], str(Path(sys.executable).resolve()))
    assert args[-2:] == ["--", sample["url"]]
    assert "--ignore-config" in args and "--skip-download" in args and "--no-playlist" in args
    assert "--no-plugin-dirs" in args and "--no-remote-components" in args
    for flag in ["--retries", "--extractor-retries", "--fragment-retries", "--file-access-retries"]:
        assert args[args.index(flag) + 1] == "0"
    download_args = command(sample["url"], str(Path(sys.executable).resolve()), "en", "isolated/%(id)s.%(ext)s")
    assert download_args[download_args.index("--sub-langs") + 1] == "en"
    assert download_args[download_args.index("--sub-format") + 1] == "json3"
    assert "--write-subs" in download_args and "--write-auto-subs" in download_args
    try:
        command(sample["url"], str(Path(sys.executable).resolve()), "en,all", "output")
        raise AssertionError("language pattern accepted")
    except ValueError:
        pass
    track = [{"ext": "json3"}]
    both = {"subtitles": {"en": track}, "automatic_captions": {"en": track}}
    assert select_kind(both, "en") == "manual"
    assert select_kind({"subtitles": {}, "automatic_captions": {"en": track}}, "en") == "automatic"
    assert select_kind({"subtitles": {}, "automatic_captions": {}}, "en") == "none"
    assert select_kind(both, "it") == "none"  # TARGET-language absence only.
    assert validate_json3({"events": [{"tStartMs": 0, "dDurationMs": 100, "segs": [{"utf8": "Hello"}]}]}) == 5
    for data in [{"events": []}, {"events": [{"tStartMs": -1, "segs": [{"utf8": "x"}]}]},
                 {"events": [{"tStartMs": float("nan"), "segs": [{"utf8": "x"}]}]}]:
        try:
            validate_json3(data)
            raise AssertionError("bad caption accepted")
        except ValueError:
            pass
    row = report_row(sample)
    assert row["kind"] is None and row["chars"] is None and row["status"] == "pending"
    assert row["tool_version"] is None
    env = isolated_env()
    assert not any(key in env for key in ["HTTP_PROXY", "HTTPS_PROXY", "GH_TOKEN", "PIP_INDEX_URL", "DATABASE_URL", "USERPROFILE"])
    assert bounded_process([sys.executable, "-I", "-c", "print('ok')"])["stdout"].strip() == "ok"
    assert bounded_process([sys.executable, "-I", "-c", "import time; time.sleep(2)"], 0.05)["error_code"] == "timeout"
    assert bounded_process([sys.executable, "-I", "-c", "print('x'*100000)"])["error_code"] == "output_limit"
    for bad in [None, {}, {"events": [None]}, {"events": [{"tStartMs": 0, "segs": [None]}]}]:
        try:
            validate_json3(bad)
            raise AssertionError("invalid JSON3 accepted")
        except ValueError:
            pass
    try:
        validate_json3({"events": [{"tStartMs": 0, "segs": [{"utf8": "x" * SUBTITLE_LIMIT}]}]})
        raise AssertionError("oversized caption accepted")
    except ValueError as error:
        assert str(error) == "subtitle_too_large"
    print("C01 offline checks passed; real C01 gate remains pending")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--self-check", action="store_true")
    modes.add_argument("--replay", action="store_true")
    modes.add_argument("--probe-tools", action="store_true")
    modes.add_argument("--live", action="store_true")
    parser.add_argument("--node", help="explicit absolute local Node >=22 executable (tool probe only)")
    parser.add_argument("--report", help="optional local JSON output path")
    options = parser.parse_args()
    if options.self_check:
        self_check()
        replay(BASE / "subtitle-fixtures.json", options.report)
        return 0
    if options.replay:
        replay(BASE / "subtitle-fixtures.json", options.report)
        return 0
    if options.probe_tools:
        if not options.node:
            parser.error("--probe-tools requires --node absolute-path")
        try:
            report = probe_tools(options.node)
        except (ValueError, OSError, json.JSONDecodeError) as error:
            code = str(error) if isinstance(error, ValueError) else "tool_probe_failed"
            report = {"mode": "tool_probe", "tool_preconditions": "pending", "error_code": code,
                      "real_requests": 0, "live_gate": "pending"}
        write_report(options.report, report)
        print(json.dumps(report))
        return 0 if report["tool_preconditions"] == "passed" else 1
    with open(BASE / "subtitle-samples.json", encoding="utf-8-sig") as handle:
        samples = json.load(handle)["samples"]
    if len(samples) != 10 or len({video_id(s["url"]) for s in samples}) != 10:
        raise ValueError("requires_ten_unique_candidates")
    report = {"mode": "live_refused" if options.live else "inert",
              "gate": "pending", "waiting_for_business_samples": True, "real_requests": 0,
              "blockers": ["waiting_for_business_samples", "blocked_address", "guarded_transport_pending"],
              "rows": [report_row(sample) for sample in samples]}
    write_report(options.report, report)
    print(json.dumps(report))
    return 1 if options.live else 0


if __name__ == "__main__":
    sys.exit(main())
