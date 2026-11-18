\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "find the cheapest shop" (supabase/test/schema-pre-compare.sql is that schema.sql, unchanged),
-- with rows in it, among them a name-only product that the old resolver_list returns. The new schema.sql is applied twice, as the push
-- to the live database does it (resolver_list changes its return type, so it is dropped and created again), and a third time after the
-- new columns hold data. (migrate-alt.sql checks the step before this one.)
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
create function t.tok(h text) returns void language sql as $$ select set_config('request.headers', case when h is null then '{}' else '{"x-resolver-token":"' || h || '"}' end, false) $$;
grant execute on all functions in schema t to public;

\o /dev/null
\i :old
\o
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk'), ('00000000-0000-0000-0000-0000000000b2', 'far@familie.dk');
insert into public.allowed_emails (email, added_at) values ('mor@familie.dk', '2026-01-01'), ('far@familie.dk', '2026-02-01') on conflict (email) do nothing;
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'Gaver');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2');
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, history, notified_price, backfill_state, list_id, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-sko', 'https://www.adidas.dk/sko/x', 'auto', null, 'error', null, null, null, null, null, '00000000-0000-0000-0000-00000000aa01', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-ting', 'https://shop.example.dk/b', 'price', 50, 'tracking', 'Fars ting', '[{"store":"Shop","price":40,"inStock":true}]', '[{"d":"2026-11-01","p":45,"s":"Shop","src":"check"}]', 40, '{"result":"done"}', null, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'navn-kun', null, 'auto', null, 'pending', null, null, null, null, null, null, now() - interval '1 day');
select t.chk('old schema: no compare columns, no resolver_compare, resolver_list has three columns',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('compare_state', 'compare_at', 'shop_url'))
  and (select count(*) = 0 from pg_proc where proname = 'resolver_compare')
  and (select array_length(proargnames, 1) = 3 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace));
update public.resolver_secret set token = repeat('a', 64);
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
set role anon;
select t.chk('old schema: the agent sees the name-only product', (select count(*) = 1 and bool_and(name = 'navn-kun') from public.resolver_list()));
reset role;

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the three columns, the two checks, exactly one resolver_list and the new resolver_compare exist',
  (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('compare_state', 'compare_at', 'shop_url'))
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_compare_state_check')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_shop_url_check')
  and (select count(*) = 1 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace)
  and (select proargnames = array['id', 'name', 'created_at', 'kind', 'host', 'price', 'req', 'variants', 'shops'] from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace));
select t.chk('migrated twice: grants are as they were (anon and authenticated may execute, public may not), the secret token is kept',
  has_function_privilege('anon', 'public.resolver_list()', 'execute') and has_function_privilege('authenticated', 'public.resolver_list()', 'execute')
  and has_function_privilege('anon', 'public.resolver_compare(uuid, text, jsonb)', 'execute') and has_function_privilege('anon', 'public.resolver_set(uuid, text)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name in ('resolver_list', 'resolver_compare', 'resolver_set', 'resolver_fail') and grantee = 'PUBLIC')
  and (select count(*) = 1 and bool_and(token = repeat('a', 64)) from public.resolver_secret));
select t.chk('migrated twice: the rows are intact and have no comparison state',
  (select count(*) = 3 from public.products) and (select count(*) = 3 from public.products where compare_state is null and compare_at is null and shop_url is null)
  and (select notified_price = 40 and backfill_state is not null and history is not null from public.products where name = 'fars-ting'));

-- the agent: the old rows come back with kind 'name'; the token is still needed
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
set role anon;
select t.chk('migrated: the agent still gets the name-only product, now with kind name and no host or price',
  (select count(*) = 1 and bool_and(name = 'navn-kun' and kind = 'name' and host is null and price is null) from public.resolver_list()));
select t.tok('fel');
select t.chk('migrated: a wrong token is still refused', t.err($$select * from public.resolver_list()$$) = 'resolver: invalid or missing token'
  and t.err($$select public.resolver_compare('00000000-0000-0000-0000-0000000000f1', null)$$) = 'resolver: invalid or missing token');
reset role;

-- the person and the agent on the migrated rows
set role authenticated;
select t.asA();
select t.chk('migrated: A asks for a comparison on the product the shop refuses', t.err($$update public.products set compare_state = 'wanted' where name = 'mors-sko'$$) = 'ok1'
  and t.q($$select (compare_state = 'wanted' and compare_at > now() - interval '1 minute')::text from public.products where name = 'mors-sko'$$) = 'true');
select t.asB();
select t.chk('migrated: B (member of the list) cannot change it', t.err($$update public.products set compare_state = 'none' where name = 'mors-sko'$$) like 'Kun den, der har tilføjet%');
select t.chk('migrated: B asks for B''s own', t.err($$update public.products set compare_state = 'wanted' where name = 'fars-ting'$$) = 'ok1');
reset role;
select t.tok(repeat('a', 64));
set role anon;
select t.chk('migrated: the agent lists the name-only product first, then the two compare rows (host, price)',
  (select array_agg(kind || ':' || name order by ord) = array['name:navn-kun', 'compare:mors-sko', 'compare:Fars ting'] from (select row_number() over () as ord, * from public.resolver_list()) x)
  and (select host = 'adidas.dk' and price is null from public.resolver_list() where name = 'mors-sko')
  and (select host = 'shop.example.dk' and price = 40 from public.resolver_list() where name = 'Fars ting'));
select t.chk('migrated: ... switches one product to Prisjagt and finds nothing for the other',
  public.resolver_compare('00000000-0000-0000-0000-0000000000f1', 'https://prisjagt.dk/product.php?p=555') and public.resolver_compare('00000000-0000-0000-0000-0000000000f2', null));
reset role;
select t.chk('migrated: ... the switched row is pending on the Prisjagt page, the original link kept, the list and the goal kept; the other has its history and state',
  (select source_url = 'https://prisjagt.dk/product.php?p=555' and shop_url = 'https://www.adidas.dk/sko/x' and compare_state = 'done' and status = 'pending' and list_id is not null and target_type = 'auto' from public.products where name = 'mors-sko')
  and (select compare_state = 'none' and source_url = 'https://shop.example.dk/b' and history is not null and notified_price = 40 and status = 'tracking' from public.products where name = 'fars-ting'));
set role authenticated;
select t.asA();
select t.chk('migrated: A goes back to the shop link (Fortryd): none, no shop_url, pending again',
  t.err($$update public.products set source_url = 'https://www.adidas.dk/sko/x' where name = 'mors-sko'$$) = 'ok1'
  and t.q($$select (compare_state = 'none' and shop_url is null and source_url = 'https://www.adidas.dk/sko/x' and status = 'pending')::text from public.products where name = 'mors-sko'$$) = 'true');
reset role;

-- a third run keeps the data and the state
\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the states and everything else',
  (select count(*) = 3 from public.products) and (select compare_state = 'none' and shop_url is null from public.products where name = 'mors-sko')
  and (select compare_state = 'none' and history is not null from public.products where name = 'fars-ting')
  and (select count(*) = 1 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace) and (select count(*) = 1 from public.list_members));
select 'COMPARE MIGRATION CHECKS PASSED' as result;
