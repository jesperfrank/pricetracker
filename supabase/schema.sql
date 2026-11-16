-- Prisvagten - database schema for Supabase.
-- Run the whole file in the Supabase SQL editor. Safe to run more than once.

-- ---------------------------------------------------------------- tables

create table if not exists public.allowed_emails (
  email    text primary key check (email = lower(email)),
  note     text,
  added_at timestamptz default now()
);

create table if not exists public.profiles (
  user_id      uuid primary key default auth.uid() references auth.users on delete cascade,
  shops_always text[] default '{}',
  shops_exclude text[] default '{}',
  shops_only   boolean default false,
  notify_email boolean default true,
  sound        text default 'jubel' check (sound is null or char_length(sound) <= 40),
  created_at   timestamptz default now(),
  constraint profiles_shops_len check (
    coalesce(cardinality(shops_always), 0) <= 100 and coalesce(cardinality(shops_exclude), 0) <= 100)
);

create table if not exists public.products (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  -- written by the user
  name            text not null check (char_length(name) between 1 and 140),
  source_url      text check (source_url is null or (char_length(source_url) <= 500 and source_url ~ '^https://(www\.)?prisjagt\.dk/')),
  target_type     text not null check (target_type in ('price', 'pct')),
  target_value    numeric not null check (target_value > 0 and (target_type <> 'pct' or target_value < 100)),
  tracked_variants text[] check (tracked_variants is null or cardinality(tracked_variants) <= 200),
  shops_always    text[] default '{}',
  shops_exclude   text[] default '{}',
  shops_only      boolean default false,
  active          boolean default true,
  created_at      timestamptz default now(),
  -- written by the job (service role) only
  status          text not null default 'pending' check (status in ('pending', 'choose', 'tracking', 'error')),
  title           text,
  variants        jsonb,
  offers          jsonb,
  history         jsonb,
  normal_price    numeric,
  verdict         jsonb,
  warning         text,
  check_note      text,
  last_checked    timestamptz,
  notified_price  numeric,
  notified_at     timestamptz,
  constraint products_shops_len check (
    coalesce(cardinality(shops_always), 0) <= 100 and coalesce(cardinality(shops_exclude), 0) <= 100)
);

create index if not exists products_user_idx on public.products (user_id);
create index if not exists products_job_idx on public.products (status) where active;

-- ---------------------------------------------------------------- is_allowed()

create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated, service_role;

-- ---------------------------------------------------------------- row level security

alter table public.allowed_emails enable row level security;
alter table public.profiles       enable row level security;
alter table public.products       enable row level security;

-- allowed_emails: no policy at all for normal users (the owner edits it in the table editor,
-- the service role bypasses RLS). Also take away the table privileges.
revoke all on public.allowed_emails from anon, authenticated;
revoke all on public.profiles, public.products from anon;

drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles
  for all to authenticated
  using ((select auth.uid()) = user_id and public.is_allowed())
  with check ((select auth.uid()) = user_id and public.is_allowed());

drop policy if exists products_own on public.products;
create policy products_own on public.products
  for all to authenticated
  using ((select auth.uid()) = user_id and public.is_allowed())
  with check ((select auth.uid()) = user_id and public.is_allowed());

grant select, insert, update, delete on public.profiles, public.products to authenticated;

-- ---------------------------------------------------------------- triggers on products

-- A normal (browser) user can neither set the job-written columns nor change user_id.
-- Roles 'authenticated' and 'anon' are the PostgREST roles of browser requests; the service role
-- (the job) and the SQL editor / table editor (postgres) are not restricted.
-- Changing source_url starts the product over: the job fetches the new page from scratch.
create or replace function public.products_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  restricted boolean := current_user in ('authenticated', 'anon');
begin
  if not restricted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.title := null; new.variants := null; new.offers := null; new.history := null;
    new.normal_price := null; new.verdict := null; new.warning := null; new.check_note := null;
    new.last_checked := null; new.notified_price := null; new.notified_at := null;
    return new;
  end if;

  -- UPDATE
  new.user_id := old.user_id;
  new.status := old.status;
  new.title := old.title; new.variants := old.variants; new.offers := old.offers; new.history := old.history;
  new.normal_price := old.normal_price; new.verdict := old.verdict; new.warning := old.warning;
  new.check_note := old.check_note; new.last_checked := old.last_checked;
  new.notified_price := old.notified_price; new.notified_at := old.notified_at;

  if new.source_url is distinct from old.source_url then
    new.status := 'pending';
    new.tracked_variants := null;
    new.title := null; new.variants := null; new.offers := null; new.history := null;
    new.normal_price := null; new.verdict := null; new.warning := null; new.check_note := null;
    new.last_checked := null; new.notified_price := null; new.notified_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists products_guard_trg on public.products;
create trigger products_guard_trg
  before insert or update on public.products
  for each row execute function public.products_guard();

-- At most 40 products per user.
create or replace function public.products_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.products where user_id = new.user_id) >= 40 then
    raise exception 'Du kan højst følge 40 produkter. Slet et produkt først.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists products_limit_trg on public.products;
create trigger products_limit_trg
  before insert on public.products
  for each row execute function public.products_limit();

-- ---------------------------------------------------------------- auth hook: Before User Created
-- Rejects sign-ups (first magic-link login) from e-mail addresses that are not in allowed_emails.
-- Enable it in the dashboard (see docs/SETUP.md). RLS above is the real protection even if the
-- hook is not enabled or its signature changes: a user who is not in allowed_emails can log in
-- but can neither read nor write anything.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  addr text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if addr <> '' and exists (select 1 from public.allowed_emails where email = addr) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'Denne e-mailadresse er ikke inviteret.',
      'http_code', 403));
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public;
