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
  notify_email boolean default false,
  sound        text default 'jubel' check (sound is null or char_length(sound) <= 40),
  created_at   timestamptz default now(),
  constraint profiles_shops_len check (
    coalesce(cardinality(shops_always), 0) <= 100 and coalesce(cardinality(shops_exclude), 0) <= 100)
);

-- The daily overview (opt-in, written by the person; "Daglig oversigt om morgenen"): one mail a day at the first run from 07:00 Copenhagen
-- time with what is on offer now and what moved at least 5 % since yesterday. It never replaces or delays the mail for a new deal
-- (notify_email). digest_sent_at = when the job last claimed the day's overview for this person (job only: see profiles_guard).
-- Added later, re-runnable.
alter table public.profiles add column if not exists mail_digest boolean not null default false;

-- Mail is opt-in: a NEW profile has "Mail ved nyt tilbud" (notify_email) off, and so has the overview. The default is changed here for
-- new rows only; every existing row keeps exactly the value it has (set default never rewrites a row). The job treats a person without
-- a profile row as off as well.
alter table public.profiles alter column notify_email set default false;

-- mail_asked_at: when the person answered the one small question "Vil du have mail ved nye tilbud?" (either answer), so it is asked once.
-- Written by the person, but stamped with the server's clock and set once (profiles_guard). Added once: the block below gives every
-- profile that exists when the column is added a time (those people already have a stored choice and are not asked); a re-run
-- never touches the rows again.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'mail_asked_at') then
    alter table public.profiles add column mail_asked_at timestamptz;
    update public.profiles set mail_asked_at = now();
  end if;
end $$;
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

-- digest_price / digest_at: no longer used. They once held a hit that was collected for the one morning mail; the daily overview
-- does not collect anything any more (it is built from the current data). The columns stay (dropping data from the live database is
-- not worth it); the job neither reads nor writes them, and products_guard still keeps them out of the browser's reach.
alter table public.products add column if not exists digest_price numeric;
alter table public.products add column if not exists digest_at timestamptz;

-- notify_silent_until: written by the job and by this file only (products_guard). While it lies in the future a hit is only
-- remembered (notified_price / notified_at), never mailed. It exists for ONE moment: when the rules for "one mail per deal" shipped,
-- every product that already existed got 24 hours of quiet, so that a product whose hit used to flicker (and was mailed again and
-- again) does not mail once more just because its notified state was cleared by the old rules. New products have null (no quiet).
-- Added once: the block runs the update only when it adds the column, so a re-run never starts a new quiet period.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'notify_silent_until') then
    alter table public.products add column notify_silent_until timestamptz;
    update public.products set notify_silent_until = now() + interval '24 hours';
  end if;
end $$;

-- "Alternativer" (see "alternatives" below): similar products and deals in the same category, answered by the AI agent.
-- alt_requested_at = when the person asked (browser, but stamped with the server clock by products_guard); alternatives,
-- alt_done_at and alt_note are written by the AI agent's functions only. Pending = requested and not answered since.
alter table public.products add column if not exists alt_requested_at timestamptz;
alter table public.products add column if not exists alternatives jsonb
  check (alternatives is null or (case when jsonb_typeof(alternatives) = 'array' then jsonb_array_length(alternatives) <= 6 else false end));
alter table public.products add column if not exists alt_done_at timestamptz;
alter table public.products add column if not exists alt_note text check (alt_note is null or char_length(alt_note) <= 200);

-- "Find the cheapest shop" (see "compare" in the resolver section): a product that follows one shop only (source_url is a shop's
-- product page, not prisjagt.dk) can be switched to its prisjagt.dk page, which lists many shops. compare_state: 'wanted' = the AI
-- agent is asked to look for the product on Prisjagt, 'done' = it was switched (shop_url keeps the original shop link, so the person
-- can go back), 'none' = looked for and not found (or the person went back); null = never asked. compare_at = when the state was
-- set. Written by the job, the AI agent's functions and products_guard only; the person may only request ('wanted') or go back.
alter table public.products add column if not exists compare_state text;
alter table public.products add column if not exists compare_at timestamptz;
alter table public.products add column if not exists shop_url text;
-- compare_tries: how many times the job has marked the product 'wanted' again by itself after a 'none' (at most 3, the first marking
-- counts as 1). Job-owned: products_guard keeps the browser off it, and a new source_url resets it. Manual requests do not count.
alter table public.products add column if not exists compare_tries integer not null default 0;

