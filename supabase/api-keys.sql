-- Public API surface for HELIOSAT clients (ROADMAP Fase 3).
-- Run this in the Supabase SQL editor after supabase/admin-profiles.sql.
--
-- Two tables, both LOCKED DOWN: RLS is enabled with NO policies, so the anon /
-- publishable key (and authenticated users) can never read or write them via
-- PostgREST. They are reached ONLY by the server using the SERVICE ROLE key, which
-- bypasses RLS. The service-role key must live server-side only (env
-- SUPABASE_SERVICE_ROLE_KEY) and never ship to the browser.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- api_keys
-- One row per issued client key. The raw key is NEVER stored: we keep the SHA-256
-- hex digest of a high-entropy random token (hashing in the app, not here). The
-- prefix is a non-secret label (e.g. "hsk_live_ab12") for identifying a key in a UI.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text,
  company text,
  key_hash text not null unique,
  key_prefix text,
  is_active boolean not null default true,
  rate_limit_per_min integer not null default 60 check (rate_limit_per_min > 0),
  -- volatile fixed-window rate-limit state (managed by consume_api_key)
  rate_window_started_at timestamptz,
  rate_window_count integer not null default 0,
  -- lifetime usage / metrics
  request_count bigint not null default 0,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists api_keys_key_hash_idx on public.api_keys (key_hash);

alter table public.api_keys enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) touches this.

drop trigger if exists set_api_keys_updated_at on public.api_keys;
create trigger set_api_keys_updated_at
before update on public.api_keys
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------- api_key_usage_daily
-- Per-key, per-UTC-day request counter for billing and abuse detection. The lifetime
-- total lives on api_keys.request_count; this is the time series. Incremented inside
-- consume_api_key so it stays consistent with what was actually authorized.
create table if not exists public.api_key_usage_daily (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  day date not null,
  request_count bigint not null default 0,
  primary key (key_id, day)
);

create index if not exists api_key_usage_daily_day_idx on public.api_key_usage_daily (day);

alter table public.api_key_usage_daily enable row level security;
-- No policies: service-role only (same as api_keys).

-- ---------------------------------------------------------------- forecast_latest
-- Precomputed "latest forecast" rows served by the public API (the cron in Fase 4
-- writes here; the API only reads). Keyed by product id so we can add products
-- later without schema changes; today there is a single 'realtime' row.
create table if not exists public.forecast_latest (
  id text primary key,
  schema_version text not null,
  payload jsonb not null,
  issued_at timestamptz not null default now(),
  observed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.forecast_latest enable row level security;
-- No policies: written by the publish job and read by the API, both via service role.

drop trigger if exists set_forecast_latest_updated_at on public.forecast_latest;
create trigger set_forecast_latest_updated_at
before update on public.forecast_latest
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------- consume_api_key
-- Atomically authenticate + rate-limit a key in one round trip. The app passes the
-- SHA-256 hex of the presented bearer token; we look the row up FOR UPDATE (so
-- concurrent requests for the same key serialize), apply a fixed 60s window, and
-- return a JSON verdict. SECURITY DEFINER + a pinned search_path; execute is
-- granted only to service_role so anon cannot brute-force it through PostgREST.
create or replace function public.consume_api_key(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.api_keys;
  window_seconds constant integer := 60;
  elapsed integer;
  remaining integer;
begin
  select * into k from public.api_keys where key_hash = p_key_hash for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'invalid');
  end if;

  if not k.is_active then
    return jsonb_build_object('allowed', false, 'reason', 'inactive');
  end if;

  if k.expires_at is not null and k.expires_at < now() then
    return jsonb_build_object('allowed', false, 'reason', 'expired');
  end if;

  -- Reset the fixed window if it is unset or has elapsed.
  if k.rate_window_started_at is null
     or now() - k.rate_window_started_at >= make_interval(secs => window_seconds) then
    k.rate_window_started_at := now();
    k.rate_window_count := 0;
  end if;

  if k.rate_window_count >= k.rate_limit_per_min then
    elapsed := floor(extract(epoch from (now() - k.rate_window_started_at)))::integer;
    -- Persist the (possibly reset) window so the clock keeps ticking.
    update public.api_keys
      set rate_window_started_at = k.rate_window_started_at,
          rate_window_count = k.rate_window_count
      where id = k.id;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limited',
      'rate_limit', k.rate_limit_per_min,
      'retry_after', greatest(window_seconds - elapsed, 1)
    );
  end if;

  k.rate_window_count := k.rate_window_count + 1;
  remaining := greatest(k.rate_limit_per_min - k.rate_window_count, 0);

  update public.api_keys
    set rate_window_started_at = k.rate_window_started_at,
        rate_window_count = k.rate_window_count,
        request_count = k.request_count + 1,
        last_used_at = now()
    where id = k.id;

  -- Per-day usage time series (billing / abuse detection).
  insert into public.api_key_usage_daily (key_id, day, request_count)
  values (k.id, (now() at time zone 'utc')::date, 1)
  on conflict (key_id, day)
    do update set request_count = public.api_key_usage_daily.request_count + 1;

  return jsonb_build_object(
    'allowed', true,
    'key_id', k.id,
    'company', k.company,
    'rate_limit', k.rate_limit_per_min,
    'remaining', remaining
  );
end;
$$;

revoke execute on function public.consume_api_key(text) from public, anon, authenticated;
grant execute on function public.consume_api_key(text) to service_role;
