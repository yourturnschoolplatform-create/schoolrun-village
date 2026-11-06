begin;
do $$ declare f record; begin
  for f in select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef loop
    execute format('alter function %s set search_path = pg_catalog, public, extensions', f.signature);
  end loop;
end $$;
commit;
