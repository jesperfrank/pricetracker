\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "extra shops" (supabase/test/schema-pre-extra.sql is that schema.sql, unchanged), with rows in it,
-- one of them waiting for the AI agent. The new schema.sql is applied twice, as the push to the live database does it (resolver_compare gets
-- a third argument, so the old signature is dropped and the function created again), and a third time after the new columns hold data.
-- (migrate-tries.sql checks the step before this one.)
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
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', null, 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', '[{"d":"2026-11-01","p":95,"s":"X","src":"check"}]', 90, '00000000-0000-0000-0000-00000000aa01', now() - interval '3 days', 'wanted', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-ting', 'https://prisjagt.dk/product.php?p=1', 'price', 50, 'pending', null, null, null, null, null, now() - interval '1 day', null, null),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'mors-anden', 'https://andet.example.dk/b', 'auto', null, 'tracking', 'Anden', '[{"store":"Y","price":70,"inStock":true}]', '[]', null, null, now() - interval '1 day', 'wanted', now() - interval '1 hour');
update public.resolver_secret set token = repeat('a', 64);
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
select t.chk('old schema: no extra columns, resolver_compare has two arguments',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('extra_urls', 'extra_state'))
  and (select count(*) = 1 and bool_and(pronargs = 2) from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the two columns, the two checks, the helper, exactly one resolver_compare (three arguments), rows intact',
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('extra_urls', 'extra_state') and is_nullable = 'YES')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_extra_urls_check')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_extra_state_check')
  and (select count(*) = 1 from pg_proc where proname = 'extra_urls_error' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 and bool_and(pronargs = 3 and pronargdefaults = 1) from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 3 from public.products) and (select count(*) = 3 from public.products where extra_urls is null and extra_state is null)
  and (select notified_price = 90 and compare_state = 'wanted' and list_id is not null from public.products where name = 'mors-ting'));
select t.chk('migrated twice: grants are as they were (anon and authenticated may execute, public may not), the secret token is kept',
  has_function_privilege('anon', 'public.resolver_compare(uuid, text, jsonb)', 'execute') and has_function_privilege('authenticated', 'public.resolver_compare(uuid, text, jsonb)', 'execute')
  and has_function_privilege('anon', 'public.resolver_list()', 'execute') and has_function_privilege('anon', 'public.resolver_set(uuid, text)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name in ('resolver_list', 'resolver_compare', 'resolver_set', 'resolver_fail') and grantee = 'PUBLIC')
  and (select count(*) = 1 and bool_and(token = repeat('a', 64)) from public.resolver_secret));

set role anon;
select t.chk('migrated: the old two-argument call form works (not found = none)',
  public.resolver_compare('00000000-0000-0000-0000-0000000000f3', null) = true
  and t.q($$select (compare_state = 'none')::text from public.products where name = 'mors-anden'$$) = 'true');
select t.chk('migrated: the new form answers a waiting product with shops; the job state stays',
  public.resolver_compare('00000000-0000-0000-0000-0000000000f1', null, '["https://a.example.dk/1", "https://b.example.dk/2"]') = true
  and t.q($$select (extra_urls = '["https://a.example.dk/1", "https://b.example.dk/2"]'::jsonb and compare_state = 'done' and status = 'tracking' and notified_price = 90 and history is not null and offers is not null)::text from public.products where name = 'mors-ting'$$) = 'true');
reset role;

set role authenticated;
select t.asA();
select t.chk('migrated: A can remove one entry, cannot add one',
  t.err($$update public.products set extra_urls = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]' where name = 'mors-ting'$$) = 'ok1'
  and t.q($$select extra_urls::text from public.products where name = 'mors-ting'$$) = '["https://a.example.dk/1", "https://b.example.dk/2"]'
  and t.err($$update public.products set extra_urls = '["https://b.example.dk/2"]' where name = 'mors-ting'$$) = 'ok1'
  and t.q($$select extra_urls::text from public.products where name = 'mors-ting'$$) = '["https://b.example.dk/2"]');
select t.asB();
select t.chk('migrated: B (member) cannot touch it on A''s product',
  t.err($$update public.products set extra_urls = null where id = '00000000-0000-0000-0000-0000000000f1'$$) like 'Kun den, der har tilføjet%');
reset role;

\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the data and everything else',
  (select count(*) = 3 from public.products) and (select extra_urls = '["https://b.example.dk/2"]'::jsonb and notified_price = 90 from public.products where name = 'mors-ting')
  and (select count(*) = 1 from public.list_members) and (select count(*) = 1 from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace));
select 'EXTRA MIGRATION CHECKS PASSED' as result;
