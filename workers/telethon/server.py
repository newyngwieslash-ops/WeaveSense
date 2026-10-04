#!/usr/bin/env python3
"""Telethon incremental worker for Loom.

GET  /health
POST /v1/history  {channel, min_id, limit}
POST /v1/search   {query, limit}
"""
from __future__ import annotations

import asyncio
import io
import math
import random
from contextlib import suppress
import os
import time
from typing import Any

from aiohttp import web
from minio import Minio
from telethon import TelegramClient
from telethon.errors import ChannelPrivateError, FloodWaitError, UsernameNotOccupiedError
from telethon.sessions import StringSession
from telethon.tl.types import Message, MessageMediaDocument, MessageMediaPhoto

API_ID = int(os.environ.get("TELEGRAM_API_ID") or "0")
API_HASH = os.environ.get("TELEGRAM_API_HASH") or ""
SESSION = os.environ.get("TELEGRAM_SESSION") or ""
SESSION_PATH = os.environ.get("TELEGRAM_SESSION_PATH") or "/data/loom.session"
PORT = int(os.environ.get("PORT") or "8787")
CONCURRENCY = max(1, int(os.environ.get("TELETHON_CONCURRENCY") or "3"))

MINIO_ENDPOINT = (os.environ.get("MINIO_ENDPOINT") or "").replace("http://", "").replace("https://", "")
MINIO_ACCESS = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("MINIO_ROOT_USER") or ""
MINIO_SECRET = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("MINIO_ROOT_PASSWORD") or ""
MINIO_BUCKET = os.environ.get("MINIO_BUCKET") or "loom"
MINIO_PUBLIC = (os.environ.get("MINIO_PUBLIC_URL") or "").rstrip("/")
MINIO_SECURE = os.environ.get("MINIO_SECURE", "false").lower() == "true"

paused_until = 0.0
client: TelegramClient | None = None
minio_client: Minio | None = None
gate = asyncio.Semaphore(CONCURRENCY)
connection_lock = asyncio.Lock()
reconnect_requested = asyncio.Event()
reconnect_task: asyncio.Task | None = None
connection_state = "unconfigured"
retry_at = 0.0
account = ""
HISTORY_TIMEOUT_SECONDS = 50
CONNECTION_POLL_SECONDS = 5
RETRY_DELAYS = (5, 15, 60, 300)
retry_wait = asyncio.sleep


def minio_ready() -> bool:
    return bool(MINIO_ENDPOINT and MINIO_ACCESS and MINIO_SECRET)


def build_minio() -> Minio | None:
    if not minio_ready():
        return None
    host = MINIO_ENDPOINT.split("/")[0]
    try:
        mc = Minio(host, access_key=MINIO_ACCESS, secret_key=MINIO_SECRET, secure=MINIO_SECURE)
        if not mc.bucket_exists(MINIO_BUCKET):
            mc.make_bucket(MINIO_BUCKET)
        return mc
    except Exception as exc:
        print(f"minio unavailable: {exc}", flush=True)
        return None


def build_client() -> TelegramClient | None:
    if not API_ID or not API_HASH:
        return None
    session = StringSession(SESSION) if SESSION else SESSION_PATH
    if not SESSION:
        os.makedirs(os.path.dirname(SESSION_PATH) or ".", exist_ok=True)
    return TelegramClient(session, API_ID, API_HASH, connection_retries=1,
                          request_retries=1, retry_delay=1, auto_reconnect=False,
                          flood_sleep_threshold=0)


def public_url(key: str) -> str:
    if MINIO_PUBLIC:
        return f"{MINIO_PUBLIC}/{key}"
    scheme = "https" if MINIO_SECURE else "http"
    return f"{scheme}://{MINIO_ENDPOINT}/{MINIO_BUCKET}/{key}"


async def upload_bytes(key: str, data: bytes, content_type: str) -> str:
    if not minio_client or not data:
        return ""
    await asyncio.to_thread(
        minio_client.put_object,
        MINIO_BUCKET,
        key,
        io.BytesIO(data),
        len(data),
        content_type or "application/octet-stream",
    )
    return public_url(key)


def media_kind(message: Message) -> str:
    if isinstance(message.media, MessageMediaPhoto):
        return "image"
    if isinstance(message.media, MessageMediaDocument):
        mime = ""
        doc = message.document
        if doc is not None:
            mime = getattr(doc, "mime_type", "") or ""
        if mime.startswith("video/"):
            return "video"
        if mime.startswith("audio/"):
            return "audio"
        if mime.startswith("image/"):
            return "image"
        return "file"
    if message.web_preview:
        return "link"
    return "text" if (message.raw_text or "").strip() else "link"


