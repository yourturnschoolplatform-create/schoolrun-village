-- Phase 1 AU location: suburb + primary/secondary sector on schools.
-- Suburb-only labels. No street address, coordinates or phone fields.
begin;
set local search_path = pg_catalog;

alter table public.schools
  add column if not exists suburb text;

alter table public.schools
  add column if not exists school_sector text;

do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'schools_suburb_check'
  ) then
    alter table public.schools
      add constraint schools_suburb_check
      check (
        suburb is null
        or (
          char_length(trim(suburb)) between 2 and 64
          and public.is_suburb_area_label(suburb)
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'schools_school_sector_check'
  ) then
    alter table public.schools
      add constraint schools_school_sector_check
      check (
        school_sector is null
        or school_sector in ('primary', 'secondary')
      );
  end if;
end;
$do$;

comment on column public.schools.suburb is
  'Australian suburb-level label only. Never street, unit, map pin or coordinates.';
comment on column public.schools.school_sector is
  'primary or secondary for Australian school badges.';

update public.schools
set
  suburb = 'Harbourview',
  school_sector = 'primary',
  updated_at = pg_catalog.now()
where slug = 'sample-harbourview-primary'
  and (suburb is null or school_sector is null);

update public.schools
set
  suburb = 'Rivergum',
  school_sector = 'primary',
  updated_at = pg_catalog.now()
where slug = 'sample-rivergum-primary'
  and (suburb is null or school_sector is null);

-- Optional Chatswood secondary sample for AU badge demos (idempotent by slug).
insert into public.schools (slug, display_name, timezone, suburb, school_sector)
values (
  'sample-chatswood-high',
  'Chatswood High School',
  'Australia/Sydney',
  'Chatswood',
  'secondary'
)
on conflict (slug) do update
set
  display_name = excluded.display_name,
  suburb = excluded.suburb,
  school_sector = excluded.school_sector,
  updated_at = pg_catalog.now();

insert into public.school_configs (school_id, matching_window_minutes, strict_reciprocity_default, allow_different_date_reciprocity)
select id, 15, true, true from public.schools
where slug = 'sample-chatswood-high'
on conflict (school_id) do nothing;

commit;
