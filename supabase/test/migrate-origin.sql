\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "origin of extra shops" (supabase/test/schema-pre-origin.sql is that schema.sql, unchanged), with rows that
-- have extra shops and job state without any origin (everything stored so far came from the AI agent, or by hand). The new schema.sql is applied
-- twice, as the push to the live database does it: the stored state is untouched. Then the agent adds a shop (origin 'agent'), the person adds
-- one by hand (origin 'hand') and removes one (only that link's state goes), and a third run changes nothing. (migrate-retry.sql checks the step before.)
create schema t;
grant usage on schema t to public;
create function t.chk(name text, ok boolean) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'ok   %', name;
end $$;
create function t.asA() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false) $$;
create function t.err(q text) returns text language plpgsql as $$
declare n integer; begin execute q; get diagnostics n = row_count; return 'ok' || n; exception when others then return sqlerrm; end $$;
create function t.q(q text) returns text language plpgsql security definer as $$ declare r text; begin execute q into r; return r; end $$;
grant execute on all functions in schema t to public;

\o /dev/null
\i :old
\o
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk');
insert into public.allowed_emails (email, added_at) values ('mor@familie.dk', '2026-01-01') on conflict (email) do nothing;
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, history, notified_price, created_at, compare_state, compare_at, extra_urls, extra_state) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'bebird', 'https://avxperten.dk/bebird', 'auto', null, 'tracking', 'Bebird M9 S', '[{"store":"Avxperten","price":219,"inStock":true}]', '[]', 219, now() - interval '3 days', 'done', now() - interval '1 day',
   '["https://cdon.dk/produkt/a/","https://b.example.dk/2"]',
   '{"https://cdon.dk/produkt/a/":{"seen":true,"fails":0,"at":"2026-11-19T10:00:00Z","offer":{"store":"CDON","price":129,"inStock":true,"name":"Tradlos ørerenser","at":"2026-11-19T10:00:00Z"}},"https://b.example.dk/2":{"seen":true,"fails":0,"origin":"search"}}'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'uden', 'https://andet.example.dk/b', 'auto', null, 'tracking', 'Anden', '[{"store":"Y","price":70,"inStock":true}]', '[]', null, now() - interval '1 day', 'wanted', now() - interval '1 hour', null, null);
update public.resolver_secret set token = repeat('a', 64);
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
select t.chk('old schema: the stored state has no origin on the agent''s link',
  (select extra_state -> 'https://cdon.dk/produkt/a/' ->> 'origin' is null from public.products where name = 'bebird'));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the stored extra_state is untouched (no origin is made up), one products_guard and one resolver_compare',
  (select extra_state = '{"https://cdon.dk/produkt/a/":{"seen":true,"fails":0,"at":"2026-11-19T10:00:00Z","offer":{"store":"CDON","price":129,"inStock":true,"name":"Tradlos ørerenser","at":"2026-11-19T10:00:00Z"}},"https://b.example.dk/2":{"seen":true,"fails":0,"origin":"search"}}'::jsonb and notified_price = 219 from public.products where name = 'bebird')
  and (select count(*) = 1 from pg_proc where proname = 'products_guard' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace));

set role anon;
select t.chk('migrated: the agent answers a waiting product: the new link gets origin agent, nothing else in the state changes',
  public.resolver_compare('00000000-0000-0000-0000-0000000000f2', null, '["https://n.example.dk/1"]') = true
  and t.q($$select (extra_state = '{"https://n.example.dk/1":{"origin":"agent"}}'::jsonb and extra_urls = '["https://n.example.dk/1"]'::jsonb)::text from public.products where name = 'uden'$$) = 'true');
reset role;
update public.products set compare_state = 'wanted' where name = 'bebird';
set role anon;
select t.chk('migrated: ... on a product with links: the old links keep their state (no origin added), the new one gets agent',
  public.resolver_compare('00000000-0000-0000-0000-0000000000f1', null, '["https://c.example.dk/3","https://cdon.dk/produkt/a/"]') = true
  and t.q($$select (extra_state -> 'https://cdon.dk/produkt/a/' ->> 'origin' is null and extra_state -> 'https://cdon.dk/produkt/a/' -> 'offer' ->> 'price' = '129'
    and extra_state -> 'https://b.example.dk/2' ->> 'origin' = 'search' and extra_state -> 'https://c.example.dk/3' ->> 'origin' = 'agent' and jsonb_array_length(extra_urls) = 3)::text from public.products where name = 'bebird'$$) = 'true');
reset role;

set role authenticated;
select t.asA();
select t.chk('migrated: A adds one link by hand: origin hand; the others keep their state',
  t.err($$update public.products set extra_urls = extra_urls || '["https://h.example.dk/9"]'::jsonb where name = 'bebird'$$) = 'ok1'
  and t.q($$select (extra_state -> 'https://h.example.dk/9' = '{"origin":"hand"}'::jsonb and extra_state -> 'https://b.example.dk/2' ->> 'origin' = 'search' and extra_state -> 'https://c.example.dk/3' ->> 'origin' = 'agent'
    and extra_state -> 'https://cdon.dk/produkt/a/' -> 'offer' ->> 'price' = '129')::text from public.products where name = 'bebird'$$) = 'true');
select t.chk('migrated: A removes the agent''s CDON link: only its state goes, the origins of the rest stay',
  t.err($$update public.products set extra_urls = '["https://b.example.dk/2","https://c.example.dk/3","https://h.example.dk/9"]' where name = 'bebird'$$) = 'ok1'
  and t.q($$select (not extra_state ? 'https://cdon.dk/produkt/a/' and extra_state -> 'https://b.example.dk/2' ->> 'origin' = 'search' and extra_state -> 'https://c.example.dk/3' ->> 'origin' = 'agent'
    and extra_state -> 'https://h.example.dk/9' ->> 'origin' = 'hand')::text from public.products where name = 'bebird'$$) = 'true');
reset role;

\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the state and the rows',
  (select count(*) = 2 from public.products) and (select (select count(*) from jsonb_object_keys(extra_state)) = 3 and notified_price = 219 from public.products where name = 'bebird'));
select 'ORIGIN MIGRATION CHECKS PASSED' as result;
