-- Remediation: accept_current_consent raised SQLSTATE 42702 because the
-- PL/pgSQL variable document_id conflicted with consent_acceptances.document_id.
-- Keep consent_acceptances (not user_consents); document_id already binds a
-- specific document_type+version row. Harden search_path to pg_catalog.
begin;
set local search_path = pg_catalog;

create or replace function public.accept_current_consent(p_document_type text, p_version integer)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  accepted_document_id uuid;
begin
  if auth.uid() is null or not public.is_verified_email_user() then
    raise exception 'verified email required' using errcode = '42501';
  end if;

  select document.id
  into accepted_document_id
  from public.consent_documents as document
  where document.document_type = p_document_type
    and document.version = p_version
    and document.is_active;

  if accepted_document_id is null then
    raise exception 'current consent document not found' using errcode = 'P0002';
  end if;

  insert into public.consent_acceptances as acceptance (user_id, document_id)
  values (auth.uid(), accepted_document_id)
  on conflict (user_id, document_id) do nothing;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(),
    'consent.accepted',
    'consent_document',
    accepted_document_id,
    pg_catalog.jsonb_build_object('source', p_document_type, 'version', p_version::text)
  );
end;
$$;

revoke all on function public.accept_current_consent(text, integer) from public;
grant execute on function public.accept_current_consent(text, integer) to authenticated;

commit;
