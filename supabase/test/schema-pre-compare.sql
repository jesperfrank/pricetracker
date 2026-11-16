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

-- The one morning mail (opt-in, written by the person). digest_sent_at = when the job last claimed a morning mail for this
-- person (job only: see profiles_guard). Added later, re-runnable.
alter table public.profiles add column if not exists mail_digest boolean not null default false;
alter table public.profiles add column if not exists digest_sent_at timestamptz;

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

-- Bought products (the person's own marking, written from the browser): when, and at what price (kr.). A bought product
-- stays in its list; the job never sends mails for it. bought_at is set by the server clock (see products_guard).
alter table public.products add column if not exists bought_at timestamptz;
alter table public.products add column if not exists bought_price numeric;
-- Who marked it as bought (a member of a shared list may do it, see "sharing" below). Set by products_guard only, never written directly.
alter table public.products add column if not exists bought_by uuid references auth.users(id) on delete set null;
alter table public.products drop constraint if exists products_bought_price_check;
alter table public.products add constraint products_bought_price_check check (
  bought_price is null or (bought_at is not null and bought_price > 0 and bought_price <= 10000000));

-- One morning mail (profiles.mail_digest): a goal hit is collected instead of mailed at once. digest_price = the price that
-- triggered the hit, digest_at = when it was collected. Written by the job only (see products_guard).
alter table public.products add column if not exists digest_price numeric;
alter table public.products add column if not exists digest_at timestamptz;

-- "Alternativer" (see "alternatives" below): similar products and deals in the same category, answered by the AI agent.
-- alt_requested_at = when the person asked (browser, but stamped with the server clock by products_guard); alternatives,
-- alt_done_at and alt_note are written by the AI agent's functions only. Pending = requested and not answered since.
alter table public.products add column if not exists alt_requested_at timestamptz;
alter table public.products add column if not exists alternatives jsonb
  check (alternatives is null or (case when jsonb_typeof(alternatives) = 'array' then jsonb_array_length(alternatives) <= 6 else false end));
alter table public.products add column if not exists alt_done_at timestamptz;
alter table public.products add column if not exists alt_note text check (alt_note is null or char_length(alt_note) <= 200);

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

-- products: the policies are in the sharing section below (they need the list helper functions).

grant select, insert, update, delete on public.profiles, public.products to authenticated;
-- The price job signs in with the service key. Newer Supabase projects do not grant table rights by default, so state them.
grant select, insert, update, delete on public.allowed_emails, public.profiles, public.products to service_role;

-- ---------------------------------------------------------------- triggers on products

-- A normal (browser) user can neither set the job-written columns nor change user_id.
-- Roles 'authenticated' and 'anon' are the PostgREST roles of browser requests; the service role
-- (the job) and the SQL editor / table editor (postgres) are not restricted.
-- Changing source_url starts the product over: the job fetches the new page from scratch (alternatives are dropped with it).
-- Someone else's product in a shared list (RLS lets list members this far): only the bought columns may change, every other
-- column must be exactly as it was (compared as a whole row, so a column added later is protected too). A bought mark is
-- stamped with the server time and with who set it (bought_by). It can be undone, or its price edited, by the person who set it,
-- by the product's owner and by the list's owner; a bought mark cannot be taken over by someone else.
create or replace function public.products_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  restricted boolean := current_user in ('authenticated', 'anon');
  uid uuid := auth.uid();
  may_edit_bought boolean;
begin
  if not restricted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.title := null; new.variants := null; new.offers := null; new.history := null;
    new.normal_price := null; new.verdict := null; new.warning := null; new.check_note := null;
    new.last_checked := null; new.notified_price := null; new.notified_at := null; new.backfill_state := null;
    new.digest_price := null; new.digest_at := null;
    new.alt_requested_at := null; new.alternatives := null; new.alt_done_at := null; new.alt_note := null;
    -- bought_at / bought_price are the person's own, but the time is the server's and the person is who is signed in
    new.bought_by := null;
    if new.bought_at is not null then new.bought_at := now(); new.bought_by := uid; end if;
    return new;
  end if;

  -- UPDATE
  may_edit_bought := old.user_id = uid or old.bought_by = uid or (old.list_id is not null and public.owns_list(old.list_id));
  if old.user_id is distinct from uid then
    if (to_jsonb(new) - 'bought_at' - 'bought_price' - 'bought_by') is distinct from (to_jsonb(old) - 'bought_at' - 'bought_price' - 'bought_by') then
      raise exception 'Kun den, der har tilføjet produktet, kan ændre det.' using errcode = 'check_violation';
    end if;
  end if;
  new.user_id := old.user_id;
  new.status := old.status;
  new.title := old.title; new.variants := old.variants; new.offers := old.offers; new.history := old.history;
  new.normal_price := old.normal_price; new.verdict := old.verdict; new.warning := old.warning;
  new.check_note := old.check_note; new.last_checked := old.last_checked;
  new.notified_price := old.notified_price; new.notified_at := old.notified_at; new.backfill_state := old.backfill_state;
  new.digest_price := old.digest_price; new.digest_at := old.digest_at;
  -- alternatives: the answer is the AI agent's. A request is a change of alt_requested_at (only the product's own person gets this
  -- far: a list member changing it fails the whole-row check above). Whatever value the browser sends, the time is the server's;
  -- null is ignored. Refused while a request is pending (unless it is over 6 hours old: the page calls that failed), and after 5
  -- requests in 24 hours (alt_take_slot).
  new.alternatives := old.alternatives; new.alt_done_at := old.alt_done_at; new.alt_note := old.alt_note;
  if new.alt_requested_at is distinct from old.alt_requested_at then
    if new.alt_requested_at is null then
      new.alt_requested_at := old.alt_requested_at;
    else
      if old.alt_requested_at is not null and (old.alt_done_at is null or old.alt_done_at < old.alt_requested_at)
         and old.alt_requested_at > now() - interval '6 hours' then
        raise exception 'Der er allerede bedt om alternativer. Vent på svaret.' using errcode = 'check_violation';
      end if;
      perform public.alt_take_slot();
      new.alt_requested_at := now();
    end if;
  end if;
  -- bought: marking stamps the server time and the person once; the time and the person cannot be edited afterwards
  -- (only cleared, which also clears the price)
  if old.bought_at is null then
    if new.bought_at is not null then new.bought_at := now(); new.bought_by := uid; else new.bought_by := null; end if;
  elsif new.bought_at is null then
    if not may_edit_bought then
      raise exception 'Kun den, der har markeret produktet som købt, kan fortryde.' using errcode = 'check_violation';
    end if;
    new.bought_by := null;
  else
    if new.bought_price is distinct from old.bought_price and not may_edit_bought then
      raise exception 'Kun den, der har markeret produktet som købt, kan rette prisen.' using errcode = 'check_violation';
    end if;
    new.bought_at := old.bought_at; new.bought_by := old.bought_by;
  end if;

  if new.source_url is distinct from old.source_url then
    new.status := 'pending';
    new.tracked_variants := null;
    new.title := null; new.variants := null; new.offers := null; new.history := null;
    new.normal_price := null; new.verdict := null; new.warning := null; new.check_note := null;
    new.last_checked := null; new.notified_price := null; new.notified_at := null; new.backfill_state := null;
    new.digest_price := null; new.digest_at := null;
    new.alt_requested_at := null; new.alternatives := null; new.alt_done_at := null; new.alt_note := null;
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

