-- User profile and admin cargo support for HelioSat.
-- Run this in the Supabase SQL editor after creating the project.

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'profile_cargo'
  ) then
    create type public.profile_cargo as enum ('user', 'admin');
  end if;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  cargo public.profile_cargo not null default 'user'::public.profile_cargo,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
drop constraint if exists profiles_cargo_check;

alter table public.profiles
alter column cargo drop default;

alter table public.profiles
alter column cargo type public.profile_cargo
using case
  when cargo::text in ('user', 'admin') then cargo::text::public.profile_cargo
  else 'user'::public.profile_cargo
end;

alter table public.profiles
alter column cargo set default 'user'::public.profile_cargo;

alter table public.profiles
alter column cargo set not null;

alter table public.profiles enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;

create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, cargo)
  values (new.id, new.email, 'user'::public.profile_cargo)
  on conflict (id) do update
    set email = excluded.email;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_profile on auth.users;

create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row
execute function public.handle_new_user_profile();

insert into public.profiles (id, email, cargo)
select id, email, 'user'::public.profile_cargo
from auth.users
on conflict (id) do update
  set email = excluded.email;

drop policy if exists "Users can read own profile" on public.profiles;

create policy "Users can read own profile"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

-- Optional: after a user has signed up, promote them from the SQL editor.
-- update public.profiles
-- set cargo = 'admin'
-- where email = 'admin@example.com';
