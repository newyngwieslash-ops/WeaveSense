alter table extract_jobs add column if not exists target_key text not null default '';
alter table extract_jobs add column if not exists attempts integer not null default 0;
alter table extract_jobs add column if not exists started_at timestamptz;

with ranked as (
  select id, media_id,
         row_number() over (
           partition by item_id, media_id
           order by (status = 'ok') desc, created_at desc, id desc
         ) as duplicate_number
  from extract_jobs
  where target_key = ''
)
update extract_jobs as job
set target_key = case
  when ranked.media_id <> '' and ranked.duplicate_number = 1 then ranked.media_id
  else 'legacy:' || job.id
end
from ranked
where job.id = ranked.id;

create unique index if not exists extract_item_target_idx
  on extract_jobs (item_id, target_key);