async def save_media(_message: Message, _channel: str) -> tuple[list[str], str]:
    # ponytail: inline video/photo download exceeds the app's 60s /v1/history
    # budget, so authorized scans silently fall back to t.me/s (~20 preview
    # items, items_new=0). History returns type/text only; binary ingest is
    # the nodes-page 媒体落盘 path.
    return [], ""


async def normalize(message: Message, channel: str) -> dict[str, Any]:
    body = (message.raw_text or "").strip()
    title = body.split("\n", 1)[0][:120] if body else f"{channel} #{message.id}"
    sender = ""
    try:
        who = await message.get_sender()
        sender = getattr(who, "username", None) or getattr(who, "title", None) or getattr(who, "first_name", "") or ""
    except (FloodWaitError, OSError):
        raise
    except Exception:
        sender = channel
    media_urls, thumb = await save_media(message, channel)
    kind = media_kind(message)
    published = message.date.isoformat() if message.date else None
    return {
        "external_id": str(message.id),
        "title": title or "频道消息",
        "body": body[:8000],
        "author": sender or channel,
        "url": f"https://t.me/{channel}/{message.id}",
        "media_type": kind,
        "media_urls": media_urls,
        "thumbnail_url": thumb,
        "views": int(message.views) if message.views is not None else None,
        "likes": int(message.forwards) if message.forwards is not None else None,
        "published_at": published,
        "extra": {"channel": channel, "telegram_id": message.id, "collector": "telethon"},
    }


async def resolve_channel(channel: str):
    assert client is not None
    return await client.get_entity(channel)


def cooldown_seconds() -> int:
    return max(0, math.ceil(paused_until - time.monotonic()))


async def history(channel: str, min_id: int, limit: int) -> dict[str, Any]:
    global paused_until, connection_state
    deadline = asyncio.get_running_loop().time() + HISTORY_TIMEOUT_SECONDS
    try:
        async with asyncio.timeout_at(deadline):
            return await history_page(channel, min_id, limit)
    except TimeoutError:
        return {"error": "timeout", "items": []}
    except FloodWaitError as exc:
        paused_until = max(paused_until, time.monotonic() + int(exc.seconds) + 1)
        return {"error": "flood_wait", "flood_wait": cooldown_seconds(), "items": []}
    except ChannelPrivateError:
        return {"error": "membership_required", "items": []}
    except OSError:
        connection_state = "unavailable"
        # The lifecycle owns disconnect/reconnect, outside the request deadline.
        reconnect_requested.set()
        return {"error": "unavailable", "items": []}
    except (UsernameNotOccupiedError, ValueError):
        return {"error": "channel_invalid", "items": []}


async def history_page(channel: str, min_id: int, limit: int) -> dict[str, Any]:
    """Fetch one bounded page of channel history, ascending from the cursor.

    T10: the page must start at the *oldest* message after the cursor, not the
    newest end of the channel. `get_messages(min_id=..., limit=N)` without
    `reverse=True` returns the newest N messages above `min_id`, so a stored
    cursor of 100 with messages 101..350 returned 251..350 and then advanced the
    cursor to 350 — dropping 101..250 permanently.

    With `reverse=True` the call yields 101..180, and `last_id` is that page's
    maximum, so the next call continues from 181. The cursor only advances once
    the caller has persisted this page.
    """
    async with gate:
        wait = cooldown_seconds()
        if wait:
            return {"error": "flood_wait", "flood_wait": wait, "items": []}
        if client is None or not client.is_connected() or connection_state != "ready":
            return {"error": connection_state if connection_state in {"unconfigured", "unauthorized"} else "unavailable", "items": []}
        entity = await resolve_channel(channel)
        messages = await client.get_messages(entity, min_id=min_id, limit=limit, reverse=True)
        items = []
        last_id = min_id
        for msg in messages:
            if not isinstance(msg, Message):
                continue
            if msg.id <= min_id:
                continue
            items.append(await normalize(msg, channel))
            last_id = max(last_id, msg.id)
        # `last_id` is a plain integer here and is serialized as a decimal
        # string: message ids can exceed 2^53, where JSON numbers lose precision.
        return {"items": items, "last_id": str(last_id) if last_id else "0"}


async def handle_health(_: web.Request) -> web.Response:
    state = connection_state
    if state == "ready" and (client is None or not client.is_connected()):
        state = "unavailable"
    wait = cooldown_seconds()
    if state == "ready" and wait:
        state = "cooldown"
    authorized = state in {"ready", "cooldown"}
    return web.json_response({
        "ok": state not in {"connecting", "unavailable"},
        "authorized": authorized,
        "me": account if authorized else "",
        "minio": minio_client is not None,
        "paused_until": wait,
        "state": state,
        "retry_after_seconds": wait if state == "cooldown" else max(0, math.ceil(retry_at - time.monotonic())),
        "error": None if authorized else state,
    })


