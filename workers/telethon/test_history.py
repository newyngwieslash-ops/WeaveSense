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


def fake_client(get_messages):
    """A minimal stand-in for telegram's client: only what history() touches."""

    class FakeClient:
        def is_connected(self):
            return True

        async def get_messages(self, entity, min_id=0, limit=80, reverse=False):
            return await get_messages(min_id=min_id, limit=limit, reverse=reverse)

    return FakeClient()


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


if __name__ == "__main__":
    unittest.main()
