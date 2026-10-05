#!/usr/bin/env python3
"""Telethon incremental worker for Loom.

GET  /health
POST /v1/history  {channel, min_id, limit}
POST /v1/search   {query, limit}
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import math
import random
import re
import tempfile
from contextlib import suppress
import os
import time
from typing import Any

from aiohttp import web
from minio import Minio
from urllib3 import PoolManager, Timeout
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
MEDIA_TOKEN = (os.environ.get("TELEGRAM_MEDIA_TOKEN") or "").strip()
MEDIA_MAX_BYTES = 25 * 1024 * 1024
MEDIA_TIMEOUT_SECONDS = 120

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
media_gate = asyncio.Semaphore(1)
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
        mc = Minio(host, access_key=MINIO_ACCESS, secret_key=MINIO_SECRET, secure=MINIO_SECURE,
                   http_client=PoolManager(timeout=Timeout(connect=5, read=20), retries=False))
        if not mc.bucket_exists(MINIO_BUCKET):
            mc.make_bucket(MINIO_BUCKET)
        return mc
    except Exception:
        print("minio unavailable", flush=True)
        return None


async def initialize_storage() -> None:
    """One bounded SDK attempt; caller owns media_gate until native IO settles."""
    global minio_client
    if minio_client is not None or not minio_ready():
        return
    setup = asyncio.create_task(asyncio.to_thread(build_minio))
    try:
        minio_client = await asyncio.shield(setup)
    except asyncio.CancelledError:
        # ponytail: native setup shares upload's SDK-IO ceiling, not a hard async wall.
        # Keep the media slot until it settles; use process isolation for a hard wall.
        while not setup.done():
            with suppress(Exception, asyncio.CancelledError):
                await asyncio.shield(setup)
        with suppress(Exception):
            minio_client = setup.result()
        raise


def build_client() -> TelegramClient | None:
    if not API_ID or not API_HASH:
        return None
    session = StringSession(SESSION) if SESSION else SESSION_PATH
    if not SESSION:
        os.makedirs(os.path.dirname(SESSION_PATH) or ".", exist_ok=True)
    return TelegramClient(session, API_ID, API_HASH, connection_retries=1,
                          request_retries=1, retry_delay=1, auto_reconnect=False,
                          flood_sleep_threshold=0)


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
    kind = media_kind(message)
    attachment = kind in {"image", "video", "audio", "file"}
    media_urls = [f"telegram://{channel.lower()}/{message.id}"] if attachment else []
    extra = {"channel": channel, "telegram_id": message.id, "collector": "telethon",
             "forwards": int(message.forwards) if message.forwards is not None else None}
    if attachment:
        extra["telegram_media"] = {"channel": channel.lower(), "message_id": str(message.id),
                                   "kind": kind, "size": getattr(message.file, "size", None)}
    published = message.date.isoformat() if message.date else None
    return {
        "external_id": str(message.id),
        "title": title or "频道消息",
        "body": body[:8000],
        "author": sender or channel,
        "url": f"https://t.me/{channel}/{message.id}",
        "media_type": kind,
        "media_urls": media_urls,
        "thumbnail_url": "",
        "views": int(message.views) if message.views is not None else None,
        "likes": None,
        "published_at": published,
        "extra": extra,
    }


async def download_media_to_store(channel: str, message_id: int) -> dict:
    assert client is not None and minio_client is not None
    entity = await resolve_channel(channel)
    message = await client.get_messages(entity, ids=message_id)
    if not isinstance(message, Message) or media_kind(message) not in {"image", "audio", "video", "file"}:
        raise ValueError("media_not_found")
    expected_size = getattr(message.file, "size", None)
    if expected_size is not None and expected_size > MEDIA_MAX_BYTES:
        raise ValueError("media_too_large")
    content_type = getattr(message.file, "mime_type", None) or "application/octet-stream"
    if not re.fullmatch(r"[\w.+-]+/[\w.+-]+", content_type, re.ASCII) or len(content_type) > 120:
        raise ValueError("media_invalid_type")
    key = f"telegram/{channel.lower()}/{message_id}"
    sha, size = hashlib.sha256(), 0
    # TemporaryFile removes its backing file on every exit, including cancellation.
    with tempfile.TemporaryFile(mode="w+b") as temp:
        stream = client.iter_download(message.media, request_size=64 * 1024)
        try:
            async for chunk in stream:
                size += len(chunk)
                if size > MEDIA_MAX_BYTES:
                    raise ValueError("media_too_large")
                temp.write(chunk)
                sha.update(chunk)
        finally:
            # Telethon's iterator uses close(); async generator fixtures use aclose().
            await (stream.close() if hasattr(stream, "close") else stream.aclose())
        if not size or (expected_size is not None and expected_size != size):
            raise ValueError("media_size_mismatch")
        temp.seek(0)
        upload = asyncio.create_task(asyncio.to_thread(minio_client.put_object, MINIO_BUCKET, key,
                    temp, size, content_type=content_type, num_parallel_uploads=1))
        try:
            await asyncio.shield(upload)
        except asyncio.CancelledError:
            # ponytail: a native SDK call cannot be killed at the async deadline.
            # Retain file/slot until bounded SDK IO settles; process isolation if a hard wall is required.
            while not upload.done():
                with suppress(Exception, asyncio.CancelledError):
                    await asyncio.shield(upload)
            with suppress(Exception):
                upload.result()
            raise
    return {"object_key": key, "content_type": content_type, "bytes": size, "sha256": sha.hexdigest()}


async def handle_media(request: web.Request) -> web.Response:
    global paused_until
    if not MEDIA_TOKEN:
        return web.json_response({"error": "media_unavailable"}, status=503)
    authorization = request.headers.get("Authorization", "")
    if not hmac.compare_digest(authorization.encode(), f"Bearer {MEDIA_TOKEN}".encode()):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        body = await request.json()
    except Exception:
        body = None
    if (not isinstance(body, dict) or set(body) != {"channel", "message_id"}
        or not isinstance(body["channel"], str) or not re.fullmatch(r"[A-Za-z0-9_]{5,32}", body["channel"])
        or not isinstance(body["message_id"], str) or not re.fullmatch(r"[1-9][0-9]{0,319}", body["message_id"])):
        return web.json_response({"error": "invalid_media_locator"}, status=400)
    try:
        async with asyncio.timeout(MEDIA_TIMEOUT_SECONDS):
            async with media_gate:
                wait = cooldown_seconds()
                if wait:
                    return web.json_response({"error": "flood_wait"}, status=429, headers={"Retry-After": str(wait)})
                if client is None or not client.is_connected() or connection_state != "ready":
                    return web.json_response({"error": "unavailable"}, status=503)
                await initialize_storage()
                if minio_client is None:
                    return web.json_response({"error": "media_unavailable"}, status=503)
                # History and account recovery can change admission while storage setup awaits.
                wait = cooldown_seconds()
                if wait:
                    return web.json_response({"error": "flood_wait"}, status=429, headers={"Retry-After": str(wait)})
                if client is None or not client.is_connected() or connection_state != "ready":
                    return web.json_response({"error": "unavailable"}, status=503)
                result = await download_media_to_store(body["channel"].lower(), int(body["message_id"]))
                return web.json_response(result)
    except FloodWaitError as exc:
        paused_until = max(paused_until, time.monotonic() + int(exc.seconds) + 1)
        return web.json_response({"error": "flood_wait"}, status=429, headers={"Retry-After": str(cooldown_seconds())})
    except TimeoutError:
        return web.json_response({"error": "timeout"}, status=504)
    except ChannelPrivateError:
        return web.json_response({"error": "membership_required"}, status=403)
    except (UsernameNotOccupiedError, ValueError) as exc:
        code = str(exc) if str(exc) in {"media_too_large", "media_not_found", "media_size_mismatch", "media_invalid_type"} else "channel_invalid"
        return web.json_response({"error": code}, status=413 if code == "media_too_large" else 404 if code == "media_not_found" else 400)
    except OSError:
        # A disk/storage failure must not take the Telegram text connection offline.
        # The existing lifecycle detects a real account disconnect independently.
        return web.json_response({"error": "media_unavailable"}, status=503)
    except Exception:
        return web.json_response({"error": "media_unavailable"}, status=503)


async def resolve_channel(channel: str):
    assert client is not None
    return await client.get_entity(channel)


def cooldown_seconds() -> int:
    return max(0, math.ceil(paused_until - time.monotonic()))


async def history(channel: str, min_id: int, limit: int, bootstrap: str = "latest") -> dict[str, Any]:
    global paused_until, connection_state
    deadline = asyncio.get_running_loop().time() + HISTORY_TIMEOUT_SECONDS
    try:
        async with asyncio.timeout_at(deadline):
            return await history_page(channel, min_id, limit, bootstrap)
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


async def history_page(channel: str, min_id: int, limit: int, bootstrap: str = "latest") -> dict[str, Any]:
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
        ascending = min_id > 0 or bootstrap == "backfill"
        messages = await client.get_messages(entity, min_id=min_id, limit=limit, reverse=ascending)
        items = []
        last_id = min_id
        for msg in messages:
            # Telegram service messages are consumed too, although they have no
            # normalized content. Otherwise a full service page repeats forever.
            message_id = getattr(msg, "id", None)
            if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id <= min_id:
                continue
            last_id = max(last_id, message_id)
            if isinstance(msg, Message):
                items.append(await normalize(msg, channel))
        # `last_id` is a plain integer here and is serialized as a decimal
        # string: message ids can exceed 2^53, where JSON numbers lose precision.
        return {"items": items, "last_id": str(last_id) if last_id else "0",
                "has_more": ascending and len(messages) >= limit}


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
        "media_available": bool(MEDIA_TOKEN and minio_client is not None),
        "media_error": None if MEDIA_TOKEN and minio_client is not None else "media_unavailable",
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
    if not isinstance(body, dict):
        return web.json_response({"error": "invalid_request"}, status=400)
    channel = str(body.get("channel") or "").lstrip("@").strip()
    if not channel:
        return web.json_response({"error": "缺少 channel"}, status=400)
    raw_min = str(body.get("min_id") or "0")
    bootstrap = body.get("bootstrap", "latest")
    if len(raw_min) > 320 or not raw_min.isascii() or not raw_min.isdecimal() or bootstrap not in ("latest", "backfill"):
        return web.json_response({"error": "invalid_cursor"}, status=400)
    min_id = int(raw_min)
    try:
        limit = min(100, max(1, int(body.get("limit") or 80)))
    except (TypeError, ValueError):
        return web.json_response({"error": "invalid_limit"}, status=400)
    try:
        result = await history(channel, min_id, limit, bootstrap)
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
    global reconnect_task, connection_state
    try:
        async with asyncio.timeout(MEDIA_TIMEOUT_SECONDS):
            async with media_gate:
                await initialize_storage()
    except TimeoutError:
        pass  # Later authenticated media requests retry storage without reconnecting Telegram.
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
    app.router.add_post("/v1/media", handle_media)
    app.router.add_post("/v1/search", handle_search)
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    web.run_app(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
