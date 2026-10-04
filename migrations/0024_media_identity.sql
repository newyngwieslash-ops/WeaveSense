-- The migration runner wraps this file in a transaction. Never delete storage
-- objects or rebind references. Refuse ambiguous groups before deleting any row.
-- ponytail: maintenance-only reference scans can be O(duplicates * history).
-- Large duplicate sets need a reviewed indexed reference inventory, not weaker checks.
lock table media_objects, extract_jobs, items, analyses, knowledge_notes,
  ai_jobs, ai_runs, agent_checkpoints in share row exclusive mode;

create temporary table media_identity_duplicates on commit drop as
select id, first_value(id) over (
  partition by item_id,source_url order by (status='stored') desc,created_at,id
) keeper from media_objects;

do $$
declare conflict_id text;
begin
  select loser.id into conflict_id
  from media_identity_duplicates d
  join media_objects loser on loser.id=d.id
  join media_objects keeper on keeper.id=d.keeper
  where d.id<>d.keeper and (
    loser.status<>'remote' or loser.object_key<>'' or loser.sha256<>'' or
    loser.bytes is not null or loser.content_type<>'' or loser.error<>'' or
    loser.public_url not in ('',loser.source_url) or loser.kind<>keeper.kind or
    -- Conservatively refuse even unrecognized JSON/prose references; never guess.
    exists(select 1 from extract_jobs r where strpos(to_jsonb(r)::text,loser.id)>0) or
    exists(select 1 from items r where strpos(to_jsonb(r)::text,loser.id)>0) or
    exists(select 1 from analyses r where strpos(to_jsonb(r)::text,loser.id)>0) or
    exists(select 1 from knowledge_notes r where strpos(to_jsonb(r)::text,loser.id)>0) or
    exists(select 1 from ai_jobs r where strpos(to_jsonb(r)::text,loser.id)>0) or
    exists(select 1 from ai_runs r where strpos(to_jsonb(r)::text,loser.id)>0) or
    -- Native blobs are opaque here, so their potential references cannot be proven absent.
    exists(select 1 from agent_checkpoints)
  ) order by loser.id limit 1;
  if conflict_id is not null then
    raise exception 'media_identity_conflict: %; review duplicates and references before retrying 0024',conflict_id;
  end if;
end $$;

delete from media_objects m using media_identity_duplicates d
where m.id=d.id and d.id<>d.keeper;
create unique index media_item_source_url_idx on media_objects(item_id,source_url);

-- NULL = historical/unprocessed; '' = processed without a valid WeChat URL.
-- Existing URLs are backfilled by the operator helper using normalizeWechatUrl.
alter table items add column normalized_wechat_url text;
create index items_source_wechat_url_idx on items(source_id,normalized_wechat_url);
create index items_wechat_url_pending_idx on items(source_id,id)
  where platform='wechat' and normalized_wechat_url is null;
create index items_source_telegram_alias_idx on items(source_id, (
  case when external_id ~ '^[0-9]+$' then coalesce(nullif(ltrim(external_id,'0'),''),'0')
    when external_id ~ '^[^/]+/[0-9]+$' then coalesce(nullif(ltrim(split_part(external_id,'/',2),'0'),''),'0') end
));