-- profiles: a browser user writes the settings, never digest_sent_at (when the job last claimed the morning mail).
create or replace function public.profiles_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.digest_sent_at := null;
  else
    new.digest_sent_at := old.digest_sent_at;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg
  before insert or update on public.profiles
  for each row execute function public.profiles_guard();

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

-- A product may only point at a list its owner owns or is a member of (checked for every role, the job and the SQL editor included).
-- SECURITY DEFINER so the check does not depend on the caller's row level security.
create or replace function public.products_list_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.list_id is not null
     and not exists (select 1 from public.lists l where l.id = new.list_id
                       and (l.user_id = new.user_id
                            or exists (select 1 from public.list_members m where m.list_id = l.id and m.user_id = new.user_id))) then
    raise exception 'Listen findes ikke.' using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists products_list_check_trg on public.products;
create trigger products_list_check_trg
  before insert or update of list_id, user_id on public.products
  for each row execute function public.products_list_check();

-- ---------------------------------------------------------------- imports (shared wish lists from Onskeskyen)
-- A person pastes a shared wish-list link from Onskeskyen (onskeskyen.dk, internationally gowish.com). That becomes one row
-- here. The price job (service role) fetches the public list, adds the wishes as products (status 'pending', goal 'auto'),
-- and marks the row 'done' or 'error' with a note. A browser user can create and delete their own rows and read them, but
-- can never set status, note, found, added or done_at. list_id = the list the products go into (null: the job decides).

