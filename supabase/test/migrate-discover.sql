\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "Butikssøgning" (supabase/test/schema-pre-discover.sql is that schema.sql, unchanged), with rows in it:
-- a Prisjagt product with offers, a waiting one, a single-shop product with extra shops. The new schema.sql (products.discover_state, the table
-- discover_usage, the guard) is applied twice, as the push to the live database does it, and a third time after the new rules have been used.
-- (migrate-pjextra.sql checks the step before this one.)
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
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, history, tracked_variants, notified_price, compare_state, compare_at, extra_urls, extra_state, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'saros', 'https://prisjagt.dk/product.php?p=16373878', 'price', 4000, 'tracking', 'Roborock Saros 10R', '[{"store":"Elgiganten","price":5500,"inStock":true}]', '[{"d":"2026-11-01","p":5500,"s":"Elgiganten","src":"check"}]', array['1'], 5500, 'done', now() - interval '5 days', null, null, now() - interval '9 days'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', null, 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', '[]', array['shop'], 90, 'done', now() - interval '3 days', '["https://a.example.dk/1"]', '{"https://a.example.dk/1":{"seen":true,"fails":0}}', now() - interval '3 days');
select t.chk('old schema: no discover_state column, no discover_usage table',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'discover_state')
  and to_regclass('public.discover_usage') is null);

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the column, the check and the table are there once, rows intact, discover_state null',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'discover_state')
  and (select count(*) = 1 from pg_constraint where conname = 'products_discover_state_check')
  and to_regclass('public.discover_usage') is not null and (select count(*) = 0 from public.discover_usage)
  and (select count(*) = 2 from public.products) and (select count(*) = 2 from public.products where discover_state is null)
  and (select notified_price = 5500 and compare_state = 'done' from public.products where name = 'saros')
  and (select extra_state -> 'https://a.example.dk/1' ->> 'seen' = 'true' from public.products where name = 'mors-ting'));
select t.chk('migrated twice: one products_guard, the counter is closed to the browser roles and open to the service role',
  (select count(*) = 1 from pg_proc where proname = 'products_guard' and pronamespace = 'public'::regnamespace)
  and (select relrowsecurity from pg_class where oid = 'public.discover_usage'::regclass)
  and not has_table_privilege('authenticated', 'public.discover_usage', 'select') and not has_table_privilege('anon', 'public.discover_usage', 'insert')
  and has_table_privilege('service_role', 'public.discover_usage', 'insert'));

set role service_role;
select t.chk('migrated: the job writes the found shop, its origin and the search state with the service role, the rule of extra_urls applies',
  t.err($$update public.products set extra_urls = '["https://www.roborock.com/dk/saros-10r"]', extra_state = '{"https://www.roborock.com/dk/saros-10r":{"origin":"search"}}', discover_state = '{"at":"2026-11-16T10:00:00Z","found":1,"added":1,"note":"ok"}' where name = 'saros'$$) = 'ok1'
  and t.err($$update public.products set extra_urls = '["https://prisjagt.dk/product.php?p=1"]' where name = 'saros'$$) like '%products_extra_urls_check%'
  and t.err($$insert into public.discover_usage (month, calls) values ('2026-11', 3)$$) = 'ok1');
reset role;

set role authenticated;
select t.asA();
select t.chk('migrated: the browser cannot write discover_state, hand-adding a link keeps the search state, new requirements clear it',
  t.err($$update public.products set discover_state = null where name = 'saros'$$) = 'ok1'
  and t.q($$select (discover_state ->> 'added' = '1')::text from public.products where name = 'saros'$$) = 'true'
  and t.err($$update public.products set extra_urls = '["https://www.roborock.com/dk/saros-10r","https://b.example.dk/1"]' where name = 'saros'$$) = 'ok1'
  and t.q($$select (discover_state ->> 'added' = '1' and extra_state -> 'https://www.roborock.com/dk/saros-10r' ->> 'origin' = 'search')::text from public.products where name = 'saros'$$) = 'true'
  and t.err($$update public.products set requirements = 'sort' where name = 'saros'$$) = 'ok1'
  and t.q($$select (discover_state is null)::text from public.products where name = 'saros'$$) = 'true');
reset role;

\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the data, the counter row and the shops',
  (select count(*) = 2 from public.products) and (select calls = 3 from public.discover_usage where month = '2026-11')
  and (select jsonb_array_length(extra_urls) = 2 and notified_price = 5500 from public.products where name = 'saros')
  and (select count(*) = 1 from pg_proc where proname = 'products_guard' and pronamespace = 'public'::regnamespace));
select 'DISCOVER MIGRATION CHECKS PASSED' as result;
