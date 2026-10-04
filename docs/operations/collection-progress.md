# Collection progress and Telegram identity repair

## Media identity migration and WeChat URL keys (0024)

Back up the database and stop collection, media, extraction and Agent workers before
applying 0024 in a maintenance window. It creates `media_item_source_url_idx` only
after removing proven empty, unreferenced duplicate queue rows. A single stored
survivor retains its original ID, storage object and every reference. Multiple
stored rows, referenced losers, nonempty metadata, incompatible kinds or opaque
Agent checkpoints refuse the entire migration with `media_identity_conflict` and
a media ID. No object or reference is deleted or rewritten. Inspect that group and
its references; resolve only from verified evidence, then retry. Never bypass the
check or delete referenced/successful objects to force the unique index through.

0024 adds `items_source_wechat_url_idx`, `items_wechat_url_pending_idx` and
`items_source_telegram_alias_idx`. Existing WeChat URL keys require explicit
maintenance using the same URL normalizer as collection. An unprepared source
refuses collection with `wechat_identity_backfill_required` (including manual and
reconciliation runs), preserving item IDs, URLs and progress.

With the source disabled and workers stopped, supply DATABASE_URL explicitly and
run the dry-run report, then apply one page:

```text
node --experimental-strip-types scripts/reconcile-collection-identities.mjs --source SOURCE_ID --wechat-url-keys
node --experimental-strip-types scripts/reconcile-collection-identities.mjs --source SOURCE_ID --wechat-url-keys --apply --workers-stopped
```

Each apply handles at most 500 pending rows. Repeat until `remaining=false`; no
cursor argument or full-history load is needed, including for larger histories.
NULL means pending; an empty key means processed but invalid/absent URL. Such rows
are explicitly reported and retained without guessing an identity. Review reported
invalid rows before enabling the source. Dry-run reports are append-only evidence;
dry-run changes no item. The script never runs migrations or discovers credentials.
Collection cooling may need to expire after preparation; do not reset collection
cursors. Duplicate normalized URL matches refuse the batch for operator review.

Collection batches now commit item changes, media enqueue, progress and successful
job completion together. Lost claims write none of those fields; a stale attempt's
earlier running job record is retained, not falsely marked successful. This does
not retry failed/unknown automatic analysis or change production-stage admission.

New Telegram sources default to the latest 80 messages. The creation APIs accept
`scan_state: { bootstrap: "backfill", boundary: "100" }` to start strictly after
message ID 100; use `"0"` for the beginning. IDs are decimal strings. Historical
backfill requires an authorized Telethon worker; it never silently substitutes a
public webpage or RSS window. Disable/enable pauses/resumes the stored progress.
The form control is tracked separately in T13. RSS and public Telegram webpages
only cover their current window; the source list shows that limitation.

Bilibili scans at most five 20-item pages per job and resumes from an overlapping
page. Its saved boundary is the original scan head. One-page overlap tolerates
bounded page drift; arbitrary reordering or more than 20 deletions between rounds
requires an upstream stable cursor and cannot be claimed as lossless history.

Fresh RSS XML IDs retain their text instead of numeric coercion. Legacy aliases
(such as 00123→123, or numeric GUIDs with attributes previously using link fallback)
produce `identity_conflict:rss_legacy_alias` before page item/progress writes.
`collection_identity_conflicts` contains safe IDs, never message text or credentials.
Previously collapsed GUIDs cannot be reconstructed from the stored ID. Resolve
these only from verified source evidence; there is no automatic guessed RSS rekey.

## Telegram maintenance

Normal collection recognizes an exact `channel/123` legacy identity and numeric
`123` as one message of that source. Unambiguous rows rekey in place, preserving
internal item IDs and every reference. Pre-existing duplicate rows require the
maintenance operation below. It is not a startup migration or background job.

Build the pinned offline codec using the existing Go worker module:

```text
cd workers/agent
go build -o checkpoint-rebind ./cmd/checkpoint-rebind
```

Supply DATABASE_URL explicitly in the operator environment. The script does not
load .env, discover model configuration, or run migrations. Start with the report:

```text
node --experimental-strip-types scripts/reconcile-collection-identities.mjs --source SOURCE_ID --checkpoint-rebinder /absolute/path/to/checkpoint-rebind
```

The report is also recorded in the append-only conflict table. Dry-run changes no
items, business references, checkpoints, or progress. Inspect its conflicts first.
For apply, stop collection, media, extraction and Agent workers and disable the
source. The flag is an operator assertion, not automatic proof that workers stopped:

```text
node --experimental-strip-types scripts/reconcile-collection-identities.mjs --source SOURCE_ID --checkpoint-rebinder /absolute/path/to/checkpoint-rebind --apply --workers-stopped
```

Apply refuses enabled/running sources, visible active writers, incompatible content,
extract-target or AI-job unique-key collisions, unknown Agent JSON references,
unsupported checkpoint formats, and codec failure. Other independent supported
groups can proceed; blocked groups retain all original rows/blobs. Exit 2 means
conflicts remain; exit 1 is a refused/failed operation. Keep workers stopped until
the result is reviewed. Re-running a completed repair is idempotent.

Supported references: media_objects, extract_jobs, analyses, ai_jobs, note item
arrays, Agent request/source snapshots, evidence receipt item links, public citation
IDs, and native pending tool calls in current Agent checkpoints. Immutable prose,
quotes, evidence tokens, hashes, model/budget facts, storage object keys and history
remain unchanged. Full original item/reference/checkpoint snapshots are stored in
collection_identity_merges inside the same transaction before rebinding and removing
a duplicate. This archive contains business data and should receive normal database
backup/access protection. Transaction failure rolls back the entire apply operation.

The native codec only supports trusted schema 1 / eino-v0.9.19 ordinary nonstreaming
state. Unknown or falsely versioned future formats are not universally understood.
For duplicate merges that change internal UUIDs, every stored checkpoint is inspected
because a pending tool argument can be the
only item reference. An unrelated opaque checkpoint can conservatively block a group.
No potentially affected checkpoint is silently skipped. Maintenance refuses more
than 10,000 items in the source; duplicate merges also cap at 100 stored checkpoints
and 1,000 duplicate/checkpoint visits. In-place external-ID rekeys preserve UUIDs
and do not read or transform checkpoints. Fully validated checkpoints with no
structured link changes retain their exact bytes and are not rewritten or archived. Each native payload is capped at 256 KiB; each subprocess at 10 seconds with
bounded input/output and no shell. Table locks protect SQL races but cannot invalidate
in-memory work, which is why stopping workers remains mandatory. Larger corpora need
a separately reviewed maintenance procedure, not relaxed silent truncation.
