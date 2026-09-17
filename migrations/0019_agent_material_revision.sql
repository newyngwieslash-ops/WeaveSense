alter table items add column if not exists material_version bigint not null default 0;
create or replace function agent_material_changed() returns trigger language plpgsql as $$
begin
  if (new.title,new.body,new.author,new.url,new.platform,new.source_id,new.published_at,new.media_type,new.media_urls)
    is distinct from (old.title,old.body,old.author,old.url,old.platform,old.source_id,old.published_at,old.media_type,old.media_urls) then
    new.material_version := old.material_version + 1;
  end if;
  return new;
end $$;
drop trigger if exists agent_material_revision on items;
create trigger agent_material_revision before update on items for each row execute function agent_material_changed();
create or replace function agent_extract_changed() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and (new.status,new.result_text,new.kind,new.media_id) is not distinct from (old.status,old.result_text,old.kind,old.media_id) then return new; end if;
  update items set material_version=material_version+1 where id=case when tg_op='DELETE' then old.item_id else new.item_id end;
  return null;
end $$;
drop trigger if exists agent_extract_revision on extract_jobs;
create trigger agent_extract_revision after insert or update or delete on extract_jobs for each row execute function agent_extract_changed();