alter table public.products drop constraint if exists products_compare_state_check;
alter table public.products add constraint products_compare_state_check check (compare_state is null or compare_state in ('wanted', 'done', 'none'));
-- shop_url follows the same rule as source_url (see below)
alter table public.products drop constraint if exists products_shop_url_check;
alter table public.products add constraint products_shop_url_check check (
  shop_url is null or (char_length(shop_url) <= 500 and shop_url ~ '^https://[^/?#@:[:space:]]+\.[^/?#@:[:space:]]+([/?#][^[:space:]]*)?$'));

-- A small picture of the product (https only, same rule as source_url). Written by the job only (taken from a page or a wish list the
-- job reads anyway; the picture itself is never downloaded or stored here). products_guard keeps the browser's hands off it.
alter table public.products add column if not exists image_url text;
alter table public.products drop constraint if exists products_image_url_check;
alter table public.products add constraint products_image_url_check check (
  image_url is null or (char_length(image_url) <= 500 and image_url ~ '^https://[^/?#@:[:space:]]+\.[^/?#@:[:space:]]+([/?#][^[:space:]]*)?$'));

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

-- Requirements ("Krav"): the person's own free words about the product, e.g. "hvid/grøn, str. 43". Data for the AI agent (resolver_list
-- gives it as `req`), never instructions. Trimmed (products_guard does it for every role), 1 to 120 characters, no control characters and
-- no angle brackets. It is only a preference, so it never blocks a product: products_guard CLEANS it for every role (control characters and
-- angle brackets become a space, runs of spaces collapse, trimmed, cut at 120 characters, empty becomes null) and the check below is only
-- the safety net that cannot fail after that. Written by the person who added the product; members of a shared list can read it, not change it (whole-row check).
alter table public.products add column if not exists requirements text;
alter table public.products drop constraint if exists products_requirements_check;
alter table public.products add constraint products_requirements_check check (
  requirements is null or (
    char_length(requirements) between 1 and 120
    and requirements = btrim(requirements, E' \t\r\n\u00a0')
    and requirements !~ '[\x01-\x1f\x7f-\x9f<>]'));
