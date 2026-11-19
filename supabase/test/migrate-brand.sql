\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before the brand shop probe / diag_products / prisjagt-only AI links (supabase/test/schema-pre-brand.sql is that
-- schema.sql, unchanged), with rows in it: a Prisjagt product with offers and extra shops, a single-shop product, answers of the AI agent that hold
-- shop links. The new schema.sql (table brand_shops, diag_products(), the stricter ai_alt_set / ai_ask_set) is applied twice, as the push to the live
-- database does it, and a third time after the new rules have been used. (migrate-discover.sql checks the step before this one.)
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
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, history, tracked_variants, notified_price, compare_state, compare_at, extra_urls, extra_state, discover_state, alt_requested_at, alternatives, alt_done_at, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'saros', 'https://prisjagt.dk/product.php?p=16373878', 'price', 4000, 'tracking', 'Roborock Saros 10R', '[{"store":"Elgiganten","price":5500,"inStock":true}]', '[{"d":"2026-11-01","p":5500,"s":"Elgiganten","src":"check"}]', array['1'], 5500, 'done', now() - interval '5 days',
   '["https://dk.roborock.com/products/roborock-saros-10r"]', '{"https://dk.roborock.com/products/roborock-saros-10r":{"origin":"search","seen":true}}', '{"at":"2026-11-10T10:00:00Z","found":3,"added":1,"note":"ny butik"}', null, null, null, now() - interval '9 days'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b2', 'fars-ting', 'https://shop.example.dk/a', 'auto', null, 'tracking', 'Fars ting', '[{"store":"X","price":90,"inStock":true}]', '[]', array['shop'], 90, 'done', now() - interval '3 days', null, null, null,
   now() - interval '2 hours', null, null, now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a1', 'mors-gamle', 'https://shop.example.dk/b', 'auto', null, 'tracking', 'Mors gamle', '[{"store":"X","price":90,"inStock":true}]', '[]', array['shop'], 90, 'done', now() - interval '3 days', null, null, null,
   now() - interval '3 days', '[{"kind":"similar","name":"Gammel","url":"https://shop.example.dk/gammel","store":"Shop","price":99,"why":"Et gammelt svar."}]', now() - interval '2 days', now() - interval '3 days');
select t.chk('old schema: no brand_shops table, no diag_products()',
  to_regclass('public.brand_shops') is null and (select count(*) = 0 from pg_proc where proname = 'diag_products' and pronamespace = 'public'::regnamespace));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the table is there once (empty, closed to the browser roles, open to the service role), one diag_products and one products_guard, rows intact',
  to_regclass('public.brand_shops') is not null and (select count(*) = 0 from public.brand_shops) and (select relrowsecurity from pg_class where oid = 'public.brand_shops'::regclass)
  and not has_table_privilege('authenticated', 'public.brand_shops', 'select') and not has_table_privilege('anon', 'public.brand_shops', 'insert') and has_table_privilege('service_role', 'public.brand_shops', 'insert')
  and (select count(*) = 1 from pg_proc where proname = 'diag_products' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'products_guard' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 3 from public.products) and (select notified_price = 5500 and compare_state = 'done' and extra_state -> 'https://dk.roborock.com/products/roborock-saros-10r' ->> 'origin' = 'search' from public.products where name = 'saros'));
select t.chk('migrated: the answer the agent stored before (with a shop link) is not touched',
  (select alternatives -> 0 ->> 'url' = 'https://shop.example.dk/gammel' from public.products where name = 'mors-gamle'));

set role service_role;
select t.chk('migrated: the job keeps the brand cache and writes the origin brand with the service role',
  t.err($$insert into public.brand_shops (brand, base, sitemaps, status) values ('roborock', 'https://dk.roborock.com', '["https://dk.roborock.com/sitemap.xml"]', 'ok')$$) = 'ok1'
  and t.err($$update public.products set extra_state = '{"https://dk.roborock.com/products/roborock-saros-10r":{"origin":"brand"}}' where name = 'saros'$$) = 'ok1');
reset role;

select set_config('request.headers', '{"x-resolver-token":"' || (select token from public.resolver_secret) || '"}', false);
set role anon;
select t.chk('migrated: the agent''s answers need a prisjagt.dk product link now; a shop link is refused, a www. link is stored without www.',
  t.err($$select public.ai_alt_set('00000000-0000-0000-0000-0000000000f3', '[{"kind":"similar","name":"L","url":"https://shop.example.dk/l","store":"Shop","price":99,"why":"Ens."}]')$$) like '%url is not valid%'
  and t.q($$select public.ai_alt_set('00000000-0000-0000-0000-0000000000f3', '[{"kind":"similar","name":"L","url":"https://www.prisjagt.dk/product.php?p=777","store":"Shop","price":99,"why":"Ens."}]')$$) = 'true');
reset role;
select t.chk('migrated: ... stored', (select alternatives -> 0 ->> 'url' = 'https://prisjagt.dk/product.php?p=777' from public.products where name = 'fars-ting'));
select t.chk('migrated: diag_products works with the token and shows only the administrator''s products',
  (select array_agg(x.name order by x.name) from (select name from public.diag_products()) x) = array['mors-gamle', 'saros']);
select set_config('request.headers', '{}', false);
set role anon;
select t.chk('migrated: ... and nothing without it', t.err($$select * from public.diag_products()$$) = 'resolver: invalid or missing token');
reset role;

\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the data, the cache row and the answers',
  (select count(*) = 3 from public.products) and (select count(*) = 1 from public.brand_shops where brand = 'roborock')
  and (select alternatives -> 0 ->> 'url' = 'https://prisjagt.dk/product.php?p=777' from public.products where name = 'fars-ting')
  and (select alternatives -> 0 ->> 'url' = 'https://shop.example.dk/gammel' from public.products where name = 'mors-gamle')
  and (select extra_state -> 'https://dk.roborock.com/products/roborock-saros-10r' ->> 'origin' = 'brand' from public.products where name = 'saros'));
select 'BRAND MIGRATION CHECKS PASSED' as result;
