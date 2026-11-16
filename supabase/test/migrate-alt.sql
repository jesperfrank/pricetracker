\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "Alternativer" (supabase/test/schema-pre-alternatives.sql is that schema.sql, unchanged),
-- with rows in it, including a person who has never heard of alternatives and one shared list. The new schema.sql is then
-- applied twice, as the push to the live database does it, and a third time after the new columns hold data.
-- (migrate.sql keeps checking the older jump, from before list sharing; this one checks the last step on its own.)
create schema t;
grant usage on schema t to public;
create function t.chk(name text, ok boolean) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'ok   %', name;
end $$;
create function t.asA() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false) $$;
create function t.asB() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"far@familie.dk","sub":"00000000-0000-0000-0000-0000000000b2"}', false) $$;
create function t.err(q text) returns text language plpgsql as $$
declare n integer; begin execute q; get diagnostics n = row_count; return 'ok' || n; exception when others then return sqlerrm; end $$;
create function t.q(q text) returns text language plpgsql security definer as $$ declare r text; begin execute q into r; return r; end $$;
grant execute on all functions in schema t to public;

\o /dev/null
\i :old
\o
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk'), ('00000000-0000-0000-0000-0000000000b2', 'far@familie.dk');
insert into public.allowed_emails (email, added_at) values ('mor@familie.dk', '2026-01-01'), ('far@familie.dk', '2026-02-01') on conflict (email) do nothing;
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'Gaver');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2');
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, normal_price, list_id, bought_at, bought_by, bought_price) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', null, 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', 120, '00000000-0000-0000-0000-00000000aa01', null, null, null),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-ting', 'https://shop.example.dk/b', 'price', 50, 'tracking', 'Fars ting', '[]', null, null, now(), '00000000-0000-0000-0000-0000000000b2', 40);
select t.chk('old schema: no alternatives columns, no log table, no ai functions',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('alt_requested_at', 'alternatives', 'alt_done_at', 'alt_note'))
  and to_regclass('public.alt_attempts') is null and (select count(*) = 0 from pg_proc where proname like 'ai_alt%'));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the four columns, the log table, the four functions and the guard exist once',
  (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('alt_requested_at', 'alternatives', 'alt_done_at', 'alt_note'))
  and to_regclass('public.alt_attempts') is not null
  and (select count(*) = 4 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('ai_alt_list', 'ai_alt_set', 'ai_alt_fail', 'alt_take_slot'))
  and (select count(*) = 1 from pg_trigger where tgname = 'products_guard_trg'));
select t.chk('migrated twice: the rows are intact and have no alternatives data',
  (select count(*) = 2 from public.products) and (select count(*) = 2 from public.products where alt_requested_at is null and alternatives is null and alt_done_at is null and alt_note is null)
  and (select bought_by is not null and bought_price = 40 from public.products where name = 'fars-ting') and (select count(*) = 1 from public.list_members));
select t.chk('migrated twice: exactly one check on alternatives and one on alt_note',
  (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and pg_get_constraintdef(oid) ~ 'alternatives')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and pg_get_constraintdef(oid) ~ 'alt_note'));

-- the person asks, the agent answers, on the migrated data
update public.resolver_secret set token = repeat('a', 64);
set role authenticated;
select t.asA();
select t.chk('migrated: A asks for alternatives on the old row', t.err($$update public.products set alt_requested_at = now() where name = 'mors-ting'$$) = 'ok1');
select t.chk('migrated: ... and cannot write the answer', t.err($$update public.products set alternatives = '[]', alt_done_at = now(), alt_note = 'x' where name = 'mors-ting'$$) = 'ok1'
  and t.q($$select (alternatives is null and alt_done_at is null and alt_note is null)::text from public.products where name = 'mors-ting'$$) = 'true');
select t.asB();
select t.chk('migrated: B (a member of the list) cannot ask for A''s product', t.err($$update public.products set alt_requested_at = now() where name = 'mors-ting'$$) like 'Kun den, der har tilføjet%');
select t.chk('migrated: B asks for B''s own', t.err($$update public.products set alt_requested_at = now() where name = 'fars-ting'$$) = 'ok1');
reset role;
select t.chk('migrated: two requests are in the log', (select count(*) = 2 from public.alt_attempts));
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
set role anon;
select t.chk('migrated: the agent lists both (oldest first), answers one, fails the other',
  (select array_agg(title order by requested_at) from public.ai_alt_list()) = array['Mors ting', 'Fars ting']
  and (select price = 90 and normal_price = 120 and host = 'shop.example.dk' from public.ai_alt_list() where title = 'Mors ting'));
select t.chk('migrated: ... answer', public.ai_alt_set('00000000-0000-0000-0000-0000000000f1',
  '[{"kind":"similar","name":"Lignende","url":"https://shop.example.dk/l","store":"Shop","price":99,"why":"Næsten det samme."}]'));
select t.chk('migrated: ... fail', public.ai_alt_fail('00000000-0000-0000-0000-0000000000f2', 'Ingen fundet.'));
reset role;

-- a third run keeps the data and the state
\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the answer, the note, the request log and everything else',
  (select alternatives -> 0 ->> 'name' = 'Lignende' and alt_done_at is not null and alt_note is null from public.products where name = 'mors-ting')
  and (select alternatives is null and alt_note = 'Ingen fundet.' from public.products where name = 'fars-ting')
  and (select count(*) = 2 from public.alt_attempts) and (select count(*) = 2 from public.products) and (select count(*) = 1 from public.list_members));
select 'ALTERNATIVES MIGRATION CHECKS PASSED' as result;
