-- Align open_school_invitation with claim_school_invitation availability rules.
-- Previously open returned 'opened' for revoked/expired/already-joined-by-other
-- rows while claim raised P0002, which surfaced as foundation_server_error.
begin;
set local search_path = pg_catalog;

create or replace function public.open_school_invitation(p_token text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  invitation public.school_invitations%rowtype;
begin
  select row_invitation.*
  into invitation
  from public.school_invitations as row_invitation
  where row_invitation.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and row_invitation.expires_at > pg_catalog.now()
  for update;

  if invitation.id is null
    or invitation.status in ('expired', 'revoked') then
    return 'unavailable';
  end if;

  -- Already consumed by someone else: do not pretend the link is openable.
  if invitation.status in ('joined', 'approved')
    and invitation.joined_by is distinct from auth.uid() then
    return 'unavailable';
  end if;

  update public.school_invitations as row_invitation
  set status = case when row_invitation.status = 'sent' then 'opened' else row_invitation.status end,
      opened_at = coalesce(row_invitation.opened_at, pg_catalog.now())
  where row_invitation.id = invitation.id;

  return 'opened';
end;
$$;

revoke all on function public.open_school_invitation(text) from public, anon, authenticated;
grant execute on function public.open_school_invitation(text) to authenticated;

commit;