create table if not exists public.imports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  list_id    uuid references public.lists(id) on delete set null,
  url        text not null,
  status     text not null default 'pending' check (status in ('pending', 'done', 'error')),
  note       text check (note is null or char_length(note) <= 300),
  found      integer check (found is null or found >= 0),
  added      integer check (added is null or added >= 0),
  created_at timestamptz default now(),
  done_at    timestamptz
);

-- A finished import stays a standing link between a list and the wish list (see job/lib/onskeskyen.js): once a day the job reads the
-- wish list again and adds new wishes. All written by the job only (imports_guard): synced_at = last attempt, seen = ids of the
-- wishes already handled (added, skipped or removed again by the person: never added a second time), title = the wish list's name,
-- sync_fails = failed attempts in a row (the job gives up after 7).
alter table public.imports add column if not exists synced_at timestamptz;
alter table public.imports add column if not exists seen jsonb
  check (seen is null or (case when jsonb_typeof(seen) = 'array' then jsonb_array_length(seen) <= 500 else false end));
alter table public.imports add column if not exists title text check (title is null or char_length(title) <= 100);
alter table public.imports add column if not exists sync_fails integer not null default 0 check (sync_fails >= 0);
create index if not exists imports_sync_idx on public.imports (synced_at nulls first) where status = 'done';

-- Only https links to onskeskyen.dk or gowish.com (optional www.): /s/<code>, or /wishlists/<id> with an optional
-- locale prefix like /da/ or /da-dk/. Dropped and re-added by name so this can be tightened later and re-run.
alter table public.imports drop constraint if exists imports_url_check;
alter table public.imports add constraint imports_url_check check (
  char_length(url) <= 300
  and url ~* '^https://(www\.)?(onskeskyen\.dk|gowish\.com)/(s/[a-z0-9_-]{1,64}|([a-z]{2}(-[a-z]{2})?/)?wishlists/[a-z0-9_-]{1,64})/?([?#][^[:space:]]*)?$');

create index if not exists imports_user_idx on public.imports (user_id);
create index if not exists imports_pending_idx on public.imports (created_at) where status = 'pending';

alter table public.imports enable row level security;
revoke all on public.imports from anon;

drop policy if exists imports_own on public.imports;
create policy imports_own on public.imports
  for all to authenticated
  using ((select auth.uid()) = user_id and public.is_allowed())
  with check ((select auth.uid()) = user_id and public.is_allowed());

-- No UPDATE for browser users at all (a row is created, read and deleted; the job does the rest).
grant select, insert, delete on public.imports to authenticated;
revoke update on public.imports from authenticated;
grant select, insert, update, delete on public.imports to service_role;

-- Browser users: a new row always starts as a plain pending request. An UPDATE (should one ever be granted) cannot touch
-- the job-written columns, the owner or the link. The service role and the SQL editor are not restricted.
create or replace function public.imports_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending'; new.note := null; new.found := null; new.added := null; new.done_at := null;
    new.synced_at := null; new.seen := null; new.title := null; new.sync_fails := 0;
    return new;
  end if;
  new.user_id := old.user_id; new.url := old.url;
  new.status := old.status; new.note := old.note; new.found := old.found; new.added := old.added; new.done_at := old.done_at;
  new.synced_at := old.synced_at; new.seen := old.seen; new.title := old.title; new.sync_fails := old.sync_fails;
  return new;
end;
$$;

drop trigger if exists imports_guard_trg on public.imports;
create trigger imports_guard_trg
  before insert or update on public.imports
  for each row execute function public.imports_guard();

