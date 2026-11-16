\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before the compare retry counter (supabase/test/schema-pre-tries.sql is that schema.sql, unchanged), with rows
-- in it, one of them in a shared list. The new schema.sql is applied twice, as the push to the live database does it, and a third time
-- after the new column holds data. (migrate-image.sql checks the step before this one.)
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
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, history, notified_price, list_id, created_at, compare_state, compare_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', null, 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', '[{"d":"2026-11-01","p":95,"s":"X","src":"check"}]', 90, '00000000-0000-0000-0000-00000000aa01', now() - interval '3 days', 'none', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-ting', 'https://prisjagt.dk/product.php?p=1', 'price', 50, 'pending', null, null, null, null, null, now() - interval '1 day', null, null);
select t.chk('old schema: no compare_tries column',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'compare_tries'));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: one not-null compare_tries column, 0 on every existing row, rows intact',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'compare_tries' and is_nullable = 'NO')
  and (select count(*) = 2 from public.products) and (select count(*) = 2 from public.products where compare_tries = 0)
  and (select notified_price = 90 and compare_state = 'none' and list_id is not null from public.products where name = 'mors-ting'));

set role authenticated;
select t.asA();
select t.chk('migrated: A cannot set compare_tries, but the rest of the update goes through',
  t.err($$update public.products set compare_tries = 3, name = 'mors-ting2' where name = 'mors-ting'$$) = 'ok1'
  and t.q($$select (compare_tries = 0 and name = 'mors-ting2')::text from public.products where id = '00000000-0000-0000-0000-0000000000f1'$$) = 'true');
select t.chk('migrated: a none from 2 hours ago can be asked again (1 hour rule)',
  t.err($$update public.products set compare_state = 'wanted' where name = 'mors-ting2'$$) = 'ok1'
  and t.q($$select (compare_state = 'wanted' and compare_tries = 0)::text from public.products where name = 'mors-ting2'$$) = 'true');
select t.asB();
select t.chk('migrated: B (member) cannot set it on A''s product',
  t.err($$update public.products set compare_tries = 2 where id = '00000000-0000-0000-0000-0000000000f1'$$) like 'Kun den, der har tilføjet%');
reset role;
update public.products set compare_tries = 2 where id = '00000000-0000-0000-0000-0000000000f1';
select t.chk('migrated: the job can store it', (select compare_tries = 2 from public.products where name = 'mors-ting2'));

\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the counter and everything else',
  (select count(*) = 2 from public.products) and (select compare_tries = 2 and notified_price = 90 from public.products where name = 'mors-ting2')
  and (select count(*) = 1 from public.list_members));
select 'TRIES MIGRATION CHECKS PASSED' as result;
