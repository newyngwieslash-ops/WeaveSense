"""T10: pagination and cursor safety for the Telegram history endpoint.

The defect this pins down: `get_messages(entity, min_id=..., limit=80)` returns
the *newest* 80 messages above `min_id`. With a stored cursor of 100 and 250 new
messages (101..350), that call returns 251..350 and the old cursor-advance logic
then jumped to 350 — silently dropping 101..250 forever.

These tests use a fake client and no network, so they are safe to run anywhere.
They also assert that importing/constructing the module never logs in.
"""
from __future__ import annotations

import asyncio
import unittest


class FakeMessage:
    """The subset of telethon's Message that normalize()/history() touch."""

    def __init__(self, msg_id, text="hello"):
        self.id = msg_id
        self.message = text
        self.raw_text = text
        self.date = None
        self.sender_id = None
        self.views = None
        self.forwards = None
        self.grouped_id = None
        self.media = None
        self.fwd_from = None
        self.post_author = None
        self.video = None
        self.photo = None
        self.document = None
        self.voice = None
        self.audio = None
        self.sticker = None
        # media_kind() checks this on the no-media path.
        self.web_preview = None
        self.file = None


def page_of(ids):
    return [FakeMessage(i) for i in ids]


async def until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0)


class FakeClient:
    def __init__(self, get_messages=None, *, connected=True, failures=0, authorized=True):
        self.connected = connected
        self.failures = failures
        self.authorized = authorized
        self.calls = 0
        self.disconnects = 0
        self.get_messages_impl = get_messages
        self.connected_event = asyncio.Event()
        self.disconnected = asyncio.get_running_loop().create_future()

    def is_connected(self):
        return self.connected

    async def connect(self):
        self.calls += 1
        if self.calls <= self.failures:
            raise OSError("synthetic offline")
        self.connected = True
        self.disconnected = asyncio.get_running_loop().create_future()

    async def is_user_authorized(self):
        self.connected_event.set()
        return self.authorized

    async def disconnect(self):
        self.disconnects += 1
        self.connected = False
        if not self.disconnected.done():
            self.disconnected.set_result(None)

    async def get_me(self):
        from types import SimpleNamespace
        return SimpleNamespace(username="synthetic") if self.authorized else None

    async def get_entity(self, channel):
        return channel

    async def get_messages(self, entity, min_id=0, limit=80, reverse=False, ids=None):
        if ids is not None:
            return await self.get_messages_impl(ids=ids)
        return await self.get_messages_impl(min_id=min_id, limit=limit, reverse=reverse)


def fake_client(get_messages):
    return FakeClient(get_messages)


