-- Tighten SECURITY DEFINER search_path. Keep pg_catalog-only where already set.
-- Upgrade bare public or pg_catalog, public, extensions to pg_catalog, public.
-- Extension calls remain schema-qualified (extensions.*); unqualified-extension
-- catalogue checks must stay empty after this change.
begin;
set local search_path = pg_catalog;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature,
      (select substr(setting, 13)
       from unnest(coalesce(p.proconfig, array[]::text[])) as setting
       where setting like 'search_path=%'
       limit 1) as path
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    if f.path is null
      or f.path = 'public'
      or f.path = 'pg_catalog, public, extensions'
      or (f.path is distinct from 'pg_catalog' and f.path is distinct from 'pg_catalog, public') then
      execute format('alter function %s set search_path = pg_catalog, public', f.signature);
    end if;
  end loop;
end $$;

commit;
