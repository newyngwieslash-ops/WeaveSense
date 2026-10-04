# Telethon worker

Incremental Telegram collector for Loom. One HTTP request = one channel `GetHistory` after `min_id`. The Node control plane still owns scheduling for 100–1000 sources.

```
GET  /health
POST /v1/history  { "channel": "durov", "min_id": "0", "limit": 80 }
POST /v1/media    { "channel": "durov", "message_id": "101" }
```

First login (interactive):

```
docker compose run --rm -it telethon python login.py
```

Session is stored in the `telethon-session` volume (`/data/loom.session`). History never downloads attachments: it returns the caption/type plus
`extra.telegram_media: {channel,message_id,kind,size}` and a logical `telegram://channel/message_id` URL. `size` may be null. Audio stays audio; forwards are `extra.forwards`, never likes.

Attachment ingest uses the existing application media queue. `/v1/media` requires an independent `Authorization: Bearer <TELEGRAM_MEDIA_TOKEN>` and accepts only a channel username and a positive decimal message ID string. It does not accept a URL, output key, or credentials. Set the same independently generated token in the **app and telethon service environment files only**. `scripts/write-service-envs.mjs` routes this optional variable to those two services; existing Compose `env_file` mappings need no change. Never reuse Telegram session/account or other service credentials as this token.

The worker needs its existing MinIO endpoint/access key/secret/bucket configuration; the app needs access to the **same bucket** for verification and extraction. Missing worker token/storage returns `503 media_unavailable`; invalid Bearer returns 401. Health reports `media_available`/`media_error` separately from account state. The existing Telethon node card keeps text history live and reports attachments as configured or unavailable; configured is not proof of a live sample. Missing app token/storage leaves attachments unclaimed and extraction waiting; existing text history still works. After changing environment settings restart the affected services through the existing operator procedure, then let the queue retry (or explicitly replay a terminal row).

One media semaphore, independent of the history gate, covers fetching the message, streaming 64 KiB Telethon chunks into a temporary file, and MinIO upload. Downloads stop at **25 MiB** (413 `media_too_large`); known size and final SHA256 are checked, and the app verifies the stored bytes/hash with its bounded trusted storage read before committing metadata. Photos use OCR; audio/video use ASR after storage. Unknown files retain the existing unsupported-extraction behavior.

The worker's asynchronous deadline is **120 seconds including queue wait**, and the app request deadline is 130 seconds. MinIO uses connect/read timeouts of 5/20 seconds, disabled retries, and one multipart upload thread. Cancellation/timeout keeps the temporary file and media slot until an already-running native SDK upload finishes, then cleans the file in all exit paths. Therefore 120 seconds is **not a hard native-thread termination or response deadline**; a non-cooperative SDK call may delay cleanup. Process isolation would be needed for a hard wall. Text history remains independent during this cleanup. Telegram account FloodWait is shared by history and media and returns `Retry-After`; no attachment task bypasses it.

On claim, new or older empty-key Telegram rows reserve `telegram/<lowercase channel>/<canonical message_id>` **before upload**. All existing nonempty keys remain immutable. The worker always uploads that same locator key and returns `{object_key,content_type,bytes,sha256}`. A legacy row with a different key uses the existing bounded trusted get/put to preserve its destination: at most the shared locator object plus its pre-existing destination, never a fresh key per retry. Shared locator objects are not deleted. Item display replacement and media completion retain the queue's atomic transaction, lease/token fencing and retries. Worker and storage-read `Retry-After` survive exhaustion and manual replay.

`telegram://` is never sent to public HTTP; an attachment with no committed key/MIME/stored status waits without creating extraction jobs or spending attempts. Real authorized image/audio sample acceptance is still pending user-supplied sources; offline fixtures do not establish live Telegram/MinIO/model success.

The application serializes attachment HTTP requests within one process, leaving the common host limiter's second permit for history. Cancelled queue waiters do not release active predecessors. This is a single-app-process ceiling; multiple replicas would require shared admission. The worker's semaphore still applies independently.

Cron keeps its existing 720-second server / 750-second request budget and 30-minute production windows. In collection slots, a metadata-only probe of the next claimable media row reserves **195 seconds** when it is Telegram (130 request + 30 verification + 30 legacy copy + 5 bookkeeping); ordinary media retains 55 seconds. Completed/failed/in-flight stage windows, cooling rows and exhausted attempts do not enlarge this reserve. Source collection defers work when the remaining reservation cannot fit; this does not preserve the old full-batch worst-case capacity for that tick. Extraction slots retain their original budget and exclude Telegram claims. Telegram-only work defers the ingest window; budget refusal happens before window claim, allowing later admission. The actual claim enforces the permitted media class even if the probe races with another claimant. Media/source stages still run serially within one cron request, so a long attachment can delay the next scheduler wake-up; T17 must measure real source latency/capacity rather than assume a two-tick bound.
