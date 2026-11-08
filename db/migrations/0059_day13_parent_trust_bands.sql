-- Parent Trust Band (AU parent-reliability): Bronze / Silver / Gold labels on
-- marketplace and instant pickup cards, plus peer profile stats (counts only).
-- Peers never receive numeric trust_score. No money, phone or photo fields.
begin;
set local search_path = pg_catalog;

create or replace function public.parent_trust_band_label(p_band text)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case trim(coalesce(p_band, ''))
    when 'Trusted' then 'Gold Guardian'
    when 'Gold Guardian' then 'Gold Guardian'
    when 'Standard' then 'Silver Partner'
    when 'Silver Partner' then 'Silver Partner'
    when 'Suspended' then 'Suspended'
    else 'Bronze Parent'
  end
$fn$;
revoke all on function public.parent_trust_band_label(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Listing JSON: seller trust band (label only)
-- ---------------------------------------------------------------------------
create or replace function public.item_listing_json(p_listing public.item_listings)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  author_name text;
  school_name text;
  school_suburb text;
  school_sector text;
  band text;
  band_label text;
begin
  select profile.display_name into author_name
  from public.profiles as profile
  where profile.id = p_listing.author_id;
  select school.display_name, school.suburb, school.school_sector
    into school_name, school_suburb, school_sector
  from public.schools as school
  where school.id = p_listing.school_id;
  band := coalesce(public.trust_band_for_user(p_listing.author_id), 'Restricted');
  band_label := public.parent_trust_band_label(band);
  return pg_catalog.jsonb_build_object(
    'id', p_listing.id,
    'school_id', p_listing.school_id,
    'author_id', p_listing.author_id,
    'author_display_name', coalesce(author_name, 'Parent'),
    'listing_kind', p_listing.listing_kind,
    'title', p_listing.title,
    'description', p_listing.description,
    'category', p_listing.category,
    'display_offer_label', p_listing.display_offer_label,
    'status', p_listing.status,
    'created_at', p_listing.created_at,
    'schoolDisplayName', coalesce(school_name, 'Your school'),
    'schoolSuburb', coalesce(nullif(trim(coalesce(school_suburb, '')), ''), 'Local suburb'),
    'schoolSector', coalesce(school_sector, 'primary'),
    'authorTrustBand', band,
    'authorParentTrustBand', band_label
  );
end;
$fn$;
revoke all on function public.item_listing_json(public.item_listings)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Instant pickup JSON: requester trust band + suburb
-- ---------------------------------------------------------------------------
create or replace function public.instant_pickup_request_json(
  p_request public.instant_pickup_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  display_name text;
  matched_name text;
  pickup_at timestamptz;
  band text;
  band_label text;
  school_suburb text;
begin
  if auth.uid() is null or not public.is_member(p_request.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  select profile.display_name into display_name
  from public.profiles as profile
  where profile.id = p_request.requester_id;
  if p_request.matched_user_id is not null then
    select profile.display_name into matched_name
    from public.profiles as profile
    where profile.id = p_request.matched_user_id;
  end if;
  select school.suburb into school_suburb
  from public.schools as school
  where school.id = p_request.school_id;
  pickup_at := public.instant_pickup_pickup_at(p_request);
  band := coalesce(public.trust_band_for_user(p_request.requester_id), 'Restricted');
  band_label := public.parent_trust_band_label(band);
  return pg_catalog.jsonb_build_object(
    'id', p_request.id,
    'schoolId', p_request.school_id,
    'requesterId', p_request.requester_id,
    'requesterDisplayName', coalesce(display_name, 'Parent'),
    'matchedUserId', p_request.matched_user_id,
    'matchedDisplayName', matched_name,
    'intent', p_request.intent::text,
    'direction', p_request.direction::text,
    'targetDate', p_request.target_date,
    'areaLabel', p_request.area_label,
    'notes', p_request.notes,
    'status', p_request.status::text,
    'checkInStatus', p_request.check_in_status,
    'finalCheckAt', p_request.final_check_at,
    'pickupAt', pickup_at,
    'chatRoomId', p_request.chat_room_id,
    'mine', p_request.requester_id = auth.uid(),
    'iAmMatched', p_request.matched_user_id = auth.uid(),
    'createdAt', p_request.created_at,
    'schoolSuburb', coalesce(nullif(trim(coalesce(school_suburb, '')), ''), p_request.area_label),
    'requesterTrustBand', band,
    'requesterParentTrustBand', band_label
  );
end;
$fn$;
revoke all on function public.instant_pickup_request_json(public.instant_pickup_requests)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Peer profile: band + reliability counts (no numeric score)
-- ---------------------------------------------------------------------------
create or replace function public.get_peer_parent_trust_profile(p_peer_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  shared_school uuid;
  band text;
  band_label text;
  peer_name text;
  school_suburb text;
  verified boolean := false;
  pickups integer := 0;
  relays integer := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_peer_user_id is null then
    raise exception 'peer parent required' using errcode = '22023';
  end if;

  select membership.school_id into shared_school
  from public.school_memberships as membership
  where membership.user_id = auth.uid()
    and membership.status = 'verified'
    and public.is_member(membership.school_id)
    and exists (
      select 1 from public.school_memberships as peer
      where peer.school_id = membership.school_id
        and peer.user_id = p_peer_user_id
        and peer.status = 'verified'
        and public.is_member(peer.school_id)
    )
  order by membership.created_at, membership.id
  limit 1;

  if shared_school is null then
    raise exception 'verified same-school peer required' using errcode = '42501';
  end if;

  select profile.display_name into peer_name
  from public.profiles as profile
  where profile.id = p_peer_user_id;
  if peer_name is null then
    raise exception 'peer profile unavailable' using errcode = 'P0002';
  end if;

  select school.suburb into school_suburb
  from public.schools as school
  where school.id = shared_school;

  verified := true;
  band := coalesce(public.trust_band_for_user(p_peer_user_id), 'Restricted');
  band_label := public.parent_trust_band_label(band);

  select pg_catalog.count(*)::integer into pickups
  from public.trust_score_events as event
  where event.subject_user_id = p_peer_user_id
    and event.school_id = shared_school
    and event.reason_code in ('completed_trip', 'urgent_cover');

  select pg_catalog.count(*)::integer into relays
  from public.item_listings as listing
  where listing.author_id = p_peer_user_id
    and listing.school_id = shared_school
    and listing.status in ('fulfilled', 'collected')
    and listing.listing_kind in ('giveaway', 'lending', 'sale', 'swap');

  return pg_catalog.jsonb_build_object(
    'peerUserId', p_peer_user_id,
    'displayName', peer_name,
    'trustBand', band,
    'parentTrustBand', band_label,
    'schoolSuburb', coalesce(nullif(trim(coalesce(school_suburb, '')), ''), 'Local suburb'),
    'verifiedSchool', verified,
    'successfulPickups', coalesce(pickups, 0),
    'communityRelayShares', coalesce(relays, 0)
  );
end;
$fn$;
revoke all on function public.get_peer_parent_trust_profile(uuid)
  from public, anon, authenticated;
grant execute on function public.get_peer_parent_trust_profile(uuid) to authenticated;

-- Keep legacy peer band RPC; add AU label without exposing score.
create or replace function public.get_peer_trust_band(p_peer_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  shared_school uuid;
  band text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_peer_user_id is null or p_peer_user_id = auth.uid() then
    raise exception 'peer trust band requires another school member' using errcode = '22023';
  end if;
  select membership.school_id into shared_school
  from public.school_memberships as membership
  where membership.user_id = auth.uid()
    and membership.status = 'verified'
    and public.is_member(membership.school_id)
    and exists (
      select 1 from public.school_memberships as peer
      where peer.school_id = membership.school_id
        and peer.user_id = p_peer_user_id
        and peer.status = 'verified'
        and public.is_member(peer.school_id)
    )
  order by membership.created_at, membership.id
  limit 1;
  if shared_school is null then
    raise exception 'verified same-school peer required' using errcode = '42501';
  end if;
  band := public.trust_band_for_user(p_peer_user_id);
  if band is null then
    raise exception 'peer profile unavailable' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object(
    'trust_band', band,
    'parentTrustBand', public.parent_trust_band_label(band)
  );
end;
$fn$;
revoke all on function public.get_peer_trust_band(uuid) from public, anon, authenticated;
grant execute on function public.get_peer_trust_band(uuid) to authenticated;

commit;
