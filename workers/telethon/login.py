#!/usr/bin/env python3
"""Interactive Telethon login. Saves SQLite session to TELEGRAM_SESSION_PATH.

  docker compose run --rm -it telethon python login.py
"""
from __future__ import annotations

import asyncio
import os

from telethon import TelegramClient

API_ID = int(os.environ.get("TELEGRAM_API_ID") or "0")
API_HASH = os.environ.get("TELEGRAM_API_HASH") or ""
SESSION_PATH = os.environ.get("TELEGRAM_SESSION_PATH") or "/data/loom.session"


async def main() -> None:
    if not API_ID or not API_HASH:
        raise SystemExit("设置 TELEGRAM_API_ID 和 TELEGRAM_API_HASH（https://my.telegram.org）")
    os.makedirs(os.path.dirname(SESSION_PATH) or ".", exist_ok=True)
    async with TelegramClient(SESSION_PATH, API_ID, API_HASH) as client:
        if not await client.is_user_authorized():
            raise SystemExit("未完成登录")
        print(f"session saved to {SESSION_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