-- At most 5 waiting imports and 20 rows per user (a done import is a standing link until the person stops it; a failed one stays until hidden).
create or replace function public.imports_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.imports where user_id = new.user_id) >= 20 then
    raise exception 'Du kan højst have 20 ønskelister. Stop eller skjul en først.' using errcode = 'check_violation';
  end if;
  if new.status = 'pending'
     and (select count(*) from public.imports where user_id = new.user_id and status = 'pending') >= 5 then
    raise exception 'Du kan højst have 5 ønskelister i gang. Vent, til de er hentet.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists imports_limit_trg on public.imports;
create trigger imports_limit_trg
  before insert on public.imports
  for each row execute function public.imports_limit();

-- list_id must be one of the owner's own lists (the same idea as products_list_check; checked for every role).
create or replace function public.imports_list_check()
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

drop trigger if exists imports_list_check_trg on public.imports;
create trigger imports_list_check_trg
  before insert or update of list_id, user_id on public.imports
  for each row execute function public.imports_list_check();

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

-- ---------------------------------------------------------------- sharing a list
-- Everything is private per person (user_id = auth.uid()), with ONE exception: the owner of a list can share that one list with
-- people who already have access to the site (at most 10 members per list). The owner is not stored as a member (lists.user_id).
-- A member sees the list and the products in it, adds products to it and marks products as bought. Everything else on someone
-- else's product is locked by products_guard (see above). A product in a shared list keeps its own user_id: the 40-product cap,
-- the price job and the deal e-mails still go by the person who added it. Imports stay the list owner's (imports_list_check).
-- Leaving or being removed moves the person's own products out of the list (list_id null): they stay theirs.
--
-- Row level security never looks at another table directly (that recurses): the two small SECURITY DEFINER functions below
-- answer "do I own this list" and "am I a member of it", and the policies call them. Both only ever speak about the caller.

create table if not exists public.list_members (
  list_id  uuid not null references public.lists(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, user_id)
);
create index if not exists list_members_user_idx on public.list_members (user_id);

create or replace function public.owns_list(p_list uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.lists l where l.id = p_list and l.user_id = auth.uid());
$$;

create or replace function public.is_list_member(p_list uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.list_members m where m.list_id = p_list and m.user_id = auth.uid());
$$;

revoke all on function public.owns_list(uuid) from public, anon;
revoke all on function public.is_list_member(uuid) from public, anon;
grant execute on function public.owns_list(uuid) to authenticated, service_role;
grant execute on function public.is_list_member(uuid) to authenticated, service_role;

alter table public.list_members enable row level security;
revoke all on public.list_members from anon;
-- Members are added by share_list() only (it checks who may be invited): no INSERT and no UPDATE for browser users at all.
revoke insert, update on public.list_members from authenticated;
grant select, delete on public.list_members to authenticated;
grant select, insert, update, delete on public.list_members to service_role;

-- The owner sees the members of their lists; a member sees their own row and the co-members of the same list.
drop policy if exists list_members_select on public.list_members;
create policy list_members_select on public.list_members
  for select to authenticated
  using (public.is_allowed()
         and ((select auth.uid()) = user_id or public.owns_list(list_id) or public.is_list_member(list_id)));

-- The owner removes a member, a member removes themselves (leaves).
drop policy if exists list_members_delete on public.list_members;
create policy list_members_delete on public.list_members
  for delete to authenticated
  using (public.is_allowed() and ((select auth.uid()) = user_id or public.owns_list(list_id)));

-- Checked for every role: the owner is never a member, at most 10 members, and only a person who is on the allowed list.
create or replace function public.list_members_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.lists l where l.id = new.list_id and l.user_id = new.user_id) then
    raise exception 'Ejeren af listen er allerede med.' using errcode = 'check_violation';
  end if;
  if (select count(*) from public.list_members m where m.list_id = new.list_id) >= 10 then
    raise exception 'En liste kan højst deles med 10 personer.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from auth.users u join public.allowed_emails a on a.email = lower(u.email) where u.id = new.user_id) then
    raise exception 'Personen skal have adgang til Prisvagten først.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists list_members_guard_trg on public.list_members;
