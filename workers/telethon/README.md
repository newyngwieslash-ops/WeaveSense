# Telethon worker

Incremental Telegram collector for Loom. One HTTP request = one channel `GetHistory` after `min_id`. The Node control plane still owns scheduling for 100–1000 sources.

```
GET  /health
POST /v1/history  { "channel": "durov", "min_id": "0", "limit": 80 }
```

First login (interactive):

```
docker compose run --rm -it telethon python login.py
```

Session is stored in the `telethon-session` volume (`/data/loom.session`). Media is uploaded to MinIO when `MINIO_ENDPOINT` is set.
