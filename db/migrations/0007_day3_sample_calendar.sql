-- Day 3 development/demo calendar data. This uses only sample schools and
-- creates a visible one-day sample closure one week after this migration runs.

begin;

insert into public.school_calendar_periods (school_id, period_type, label, starts_on, ends_on)
select id, 'term', 'Sample current term', current_date - 14, current_date + 90
from public.schools
where slug in ('sample-harbourview-primary', 'sample-rivergum-primary')
on conflict do nothing;

insert into public.school_calendar_periods (school_id, period_type, label, starts_on, ends_on)
select id, 'holiday', 'Sample school closure', current_date + 7, current_date + 7
from public.schools
where slug in ('sample-harbourview-primary', 'sample-rivergum-primary')
on conflict do nothing;

commit;
