-- Prisvagten - database schema for Supabase.
-- Run the whole file in the Supabase SQL editor. Safe to run more than once.

-- ---------------------------------------------------------------- tables

create table if not exists public.allowed_emails (
  email    text primary key check (email = lower(email)),
  note     text,
  added_at timestamptz default now()
);
-- Added later (access requests): the owner is an admin and decides on requests. Re-runnable.
alter table public.allowed_emails add column if not exists is_admin boolean not null default false;

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
  source_url      text,
  -- the goal: see products_target_* below ('auto' = no goal, notify on a genuinely good deal)
  target_type     text not null,
  target_value    numeric,
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
  backfill_state  jsonb,
  constraint products_shops_len check (
    coalesce(cardinality(shops_always), 0) <= 100 and coalesce(cardinality(shops_exclude), 0) <= 100)
);

-- Older prices from the Internet Archive are fetched once per single-shop product. The job records the attempt here
-- ({at, result: 'done' | 'retry', found, tries}); null = not attempted. Written by the job only (see products_guard).
alter table public.products add column if not exists backfill_state jsonb;

-- A product may be added by name only (source_url null); the name must then not be blank.
-- NOT VALID: enforced for every new/changed row without re-checking old rows.
alter table public.products drop constraint if exists products_name_not_blank;
alter table public.products add constraint products_name_not_blank check (btrim(name) <> '') not valid;

-- The goal. target_type 'price' (a price in kr.) or 'pct' (a discount in %) needs a target_value; 'auto' means no goal of
-- the user's own (notify on a good deal) and has target_value null. Older databases have unnamed inline checks and
-- target_value NOT NULL: every check that mentions the goal columns is dropped (whatever it is called) and the two named
-- checks are added again, so this is safe to re-run. Existing price/pct rows satisfy the new checks as they are.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.products'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ~ 'target_(type|value)'
  loop
    execute format('alter table public.products drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.products alter column target_value drop not null;
alter table public.products add constraint products_target_type_check check (target_type in ('price', 'pct', 'auto'));
alter table public.products add constraint products_target_value_check check (
  (target_type = 'auto' and target_value is null)
  or (target_type in ('price', 'pct') and target_value is not null and target_value > 0 and (target_type <> 'pct' or target_value < 100)));

-- source_url: a prisjagt.dk page (many shops) or the product page of a single web shop. Any https:// link whose
-- host contains a dot (no user:password@, no port, no spaces), at most 500 characters. The job guards again before fetching.
-- Dropped and re-added by name so the live database (which has the older prisjagt.dk-only check) is updated safely.
alter table public.products drop constraint if exists products_source_url_check;
alter table public.products add constraint products_source_url_check check (
  source_url is null or (char_length(source_url) <= 500 and source_url ~ '^https://[^/?#@:[:space:]]+\.[^/?#@:[:space:]]+([/?#][^[:space:]]*)?$'));

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
-- The price job signs in with the service key. Newer Supabase projects do not grant table rights by default, so state them.
grant select, insert, update, delete on public.allowed_emails, public.profiles, public.products to service_role;

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
    new.last_checked := null; new.notified_price := null; new.notified_at := null; new.backfill_state := null;
    return new;
  end if;

  -- UPDATE
  new.user_id := old.user_id;
  new.status := old.status;
  new.title := old.title; new.variants := old.variants; new.offers := old.offers; new.history := old.history;
  new.normal_price := old.normal_price; new.verdict := old.verdict; new.warning := old.warning;
  new.check_note := old.check_note; new.last_checked := old.last_checked;
  new.notified_price := old.notified_price; new.notified_at := old.notified_at; new.backfill_state := old.backfill_state;

  if new.source_url is distinct from old.source_url then
    new.status := 'pending';
    new.tracked_variants := null;
    new.title := null; new.variants := null; new.offers := null; new.history := null;
    new.normal_price := null; new.verdict := null; new.warning := null; new.check_note := null;
    new.last_checked := null; new.notified_price := null; new.notified_at := null; new.backfill_state := null;
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

-- ---------------------------------------------------------------- lists
-- A person can split what they track into named lists (fx "Elektronik"). A product belongs to at most one list
-- (products.list_id, null = no list). Deleting a list keeps its products: they just lose the list.

create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  created_at timestamptz default now()
);
-- One name per person, ignoring case (names are trimmed by lists_guard below).
create unique index if not exists lists_user_name_key on public.lists (user_id, lower(name));

