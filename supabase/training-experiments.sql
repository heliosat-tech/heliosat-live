-- Training Lab experiment registry for Admin Playground.
-- Run this in the Supabase SQL editor after supabase/admin-profiles.sql.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'experiment_status'
  ) then
    create type public.experiment_status as enum (
      'draft',
      'active',
      'training',
      'completed',
      'failed',
      'archived'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'experiment_run_status'
  ) then
    create type public.experiment_run_status as enum (
      'queued',
      'running',
      'completed',
      'failed'
    );
  end if;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  status public.experiment_status not null default 'draft'::public.experiment_status,
  is_active boolean not null default false,
  config_hash text not null,
  parent_id uuid references public.experiments (id) on delete set null,
  config jsonb not null,
  constraint experiments_name_slug_check check (name ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  constraint experiments_config_hash_check check (config_hash ~ '^[a-f0-9]{64}$'),
  constraint experiments_owner_name_unique unique (owner_id, name)
);

create unique index if not exists experiments_one_active_per_owner
on public.experiments (owner_id)
where is_active;

create index if not exists experiments_owner_created_idx
on public.experiments (owner_id, created_at desc);

create index if not exists experiments_config_gin_idx
on public.experiments using gin (config);

alter table public.experiments enable row level security;

drop trigger if exists set_experiments_updated_at on public.experiments;

create trigger set_experiments_updated_at
before update on public.experiments
for each row
execute function public.set_updated_at();

create or replace function public.prevent_non_draft_experiment_config_edits()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft'::public.experiment_status then
    if new.name is distinct from old.name
      or new.description is distinct from old.description
      or new.parent_id is distinct from old.parent_id
      or new.config_hash is distinct from old.config_hash
      or new.config is distinct from old.config then
      raise exception 'Only draft experiments can change configuration fields.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_non_draft_experiment_config_edits on public.experiments;

create trigger prevent_non_draft_experiment_config_edits
before update on public.experiments
for each row
execute function public.prevent_non_draft_experiment_config_edits();

drop policy if exists "Users can read own experiments" on public.experiments;
drop policy if exists "Users can insert own experiments" on public.experiments;
drop policy if exists "Users can update own experiments" on public.experiments;

create policy "Users can read own experiments"
on public.experiments
for select
to authenticated
using (auth.uid() = owner_id);

create policy "Users can insert own experiments"
on public.experiments
for insert
to authenticated
with check (auth.uid() = owner_id);

create policy "Users can update own experiments"
on public.experiments
for update
to authenticated
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create table if not exists public.experiment_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  experiment_id uuid not null references public.experiments (id) on delete restrict,
  model_name text not null,
  status public.experiment_run_status not null default 'queued'::public.experiment_run_status,
  started_at timestamptz,
  completed_at timestamptz,
  metrics_global jsonb not null default '{}'::jsonb,
  metrics_per_fold jsonb not null default '[]'::jsonb,
  metrics_events jsonb not null default '{}'::jsonb,
  hyperparams jsonb not null default '{}'::jsonb,
  model_artifact_path text,
  feature_importance jsonb not null default '[]'::jsonb,
  n_train_samples integer,
  n_val_samples integer,
  log_uri text,
  prediction_uri text,
  score double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiment_runs'
      and column_name = 'model_key'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiment_runs'
      and column_name = 'model_name'
  ) then
    alter table public.experiment_runs rename column model_key to model_name;
  end if;
end;
$$;

alter table public.experiment_runs
add column if not exists model_name text,
add column if not exists started_at timestamptz,
add column if not exists completed_at timestamptz,
add column if not exists metrics_global jsonb not null default '{}'::jsonb,
add column if not exists metrics_per_fold jsonb not null default '[]'::jsonb,
add column if not exists metrics_events jsonb not null default '{}'::jsonb,
add column if not exists hyperparams jsonb not null default '{}'::jsonb,
add column if not exists model_artifact_path text,
add column if not exists feature_importance jsonb not null default '[]'::jsonb,
add column if not exists n_train_samples integer,
add column if not exists n_val_samples integer,
add column if not exists log_uri text,
add column if not exists prediction_uri text,
add column if not exists score double precision;