-- req_state: the AI agent's variant work for the current requirements, job/agent-owned (the browser cannot write it). null = nothing.
--   {"want": true, "at": t}  the person changed the requirements of a Prisjagt product that has several variants: pick the variants again
--   {"for": "<requirements>", "by": "agent" | "person", "at": t, "n": k}  answered for exactly these requirements (resolver_variants,
--                            or the person's own choice, which always wins); k = how many variants the agent chose (0 = could not decide)
-- A browser change of requirements or of source_url resets it (products_guard).
alter table public.products add column if not exists req_state jsonb;
alter table public.products drop constraint if exists products_req_state_check;
alter table public.products add constraint products_req_state_check check (req_state is null or jsonb_typeof(req_state) = 'object');

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

-- "Extra shops": a single-shop product (source_url is a shop's product page) can also be followed in other Danish shops that sell exactly
-- the same product, for the things that are not on Prisjagt. extra_urls = 1 to 5 https product-page links, one per shop (none on
-- prisjagt.dk, none with the host of source_url or of each other). The AI agent writes it (resolver_compare with p_shops); a browser user
-- can never add or change an entry, only remove one of their own product's entries (products_guard). extra_state is the job's own
-- bookkeeping per link ({"<link>": {"seen": true, "fails": 0, "at": "<time>"}}: seen = read successfully once, fails = failures in a row,
-- at = last attempt); the browser cannot write it.
alter table public.products add column if not exists extra_urls jsonb;
alter table public.products add column if not exists extra_state jsonb;

-- The reason why p_extra is not a valid extra_urls value for a product with the link p_src, or null when it is. One place for the rule:
-- the check constraint below and resolver_compare both use it, so the agent gets an error that names the bad entry. Hosts are compared in
-- lower case without a leading www.
create or replace function public.extra_urls_error(p_src text, p_extra jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  rx constant text := '^https://[^/?#@:[:space:]]+\.[^/?#@:[:space:]]+([/?#][^[:space:]]*)?$';
  n integer;
  i integer;
  e jsonb;
  u text;
  h text;
  seen text[] := '{}';
  src_host text;
begin
  if p_extra is null then return null; end if;
  if jsonb_typeof(p_extra) <> 'array' then return 'shops must be an array of 1 to 5 links'; end if;
  n := jsonb_array_length(p_extra);
  if n < 1 or n > 5 then return 'shops must hold 1 to 5 links, not ' || n; end if;
  if p_src is null or char_length(p_src) > 500 or p_src !~ rx then return 'the product has no shop link to compare with'; end if;
  if p_src ~* '^https://(www\.)?prisjagt\.dk([/?#]|$)' then return 'only a product that follows one shop can have extra shops'; end if;
  src_host := regexp_replace(lower(substring(p_src from '^https://([^/?#]+)')), '^www\.', '');
  for i in 0 .. n - 1 loop
    e := p_extra -> i;
    if jsonb_typeof(e) <> 'string' then return 'shops entry ' || (i + 1) || ' is not a link'; end if;
    u := e #>> '{}';
    if char_length(u) > 500 or u !~ rx then return 'shops entry ' || (i + 1) || ' is not an https product link: ' || left(u, 80); end if;
    if u ~* '^https://(www\.)?prisjagt\.dk([/?#]|$)' then return 'shops entry ' || (i + 1) || ' is a prisjagt.dk link: ' || left(u, 80); end if;
    h := regexp_replace(lower(substring(u from '^https://([^/?#]+)')), '^www\.', '');
    if h = src_host then return 'shops entry ' || (i + 1) || ' is the shop of the product itself: ' || left(u, 80); end if;
    if h = any (seen) then return 'shops entry ' || (i + 1) || ' is a second link to the same shop: ' || left(u, 80); end if;
    seen := seen || h;
  end loop;
  return null;
end;
$$;

alter table public.products drop constraint if exists products_extra_urls_check;
alter table public.products add constraint products_extra_urls_check check (extra_urls is null or public.extra_urls_error(source_url, extra_urls) is null);
alter table public.products drop constraint if exists products_extra_state_check;
alter table public.products add constraint products_extra_state_check check (extra_state is null or jsonb_typeof(extra_state) = 'object');

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
  asked_compare text;
  asked_extra jsonb;
  extras_gone boolean := false;
  i integer;
  on_pj boolean;
begin
  -- requirements: cleaned for every role before anything is compared (see the column): the text never makes a row fail
  new.requirements := nullif(btrim(left(btrim(regexp_replace(regexp_replace(new.requirements, '[\x01-\x1f\x7f-\x9f<>]+', ' ', 'g'), '[ \u00a0]{2,}', ' ', 'g'), E' \u00a0'), 120), E' \u00a0'), '');
  if not restricted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.title := null; new.variants := null; new.offers := null; new.history := null;
    new.normal_price := null; new.verdict := null; new.warning := null; new.check_note := null;
    new.last_checked := null; new.notified_price := null; new.notified_at := null; new.backfill_state := null;
    new.digest_price := null; new.digest_at := null; new.notify_silent_until := null;
    new.alt_requested_at := null; new.alternatives := null; new.alt_done_at := null; new.alt_note := null;
    new.compare_state := null; new.compare_at := null; new.shop_url := null; new.image_url := null; new.compare_tries := 0;
    new.extra_urls := null; new.extra_state := null; new.req_state := null;
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
  new.digest_price := old.digest_price; new.digest_at := old.digest_at; new.notify_silent_until := old.notify_silent_until;
  -- a new goal (kind or value) starts the notifications over: the job mails the next time the product is a hit, whatever was mailed
  -- under the old goal. (A new link does the same, see the source_url block below.)
  if new.target_type is distinct from old.target_type or new.target_value is distinct from old.target_value then
    new.notified_price := null; new.notified_at := null;
  end if;
  new.image_url := old.image_url; new.compare_tries := old.compare_tries; new.req_state := old.req_state;
  -- extra shops: the agent's and the job's. The person (only their own product gets this far) may only remove ONE entry of extra_urls
  -- (the same array minus one element, same order; removing the only entry gives null, and the product then counts as "not found
  -- elsewhere"). Anything else the browser sends is ignored.
  new.extra_state := old.extra_state;
  asked_extra := new.extra_urls;
  new.extra_urls := old.extra_urls;
  if old.extra_urls is not null and jsonb_typeof(old.extra_urls) = 'array' and asked_extra is distinct from old.extra_urls then
    if asked_extra is null then
      if jsonb_array_length(old.extra_urls) = 1 then new.extra_urls := null; end if;
    elsif jsonb_typeof(asked_extra) = 'array' and jsonb_array_length(old.extra_urls) >= 2 and jsonb_array_length(asked_extra) = jsonb_array_length(old.extra_urls) - 1 then
      for i in 0 .. jsonb_array_length(old.extra_urls) - 1 loop
        if old.extra_urls - i = asked_extra then new.extra_urls := asked_extra; exit; end if;
      end loop;
    end if;
    if new.extra_urls is distinct from old.extra_urls then
      new.extra_state := null;
      extras_gone := new.extra_urls is null;
    end if;
  end if;
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
  -- compare: the state is the job's and the AI agent's. Whatever the browser sends is ignored, with two exceptions that only the
  -- product's own person gets this far for (a list member changing it fails the whole-row check above): a request, compare_state
  -- 'wanted' (see the source_url block below for going back). A request is accepted for a single-shop product (a link that is not a
  -- prisjagt.dk page) never asked before, or asked and not found more than 1 hour ago; the time is the server's.
  asked_compare := new.compare_state;
  new.compare_state := old.compare_state; new.compare_at := old.compare_at; new.shop_url := old.shop_url;
  if asked_compare is not distinct from 'wanted' and old.compare_state is distinct from 'wanted' and new.source_url is not distinct from old.source_url
     and old.source_url is not null and old.source_url !~* '^https://(www\.)?prisjagt\.dk([/?#]|$)'
     and (old.compare_state is null or (old.compare_state = 'none' and coalesce(old.compare_at, '-infinity') < now() - interval '1 hour')) then
    new.compare_state := 'wanted'; new.compare_at := now();
  end if;
  if extras_gone then new.compare_state := 'none'; new.compare_at := now(); end if;
  -- requirements changed by the person (a list member gets no further, see the whole-row check): what the agent answered for the old
  -- words no longer counts (req_state null). With new words (not when they are removed):
  --  * a product that follows one shop, or that the agent switched to Prisjagt (shop_url kept): the lookup starts again (compare_state null,
  --    compare_tries 0, so the job marks it 'wanted' and the agent reads `req`). source_url, shop_url, extra_urls and the prices stay until
  --    the agent's new answer replaces them. A Prisjagt link the person added themself (no shop_url) is never switched because of
  --    requirements: they only steer the choice of variant.
  --  * a Prisjagt product with 2 or more variants: req_state {"want": true}, so the agent picks the variants again (resolver_list kind 'variant').
  if new.requirements is distinct from old.requirements then
    new.req_state := null;
    if new.requirements is not null and old.source_url is not null then
      on_pj := old.source_url ~* '^https://(www\.)?prisjagt\.dk([/?#]|$)';
      if not on_pj or (old.shop_url is not null and old.compare_state = 'done') then
        new.compare_state := null; new.compare_at := null; new.compare_tries := 0;
      end if;
      if on_pj and jsonb_typeof(old.variants) = 'array' and jsonb_array_length(old.variants) >= 2 then
        new.req_state := jsonb_build_object('want', true, 'at', now());
      end if;
    end if;
  end if;
  -- the person's own choice of variants wins over the agent: it answers the current requirements (the row leaves the agent's queue)
  if new.tracked_variants is distinct from old.tracked_variants and coalesce(cardinality(new.tracked_variants), 0) > 0 and new.requirements is not null then
    new.req_state := jsonb_build_object('for', new.requirements, 'by', 'person', 'at', now());
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
    new.digest_price := null; new.digest_at := null; new.image_url := null; new.compare_tries := 0;
    new.extra_urls := null; new.extra_state := null;
    new.alt_requested_at := null; new.alternatives := null; new.alt_done_at := null; new.alt_note := null; new.req_state := null;
    -- A new link is the person's own choice: the comparison starts over, except for going back to the original shop link after a
    -- switch to Prisjagt (exactly shop_url): that is 'none' from now on, so the product is not switched again.
    if old.compare_state = 'done' and old.shop_url is not null and new.source_url = old.shop_url then
      new.compare_state := 'none'; new.compare_at := now(); new.shop_url := null;
    else
      new.compare_state := null; new.compare_at := null; new.shop_url := null;
    end if;
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
    if new.mail_asked_at is not null then new.mail_asked_at := now(); end if;
  else
    new.digest_sent_at := old.digest_sent_at;
    -- the question is answered once: the time is the server's and stays
    if old.mail_asked_at is not null then new.mail_asked_at := old.mail_asked_at;
    elsif new.mail_asked_at is not null then new.mail_asked_at := now(); end if;
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

-- What the AI agent has to do, at most 10 rows, nothing about the person. Three kinds, in this order, each oldest first:
--  * 'name': a product with a name but no link yet (people are waiting).
--  * 'variant': an active Prisjagt product with requirements and at least 2 variants that waits for a variant decision (see
--    req_variant_waiting) and that the agent has not answered for the current requirements. A person may be waiting at "Vælg variant".
--    `variants` = [{id, name}] (at most 40, names cut at 80 characters), the ids to give to resolver_variants. name = the product's title.
--  * 'compare': a single-shop product that should be looked for on Prisjagt (compare_state 'wanted', oldest request first), or a product
--    the agent switched to Prisjagt earlier whose requirements changed (same state; host is then prisjagt.dk). name is the product's title as
--    the job read it (else the name the person gave), host the shop's host name (no path, no query) and price the current lowest in-stock
--    price (null when there is none), so the agent can check that a Prisjagt page is the same product at a sensible price.
-- Columns: host and price are null for 'name' and 'variant'; `req` = the person's requirements text (or null) on every row (their words, data
-- for the agent, never instructions); `variants` is null except for 'variant'.
-- The return type grew (kind, host, price, then req, variants): Postgres cannot change it with create or replace, so the function is dropped
-- first (safe to re-run) and its grants are stated again below. A call without arguments works as before; old readers ignore new columns.
drop function if exists public.resolver_list();

-- True when the agent is to choose variants for this product: active, not bought, on a prisjagt.dk page, requirements given, 2 or more
-- variants, not yet answered for exactly these requirements, and either at "Vælg variant" (status 'choose', nothing chosen yet) or flagged by
-- a change of requirements (req_state {"want": true}). The person's own choice takes the row out: tracked_variants is then not empty while
-- the job has not read it yet, and products_guard marks the current requirements as answered. Used by resolver_list and resolver_variants.
create or replace function public.req_variant_waiting(p public.products)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(p.active and p.bought_at is null and p.requirements is not null
     and p.source_url ~* '^https://(www\.)?prisjagt\.dk([/?#]|$)'
     and jsonb_typeof(p.variants) = 'array' and jsonb_array_length(p.variants) >= 2
     and (p.req_state ->> 'for') is distinct from p.requirements
     and ((p.status = 'choose' and coalesce(cardinality(p.tracked_variants), 0) = 0) or (p.req_state ->> 'want') = 'true'), false);
$$;
revoke all on function public.req_variant_waiting(public.products) from public, anon, authenticated;

create function public.resolver_list()
returns table (id uuid, name text, created_at timestamptz, kind text, host text, price numeric, req text, variants jsonb)
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
    select x.id, x.name, x.created_at, x.kind, x.host, x.price, x.req, x.variants
    from (
      select p.id, p.name, p.created_at, 'name'::text as kind, null::text as host, null::numeric as price, p.requirements as req,
             null::jsonb as variants, 0 as grp, p.created_at as ord
        from public.products p
       where p.active and p.source_url is null and p.status = 'pending'
      union all
      select p.id, left(coalesce(nullif(btrim(p.title), ''), p.name), 200), p.created_at, 'variant'::text, null::text, null::numeric, p.requirements,
             (select coalesce(jsonb_agg(jsonb_build_object('id', t.e ->> 'id', 'name', left(coalesce(t.e ->> 'label', t.e ->> 'name', t.e ->> 'id'), 80)) order by t.o), '[]'::jsonb)
                from (select e, o from jsonb_array_elements(p.variants) with ordinality as w(e, o)
                       where jsonb_typeof(e) = 'object' and e ->> 'id' is not null order by o limit 40) t),
             1, coalesce((p.req_state ->> 'at')::timestamptz, p.last_checked, p.created_at)
        from public.products p
       where public.req_variant_waiting(p)
      union all
      select p.id, left(coalesce(nullif(btrim(p.title), ''), p.name), 200), p.created_at, 'compare'::text,
             nullif(regexp_replace(substring(p.source_url from '^https://([^/?#]+)'), '^www\.', ''), ''),
             (select min((o ->> 'price')::numeric)
                from jsonb_array_elements(case when jsonb_typeof(p.offers) = 'array' then p.offers else '[]'::jsonb end) o
               where jsonb_typeof(o) = 'object' and o -> 'inStock' = 'true'::jsonb and jsonb_typeof(o -> 'price') = 'number'),
             p.requirements, null::jsonb,
             2, coalesce(p.compare_at, p.created_at)
        from public.products p
       where p.active and p.compare_state = 'wanted' and p.source_url is not null
    ) x
    order by x.grp, x.ord, x.id
    limit 10;
end;
$$;

-- The answer to a 'variant' row: p_ids = a json array of 1 to 20 variant ids (strings, as in the row's `variants`), every one of which
-- must exist in the product's own variants (else 22023 naming the first bad id), or null = "cannot decide, leave it to the person".
--  * with ids: tracked_variants is set exactly as the browser's own choice sets it (status is left alone: the job tracks those variants at
--    its next run, whether the product is at "Vælg variant" or already tracking), and req_state records the answer for these requirements.
--  * with null: only req_state is written (n 0). The product stays at "Vælg variant" for the person; a tracking product is not touched.
-- Either way the row leaves the queue until the requirements change again. Returns true when the product was waiting (see
-- req_variant_waiting), false when it is not (any more): a bad shape of p_ids is an error in either case, a bad id only for a waiting product.
create or replace function public.resolver_variants(p_id uuid, p_ids jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
  e jsonb;
  ids text[] := '{}';
  v text;
  have text[];
  pr public.products;
begin
  if not public.resolver_token_ok() then
    raise exception 'resolver: invalid or missing token' using errcode = '42501';
  end if;
  if p_ids is not null and jsonb_typeof(p_ids) = 'null' then p_ids := null; end if;
  if p_ids is not null then
    if jsonb_typeof(p_ids) <> 'array' then
      raise exception 'resolver: ids must be an array of 1 to 20 variant ids, or null' using errcode = '22023';
    end if;
    if jsonb_array_length(p_ids) < 1 or jsonb_array_length(p_ids) > 20 then
      raise exception 'resolver: ids must hold 1 to 20 variant ids, not %', jsonb_array_length(p_ids) using errcode = '22023';
    end if;
    for e in select x from jsonb_array_elements(p_ids) x loop
      if jsonb_typeof(e) <> 'string' then
        raise exception 'resolver: a variant id must be text: %', left(e::text, 80) using errcode = '22023';
      end if;
      v := e #>> '{}';
      if not (v = any (ids)) then ids := ids || v; end if;
    end loop;
  end if;
  select * into pr from public.products where id = p_id for update;
  if not found or not public.req_variant_waiting(pr) then
    return false;
  end if;
  if p_ids is not null then
    select coalesce(array_agg(w.e ->> 'id'), '{}') into have from jsonb_array_elements(pr.variants) w(e) where jsonb_typeof(w.e) = 'object';
    foreach v in array ids loop
      if not (v = any (have)) then
        raise exception 'resolver: variant id not found in the product: %', left(v, 80) using errcode = '22023';
      end if;
    end loop;
  end if;
  update public.products
     set tracked_variants = case when p_ids is null then tracked_variants else ids end,
         req_state = jsonb_build_object('for', pr.requirements, 'by', 'agent', 'at', now(), 'n', case when p_ids is null then 0 else cardinality(ids) end)
   where id = p_id;
  get diagnostics n = row_count;
  return n = 1;
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

-- The answer to a 'compare' row. Three answers, and p_url and p_shops can never both be given (22023):
--  * p_url = the product's prisjagt.dk page, exactly https://prisjagt.dk/product.php?p=<digits> (a leading www. is dropped): the product
--    is then switched to it. The original shop link is kept in shop_url, compare_state becomes 'done', and the job-written state is reset
--    exactly as products_guard does when the person changes the link, so the job fetches the Prisjagt page as a new product (status
--    'pending'). The person's own fields (name, goal, list, bought, shop choices) and the alternatives stay.
--  * p_shops = a json array of 1 to 5 https product-page links in other shops that sell exactly the same product (not on Prisjagt): the
--    product keeps its source_url, extra_urls is set (the rule is extra_urls_error: one link per shop, none on prisjagt.dk, none in the
--    product's own shop), compare_state becomes 'done', compare_at now. The job-written state (price, history, offers ...) is NOT reset:
--    the current shop's price and history stay valid. A bad entry raises 22023 with a message naming it and changes nothing.
--  * both null: the product was not found elsewhere (or is not the same product): compare_state 'none', nothing else changes.
-- Any other link raises 22023 and changes nothing. Returns true when the product was waiting, false when it is not (any more).
-- (The first version had two arguments: dropped, then created again with the third, optional one. A call with two arguments still works.)
drop function if exists public.resolver_compare(uuid, text);
create or replace function public.resolver_compare(p_id uuid, p_url text, p_shops jsonb default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u text;
  n integer;
  src text;
  err text;
  shops jsonb;
begin
  if not public.resolver_token_ok() then
    raise exception 'resolver: invalid or missing token' using errcode = '42501';
  end if;
  if p_shops is not null and jsonb_typeof(p_shops) = 'null' then p_shops := null; end if;
  if p_url is not null and p_shops is not null then
    raise exception 'resolver: give either a prisjagt.dk link or other shops, not both' using errcode = '22023';
  end if;
  if p_shops is not null then
    if jsonb_typeof(p_shops) <> 'array' then
      raise exception 'resolver: shops must be an array of 1 to 5 links' using errcode = '22023';
    end if;
    -- the links, trimmed (a link that is not text is kept as it is and fails the check below)
    select coalesce(jsonb_agg(case when jsonb_typeof(x.v) = 'string' then to_jsonb(btrim(x.v #>> '{}')) else x.v end order by x.o), '[]'::jsonb)
      into shops from jsonb_array_elements(p_shops) with ordinality as x(v, o);
    select source_url into src from public.products where id = p_id and active and compare_state = 'wanted' and source_url is not null;
    -- validated also when the product is not waiting (then against a placeholder shop), so that a bad call is always an error
    err := public.extra_urls_error(coalesce(src, 'https://placeholder-shop.invalid/vare'), shops);
    if err is not null then
      raise exception 'resolver: %', err using errcode = '22023';
    end if;
    update public.products
       set extra_urls = shops, extra_state = null, compare_state = 'done', compare_at = now()
     where id = p_id and active and compare_state = 'wanted' and source_url is not null;
    get diagnostics n = row_count;
    return n = 1;
  end if;
  if p_url is null then
    -- not found elsewhere. A product the agent switched to Prisjagt earlier (source on prisjagt.dk, shop_url kept) stays switched: 'done'.
    update public.products
       set compare_state = case when source_url ~* '^https://(www\.)?prisjagt\.dk([/?#]|$)' and shop_url is not null then 'done' else 'none' end,
           compare_at = now()
     where id = p_id and active and compare_state = 'wanted';
    get diagnostics n = row_count;
    return n = 1;
  end if;
  u := regexp_replace(btrim(p_url), '^https://www\.prisjagt\.dk/', 'https://prisjagt.dk/');
  if u !~ '^https://prisjagt\.dk/product\.php\?p=[0-9]{1,18}$' then
    raise exception 'resolver: not a prisjagt.dk product link' using errcode = '22023';
  end if;
  -- the page the product is on already (a re-check after changed requirements found the same page right): nothing is reset
  update public.products
     set compare_state = 'done', compare_at = now()
   where id = p_id and active and compare_state = 'wanted' and source_url = u;
  get diagnostics n = row_count;
  if n = 1 then return true; end if;
  -- the same reset as the source_url block of products_guard (without the alternatives, which stay)
  update public.products
     set shop_url = case when source_url ~* '^https://(www\.)?prisjagt\.dk([/?#]|$)' then shop_url else source_url end,
         source_url = u, compare_state = 'done', compare_at = now(), req_state = null,
         status = 'pending', tracked_variants = null,
         title = null, variants = null, offers = null, history = null,
         normal_price = null, verdict = null, warning = null, check_note = null,
         last_checked = null, notified_price = null, notified_at = null, backfill_state = null,
         digest_price = null, digest_at = null, extra_urls = null, extra_state = null
   where id = p_id and active and compare_state = 'wanted' and source_url is not null;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.resolver_list() from public;
revoke all on function public.resolver_set(uuid, text) from public;
revoke all on function public.resolver_fail(uuid, text) from public;
revoke all on function public.resolver_compare(uuid, text, jsonb) from public;
revoke all on function public.resolver_variants(uuid, jsonb) from public;
grant execute on function public.resolver_list() to anon, authenticated;
grant execute on function public.resolver_variants(uuid, jsonb) to anon, authenticated;
grant execute on function public.resolver_set(uuid, text) to anon, authenticated;
grant execute on function public.resolver_fail(uuid, text) to anon, authenticated;
grant execute on function public.resolver_compare(uuid, text, jsonb) to anon, authenticated;

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
-- A signed-in caller (a JWT with an e-mail claim) always asks for their OWN address: p_email is ignored, so nobody can file requests
-- for others. Anonymous callers (the login screen, no e-mail claim) and the service role use p_email.
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
  if coalesce(auth.jwt() ->> 'email', '') <> '' then
    e := lower(btrim(auth.jwt() ->> 'email'));
  end if;
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

-- The signed-in caller's own access state, by the JWT e-mail: 'allowed' | 'pending' | 'rejected' | 'none'. The site shows its
-- no-access screen from this. Reveals nothing about other addresses.
create or replace function public.my_access()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (select 1 from public.allowed_emails a where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))) then 'allowed'
    else coalesce(
      (select r.status from public.access_requests r
        where r.email = lower(coalesce(auth.jwt() ->> 'email', '')) and r.status in ('pending', 'rejected')),
      'none')
  end;
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated, service_role;

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
