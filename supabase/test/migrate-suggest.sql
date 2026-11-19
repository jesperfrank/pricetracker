\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "Mente du" (supabase/test/schema-pre-suggest.sql is that schema.sql, unchanged), with rows in it:
-- a tracked product in a shared list, a name-only product that waits, a name-only product that failed. The new schema.sql is then
-- applied twice, as the push to the live database does it, and a third time after name_options holds data. (The last step on its own.)
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
insert into public.products (id, user_id, name, source_url, target_type, status, title, offers, list_id, check_note) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', '00000000-0000-0000-0000-00000000aa01', null),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'airfryer fra philips', null, 'auto', 'pending', null, null, '00000000-0000-0000-0000-00000000aa01', null),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'noget uden hit', null, 'auto', 'error', null, null, null, 'Produktet blev ikke fundet.');
update public.resolver_secret set token = repeat('a', 64);
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
select t.chk('old schema: no name_options column, no resolver_suggest, no name_options_error',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'name_options')
  and (select count(*) = 0 from pg_proc where proname in ('resolver_suggest', 'name_options_error')));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the column, the helper, the function and one check exist',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'name_options' and data_type = 'jsonb')
  and (select count(*) = 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolver_suggest')
  and (select count(*) = 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'name_options_error')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_name_options_check'));
select t.chk('migrated twice: the old rows are intact and have no options',
  (select count(*) = 3 and bool_and(name_options is null) from public.products)
  and (select status = 'pending' and check_note is null from public.products where name = 'noget uden hit')     -- the one-time repair of failed name lookups (schema_marks)
  and (select count(*) = 1 from public.list_members));
select t.chk('migrated twice: the agent sees the waiting name-only row and the failed one that the one-time repair put back',
  (select array_agg(name order by name) from public.resolver_list() where kind = 'name') = array['airfryer fra philips', 'noget uden hit']);
set role anon;
select t.chk('migrated: the agent gives up on the repaired row again (the state the rest of this test starts from)', public.resolver_fail('00000000-0000-0000-0000-0000000000f3', 'Produktet blev ikke fundet.'));
reset role;

-- the agent suggests for the waiting product, the person (A, owner) and B (a member of the list) act on the migrated data
set role anon;
select t.chk('migrated: resolver_suggest stores two options and the row leaves the queue',
  public.resolver_suggest('00000000-0000-0000-0000-0000000000f2', '[{"name":"Philips Airfryer HD9270","url":"https://www.prisjagt.dk/product.php?p=100","price":1299,"store":"Proshop"},{"name":"Philips Airfryer 3000","url":"https://prisjagt.dk/product.php?p=101"}]'));
select t.chk('migrated: ... and the row is out of the queue', (select count(*) = 0 from public.resolver_list() where kind = 'name'));
select t.chk('migrated: ... the failed product is not waiting: false', public.resolver_suggest('00000000-0000-0000-0000-0000000000f3', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') = false);
reset role;
select t.chk('migrated: ... stored without www', (select name_options -> 0 ->> 'url' = 'https://prisjagt.dk/product.php?p=100' and source_url is null and status = 'pending' from public.products where name = 'airfryer fra philips'));
set role authenticated;
select t.asB();
select t.chk('migrated: B (a member) sees the options and cannot choose, rename or clear',
  (select jsonb_array_length(name_options) = 2 from public.products where name = 'airfryer fra philips')
  and t.err($$update public.products set source_url = 'https://prisjagt.dk/product.php?p=100' where name = 'airfryer fra philips'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set name = 'andet' where name = 'airfryer fra philips'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set name_options = null where name = 'airfryer fra philips'$$) like 'Kun den, der har tilføjet%');
select t.asA();
update public.products set name = 'philips airfryer xxl' where name = 'airfryer fra philips';
select t.chk('migrated: A types a new name: options gone, queued again', (select name_options is null and status = 'pending' from public.products where name = 'philips airfryer xxl'));
update public.products set name = 'noget uden hit 2' where name = 'noget uden hit';
select t.chk('migrated: A types a new name on the failed one: pending, note gone', (select status = 'pending' and check_note is null from public.products where name = 'noget uden hit 2'));
reset role;
set role anon;
select t.chk('migrated: both are in the queue now', (select array_agg(name order by name) from public.resolver_list() where kind = 'name') = array['noget uden hit 2', 'philips airfryer xxl']);
select t.chk('migrated: a second round of options, then A chooses one',
  public.resolver_suggest('00000000-0000-0000-0000-0000000000f2', '[{"name":"Philips Airfryer XXL","url":"https://prisjagt.dk/product.php?p=200"},{"name":"Philips Airfryer XL","url":"https://shop.example.dk/xl","price":999.5}]'));
reset role;
set role authenticated;
select t.asA();
update public.products set source_url = 'https://prisjagt.dk/product.php?p=200' where name = 'philips airfryer xxl';
select t.chk('migrated: A chooses: link set, options gone, pending', (select name_options is null and status = 'pending' and source_url = 'https://prisjagt.dk/product.php?p=200' from public.products where name = 'philips airfryer xxl'));
reset role;
set role anon;
select public.resolver_suggest('00000000-0000-0000-0000-0000000000f3', '[{"name":"Sort","url":"https://shop.example.dk/s1"},{"name":"Hvid","url":"https://shop.example.dk/s2"}]');
reset role;

-- a third run keeps the data and the state
\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the options and the old rows',
  (select jsonb_array_length(name_options) = 2 and source_url is null from public.products where name = 'noget uden hit 2')
  and (select status = 'tracking' from public.products where name = 'mors-ting') and (select count(*) = 3 from public.products));
select 'SUGGEST MIGRATION CHECKS PASSED' as result;