alter table public.products add column if not exists list_id uuid references public.lists(id) on delete set null;
create index if not exists products_list_idx on public.products (list_id);

alter table public.lists enable row level security;
revoke all on public.lists from anon;

drop policy if exists lists_own on public.lists;
create policy lists_own on public.lists
  for all to authenticated
  using ((select auth.uid()) = user_id and public.is_allowed())
  with check ((select auth.uid()) = user_id and public.is_allowed());

grant select, insert, update, delete on public.lists to authenticated;
grant select, insert, update, delete on public.lists to service_role;

-- Trims the name (every role), and keeps a browser user from moving a list to someone else.
create or replace function public.lists_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon') then
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists lists_guard_trg on public.lists;
create trigger lists_guard_trg
  before insert or update on public.lists
  for each row execute function public.lists_guard();

-- At most 30 lists per user.
create or replace function public.lists_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.lists where user_id = new.user_id) >= 30 then
    raise exception 'Du kan højst have 30 lister. Slet en liste først.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists lists_limit_trg on public.lists;
create trigger lists_limit_trg
  before insert on public.lists
  for each row execute function public.lists_limit();

-- A product may only point at one of its owner's own lists (checked for every role, the job and the SQL editor included).
-- SECURITY DEFINER so the check does not depend on the caller's row level security.
create or replace function public.products_list_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.list_id is not null
     and not exists (select 1 from public.lists l where l.id = new.list_id and l.user_id = new.user_id) then
    raise exception 'Listen findes ikke.' using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists products_list_check_trg on public.products;
create trigger products_list_check_trg
  before insert or update of list_id, user_id on public.products
  for each row execute function public.products_list_check();

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

-- ---------------------------------------------------------------- name lookup: resolver functions
-- A user can add a product by name only (source_url null, status 'pending'). An external assistant
-- (no service key!) finds the prisjagt.dk page and writes the link back through the three functions
-- below, called over PostgREST (/rest/v1/rpc/...) with the publishable key in "apikey" and a secret
-- in the HTTP header "x-resolver-token". The secret lives in resolver_secret; nobody but the
-- SECURITY DEFINER functions (owner = the role that runs this file) can read it.
--
-- How they coexist with products_guard(): the guard restricts only when current_user is
-- 'authenticated' or 'anon'. Inside a SECURITY DEFINER function current_user is the function owner,
-- so the guard lets these functions write status/check_note/source_url, while a browser user's own
-- UPDATE (current_user = authenticated) is still restricted exactly as before. No flag, no change
-- to the guard. The functions themselves only touch a pending product without link, and only
-- the columns listed below.

create table if not exists public.resolver_secret (
  token      text primary key check (char_length(token) >= 32),
  created_at timestamptz default now()
);
alter table public.resolver_secret enable row level security;     -- and no policy: no access via the API
revoke all on public.resolver_secret from public, anon, authenticated;
grant select, insert, update, delete on public.resolver_secret to service_role;

-- First run only: one random token (two v4 UUIDs = 64 hex chars from the server's CSPRNG;
-- gen_random_uuid() is built into Postgres 13+, so no pgcrypto/search_path dependency).
insert into public.resolver_secret (token)
select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
where not exists (select 1 from public.resolver_secret);

-- True when the request header x-resolver-token (PostgREST lower-cases header names) matches a stored token.
create or replace function public.resolver_token_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  h text;
begin
  begin
    h := (current_setting('request.headers', true)::json) ->> 'x-resolver-token';
  exception when others then
    return false;
  end;
  if h is null or h = '' then
    return false;
  end if;
  return exists (select 1 from public.resolver_secret where token = h);
