-- Per-user dashboard watch-list persistence for HELIOSAT Mission Control.
-- Stores the satellites a user tracks on the map plus the instruments and thresholds they
-- declared, so they survive logout / new sessions / new devices.
--
-- Run this in the Supabase SQL editor after supabase/admin-profiles.sql (which already defines
-- public.set_updated_at()). Re-run-safe.
--
-- Security model: RLS on, with policies scoped to auth.uid() = user_id, so the browser
-- (publishable/anon key) lets each authenticated user read & write ONLY their own row. No
-- service-role key is needed for this feature.

-- set_updated_at() is also created by admin-profiles.sql / api-keys.sql; included here so this
-- file is self-contained.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.dashboard_watchlists (
  -- One row per user; the PK is the auth user id.
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Tracked satellites: SatelliteTLE[] = [{ name, line1, line2, source }, ...]
  tracked jsonb not null default '[]'::jsonb,
  -- Instruments & thresholds: Record<satelliteKey, Instrument[]>
  -- where Instrument = { id, name, thresholds: [{ id, variable, comparator, value }] }
  instruments jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dashboard_watchlists enable row level security;

-- Each authenticated user can touch only their own row.
drop policy if exists "dashboard_watchlists_select_own" on public.dashboard_watchlists;
create policy "dashboard_watchlists_select_own"
  on public.dashboard_watchlists
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "dashboard_watchlists_insert_own" on public.dashboard_watchlists;
create policy "dashboard_watchlists_insert_own"
  on public.dashboard_watchlists
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "dashboard_watchlists_update_own" on public.dashboard_watchlists;
create policy "dashboard_watchlists_update_own"
  on public.dashboard_watchlists
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "dashboard_watchlists_delete_own" on public.dashboard_watchlists;
create policy "dashboard_watchlists_delete_own"
  on public.dashboard_watchlists
  for delete
  to authenticated
  using (auth.uid() = user_id);

drop trigger if exists set_dashboard_watchlists_updated_at on public.dashboard_watchlists;
create trigger set_dashboard_watchlists_updated_at
  before update on public.dashboard_watchlists
  for each row
  execute function public.set_updated_at();
