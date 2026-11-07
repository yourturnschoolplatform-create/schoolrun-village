-- Task 7.3 remediation: avoid schema-qualified coalesce under pg_catalog-only path.
begin;
set local search_path = pg_catalog;

create or replace function public.purge_expired_disclosure_retention()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  run_id uuid;
  ended_swaps uuid[];
  swap_count integer := 0;
  contact_count integer := 0;
  notice_count integer := 0;
  departure_count integer := 0;
  relay_count integer := 0;
  mobiles_deleted integer := 0;
  backups_deleted integer := 0;
  consents_deleted integer := 0;
  notifications_deleted integer := 0;
  access_logs_deleted integer := 0;
  notices_deleted integer := 0;
  relay_events_deleted integer := 0;
  relay_queue_deleted integer := 0;
begin
  if auth.role() is distinct from 'service_role' and current_user is distinct from 'service_role' then
    if current_setting('request.jwt.claim.role', true) in ('authenticated', 'anon')
      or current_user in ('authenticated', 'anon') then
      raise exception 'service role required for retention purge' using errcode = '42501';
    end if;
  end if;

  insert into public.retention_purge_runs (retention_days)
  values (90)
  returning id into run_id;

  select coalesce(pg_catalog.array_agg(swap.id), array[]::uuid[])
    into ended_swaps
  from public.swap_proposals swap
  where public.swap_retention_ended_at(swap) is not null
    and public.swap_retention_ended_at(swap) <= pg_catalog.now() - interval '90 days';

  swap_count := coalesce(pg_catalog.cardinality(ended_swaps), 0);

  perform set_config('yourturn.retention_purge', '1', true);

  delete from yourturn_private.mobile_numbers mobile
  using public.contact_consents consent
  where mobile.consent_id = consent.id
    and consent.swap_id = any (ended_swaps);
  get diagnostics mobiles_deleted = row_count;

  delete from public.contact_consent_backups backup
  using public.contact_consents consent
  where backup.consent_id = consent.id
    and consent.swap_id = any (ended_swaps);
  get diagnostics backups_deleted = row_count;

  delete from public.contact_consents consent
  where consent.swap_id = any (ended_swaps);
  get diagnostics consents_deleted = row_count;

  delete from public.swap_contact_notifications notification
  where notification.swap_id = any (ended_swaps);
  get diagnostics notifications_deleted = row_count;

  contact_count := mobiles_deleted + backups_deleted + consents_deleted + notifications_deleted;

  delete from public.school_notice_access_logs access_log
  using public.school_notices notice
  where access_log.notice_id = notice.id
    and notice.swap_id = any (ended_swaps);
  get diagnostics access_logs_deleted = row_count;

  delete from public.school_notices notice
  where notice.swap_id = any (ended_swaps);
  get diagnostics notices_deleted = row_count;

  notice_count := access_logs_deleted + notices_deleted;

  delete from public.departure_check_logs departure
  where departure.swap_id = any (ended_swaps);
  get diagnostics departure_count = row_count;

  delete from public.email_relay_delivery_events delivery
  using public.email_relay_queue queue
  where delivery.queue_id = queue.id
    and queue.swap_id = any (ended_swaps);
  get diagnostics relay_events_deleted = row_count;

  delete from public.email_relay_queue queue
  where queue.swap_id = any (ended_swaps);
  get diagnostics relay_queue_deleted = row_count;

  relay_count := relay_events_deleted + relay_queue_deleted;

  perform set_config('yourturn.retention_purge', '0', true);

  update public.retention_purge_runs
  set finished_at = pg_catalog.now(),
      swaps_considered = swap_count,
      contact_disclosures_purged = contact_count,
      notice_logs_purged = notice_count,
      departure_checks_purged = departure_count,
      email_relay_rows_purged = relay_count,
      detail = pg_catalog.jsonb_build_object(
        'mobiles', mobiles_deleted,
        'backups', backups_deleted,
        'consents', consents_deleted,
        'notifications', notifications_deleted,
        'notice_access_logs', access_logs_deleted,
        'notices', notices_deleted,
        'relay_events', relay_events_deleted,
        'relay_queue', relay_queue_deleted
      )
  where id = run_id;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), null, 'retention.purge_completed', 'retention_purge_run', run_id,
    pg_catalog.jsonb_build_object('outcome', 'completed', 'reason_code', 'retention_90d')
  );

  return pg_catalog.jsonb_build_object(
    'run_id', run_id,
    'retention_days', 90,
    'swaps_considered', swap_count,
    'contact_disclosures_purged', contact_count,
    'notice_logs_purged', notice_count,
    'departure_checks_purged', departure_count,
    'email_relay_rows_purged', relay_count
  );
end;
$$;
revoke all on function public.purge_expired_disclosure_retention()
  from public, anon, authenticated;
grant execute on function public.purge_expired_disclosure_retention() to service_role;

commit;