create trigger list_members_guard_trg
  before insert on public.list_members
  for each row execute function public.list_members_guard();

-- Whoever leaves, is removed (or loses the list because it is deleted): their own products leave the list and stay theirs.
create or replace function public.list_members_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.products set list_id = null where list_id = old.list_id and user_id = old.user_id;
  return old;
end;
$$;

drop trigger if exists list_members_after_delete_trg on public.list_members;
create trigger list_members_after_delete_trg
  after delete on public.list_members
  for each row execute function public.list_members_after_delete();

-- A member can read the shared list's row (name), never the owner's other lists. Writing a list stays with the owner (lists_own).
drop policy if exists lists_member_select on public.lists;
create policy lists_member_select on public.lists
  for select to authenticated
  using (public.is_allowed() and public.is_list_member(id));

-- products: one policy per command, replacing the old "all" policy.
-- Read: your own products, and every product in a list you own or are a member of.
-- Insert and delete: your own products only (a product can be added to a shared list: products_list_check). Update: your own
-- products, or someone else's product in a shared list (products_guard then lets only the bought columns through).
drop policy if exists products_own on public.products;
drop policy if exists products_select on public.products;
drop policy if exists products_insert on public.products;
drop policy if exists products_update_own on public.products;
drop policy if exists products_update_shared on public.products;
drop policy if exists products_delete on public.products;
create policy products_select on public.products
  for select to authenticated
  using (public.is_allowed()
         and ((select auth.uid()) = user_id or public.owns_list(list_id) or public.is_list_member(list_id)));
create policy products_insert on public.products
  for insert to authenticated
  with check ((select auth.uid()) = user_id and public.is_allowed());
create policy products_update_own on public.products
  for update to authenticated
  using ((select auth.uid()) = user_id and public.is_allowed())
  with check ((select auth.uid()) = user_id and public.is_allowed());
create policy products_update_shared on public.products
  for update to authenticated
  using (public.is_allowed() and (select auth.uid()) <> user_id and (public.owns_list(list_id) or public.is_list_member(list_id)))
  with check (public.is_allowed() and (select auth.uid()) <> user_id and (public.owns_list(list_id) or public.is_list_member(list_id)));
create policy products_delete on public.products
  for delete to authenticated
  using ((select auth.uid()) = user_id and public.is_allowed());

-- A short name for a person, for the people in a shared list: the first word of the name they gave when they asked for access,
-- else the part of the e-mail before the @ (up to the first dot, dash, underscore or plus), first letter capitalised.
-- Internal: nobody can call it, only the functions below.
create or replace function public.person_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(left(split_part(btrim(r.name), ' ', 1), 20), '')
       from public.access_requests r where r.email = lower(u.email) and r.status = 'approved'),
    (select nullif(upper(left(x.l, 1)) || substr(x.l, 2), '')
       from (select left(split_part(split_part(split_part(split_part(lower(u.email), '@', 1), '.', 1), '-', 1), '_', 1), 20) as l) x),
    'Ukendt')
  from auth.users u where u.id = p_user;
$$;
revoke all on function public.person_name(uuid) from public, anon, authenticated;

-- Shares one of your lists with a person who already has access. Returns 'ok', 'already' (already a member), 'self', 'full'
-- (10 members), 'invalid' (not an e-mail address), 'slow' (more than 20 look-ups in the last hour) or 'unknown'. 'unknown' is the one
-- answer both for an address with no account and for one that is not allowed, so nobody can find out who has an account.
-- Raises 42501 when you are not allowed or do not own the list (the same for a list that does not exist).
create table if not exists public.share_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists share_attempts_idx on public.share_attempts (user_id, at);
alter table public.share_attempts enable row level security;      -- and no policy: only share_list() and the service role
revoke all on public.share_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.share_attempts to service_role;