alter table public.experiment_runs
alter column model_name set not null;

create index if not exists experiment_runs_experiment_created_idx
on public.experiment_runs (experiment_id, created_at desc);

create index if not exists experiment_runs_experiment_status_idx
on public.experiment_runs (experiment_id, status, created_at desc);

alter table public.experiment_runs enable row level security;

drop trigger if exists set_experiment_runs_updated_at on public.experiment_runs;

create trigger set_experiment_runs_updated_at
before update on public.experiment_runs
for each row
execute function public.set_updated_at();

drop policy if exists "Users can read own experiment runs" on public.experiment_runs;
drop policy if exists "Users can insert own experiment runs" on public.experiment_runs;
drop policy if exists "Users can update own experiment runs" on public.experiment_runs;
drop policy if exists "Users can delete own experiment runs" on public.experiment_runs;

create policy "Users can read own experiment runs"
on public.experiment_runs
for select
to authenticated
using (auth.uid() = owner_id);

create policy "Users can insert own experiment runs"
on public.experiment_runs
for insert
to authenticated
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.experiments e
    where e.id = experiment_id
      and e.owner_id = auth.uid()
  )
);

create policy "Users can update own experiment runs"
on public.experiment_runs
for update
to authenticated
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "Users can delete own experiment runs"
on public.experiment_runs
for delete
to authenticated
using (auth.uid() = owner_id);

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  experiment_id uuid not null references public.experiments (id) on delete cascade,
  run_id uuid not null references public.experiment_runs (id) on delete cascade,
  timestamp_utc timestamptz not null,
  split text not null,
  fold integer,
  y_true double precision not null,
  y_pred double precision not null,
  residual double precision not null,
  created_at timestamptz not null default now()
);

create index if not exists predictions_run_timestamp_idx
on public.predictions (run_id, timestamp_utc);

create index if not exists predictions_experiment_run_idx
on public.predictions (experiment_id, run_id);

alter table public.predictions enable row level security;

drop policy if exists "Users can read own predictions" on public.predictions;
drop policy if exists "Users can insert own predictions" on public.predictions;
drop policy if exists "Users can delete own predictions" on public.predictions;

create policy "Users can read own predictions"
on public.predictions
for select
to authenticated
using (auth.uid() = owner_id);

create policy "Users can insert own predictions"
on public.predictions
for insert
to authenticated
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.experiment_runs r
    where r.id = run_id
      and r.owner_id = auth.uid()
      and r.experiment_id = predictions.experiment_id
  )
);

create policy "Users can delete own predictions"
on public.predictions
for delete
to authenticated
using (auth.uid() = owner_id);

create or replace function public.activate_experiment(target_experiment_id uuid)
returns public.experiments
language plpgsql
security invoker
set search_path = public
as $$
declare
  activated public.experiments;
begin
  select *
  into activated
  from public.experiments
  where id = target_experiment_id
    and owner_id = auth.uid()
  for update;

  if not found then
    raise exception 'Experiment not found.';
  end if;

  if activated.status = 'archived'::public.experiment_status then
    raise exception 'Archived experiments cannot be activated.';
  end if;

  update public.experiments
  set
    is_active = false,
    status = case
      when status = 'active'::public.experiment_status then 'archived'::public.experiment_status
      else status
    end
  where owner_id = auth.uid()
    and is_active = true
    and id <> target_experiment_id;

  update public.experiments
  set
    is_active = true,
    status = 'active'::public.experiment_status,
    activated_at = coalesce(activated_at, now())
  where id = target_experiment_id
    and owner_id = auth.uid()
  returning * into activated;

  return activated;
end;
$$;