end;
$$;
revoke all on function public.resolver_token_ok() from public, anon, authenticated;

-- Up to 20 products with a name but no link yet, oldest first. No user ids, no e-mails.
create or replace function public.resolver_list()
returns table (id uuid, name text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.resolver_token_ok() then
    raise exception 'resolver: invalid or missing token' using errcode = '42501';
  end if;
  return query
    select p.id, p.name, p.created_at
    from public.products p
    where p.active and p.source_url is null and p.status = 'pending'
    order by p.created_at, p.id
    limit 20;
end;
$$;

-- Writes the link for a product that is still name-only and pending. Status stays 'pending', so the
-- price job does its normal first fetch. Accepted: any https link that passes the same rule as the
-- products.source_url check (host with a dot, no port, no user:password@, no spaces, at most 500 characters),
-- so a prisjagt.dk page or the product page of one web shop. A leading www. on prisjagt.dk is dropped.
-- Returns true when the product was updated, false when it is no longer in that state.
create or replace function public.resolver_set(p_id uuid, p_url text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u text := btrim(coalesce(p_url, ''));
  n integer;
begin
  if not public.resolver_token_ok() then
    raise exception 'resolver: invalid or missing token' using errcode = '42501';
  end if;
  u := regexp_replace(u, '^https://www\.prisjagt\.dk/', 'https://prisjagt.dk/');
  if char_length(u) > 500 or u !~ '^https://[^/?#@:[:space:]]+\.[^/?#@:[:space:]]+([/?#][^[:space:]]*)?$' then
    raise exception 'resolver: not a usable https link' using errcode = '22023';
  end if;
  update public.products
     set source_url = u, check_note = null
   where id = p_id and active and source_url is null and status = 'pending';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- Marks a still name-only pending product as failed (the user sees the note and can paste a link).
create or replace function public.resolver_fail(p_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if not public.resolver_token_ok() then
    raise exception 'resolver: invalid or missing token' using errcode = '42501';
  end if;
  update public.products
     set status = 'error', check_note = nullif(left(btrim(coalesce(p_note, '')), 200), '')
   where id = p_id and active and source_url is null and status = 'pending';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.resolver_list() from public;
revoke all on function public.resolver_set(uuid, text) from public;
revoke all on function public.resolver_fail(uuid, text) from public;
grant execute on function public.resolver_list() to anon, authenticated;
grant execute on function public.resolver_set(uuid, text) to anon, authenticated;
grant execute on function public.resolver_fail(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------- access requests
-- A visitor asks for access on the login screen (request_access, callable without login). The owner
-- (an admin row in allowed_emails) approves or rejects inside the site. Approving inserts the address
-- into allowed_emails, so the Before User Created hook and RLS above let the person in. The price job
-- (service role) sends the e-mails: owner_notified_at / requester_notified_at record that it has.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.allowed_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', '')) and a.is_admin
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

create table if not exists public.access_requests (
  email               text primary key check (email = lower(email) and char_length(email) <= 200),
  name                text check (name is null or char_length(name) <= 80),
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at          timestamptz default now(),
  decided_at          timestamptz,
  owner_notified_at   timestamptz,
  requester_notified_at timestamptz
);
alter table public.access_requests enable row level security;      -- and no policy: only the functions below and the service role
revoke all on public.access_requests from public, anon, authenticated;
grant select, insert, update, delete on public.access_requests to service_role;

-- Returns 'requested' | 'pending' | 'allowed' | 'rejected' | 'full' | 'invalid'. Never raises on bad input.
create or replace function public.request_access(p_email text, p_name text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e  text := lower(btrim(coalesce(p_email, '')));
  n  text := nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), 80), '');
  st text;
  k  integer;
begin
  if char_length(e) > 200 or e !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$' then
    return 'invalid';
  end if;
  if exists (select 1 from public.allowed_emails a where a.email = e) then
    return 'allowed';
  end if;
  select r.status into st from public.access_requests r where r.email = e;
  if st = 'pending' then return 'pending'; end if;
  if st = 'rejected' then return 'rejected'; end if;
  if (select count(*) from public.access_requests r where r.status = 'pending') >= 30 then
    return 'full';
  end if;
  if st = 'approved' then
    -- approved earlier, but the address is no longer in allowed_emails (access was removed): ask again
    update public.access_requests
       set status = 'pending', name = coalesce(n, name), created_at = now(), decided_at = null,
           owner_notified_at = null, requester_notified_at = null
     where email = e;
    return 'requested';
  end if;
  insert into public.access_requests (email, name) values (e, n) on conflict (email) do nothing;
  get diagnostics k = row_count;
  if k = 0 then   -- a parallel request for the same address won the race
    return 'pending';
  end if;
  return 'requested';
end;
$$;
revoke all on function public.request_access(text, text) from public;
grant execute on function public.request_access(text, text) to anon, authenticated, service_role;

-- Admin-only functions: anyone else gets SQLSTATE 42501.
create or replace function public.admin_list_requests()
returns table (email text, name text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select r.email, r.name, r.created_at
    from public.access_requests r
    where r.status = 'pending'
    order by r.created_at, r.email
    limit 50;
end;
$$;

-- Approve (inserts the address into allowed_emails) or reject a request. A rejected request can be approved later.
-- Returns true when a request was changed.
create or replace function public.admin_decide(p_email text, p_approve boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  rn text;
  k  integer;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_approve is null then return false; end if;
  if p_approve then
    update public.access_requests r
       set status = 'approved', decided_at = now()
     where r.email = e and r.status in ('pending', 'rejected')
    returning r.name into rn;
    get diagnostics k = row_count;
    if k = 0 then return false; end if;
    insert into public.allowed_emails (email, note)
    values (e, 'Godkendt via adgangsanmodning' || coalesce(' (' || rn || ')', ''))
    on conflict (email) do nothing;
    return true;
  end if;
  update public.access_requests r
     set status = 'rejected', decided_at = now()
   where r.email = e and r.status = 'pending';
  get diagnostics k = row_count;
  return k = 1;
end;
$$;

create or replace function public.admin_list_allowed()
returns table (email text, note text, added_at timestamptz, is_admin boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select a.email, a.note, a.added_at, a.is_admin
    from public.allowed_emails a
    order by a.is_admin desc, a.added_at, a.email;
end;
$$;

-- Removes a non-admin address. Only stops future access: the person's products stay stored. Never removes an admin row.
create or replace function public.admin_remove_allowed(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k integer;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.allowed_emails a
   where a.email = lower(btrim(coalesce(p_email, ''))) and not a.is_admin;
  get diagnostics k = row_count;
  return k = 1;
end;
$$;

revoke all on function public.admin_list_requests() from public, anon;
revoke all on function public.admin_decide(text, boolean) from public, anon;
revoke all on function public.admin_list_allowed() from public, anon;
revoke all on function public.admin_remove_allowed(text) from public, anon;
grant execute on function public.admin_list_requests() to authenticated;
grant execute on function public.admin_decide(text, boolean) to authenticated;
grant execute on function public.admin_list_allowed() to authenticated;
grant execute on function public.admin_remove_allowed(text) to authenticated;

-- First run only: nobody is admin yet, so the address added first (the owner added themselves first) becomes admin.
-- Later runs change nothing, so admin never moves.
update public.allowed_emails
   set is_admin = true
 where email = (select a.email from public.allowed_emails a order by a.added_at asc nulls last, a.email limit 1)
   and not exists (select 1 from public.allowed_emails x where x.is_admin);

-- Shows the token (copy it from the result of this last query; see docs/SETUP.md).
select token as resolver_token_copy_this from public.resolver_secret;