create or replace function public.share_list(p_list uuid, p_email text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := auth.uid();
  e      text := lower(btrim(coalesce(p_email, '')));
  target uuid;
begin
  if me is null or not public.is_allowed() or not public.owns_list(p_list) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(e) > 200 or e !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$' then
    return 'invalid';
  end if;
  if e = lower(coalesce(auth.jwt() ->> 'email', '')) then
    return 'self';
  end if;
  if (select count(*) from public.share_attempts a where a.user_id = me and a.at > now() - interval '1 hour') >= 20 then
    return 'slow';
  end if;
  if (select count(*) from public.list_members m where m.list_id = p_list) >= 10 then
    return 'full';
  end if;
  -- every look-up counts, a hit as well as a miss: nobody can run through addresses to find out who has an account
  insert into public.share_attempts (user_id) values (me);
  delete from public.share_attempts a where a.user_id = me and a.at < now() - interval '1 day';
  select u.id into target from auth.users u where lower(u.email) = e limit 1;
  if target is null or not exists (select 1 from public.allowed_emails a where a.email = e) then
    return 'unknown';
  end if;
  if exists (select 1 from public.list_members m where m.list_id = p_list and m.user_id = target)
     or exists (select 1 from public.lists l where l.id = p_list and l.user_id = target) then
    return 'already';
  end if;
  insert into public.list_members (list_id, user_id) values (p_list, target);
  return 'ok';
end;
$$;

-- The people of a list, for the owner and the members only (everyone else gets no rows): the owner, the members, and anyone
-- else who is named on a product in it (someone who left after buying). role = 'owner' | 'member' | 'former'. The e-mail address
-- is only given to the list's owner, and only for members they invited themselves.
create or replace function public.list_members_named(p_list uuid)
returns table (user_id uuid, name text, role text, email text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  is_owner boolean;
begin
  if auth.uid() is null or not public.is_allowed() then
    return;
  end if;
  is_owner := public.owns_list(p_list);
  if not (is_owner or public.is_list_member(p_list)) then
    return;
  end if;
  return query
    select l.user_id, public.person_name(l.user_id), 'owner'::text, null::text
      from public.lists l where l.id = p_list
    union all
    select m.user_id, public.person_name(m.user_id), 'member'::text,
           case when is_owner then (select lower(u.email) from auth.users u where u.id = m.user_id) else null end
      from public.list_members m where m.list_id = p_list
    union all
    select x.id, public.person_name(x.id), 'former'::text, null::text
      from (select p.user_id as id from public.products p where p.list_id = p_list
            union select p.bought_by from public.products p where p.list_id = p_list and p.bought_by is not null) x
     where not exists (select 1 from public.lists l where l.id = p_list and l.user_id = x.id)
       and not exists (select 1 from public.list_members m where m.list_id = p_list and m.user_id = x.id);
end;
$$;

-- The owner removes a member. Returns true when someone was removed. Raises 42501 for anyone but the list's owner.
create or replace function public.unshare_list(p_list uuid, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if auth.uid() is null or not public.is_allowed() or not public.owns_list(p_list) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.list_members m where m.list_id = p_list and m.user_id = p_user;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- A member leaves a list. Returns true when they were a member.
create or replace function public.leave_list(p_list uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if auth.uid() is null or not public.is_allowed() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.list_members m where m.list_id = p_list and m.user_id = auth.uid();
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.share_list(uuid, text) from public, anon;
revoke all on function public.list_members_named(uuid) from public, anon;
revoke all on function public.unshare_list(uuid, uuid) from public, anon;
revoke all on function public.leave_list(uuid) from public, anon;
grant execute on function public.share_list(uuid, text) to authenticated;
grant execute on function public.list_members_named(uuid) to authenticated;
grant execute on function public.unshare_list(uuid, uuid) to authenticated;
grant execute on function public.leave_list(uuid) to authenticated;

-- ---------------------------------------------------------------- alternatives (answered by the AI agent)
-- A person asks for "Alternativer" for a product of their own (the browser sets alt_requested_at, see products_guard). The AI agent
-- (the same scheduled Claude session and the same x-resolver-token as the resolver functions above, with no broader access) reads
-- the waiting requests with ai_alt_list(), and answers with ai_alt_set() or ai_alt_fail(). Same pattern and grants as resolver_*.
-- A request is pending when alt_requested_at is set and alt_done_at is null or older than it.

-- One row per request, so the limit (5 per person per 24 hours, across all their products) survives a product being asked again
-- and again. No policy and no grants: only alt_take_slot() and the service role.
create table if not exists public.alt_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists alt_attempts_idx on public.alt_attempts (user_id, at);
alter table public.alt_attempts enable row level security;
revoke all on public.alt_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.alt_attempts to service_role;

-- Called by products_guard for a request. It only works inside a trigger (it is no use as an RPC), speaks only about the caller,
-- and is SECURITY DEFINER so the caller needs no rights on alt_attempts. The row is written in the request's own transaction.
create or replace function public.alt_take_slot()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or pg_trigger_depth() = 0 then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alt:' || me::text, 0));
  delete from public.alt_attempts a where a.user_id = me and a.at < now() - interval '2 days';
  if (select count(*) from public.alt_attempts a where a.user_id = me and a.at > now() - interval '24 hours') >= 5 then
    raise exception 'Du kan bede om alternativer 5 gange i døgnet.' using errcode = 'check_violation';
  end if;
  insert into public.alt_attempts (user_id) values (me);
end;
$$;
revoke all on function public.alt_take_slot() from public, anon;
grant execute on function public.alt_take_slot() to authenticated;

-- Up to 5 pending requests, oldest first, only for products that are being tracked and have a title. Nothing about the person.
-- price = the lowest in-stock price in offers now (null when there is none), host = the shop's host name (no path, no query).
create or replace function public.ai_alt_list()
returns table (id uuid, title text, price numeric, normal_price numeric, host text, requested_at timestamptz)
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
    select p.id,
           left(coalesce(nullif(btrim(p.title), ''), p.name), 200),
           (select min((o ->> 'price')::numeric)
              from jsonb_array_elements(case when jsonb_typeof(p.offers) = 'array' then p.offers else '[]'::jsonb end) o
             where jsonb_typeof(o) = 'object' and o -> 'inStock' = 'true'::jsonb and jsonb_typeof(o -> 'price') = 'number'),
           p.normal_price,
           nullif(regexp_replace(substring(p.source_url from '^https://([^/?#]+)'), '^www\.', ''), ''),
           p.alt_requested_at
      from public.products p
     where p.active and p.status = 'tracking' and p.title is not null
       and p.alt_requested_at is not null and (p.alt_done_at is null or p.alt_done_at < p.alt_requested_at)
     order by p.alt_requested_at, p.id
     limit 5;
end;
$$;

-- Stores the answer for a pending product: 1 to 6 suggestions, each an object with exactly the keys kind ('similar' | 'deal'),
-- name (1-120), url (https, the products.source_url rule, 500), store (1-60), price (> 0 and < 10 million) and why (1-160), and
-- optionally was (a number above price: the normal price of a deal; null counts as absent). Text must have no control
-- characters, no invisible direction marks and no < or >. Anything else raises 22023 and stores nothing. The stored copy is
-- cleaned (trimmed, price and was rounded to 2 decimals). Returns true, or false when the product is not pending (any more).
create or replace function public.ai_alt_set(p_id uuid, p_items jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e       jsonb;
  i       integer := 0;
  k       text;
  s       text;
  pr      numeric;
  wa      numeric;
  clean   jsonb := '[]'::jsonb;
  item    jsonb;
  n       integer;
  bad     constant text := '[[:cntrl:]<>​-‏‪-‮⁦-⁩﻿  ]';
begin
  if not public.resolver_token_ok() then
    raise exception 'resolver: invalid or missing token' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 6 then
    raise exception 'ai_alt: items must be an array of 1 to 6 objects' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_items) x loop
    i := i + 1;
    if jsonb_typeof(e) <> 'object' then
      raise exception 'ai_alt: item %: not an object', i using errcode = '22023';
    end if;
    for k in select jsonb_object_keys(e) loop
      if k not in ('kind', 'name', 'url', 'store', 'price', 'was', 'why') then
        raise exception 'ai_alt: item %: unknown key %', i, left(k, 40) using errcode = '22023';
      end if;
    end loop;
    foreach k in array array['kind', 'name', 'url', 'store', 'price', 'why'] loop
      if not e ? k or jsonb_typeof(e -> k) = 'null' then
        raise exception 'ai_alt: item %: % is missing', i, k using errcode = '22023';
      end if;
    end loop;
    -- the text fields
    foreach k in array array['kind', 'name', 'url', 'store', 'why'] loop
      if jsonb_typeof(e -> k) <> 'string' then
        raise exception 'ai_alt: item %: % must be a string', i, k using errcode = '22023';
      end if;
      s := btrim(e ->> k);
      if s ~ bad then
        raise exception 'ai_alt: item %: % has control characters or angle brackets', i, k using errcode = '22023';
      end if;
      if (k = 'kind' and s not in ('similar', 'deal'))
         or (k = 'name' and char_length(s) not between 1 and 120)
         or (k = 'store' and char_length(s) not between 1 and 60)
         or (k = 'why' and char_length(s) not between 1 and 160)
         or (k = 'url' and (char_length(s) > 500 or s !~ '^https://[^/?#@:[:space:]]+\.[^/?#@:[:space:]]+([/?#][^[:space:]]*)?$')) then
        raise exception 'ai_alt: item %: % is not valid', i, k using errcode = '22023';
      end if;
    end loop;
    -- the numbers
    if jsonb_typeof(e -> 'price') <> 'number' then
      raise exception 'ai_alt: item %: price must be a number', i using errcode = '22023';
    end if;
    pr := round((e ->> 'price')::numeric, 2);
    if not (pr > 0 and pr < 10000000) then
      raise exception 'ai_alt: item %: price must be above 0 and below 10000000', i using errcode = '22023';
    end if;
    wa := null;
    if e ? 'was' and jsonb_typeof(e -> 'was') <> 'null' then
      if jsonb_typeof(e -> 'was') <> 'number' then
        raise exception 'ai_alt: item %: was must be a number', i using errcode = '22023';
      end if;
      wa := round((e ->> 'was')::numeric, 2);
      if not (wa > pr and wa < 10000000) then
        raise exception 'ai_alt: item %: was must be above price and below 10000000', i using errcode = '22023';
      end if;
    end if;
    item := jsonb_build_object('kind', btrim(e ->> 'kind'), 'name', btrim(e ->> 'name'), 'url', btrim(e ->> 'url'),
                               'store', btrim(e ->> 'store'), 'price', pr, 'why', btrim(e ->> 'why'));
    if wa is not null then item := item || jsonb_build_object('was', wa); end if;
    clean := clean || jsonb_build_array(item);
  end loop;
  update public.products
     set alternatives = clean, alt_done_at = now(), alt_note = null
   where id = p_id and active and alt_requested_at is not null and (alt_done_at is null or alt_done_at < alt_requested_at);
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- The agent found nothing usable: stores a short note for the person (control characters and < > removed, cut to 200 characters,
-- a plain sentence when empty) and no alternatives. Returns true, or false when the product is not pending (any more).
create or replace function public.ai_alt_fail(p_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
  t text;
begin
  if not public.resolver_token_ok() then
    raise exception 'resolver: invalid or missing token' using errcode = '42501';
  end if;
  t := left(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]<>​-‏‪-‮⁦-⁩﻿  ]+', ' ', 'g')), 200);
  update public.products
     set alternatives = null, alt_done_at = now(), alt_note = coalesce(nullif(btrim(t), ''), 'Kunne ikke finde alternativer.')
   where id = p_id and active and alt_requested_at is not null and (alt_done_at is null or alt_done_at < alt_requested_at);
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.ai_alt_list() from public;
revoke all on function public.ai_alt_set(uuid, jsonb) from public;
revoke all on function public.ai_alt_fail(uuid, text) from public;
grant execute on function public.ai_alt_list() to anon, authenticated;
grant execute on function public.ai_alt_set(uuid, jsonb) to anon, authenticated;
grant execute on function public.ai_alt_fail(uuid, text) to anon, authenticated;

-- First run only: nobody is admin yet, so the address added first (the owner added themselves first) becomes admin.
-- Later runs change nothing, so admin never moves.
update public.allowed_emails
   set is_admin = true
 where email = (select a.email from public.allowed_emails a order by a.added_at asc nulls last, a.email limit 1)
   and not exists (select 1 from public.allowed_emails x where x.is_admin);

-- Shows the token (copy it from the result of this last query; see docs/SETUP.md).
select token as resolver_token_copy_this from public.resolver_secret;