class HistoryPaginationTests(unittest.TestCase):
    """The pagination rule, tested against a fake client (no network)."""

    def setUp(self):
        # Import lazily so a missing telethon install cannot break collection of
        # this module (the fake stub above stands in for it).
        import importlib.util
        import pathlib

        server_path = pathlib.Path(__file__).with_name("server.py")
        spec = importlib.util.spec_from_file_location("loom_telethon_server", server_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        # Provide the minimal globals server.py expects at import time.
        module.__dict__.setdefault("__name__", "loom_telethon_server")
        try:
            spec.loader.exec_module(module)
        except Exception as exc:  # pragma: no cover - environment lacking deps
            self.skipTest(f"server.py not importable in this environment: {exc}")
        # history() filters with `isinstance(msg, Message)`; point that name at the
        # fake so the offline fake is accepted (test-only, no production change).
        module.Message = FakeMessage
        module.connection_state = "ready"
        self.mod = module

    def test_storage_startup_failure_recovers_serially_without_reconnecting(self):
        import json
        import threading
        from types import SimpleNamespace
        from unittest.mock import patch
        mod = self.mod
        async def run():
            message = FakeMessage(101)
            message.media = mod.MessageMediaPhoto()
            message.file = SimpleNamespace(size=3, mime_type="image/jpeg")
            async def messages(**kwargs): return message if "ids" in kwargs else [message]
            candidate = FakeClient(messages, connected=False)
            async def download(media, **kwargs): yield b"abc"
            candidate.iter_download = download
            mod.build_client = lambda: candidate
            mod.MEDIA_TOKEN = "synthetic"
            mod.MINIO_ENDPOINT, mod.MINIO_ACCESS, mod.MINIO_SECRET = "fixture", "synthetic", "synthetic"
            entered, release = threading.Event(), threading.Event()
            probes, owners, peak, creates = 0, 0, 0, 0
            saved = []
            loop_thread = threading.get_ident()
            outer = self
            class Store:
                def bucket_exists(self, bucket):
                    nonlocal probes, owners, peak
                    outer.assertNotEqual(threading.get_ident(), loop_thread)
                    probes += 1
                    owners += 1
                    peak = max(peak, owners)
                    try:
                        if probes == 1: raise OSError("secret cold start")
                        entered.set()
                        if not release.wait(2): raise TimeoutError("test release missing")
                        return False
                    finally: owners -= 1
                def make_bucket(self, bucket):
                    nonlocal creates
                    creates += 1
                def put_object(self, bucket, key, data, length, **kwargs):
                    nonlocal owners, peak
                    owners += 1
                    peak = max(peak, owners)
                    try: saved.append((key, data.read()))
                    finally: owners -= 1
            class Request:
                headers = {"Authorization": "Bearer synthetic"}
                async def json(self): return {"channel": "Channel", "message_id": "101"}
            with patch.object(mod, "Minio", return_value=Store()):
                await mod.on_start(None)
                await until(lambda: mod.connection_state == "ready")
                try:
                    self.assertIsNone(mod.minio_client)
                    health = json.loads((await mod.handle_health(None)).text)
                    self.assertFalse(health["media_available"])
                    self.assertEqual(probes, 1, "health must not retry bucket initialization")
                    item = (await mod.history("channel", 100, 80))["items"][0]
                    self.assertEqual(item["media_urls"], ["telegram://channel/101"])
                    first = asyncio.create_task(mod.handle_media(Request()))
                    second = None
                    try:
                        await until(entered.is_set)
                        second = asyncio.create_task(mod.handle_media(Request()))
                        await asyncio.sleep(0)
                        self.assertEqual(probes, 2)
                        self.assertTrue(mod.media_gate.locked())
                        self.assertEqual((await asyncio.wait_for(mod.history("channel", 100, 80), 0.2))["items"][0]["external_id"], "101")
                        await mod.handle_health(None)
                        self.assertEqual(probes, 2)
                    finally:
                        release.set()
                        responses = await asyncio.gather(first, *([second] if second else []))
                    self.assertEqual([response.status for response in responses], [200, 200])
                    self.assertEqual([json.loads(response.text)["object_key"] for response in responses], ["telegram/channel/101"] * 2)
                    self.assertEqual(saved, [("telegram/channel/101", b"abc")] * 2)
                    self.assertEqual((probes, creates, peak), (2, 1, 1))
                    self.assertEqual(candidate.calls, 1)
                    self.assertEqual(candidate.disconnects, 0)
                    self.assertTrue(json.loads((await mod.handle_health(None)).text)["media_available"])
                finally: await mod.on_stop(None)
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_storage_recovery_rechecks_shared_cooldown_and_account_readiness(self):
        import json
        import threading
        from types import SimpleNamespace
        from unittest.mock import patch
        mod = self.mod
        async def run():
            class Request:
                headers = {"Authorization": "Bearer synthetic"}
                async def json(self): return {"channel": "channel", "message_id": "101"}
            mod.MEDIA_TOKEN = "synthetic"
            mod.MINIO_ENDPOINT, mod.MINIO_ACCESS, mod.MINIO_SECRET = "fixture", "synthetic", "synthetic"
            for state in ["flood_wait", "unavailable", "disconnected"]:
                with self.subTest(state=state):
                    mod.minio_client, mod.paused_until, mod.connection_state = None, 0, "ready"
                    entered, release = threading.Event(), threading.Event()
                    calls, saved = [], []
                    probes = 0
                    message = FakeMessage(101)
                    message.media = mod.MessageMediaPhoto()
                    message.file = SimpleNamespace(size=3, mime_type="image/jpeg")
                    async def messages(**kwargs):
                        calls.append("messages")
                        if "ids" in kwargs: return message
                        if state == "flood_wait": raise mod.FloodWaitError(request=None, capture=30)
                        raise OSError("synthetic disconnect")
                    candidate = FakeClient(messages)
                    async def entity(channel):
                        calls.append("entity")
                        return channel
                    async def download(media, **kwargs):
                        calls.append("download")
                        yield b"abc"
                    candidate.get_entity, candidate.iter_download = entity, download
                    mod.client = candidate
                    class Store:
                        def bucket_exists(self, bucket):
                            nonlocal probes
                            probes += 1
                            entered.set()
                            if not release.wait(2): raise TimeoutError("test release missing")
                            return True
                        def put_object(self, bucket, key, data, length, **kwargs):
                            saved.append((key, data.read()))
                    with patch.object(mod, "Minio", return_value=Store()):
                        pending = asyncio.create_task(mod.handle_media(Request()))
                        try:
                            await until(entered.is_set)
                            self.assertEqual(calls, [], "no Telegram work before storage is ready")
                            if state == "disconnected": await candidate.disconnect()
                            else:
                                history = await asyncio.wait_for(mod.history("channel", 100, 80), 0.2)
                                self.assertEqual(history["error"], state)
                            calls.clear()
                        finally:
                            release.set()
                            response = await pending
                        self.assertEqual(response.status, 429 if state == "flood_wait" else 503)
                        self.assertEqual(json.loads(response.text)["error"], "flood_wait" if state == "flood_wait" else "unavailable")
                        if state == "flood_wait": self.assertGreaterEqual(int(response.headers["Retry-After"]), 30)
                        self.assertEqual(calls, [], "admission must be rechecked before entity/message/download calls")
                        self.assertEqual(saved, [])
                        self.assertIsNotNone(mod.minio_client, "successful storage setup stays cached")
                        self.assertFalse(mod.media_gate.locked())
                        mod.paused_until, mod.connection_state, candidate.connected = 0, "ready", True
                        self.assertEqual((await mod.handle_media(Request())).status, 200)
                        self.assertEqual(probes, 1)
                        self.assertEqual(saved, [("telegram/channel/101", b"abc")])
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_storage_recovery_timeout_or_cancel_retains_native_setup_owner(self):
        import threading
        from unittest.mock import patch
        mod = self.mod
        async def run():
            class Request:
                headers = {"Authorization": "Bearer synthetic"}
                async def json(self): return {"channel": "channel", "message_id": "101"}
            mod.MEDIA_TOKEN = "synthetic"
            mod.MINIO_ENDPOINT, mod.MINIO_ACCESS, mod.MINIO_SECRET = "fixture", "synthetic", "synthetic"
            async def messages(**kwargs): return []
            mod.client = FakeClient(messages)
            for cancel in [False, True]:
                mod.minio_client = None
                mod.MEDIA_TIMEOUT_SECONDS = 0.02
                entered, release = threading.Event(), threading.Event()
                probes = 0
                class Store:
                    def bucket_exists(self, bucket):
                        nonlocal probes
                        probes += 1
                        entered.set()
                        if not release.wait(2): raise TimeoutError("test release missing")
                        raise OSError("secret unavailable")
                with patch.object(mod, "Minio", return_value=Store()):
                    pending = asyncio.create_task(mod.handle_media(Request()))
                    try:
                        await until(entered.is_set)
                        if cancel: pending.cancel()
                        await asyncio.sleep(0.04)
                        if cancel:
                            pending.cancel()
                            await asyncio.sleep(0)
                        self.assertFalse(pending.done())
                        self.assertTrue(mod.media_gate.locked())
                        self.assertEqual((await asyncio.wait_for(mod.history("channel", 0, 80), 0.2))["items"], [])
                        self.assertEqual((await mod.handle_media(Request())).status, 504)
                        self.assertEqual(probes, 1, "queued timeout must not start a second native setup")
                    finally:
                        release.set()
                        if cancel:
                            with self.assertRaises(asyncio.CancelledError): await pending
                        else: self.assertEqual((await pending).status, 504)
                self.assertFalse(mod.media_gate.locked())
                self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_storage_absent_configuration_and_persistent_failure_are_bounded_and_safe(self):
        import contextlib
        import io
        import json
        from unittest.mock import patch
        mod = self.mod
        async def run():
            class Request:
                headers = {"Authorization": "Bearer synthetic"}
                async def json(self): return {"channel": "channel", "message_id": "101"}
            mod.MEDIA_TOKEN = "synthetic"
            async def messages(**kwargs): return []
            candidate = FakeClient(messages)
            mod.client = candidate
            with patch.object(mod, "Minio") as factory:
                self.assertEqual((await mod.handle_media(Request())).status, 503)
                factory.assert_not_called()
            mod.MINIO_ENDPOINT, mod.MINIO_ACCESS, mod.MINIO_SECRET = "fixture", "synthetic", "synthetic"
            class Store:
                def bucket_exists(self, bucket): raise OSError("secret bucket credentials")
            output = io.StringIO()
            with patch.object(mod, "Minio", return_value=Store()) as factory, contextlib.redirect_stdout(output):
                for n in range(3):
                    response = await asyncio.wait_for(mod.handle_media(Request()), 0.5)
                    self.assertEqual(response.status, 503)
                    self.assertEqual(json.loads(response.text), {"error": "media_unavailable"})
                    self.assertEqual(factory.call_count, n + 1, "only one setup attempt per request")
                    http = factory.call_args.kwargs["http_client"]
                    retries = http.connection_pool_kw["retries"]
                    self.assertFalse(getattr(retries, "total", retries))
                    self.assertEqual(http.connection_pool_kw["timeout"].connect_timeout, 5)
                    self.assertEqual(http.connection_pool_kw["timeout"].read_timeout, 20)
                    self.assertFalse(json.loads((await mod.handle_health(None)).text)["media_available"])
                    self.assertEqual(factory.call_count, n + 1)
            self.assertNotIn("secret", output.getvalue())
            self.assertEqual(mod.connection_state, "ready")
            self.assertEqual(candidate.disconnects, 0)
            self.assertEqual((await mod.history("channel", 0, 80))["items"], [])
        asyncio.run(run())

    def test_history_defers_attachments_and_media_endpoint_streams_later(self):
        import hashlib
        import json
        from types import SimpleNamespace
        mod = self.mod
        async def run():
            message = FakeMessage(101)
            message.media = mod.MessageMediaPhoto()
            message.file = SimpleNamespace(size=6, mime_type="image/jpeg")
            message.forwards = 9
            async def messages(**kwargs):
                return message if "ids" in kwargs else [message]
            candidate = FakeClient(messages)
            download_calls = 0
            async def download(media, **kwargs):
                nonlocal download_calls
                download_calls += 1
                self.assertIs(media, message.media)
                yield b"abc"
                yield b"def"
            candidate.iter_download = download
            mod.client = candidate
            saved = []
            class Store:
                def put_object(self, bucket, key, data, length, content_type, num_parallel_uploads):
                    saved.append((key, data.read(), length, content_type))
            mod.minio_client = Store()
            mod.MEDIA_TOKEN = "synthetic-media-token"
            result = await mod.history("Channel", 100, 80)
            self.assertEqual(download_calls, 0)
            item = result["items"][0]
            self.assertEqual(item["extra"]["telegram_media"]["message_id"], "101")
            self.assertEqual(item["extra"]["telegram_media"]["size"], 6)
            self.assertEqual(item["media_urls"], ["telegram://channel/101"])
            self.assertIsNone(item["likes"])
            self.assertEqual(item["extra"]["forwards"], 9)
            class Request:
                headers = {"Authorization": "Bearer synthetic-media-token"}
                async def json(self): return {"channel": "Channel", "message_id": "101"}
            response = await mod.handle_media(Request())
            self.assertEqual(response.status, 200, response.text)
            body = json.loads(response.text)
            self.assertEqual(body, {"object_key": "telegram/channel/101", "content_type": "image/jpeg",
                                    "bytes": 6, "sha256": hashlib.sha256(b"abcdef").hexdigest()})
            self.assertEqual(saved, [("telegram/channel/101", b"abcdef", 6, "image/jpeg")])
            self.assertEqual(download_calls, 1)
        asyncio.run(run())

    def test_media_auth_validation_limits_cleanup_and_shared_cooldown(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        mod = self.mod
        async def run():
            class Request:
                headers = {"Authorization": "Bearer synthetic"}
                payload = {"channel": "channel", "message_id": "101"}
                async def json(self): return self.payload
            request = Request()
            message = FakeMessage(101)
            message.media = mod.MessageMediaDocument()
            message.document = SimpleNamespace(mime_type="audio/ogg")
            message.file = SimpleNamespace(size=6, mime_type="audio/ogg")
            reads, downloads, uploads, temps = [], [], [], []
            storage_failure = False
            async def messages(**kwargs):
                reads.append(kwargs)
                return message if "ids" in kwargs else [message]
            candidate = FakeClient(messages)
            async def download(media, **kwargs):
                downloads.append(True)
                yield b"abc"
                yield b"def"
            candidate.iter_download = download
            mod.client = candidate
            class Store:
                def put_object(self, bucket, key, data, length, **kwargs):
                    self_outer.assertEqual(kwargs["num_parallel_uploads"], 1)
                    if storage_failure: raise OSError("synthetic disk failure")
                    uploads.append(data.read())
            self_outer = self
            mod.MEDIA_TOKEN = ""
            self.assertEqual((await mod.handle_media(request)).status, 503)
            mod.MEDIA_TOKEN = "synthetic"
            request.headers = {"Authorization": "Bearer wrong"}
            self.assertEqual((await mod.handle_media(request)).status, 401)
            request.headers = {"Authorization": "Bearer synthetic"}
            for payload in [None, [], {}, {"channel": "channel", "message_id": 101},
                            {"channel": "http://evil", "message_id": "101"},
                            {"channel": "channel", "message_id": "01"},
                            {"channel": "channel", "message_id": "101", "url": "http://evil"}]:
                request.payload = payload
                self.assertEqual((await mod.handle_media(request)).status, 400)
            request.payload = {"channel": "channel", "message_id": "101"}
            self.assertEqual((await mod.handle_media(request)).status, 503)
            self.assertEqual(reads, [])
            mod.minio_client = Store()
            actual_temp = mod.tempfile.TemporaryFile
            def temp_file(**kwargs):
                temp = actual_temp(**kwargs)
                temps.append(temp)
                return temp
            with patch.object(mod.tempfile, "TemporaryFile", temp_file):
                mod.MEDIA_MAX_BYTES = 5
                response = await mod.handle_media(request)
                self.assertEqual(response.status, 413)
                self.assertEqual(downloads, [])
                message.file.size = None
                response = await mod.handle_media(request)
                self.assertEqual(json.loads(response.text)["error"], "media_too_large")
                self.assertTrue(temps[-1].closed)
                self.assertEqual(uploads, [])
                mod.MEDIA_MAX_BYTES = 6
                response = await mod.handle_media(request)
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.text)["content_type"], "audio/ogg")
                self.assertTrue(temps[-1].closed)
                storage_failure = True
                response = await mod.handle_media(request)
                self.assertEqual(response.status, 503)
                self.assertTrue(temps[-1].closed)
                self.assertEqual(mod.connection_state, "ready")
                self.assertEqual((await mod.history("channel", 100, 80))["items"][0]["media_type"], "audio")
                storage_failure = False
                message.file.size = 5
                response = await mod.handle_media(request)
                self.assertEqual(json.loads(response.text)["error"], "media_size_mismatch")
                self.assertTrue(temps[-1].closed)
                async def flooding(media, **kwargs):
                    raise mod.FloodWaitError(request=None, capture=30)
                    yield b""
                candidate.iter_download = flooding
                response = await mod.handle_media(request)
                self.assertEqual(response.status, 429)
                self.assertGreaterEqual(int(response.headers["Retry-After"]), 30)
                self.assertTrue(temps[-1].closed)
                count = len(reads)
                self.assertEqual((await mod.history("channel", 100, 80))["error"], "flood_wait")
                self.assertEqual((await mod.handle_media(request)).status, 429)
                self.assertEqual(len(reads), count)
            self.assertEqual(uploads, [b"abcdef"])
        asyncio.run(run())

    def test_media_upload_timeout_or_cancel_retains_slot_file_and_text_progress(self):
        import threading
        from types import SimpleNamespace
        mod = self.mod
        async def run():
            class Request:
                headers = {"Authorization": "Bearer synthetic"}
                async def json(self): return {"channel": "channel", "message_id": "101"}
            for cancel in [False, True]:
                message = FakeMessage(101)
                message.media = mod.MessageMediaPhoto()
                message.file = SimpleNamespace(size=3, mime_type="image/jpeg")
                entered, release = threading.Event(), threading.Event()
                files = []
                async def messages(**kwargs): return message if "ids" in kwargs else [message]
                candidate = FakeClient(messages)
                async def download(media, **kwargs): yield b"abc"
                candidate.iter_download = download
                mod.client, mod.MEDIA_TOKEN = candidate, "synthetic"
                mod.MEDIA_TIMEOUT_SECONDS = 0.02
                class Store:
                    def put_object(self, bucket, key, data, length, **kwargs):
                        files.append(data)
                        entered.set()
                        if not release.wait(2): raise TimeoutError("test release missing")
                        self_outer.assertFalse(data.closed)
                        self_outer.assertEqual(data.read(), b"abc")
                self_outer = self
                mod.minio_client = Store()
                pending = asyncio.create_task(mod.handle_media(Request()))
                try:
                    await until(entered.is_set)
                    if cancel:
                        pending.cancel()
                    await asyncio.sleep(0.04)
                    if cancel:
                        pending.cancel()  # repeated cancellation must not orphan the native thread
                        await asyncio.sleep(0)
                    self.assertFalse(pending.done())
                    self.assertFalse(files[0].closed)
                    self.assertTrue(mod.media_gate.locked())
                    result = await asyncio.wait_for(mod.history("channel", 100, 80), 0.2)
                    self.assertEqual(result["items"][0]["external_id"], "101")
                    queued = await mod.handle_media(Request())
                    self.assertEqual(queued.status, 504, "queue wait shares the async deadline")
                finally:
                    release.set()
                    if cancel:
                        with self.assertRaises(asyncio.CancelledError): await pending
                    else:
                        self.assertEqual((await pending).status, 504)
                self.assertTrue(files[0].closed)
                self.assertFalse(mod.media_gate.locked())
        asyncio.run(run())

    def test_media_uses_installed_sdk_interfaces_and_safe_storage_timeouts(self):
        from inspect import signature
        from unittest.mock import patch
        from telethon import utils
        from telethon.tl import types
        from telethon.tl.custom.file import File
        mod = self.mod
        photo = types.Photo(id=1, access_hash=2, file_reference=b"", date=None,
                            sizes=[types.PhotoSize(type="x", w=2, h=2, size=6)], dc_id=1)
        media = types.MessageMediaPhoto(photo=photo)
        info = utils._get_file_info(media)
        self.assertEqual(info.size, File(photo).size)
        self.assertEqual(info.location.thumb_size, "x")
        self.assertIn("request_size", signature(mod.TelegramClient.iter_download).parameters)
        self.assertIn("num_parallel_uploads", signature(mod.Minio.put_object).parameters)
        with patch.object(mod, "minio_ready", return_value=True), patch.object(mod, "Minio") as sdk:
            mod.build_minio()
            http = sdk.call_args.kwargs["http_client"]
            self.assertIs(http.connection_pool_kw["retries"].total, False)
            self.assertEqual(http.connection_pool_kw["timeout"].connect_timeout, 5)
            self.assertEqual(http.connection_pool_kw["timeout"].read_timeout, 20)

    def test_ascending_window_returns_the_oldest_not_yet_seen_page(self):
        """With cursor=100 and messages 101..350, the first page must be 101..180."""
        mod = self.mod

        async def run():
            seen = {}

            async def get_messages(min_id=0, limit=80, reverse=False):
                # Ascending fetch: the oldest `limit` messages above min_id.
                ids = [i for i in range(min_id + 1, 351)][:limit]
                seen["min_id"] = min_id
                seen["reverse"] = reverse
                return page_of(ids)

            mod.client = fake_client(get_messages)
            async def resolve(channel):
                return channel
            mod.resolve_channel = resolve
            mod.paused_until = 0
            return await mod.history("chan", 100, 80), seen

        result, seen = asyncio.run(run())
        ids = [int(item["external_id"]) for item in result["items"]]
        # The page must start where the cursor is, not at the newest end.
        self.assertEqual(ids[0], 101, f"page must start at the cursor; got {ids[0]}")
        self.assertEqual(ids[-1], 180, f"page must be a bounded ascending window; got {ids[-1]}")
        self.assertEqual(result["last_id"], "180", "the cursor must advance only to the page's max")
        self.assertTrue(result["has_more"])
        self.assertTrue(seen.get("reverse"), "an ascending fetch is what avoids skipping the middle")

    def test_the_cursor_never_jumps_over_unfetched_messages(self):
        """Walking pages 101.. must reach 350 without a gap."""
        mod = self.mod

        async def run():
            async def get_messages(min_id=0, limit=80, reverse=False):
                ids = [i for i in range(min_id + 1, 351)][:limit]
                return page_of(ids)

            mod.client = fake_client(get_messages)
            async def resolve(channel):
                return channel
            mod.resolve_channel = resolve
            mod.paused_until = 0
            collected = []
            cursor = 100
            for _ in range(10):
                result = await mod.history("chan", cursor, 80)
                if not result["items"]:
                    break
                collected.extend(int(item["external_id"]) for item in result["items"])
                cursor = int(result["last_id"])
            return collected, cursor

        collected, cursor = asyncio.run(run())
        self.assertEqual(collected, list(range(101, 351)), "every message must appear exactly once, in order")
        self.assertEqual(cursor, 350)

    def test_a_first_run_from_zero_does_not_pull_the_whole_history(self):
        """cursor=0 means 'start from the recent window', not 'fetch everything'."""
        mod = self.mod

        async def run():
            async def get_messages(min_id=0, limit=80, reverse=False):
                # Pretend the channel has 1000 messages.
                ids = list(range(min_id + 1, 1001))
                ids = (ids if reverse else list(reversed(ids)))[:limit]
                return page_of(ids)

            mod.client = fake_client(get_messages)
            async def resolve(channel):
                return channel
            mod.resolve_channel = resolve
            mod.paused_until = 0
            return await mod.history("chan", 0, 80)

        result = asyncio.run(run())
        self.assertLessEqual(len(result["items"]), 80, "a cold start must stay bounded")
        self.assertEqual(result["last_id"], "1000")
        self.assertEqual([i["external_id"] for i in result["items"]], [str(i) for i in range(1000, 920, -1)])
        self.assertFalse(result["has_more"])

    def test_service_pages_advance_traversal_and_deleted_ids_are_not_gaps(self):
        mod = self.mod
        async def run():
            class Service:
                def __init__(self, ident): self.id = ident
            calls = []
            async def get_messages(min_id=0, limit=80, reverse=False):
                calls.append((min_id, reverse))
                if min_id == 100: return [Service(i) for i in range(101, 181)]
                if min_id == 180: return page_of([190, 250])
                return []
            mod.client = fake_client(get_messages)
            first = await mod.history("channel", 100, 80)
            second = await mod.history("channel", int(first["last_id"]), 80)
            end = await mod.history("channel", int(second["last_id"]), 80)
            return first, second, end, calls
        first, second, end, calls = asyncio.run(run())
        self.assertEqual(first["items"], [])
        self.assertEqual(first["last_id"], "180")
        self.assertTrue(first["has_more"])
        self.assertEqual([x["external_id"] for x in second["items"]], ["190", "250"])
        self.assertEqual(end["last_id"], "250")
        self.assertFalse(end["has_more"])
        self.assertEqual(calls, [(100, True), (180, True), (250, True)])

    def test_explicit_backfill_from_zero_is_ascending(self):
        mod = self.mod
        async def run():
            async def get_messages(min_id=0, limit=80, reverse=False):
                self.assertTrue(reverse)
                return page_of(range(1, 81))
            mod.client = fake_client(get_messages)
            return await mod.history("channel", 0, 80, "backfill")
        result = asyncio.run(run())
        self.assertEqual(result["last_id"], "80")
        self.assertTrue(result["has_more"])

    def test_flood_wait_is_reported_without_advancing(self):
        mod = self.mod

        async def run():
            async def get_messages(min_id=0, limit=80, reverse=False):
                raise RuntimeError("flood")

            mod.client = fake_client(get_messages)
            async def resolve(channel):
                return channel
            mod.resolve_channel = resolve
            mod.paused_until = 0
            try:
                return await mod.history("chan", 100, 80)
            except Exception:
                # A raised error is also acceptable; what matters is no cursor claim.
                return {"items": [], "last_id": "100"}

        result = asyncio.run(run())
        self.assertEqual(result.get("items"), [])

    def test_big_ids_do_not_lose_precision(self):
        """Message ids exceed 2^53 in principle; the cursor must stay a string."""
        mod = self.mod
        huge = 9_007_199_254_740_993  # 2^53 + 1

        async def run():
            async def get_messages(min_id=0, limit=80, reverse=False):
                return page_of([huge, huge + 1])

            mod.client = fake_client(get_messages)
            async def resolve(channel):
                return channel
            mod.resolve_channel = resolve
            mod.paused_until = 0
            return await mod.history("chan", huge - 1, 80)

        result = asyncio.run(run())
        self.assertEqual(result["last_id"], str(huge + 1))
        self.assertEqual([int(i["external_id"]) for i in result["items"]], [huge, huge + 1])


    def test_reconnect_recovers_and_cleanup_awaits_task(self):
        mod = self.mod
        async def run():
            candidate = FakeClient(connected=False, failures=1)
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            waits = []
            retrying = asyncio.Event()
            release = asyncio.Event()
            async def retry_wait(seconds):
                waits.append(seconds)
                retrying.set()
                await release.wait()
            mod.retry_wait = retry_wait
            await asyncio.wait_for(mod.on_start(None), 0.2)
            try:
                await asyncio.wait_for(retrying.wait(), 1)
                self.assertEqual(mod.connection_state, "unavailable")
                self.assertGreaterEqual(waits[0], 5)
                self.assertLessEqual(waits[0], 6)
                release.set()
                await asyncio.wait_for(candidate.connected_event.wait(), 1)
                await until(lambda: mod.connection_state == "ready")
                self.assertEqual(mod.connection_state, "ready")
                self.assertEqual(candidate.calls, 2)
                task = mod.reconnect_task
            finally:
                await mod.on_stop(None)
            self.assertTrue(task.done())
            self.assertFalse(candidate.connected)
            self.assertIsNone(mod.reconnect_task)
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_concurrent_requests_do_not_create_connections(self):
        mod = self.mod
        async def run():
            candidate = FakeClient(connected=False)
            started, release = asyncio.Event(), asyncio.Event()
            async def connect():
                candidate.calls += 1
                started.set()
                await release.wait()
                candidate.connected = True
            candidate.connect = connect
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            await asyncio.wait_for(mod.on_start(None), 0.2)
            try:
                await asyncio.wait_for(started.wait(), 1)
                results = await asyncio.gather(*(mod.history("chan", 0, 10) for _ in range(8)))
                self.assertTrue(all(r["error"] == "unavailable" for r in results))
                self.assertEqual(candidate.calls, 1)
                self.assertEqual(mod.connection_state, "connecting")
            finally:
                await mod.on_stop(None)
            self.assertEqual(candidate.disconnects, 1)
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_unauthorized_is_explicit_and_health_does_not_login(self):
        import json
        mod = self.mod
        async def run():
            candidate = FakeClient(connected=False, authorized=False)
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            await asyncio.wait_for(mod.on_start(None), 0.2)
            try:
                await asyncio.wait_for(mod.reconnect_task, 1)
                data = json.loads((await mod.handle_health(None)).text)
                self.assertEqual(data["state"], "unauthorized")
                self.assertFalse(data["authorized"])
                self.assertEqual(data["retry_after_seconds"], 0)
                self.assertEqual(candidate.calls, 1)
                self.assertFalse(candidate.connected)
            finally:
                await mod.on_stop(None)
        asyncio.run(run())

    def test_queued_request_observes_shared_floodwait(self):
        mod = self.mod
        async def run():
            mod.gate = asyncio.Semaphore(1)
            entered, release = asyncio.Event(), asyncio.Event()
            calls = []
            async def messages(**kwargs):
                calls.append(kwargs)
                entered.set()
                await release.wait()
                raise mod.FloodWaitError(request=None, capture=12)
            mod.client = FakeClient(messages)
            first = asyncio.create_task(mod.history("chan", 0, 10))
            await entered.wait()
            second = asyncio.create_task(mod.history("chan", 0, 10))
            await asyncio.sleep(0)
            release.set()
            results = await asyncio.gather(first, second)
            self.assertEqual(len(calls), 1)
            self.assertTrue(all(r["flood_wait"] >= 12 for r in results))
            class Request:
                async def json(self): return {"channel": "chan"}
            response = await mod.handle_history(Request())
            self.assertEqual(response.status, 429)
            self.assertGreaterEqual(int(response.headers["Retry-After"]), 12)
        asyncio.run(run())

    def test_history_deadline_includes_semaphore_queue(self):
        mod = self.mod
        async def run():
            mod.client = FakeClient()
            mod.gate = asyncio.Semaphore(0)
            mod.HISTORY_TIMEOUT_SECONDS = 0.01
            result = await asyncio.wait_for(mod.history("chan", 7, 10), 1)
            self.assertEqual(result, {"error": "timeout", "items": []})
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_private_channel_is_not_joined_or_retried(self):
        mod = self.mod
        async def run():
            calls = []
            async def messages(**kwargs):
                calls.append(kwargs)
                raise mod.ChannelPrivateError(request=None)
            mod.client = FakeClient(messages)
            result = await mod.history("private", 0, 10)
            self.assertEqual(result["error"], "membership_required")
            self.assertEqual(len(calls), 1)
        asyncio.run(run())


    def test_ready_connection_drop_recovers_and_resets_retry_backoff(self):
        mod = self.mod
        async def run():
            mod.CONNECTION_POLL_SECONDS = 0.001
            candidate = FakeClient(connected=False, failures=4)
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            waits = []
            async def retry_wait(seconds):
                waits.append(seconds)
                await asyncio.sleep(0)
            mod.retry_wait = retry_wait
            await mod.on_start(None)
            try:
                await until(lambda: mod.connection_state == "ready")
                self.assertEqual(len(waits), 4)
                for actual, base in zip(waits, [5, 15, 60, 300]):
                    self.assertGreaterEqual(actual, base)
                    self.assertLessEqual(actual, base * 1.2)
                self.assertEqual(mod.retry_at, 0)
                await candidate.disconnect()
                await until(lambda: candidate.calls == 6 and mod.connection_state == "ready")
                self.assertGreaterEqual(waits[-1], 5)
                self.assertLessEqual(waits[-1], 6)
                self.assertEqual(mod.retry_at, 0)
            finally:
                await mod.on_stop(None)
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_health_states_are_cached_and_never_trigger_account_calls(self):
        import json
        mod = self.mod
        async def run():
            candidate = FakeClient()
            mod.client = candidate
            async def forbidden():
                self.fail("health must not contact Telegram")
            candidate.get_me = forbidden
            candidate.is_user_authorized = forbidden
            for state in ["unconfigured", "unauthorized", "connecting", "ready", "unavailable"]:
                mod.connection_state = state
                h = json.loads((await mod.handle_health(None)).text)
                self.assertEqual(h["state"], state)
                self.assertEqual(h["authorized"], state == "ready")
            mod.connection_state = "ready"
            mod.paused_until = mod.time.monotonic() + 10
            h = json.loads((await mod.handle_health(None)).text)
            self.assertEqual(h["state"], "cooldown")
            self.assertEqual(h["retry_after_seconds"], 10)
            self.assertTrue(h["authorized"])
            candidate.connected = False
            h = json.loads((await mod.handle_health(None)).text)
            self.assertEqual(h["state"], "unavailable")
            self.assertFalse(h["authorized"])
        asyncio.run(run())

    def test_public_channel_never_joins_and_sdk_retries_are_bounded(self):
        from unittest.mock import patch
        mod = self.mod
        async def run():
            async def messages(**kwargs): return []
            calls = []
            class JoinDetectingClient(FakeClient):
                async def __call__(self, request): calls.append(request)
            candidate = JoinDetectingClient(messages)
            from telethon.tl.types import Channel, ChatPhotoEmpty
            channel = Channel(id=1, title="synthetic", photo=ChatPhotoEmpty(), date=None)
            async def entity(_): return channel
            candidate.get_entity = entity
            mod.client = candidate
            self.assertEqual((await mod.history("public", 0, 10))["items"], [])
            self.assertEqual(calls, [])
        asyncio.run(run())
        with patch.object(mod, "API_ID", 1), patch.object(mod, "API_HASH", "synthetic"), patch.object(mod, "SESSION", "synthetic"), patch.object(mod, "StringSession", return_value="fake-session"), patch.object(mod, "TelegramClient") as sdk:
            mod.build_client()
            self.assertEqual(sdk.call_args.kwargs["flood_sleep_threshold"], 0)
            self.assertEqual(sdk.call_args.kwargs["connection_retries"], 1)
            self.assertEqual(sdk.call_args.kwargs["request_retries"], 1)
            self.assertFalse(sdk.call_args.kwargs["auto_reconnect"])

    def test_cancel_during_backoff_leaves_no_task(self):
        mod = self.mod
        async def run():
            candidate = FakeClient(connected=False, failures=1)
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            waiting = asyncio.Event()
            async def retry_wait(seconds):
                waiting.set()
                await asyncio.Event().wait()
            mod.retry_wait = retry_wait
            await mod.on_start(None)
            await asyncio.wait_for(waiting.wait(), 1)
            task = mod.reconnect_task
            await mod.on_stop(None)
            self.assertTrue(task.done())
            self.assertFalse(candidate.connected)
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())


    def test_transient_authorization_failure_is_not_reported_as_unauthorized(self):
        mod = self.mod
        async def run():
            candidate = FakeClient(connected=False, authorized=False)
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            async def get_me(): raise mod.FloodWaitError(request=None, capture=40)
            candidate.get_me = get_me
            waiting = asyncio.Event()
            async def retry_wait(seconds):
                self.assertGreaterEqual(seconds, 40)
                waiting.set()
                await asyncio.Event().wait()
            mod.retry_wait = retry_wait
            await mod.on_start(None)
            try:
                await asyncio.wait_for(waiting.wait(), 1)
                self.assertEqual(mod.connection_state, "unavailable")
            finally:
                await mod.on_stop(None)
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())

    def test_shutdown_awaits_shielded_sdk_cleanup(self):
        mod = self.mod
        async def run():
            candidate = FakeClient(connected=False, failures=1)
            started, release, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
            async def disconnect():
                started.set()
                await release.wait()
                candidate.connected = False
                finished.set()
            candidate.disconnect = lambda: asyncio.shield(asyncio.create_task(disconnect()))
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            await mod.on_start(None)
            await asyncio.wait_for(started.wait(), 1)
            stop = asyncio.create_task(mod.on_stop(None))
            await asyncio.sleep(0)
            self.assertFalse(stop.done())
            release.set()
            await asyncio.wait_for(stop, 1)
            self.assertTrue(finished.is_set())
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())


    def test_history_network_failure_wakes_the_single_recovery_task(self):
        mod = self.mod
        async def run():
            async def messages(**kwargs): raise OSError("synthetic disconnect")
            candidate = FakeClient(messages, connected=False)
            mod.build_client = lambda: candidate
            mod.build_minio = lambda: None
            async def retry_wait(seconds): await asyncio.sleep(0)
            mod.retry_wait = retry_wait
            await mod.on_start(None)
            try:
                await until(lambda: mod.connection_state == "ready")
                original_task = mod.reconnect_task
                result = await mod.history("chan", 10, 10)
                self.assertEqual(result, {"error": "unavailable", "items": []})
                await until(lambda: candidate.calls == 2 and mod.connection_state == "ready")
                self.assertIs(mod.reconnect_task, original_task)
            finally:
                await mod.on_stop(None)
            self.assertEqual(len(asyncio.all_tasks()), 1)
        asyncio.run(run())



    def test_history_rejects_malformed_bootstrap_before_worker_access(self):
        mod = self.mod
        async def run():
            for bootstrap in [[], {}, 1, None, "unknown"]:
                class Request:
                    async def json(self):
                        return {"channel": "channel", "min_id": "0", "bootstrap": bootstrap}
                response = await mod.handle_history(Request())
                self.assertEqual(response.status, 400)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
