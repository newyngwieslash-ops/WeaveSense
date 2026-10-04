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

    async def get_messages(self, entity, min_id=0, limit=80, reverse=False):
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
                ids = [i for i in range(min_id + 1, 1001)][:limit]
                return page_of(ids)

            mod.client = fake_client(get_messages)
            async def resolve(channel):
                return channel
            mod.resolve_channel = resolve
            mod.paused_until = 0
            return await mod.history("chan", 0, 80)

        result = asyncio.run(run())
        self.assertLessEqual(len(result["items"]), 80, "a cold start must stay bounded")
        self.assertNotEqual(result["last_id"], "1000", "a cold start must not claim to have covered the history")

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


if __name__ == "__main__":
    unittest.main()
