\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "extra shops for Prisjagt products" (supabase/test/schema-pre-pjextra.sql is that schema.sql, unchanged),
-- with rows in it: a Prisjagt product the agent switched earlier (compare done, shop_url), one that waits, a single-shop product with extra shops.
-- The new schema.sql is applied twice, as the push to the live database does it (resolver_list gets a column, so it is dropped and created
-- again), and a third time after the new rules have been used. The old schema refuses extra shops on a Prisjagt product; the new one accepts them.
-- (migrate-suggest.sql checks the step before this one.)
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
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, history, tracked_variants, notified_price, compare_state, compare_at, shop_url, extra_urls, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'saros', 'https://prisjagt.dk/product.php?p=16373878', 'price', 4000, 'tracking', 'Roborock Saros 10R', '[{"store":"Elgiganten","price":5500,"inStock":true},{"store":"Proshop","price":5600,"inStock":true}]', '[{"d":"2026-11-01","p":5500,"s":"Elgiganten","src":"check"}]', array['1'], 5500, 'done', now() - interval '5 days', 'https://shop.example.dk/saros', null, now() - interval '9 days'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-pj', 'https://prisjagt.dk/product.php?p=2', 'price', 50, 'tracking', 'Fars ting', '[{"store":"X","price":90,"inStock":true}]', '[]', array['1'], null, 'wanted', now() - interval '2 hours', null, null, now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', null, 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', '[]', array['shop'], 90, 'done', now() - interval '3 days', null, '["https://a.example.dk/1"]', now() - interval '3 days');
update public.resolver_secret set token = repeat('a', 64);
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
select t.chk('old schema: a Prisjagt product cannot have extra shops, resolver_list has 8 columns',
  t.err($$update public.products set extra_urls = '["https://www.roborock.com/dk/saros"]' where name = 'saros'$$) like '%products_extra_urls_check%'
  and (select array_length(proargnames, 1) = 8 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: one resolver_list with a shops column, one resolver_compare (three arguments), one products_guard, rows intact',
  (select count(*) = 1 and bool_and(array_length(proargnames, 1) = 9 and proargnames[9] = 'shops') from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 and bool_and(pronargs = 3) from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'products_guard' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 3 from public.products) and (select notified_price = 5500 and compare_state = 'done' and shop_url is not null from public.products where name = 'saros'));
select t.chk('migrated twice: grants as they were, the secret token is kept',
  has_function_privilege('anon', 'public.resolver_list()', 'execute') and has_function_privilege('authenticated', 'public.resolver_compare(uuid, text, jsonb)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name in ('resolver_list', 'resolver_compare', 'resolver_set', 'resolver_fail') and grantee = 'PUBLIC')
  and (select count(*) = 1 and bool_and(token = repeat('a', 64)) from public.resolver_secret));
select t.chk('migrated: extra shops on a Prisjagt product are accepted by the check now',
  t.err($$update public.products set extra_urls = '["https://www.roborock.com/dk/saros"]' where name = 'saros'$$) = 'ok1'
  and t.err($$update public.products set extra_urls = null where name = 'saros'$$) = 'ok1'
  and t.err($$update public.products set extra_urls = '["https://prisjagt.dk/product.php?p=1"]' where name = 'saros'$$) like '%products_extra_urls_check%');

set role anon;
select t.chk('migrated: the waiting Prisjagt product is a compare row with the shops of its offers; the agent answers it with shops',
  (select kind = 'compare' and host = 'prisjagt.dk' and shops = '["X"]'::jsonb from public.resolver_list() where name = 'Fars ting')
  and public.resolver_compare('00000000-0000-0000-0000-0000000000f2', null, '["https://www.roborock.com/dk/x"]') = true
  and t.q($$select (extra_urls = '["https://www.roborock.com/dk/x"]'::jsonb and compare_state = 'done' and source_url = 'https://prisjagt.dk/product.php?p=2' and status = 'tracking')::text from public.products where name = 'fars-pj'$$) = 'true');
reset role;

set role authenticated;
select t.asA();
select t.chk('migrated: A adds one link to the switched Prisjagt product and to the single-shop one; compare_state and the price state stay',
  t.err($$update public.products set extra_urls = '["https://www.roborock.com/dk/saros"]' where name = 'saros'$$) = 'ok1'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1", "https://b.example.dk/2"]' where name = 'mors-ting'$$) = 'ok1'
  and t.q($$select (extra_urls = '["https://www.roborock.com/dk/saros"]'::jsonb and compare_state = 'done' and notified_price = 5500 and history is not null)::text from public.products where name = 'saros'$$) = 'true'
  and t.q($$select (jsonb_array_length(extra_urls) = 2 and compare_state = 'done')::text from public.products where name = 'mors-ting'$$) = 'true');
select t.chk('migrated: wrong links get the Danish errors, a replacement of the list is ignored',
  t.err($$update public.products set extra_urls = '["https://www.roborock.com/dk/saros", "https://roborock.com/dk/andet"]' where name = 'saros'$$) = 'Den butik følges allerede.'
  and t.err($$update public.products set extra_urls = '["https://www.roborock.com/dk/saros", "https://www.prisjagt.dk/product.php?p=3"]' where name = 'saros'$$) = 'Brug et link til varens egen side i butikken.'
  and t.err($$update public.products set extra_urls = '["https://x.example.dk/1", "https://y.example.dk/2"]' where name = 'saros'$$) = 'ok1'
  and t.q($$select extra_urls::text from public.products where name = 'saros'$$) = '["https://www.roborock.com/dk/saros"]');
reset role;

\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the data and everything else',
  (select count(*) = 3 from public.products) and (select jsonb_array_length(extra_urls) = 2 and notified_price = 90 from public.products where name = 'mors-ting')
  and (select extra_urls = '["https://www.roborock.com/dk/saros"]'::jsonb from public.products where name = 'saros')
  and (select count(*) = 1 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace));
select 'PJEXTRA MIGRATION CHECKS PASSED' as result;
