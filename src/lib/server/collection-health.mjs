/** Read-only diagnostics shared by the CLI and existing dashboard.
 * @param {{query:(text:string,params?:unknown[])=>Promise<Record<string,any>[]>}} sql
 * @param {number} now
 */
export async function collectionHealth(sql, now = Date.now()) {
  const at = new Date(now).toISOString();
  const sources = await sql.query(`select id,adapter,interval_minutes,last_success_at,last_content_at,last_error_code,next_attempt_at
    from sources where enabled and id <> 'src_kw_radar'`);
  const failed_sources = await sql.query(`select adapter,count(*)::int total,
    count(*) filter(where last_error_code<>'')::int failed from sources where enabled and id <> 'src_kw_radar' group by adapter`);
  const adapter_jobs = await sql.query(`select coalesce(adapter,'unknown') adapter,count(*)::int total,
    count(*) filter(where status='error' or nullif(error_code,'') is not null)::int failed
    from jobs where started_at >= $1::timestamptz-interval '24 hours' and started_at <= $1::timestamptz
      and status in ('ok','error','skipped') group by adapter`,[at]);
  const [ages] = await sql.query(`select
    (select max(extract(epoch from ($1::timestamptz-due_at))/60) from (
      select coalesce(next_attempt_at,case when status='running' then coalesce(claimed_at+interval '15 minutes',last_scanned_at,created_at)
        else last_scanned_at+case when has_more then interval '1 minute' else interval_minutes*interval '1 minute' end end,created_at) due_at
      from sources where enabled and id <> 'src_kw_radar'
        and (next_attempt_at is null or next_attempt_at <= $1::timestamptz)
        and (status<>'running' or claimed_at is null or claimed_at <= $1::timestamptz-interval '15 minutes')
    ) due where due_at <= $1::timestamptz) oldest_due_age_minutes,
    (select max(extract(epoch from ($1::timestamptz-created_at))/60) from media_objects
      where status in ('remote','running','error','dead') and created_at <= $1::timestamptz) pending_media_age_minutes,
    (select max(extract(epoch from ($1::timestamptz-coalesce(next_attempt_at,
      case when status='running' then claimed_at+interval '5 minutes' end,created_at)))/60) from media_objects
      where attempts<4 and ((status='remote' and (next_attempt_at is null or next_attempt_at<=$1::timestamptz))
        or (status='error' and next_attempt_at<=$1::timestamptz)
        or (status='running' and (claimed_at is null or claimed_at<=$1::timestamptz-interval '5 minutes')))) oldest_due_media_age_minutes,
    (select count(*)::int from media_objects where status in ('remote','error') and next_attempt_at>$1::timestamptz) media_cooling,
    (select count(*)::int from media_objects where status='running' and claimed_at>$1::timestamptz-interval '5 minutes') media_leased,
    (select count(*)::int from media_objects where status='dead' or (status='error' and next_attempt_at is null)) media_manual`,[at]);
  const [discovery] = await sql.query(`select count(*)::int total,
    count(*) filter(where published_at is null or extra->>'publication_time_kind'='updated')::int unknown,
    count(*) filter(where (published_at>collected_at or published_at>$1::timestamptz) and coalesce(extra->>'publication_time_kind','')<>'updated')::int invalid_future,
    count(*) filter(where published_at<=collected_at and collected_at<=$1::timestamptz and coalesce(extra->>'publication_time_kind','')<>'updated')::int observed,
    percentile_cont(0.5) within group(order by extract(epoch from(collected_at-published_at)))
      filter(where published_at<=collected_at and collected_at<=$1::timestamptz and coalesce(extra->>'publication_time_kind','')<>'updated') p50_seconds,
    percentile_cont(0.95) within group(order by extract(epoch from(collected_at-published_at)))
      filter(where published_at<=collected_at and collected_at<=$1::timestamptz and coalesce(extra->>'publication_time_kind','')<>'updated') p95_seconds
    from items where collected_at >= $1::timestamptz-interval '24 hours' and collected_at <= $1::timestamptz`,[at]);
  const [body] = await sql.query(`select count(*)::int total,
    count(*) filter(where extra->>'body_complete' in ('true','false'))::int known,
    count(*) filter(where extra->>'body_complete'='true')::int complete
    from items`);
  return {as_of:at,window_hours:24,sources,failed_sources,adapter_jobs,
    oldest_due_age_minutes:ages?.oldest_due_age_minutes == null ? null : Number(ages.oldest_due_age_minutes),
    pending_media_age_minutes:ages?.pending_media_age_minutes == null ? null : Number(ages.pending_media_age_minutes),
    oldest_due_media_age_minutes:ages?.oldest_due_media_age_minutes == null ? null : Number(ages.oldest_due_media_age_minutes),
    media_cooling:Number(ages.media_cooling),media_leased:Number(ages.media_leased),media_manual:Number(ages.media_manual),
    discovery:{total:Number(discovery.total),unknown:Number(discovery.unknown),invalid_future:Number(discovery.invalid_future),
      observed:Number(discovery.observed),p50_seconds:discovery.p50_seconds==null?null:Number(discovery.p50_seconds),
      p95_seconds:discovery.p95_seconds==null?null:Number(discovery.p95_seconds)},
    body:{total:Number(body.total),known:Number(body.known),complete:Number(body.complete)}};
}

