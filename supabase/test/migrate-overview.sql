\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "one mail per deal / opt-in mail / daily overview" (supabase/test/schema-pre-overview.sql is that schema.sql,
-- unchanged), with rows in it. The new schema.sql is applied twice, as the push to the live database does it, and a third time after the new columns
-- hold data. Existing profiles keep their switches exactly; every existing profile counts as "asked"; every existing product gets 24 hours of quiet,
-- once; nothing of that is repeated by a re-run.
create schema t;
grant usage on schema t to public;
create function t.chk(name text, ok boolean) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'ok   %', name;
end $$;
create function t.asA() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false) $$;
create function t.asB() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"far@familie.dk","sub":"00000000-0000-0000-0000-0000000000b2"}', false) $$;
create function t.asC() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"ny@familie.dk","sub":"00000000-0000-0000-0000-0000000000c3"}', false) $$;
create function t.err(q text) returns text language plpgsql as $$
declare n integer; begin execute q; get diagnostics n = row_count; return 'ok' || n; exception when others then return sqlerrm; end $$;
grant execute on all functions in schema t to public;

\o /dev/null
\i :old
\o
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk'), ('00000000-0000-0000-0000-0000000000b2', 'far@familie.dk'), ('00000000-0000-0000-0000-0000000000c3', 'ny@familie.dk');
insert into public.allowed_emails (email, added_at) values ('mor@familie.dk', '2026-01-01'), ('far@familie.dk', '2026-02-01'), ('ny@familie.dk', '2026-03-01') on conflict (email) do nothing;
-- a: mail on (the old default), b: switched off by the person, a third person has products but no profile row
insert into public.profiles (user_id, notify_email, mail_digest) values ('00000000-0000-0000-0000-0000000000a1', true, true), ('00000000-0000-0000-0000-0000000000b2', false, false);
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, offers, history, notified_price, notified_at, digest_price, digest_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'price', 100, 'tracking', '[{"store":"X","price":90,"inStock":true}]', '[]', 90, '2026-11-10 10:00:00+00', 90, '2026-11-10 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-sko', 'https://shop.example.dk/b', 'auto', null, 'tracking', null, null, null, null, null, null),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c3', 'uden-profil', 'https://shop.example.dk/c', 'price', 50, 'tracking', null, null, null, null, null, null);
select t.chk('old schema: no quiet column, no asked column, notify_email defaults to true',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and column_name in ('notify_silent_until', 'mail_asked_at'))
  and (select column_default = 'true' from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'notify_email'));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: both columns exist (nullable), notify_email now defaults to false',
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and column_name in ('notify_silent_until', 'mail_asked_at') and table_name in ('products', 'profiles') and is_nullable = 'YES')
  and (select column_default = 'false' from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'notify_email'));
select t.chk('migrated twice: existing profiles keep their switches exactly (on stays on, off stays off, overview as it was) and none is asked again',
  (select count(*) = 2 and bool_and(mail_asked_at is not null) from public.profiles)
  and (select notify_email and mail_digest from public.profiles where user_id = '00000000-0000-0000-0000-0000000000a1')
  and (select not notify_email and not mail_digest from public.profiles where user_id = '00000000-0000-0000-0000-0000000000b2'));
select t.chk('migrated twice: every existing product has its 24 hours of quiet (once), notified state and rows are intact',
  (select count(*) = 3 and bool_and(notify_silent_until > now() + interval '23 hours' and notify_silent_until <= now() + interval '24 hours') from public.products)
  and (select notified_price = 90 and notified_at = '2026-11-10 10:00:00+00' and digest_price = 90 from public.products where name = 'mors-ting')
  and (select count(*) = 2 from public.profiles) and (select count(*) = 0 from public.profiles where user_id = '00000000-0000-0000-0000-0000000000c3'));
create table t.before as select id, notify_silent_until as q from public.products;
create table t.pbefore as select user_id, mail_asked_at as a from public.profiles;

select pg_sleep(1.1);
\o /dev/null
\i :new
\o
select t.chk('a third run moves neither the quiet period nor the asked time',
  (select count(*) = 3 and bool_and(p.notify_silent_until = b.q) from public.products p join t.before b using (id))
  and (select count(*) = 2 and bool_and(p.mail_asked_at = b.a) from public.profiles p join t.pbefore b using (user_id)));

set role authenticated;
select t.asC();
insert into public.profiles (user_id) values ('00000000-0000-0000-0000-0000000000c3');
select t.chk('a new person after the migration: mail off, overview off, not asked yet',
  (select not notify_email and not mail_digest and mail_asked_at is null from public.profiles));
update public.profiles set notify_email = true, mail_asked_at = '2001-01-01';
select t.chk('... says yes: on, with the server time', (select notify_email and mail_asked_at > now() - interval '1 minute' from public.profiles));
insert into public.products (id, user_id, name, source_url, target_type) values ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000c3', 'ny-ting', 'https://shop.example.dk/d', 'auto');
select t.chk('a new product has no quiet period', (select notify_silent_until is null from public.products where name = 'ny-ting'));
select t.asA();
update public.products set target_value = 80 where name = 'mors-ting';
select t.chk('migrated: a changed goal clears the notified fields, the quiet period stays',
  (select notified_price is null and notified_at is null and digest_price = 90 and notify_silent_until is not null from public.products where name = 'mors-ting'));
reset role;
select 'OVERVIEW MIGRATION CHECKS PASSED' as result;
