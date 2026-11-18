\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "requirements" (supabase/test/schema-pre-requirements.sql is that schema.sql, unchanged), with rows
-- in it. The new schema.sql is applied twice, as the push to the live database does it (resolver_list gets two columns, so it is dropped and
-- created again; resolver_variants is new), and a third time after the new columns hold data.
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
insert into public.products (id, user_id, name, source_url, target_type, status, title, variants, offers, history, notified_price, list_id, compare_state, compare_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', 'tracking', 'Mors ting', '[{"id":"shop"}]', '[{"store":"X","price":90,"inStock":true}]', '[]', 90, '00000000-0000-0000-0000-00000000aa01', 'wanted', now()),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-sko', 'https://prisjagt.dk/product.php?p=1', 'auto', 'choose', 'Sko', '[{"id":"v1","label":"Hvid"},{"id":"v2","label":"Sort"}]', null, null, null, null, null, null),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'navn-kun', null, 'auto', 'pending', null, null, null, null, null, null, null, null);
update public.resolver_secret set token = repeat('a', 64);
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
select t.chk('old schema: no requirements columns, no resolver_variants, resolver_list has six columns',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('requirements', 'req_state'))
  and (select count(*) = 0 from pg_proc where proname = 'resolver_variants') and (select array_length(proargnames, 1) = 6 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the two columns (nullable), the two checks, one resolver_list (9 columns, the last one is from a later step), resolver_variants, rows intact with no requirements',
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('requirements', 'req_state') and is_nullable = 'YES')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_requirements_check')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_req_state_check')
  and (select count(*) = 1 and bool_and(array_length(proargnames, 1) = 9) from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'resolver_variants' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 3 from public.products) and (select count(*) = 3 from public.products where requirements is null and req_state is null)
  and (select notified_price = 90 and compare_state = 'wanted' and list_id is not null from public.products where name = 'mors-ting'));
select t.chk('migrated twice: grants (anon and authenticated may execute, public may not), the secret token is kept',
  has_function_privilege('anon', 'public.resolver_list()', 'execute') and has_function_privilege('authenticated', 'public.resolver_variants(uuid, jsonb)', 'execute')
  and has_function_privilege('anon', 'public.resolver_compare(uuid, text, jsonb)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name in ('resolver_list', 'resolver_variants', 'resolver_compare', 'resolver_set', 'resolver_fail') and grantee = 'PUBLIC')
  and (select count(*) = 1 and bool_and(token = repeat('a', 64)) from public.resolver_secret));
set role anon;
select t.chk('migrated: the agent still gets the old rows (name and compare) with req null and no variants; a wrong token is still refused',
  (select count(*) = 2 and bool_and(req is null and variants is null) from public.resolver_list())
  and (select count(*) = 1 from public.resolver_list() where kind = 'name' and name = 'navn-kun') and (select count(*) = 1 from public.resolver_list() where kind = 'compare'));
reset role;

set role authenticated;
select t.asB();
select t.chk('migrated: B sets requirements on the own product: the product is flagged for the agent (2 variants), and the row becomes a variant row',
  t.err($$update public.products set requirements = '  sort, str. 43 ' where name = 'fars-sko'$$) = 'ok1'
  and t.q($$select (requirements = 'sort, str. 43' and req_state ->> 'want' = 'true')::text from public.products where name = 'fars-sko'$$) = 'true');
reset role; set role anon;
select t.chk('migrated: ... resolver_list shows it with the variants; resolver_variants answers it',
  (select count(*) = 1 and bool_and(req = 'sort, str. 43' and variants = '[{"id":"v1","name":"Hvid"},{"id":"v2","name":"Sort"}]'::jsonb) from public.resolver_list() where kind = 'variant')
  and public.resolver_variants('00000000-0000-0000-0000-0000000000f2', '["v2"]') = true
  and t.q($$select (tracked_variants = array['v2'] and status = 'choose' and req_state ->> 'by' = 'agent')::text from public.products where name = 'fars-sko'$$) = 'true');
reset role;
set role authenticated;
select t.asA();
select t.chk('migrated: A (list owner) cannot change requirements on B''s product',
  t.err($$update public.products set requirements = 'x' where name = 'fars-sko'$$) = 'ok0' or t.err($$update public.products set requirements = 'x' where id = '00000000-0000-0000-0000-0000000000f2'$$) = 'ok0');
select t.chk('migrated: A can set requirements on the own product; the lookup restarts (compare_state null)',
  t.err($$update public.products set requirements = 'rød' where name = 'mors-ting'$$) = 'ok1'
  and t.q($$select (requirements = 'rød' and compare_state is null and compare_tries = 0)::text from public.products where name = 'mors-ting'$$) = 'true');
reset role;

\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the data and everything else',
  (select count(*) = 3 from public.products) and (select requirements = 'rød' from public.products where name = 'mors-ting')
  and (select tracked_variants = array['v2'] and req_state ->> 'by' = 'agent' from public.products where name = 'fars-sko')
  and (select count(*) = 1 from public.list_members) and (select count(*) = 1 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'resolver_variants' and pronamespace = 'public'::regnamespace));
select 'REQUIREMENTS MIGRATION CHECKS PASSED' as result;