async def handle_history(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求不是 JSON"}, status=400)
    channel = str(body.get("channel") or "").lstrip("@").strip()
    if not channel:
        return web.json_response({"error": "缺少 channel"}, status=400)
    raw_min = str(body.get("min_id") or "0")
    digits = "".join(ch for ch in raw_min if ch.isdigit())
    min_id = int(digits or 0)
    limit = min(100, max(1, int(body.get("limit") or 80)))
    try:
        result = await history(channel, min_id, limit)
    except Exception as exc:
        return web.json_response({"error": str(exc)[:180], "items": []}, status=400)
    status = 429 if result.get("flood_wait") else 200
    if result.get("error") and result.get("error") not in {"flood_wait"} and not result.get("items"):
        status = 400
    if result.get("error") == "unavailable":
        status = 503
    elif result.get("error") == "timeout":
        status = 504
    headers = {"Retry-After": str(result["flood_wait"])} if status == 429 else {}
    return web.json_response(result, status=status, headers=headers)


async def handle_search(request: web.Request) -> web.Response:
    return web.json_response(
        {"error": "关键词检索由控制面负责；本节点只做频道 GetHistory", "items": []},
        status=400,
    )


async def disconnect_client(candidate: TelegramClient) -> None:
    # Telethon shields its own cleanup task; protect and await it even at shutdown.
    pending = asyncio.ensure_future(candidate.disconnect())
    try:
        await asyncio.shield(pending)
    except asyncio.CancelledError:
        with suppress(Exception):
            await pending
        raise
    except Exception:
        pass  # A completed failed cleanup must not kill the recovery loop.


async def reconnect() -> None:
    global client, connection_state, retry_at, account, paused_until
    failures = 0
    while True:
        try:
            async with connection_lock:
                connection_state = "connecting"
                if client is None:
                    client = build_client()
                if client is None:
                    connection_state = "unconfigured"
                    return
                await asyncio.wait_for(client.connect(), timeout=10)
                authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=5)
                # Telethon caches False for *any* RPCError in is_user_authorized.
                # get_me returns None only for UnauthorizedError; other errors retry.
                user = await asyncio.wait_for(client.get_me(), timeout=5)
                authorized = authorized or user is not None
                if not authorized or user is None:
                    connection_state = "unauthorized"
                    retry_at = 0
                    await disconnect_client(client)
                    return  # Manual login/session replacement, never send codes here.
                account = getattr(user, "username", None) or str(getattr(user, "id", ""))
                connection_state = "ready"
                failures = 0
                retry_at = 0
            # ponytail: idle disconnect detection is bounded to 5s; use an SDK
            # disconnect event if a faster idle recovery target is required.
            while connection_state == "ready" and client.is_connected():
                try:
                    await asyncio.wait_for(reconnect_requested.wait(), timeout=CONNECTION_POLL_SECONDS)
                except TimeoutError:
                    pass
                reconnect_requested.clear()
            connection_state = "unavailable"
        except FloodWaitError as exc:
            paused_until = max(paused_until, time.monotonic() + int(exc.seconds) + 1)
            connection_state = "unavailable"
        except Exception:
            connection_state = "unavailable"
        if client is not None:
            await disconnect_client(client)
        delay = RETRY_DELAYS[min(failures, len(RETRY_DELAYS) - 1)]
        delay = max(delay + random.uniform(0, delay * 0.2), cooldown_seconds())
        failures += 1
        retry_at = time.monotonic() + delay
        await retry_wait(delay)


async def on_start(app: web.Application) -> None:
    global minio_client, reconnect_task, connection_state
    minio_client = build_minio()
    if reconnect_task is None:
        connection_state = "connecting"
        reconnect_task = asyncio.create_task(reconnect(), name="telethon-reconnect")


async def on_stop(app: web.Application) -> None:
    global client, reconnect_task, connection_state
    if reconnect_task is not None:
        reconnect_task.cancel()
        with suppress(asyncio.CancelledError):
            await reconnect_task
        reconnect_task = None
    if client is not None:
        await disconnect_client(client)
        client = None
    connection_state = "unavailable"


def main() -> None:
    app = web.Application()
    app.router.add_get("/health", handle_health)
    app.router.add_post("/v1/history", handle_history)
    app.router.add_post("/v1/search", handle_search)
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    web.run_app(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
