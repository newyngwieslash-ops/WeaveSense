-- Cache only fully consumed source responses; unknown identity forces a fresh 200.
alter table sources add column if not exists feed_etag text not null default '';
alter table sources add column if not exists feed_last_modified text not null default '';
alter table sources add column if not exists feed_validator_identity text not null default '';
