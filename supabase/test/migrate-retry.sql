\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "Prøv igen" / the one-time requeue of failed name lookups / richer diag_products
-- (supabase/test/schema-pre-retry.sql is that schema.sql, unchanged), with rows in it: name-only products that failed with the older lookup agent
-- (status 'error', the notes that really are on the live rows), a waiting one, one with a link that is in error, a tracking one. The new schema.sql
-- is applied twice, as the push to the live database does it. Then a new failure happens and the schema is applied a third time: the repair is a
-- one-time fix, so that failure stays. (migrate-brand.sql checks the step before this one.)
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
create function t.st(n text) returns text language plpgsql security definer as $$
begin return (select status || '|' || coalesce(check_note, '-') || '|' || (name_options is not null)::text from public.products where name = n); end $$;
create function t.queue() returns text language plpgsql as $$
begin return (select coalesce(string_agg(name, ',' order by name), '') from public.resolver_list() where kind = 'name'); exception when others then return sqlerrm; end $$;
grant execute on all functions in schema t to public;

\o /dev/null
\i :old
\o
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk'), ('00000000-0000-0000-0000-0000000000b2', 'far@familie.dk');
insert into public.allowed_emails (email, added_at) values ('mor@familie.dk', '2026-01-01'), ('far@familie.dk', '2026-02-01') on conflict (email) do nothing;
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'Ønsker');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2');
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, check_note, requirements, active, list_id, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Playstation 5 pro', null, 'price', 5000, 'error', 'Kunne ikke finde produktet. Prøv at skrive det præcise navn.', '2 TB', true, '00000000-0000-0000-0000-00000000aa01', '2026-11-01'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'Xiaomi Mijia 6', null, 'auto', null, 'error', 'Mente du Xiaomi Mijia 6 Pro eller Xiaomi Mijia 6? Skriv det præcise navn.', null, true, null, '2026-11-02'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b2', 'Roborock R10', null, 'auto', null, 'error', 'Mente du Roborock Q Revo eller Saros 10? Skriv det præcise navn.', null, false, null, '2026-11-03'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a1', 'ny vare', null, 'auto', null, 'pending', null, null, true, null, '2026-11-04'),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000a1', 'med link i fejl', 'https://shop.example.dk/a', 'auto', null, 'error', 'Siden kunne ikke hentes.', null, true, null, '2026-11-05'),
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000b2', 'sporet', 'https://shop.example.dk/b', 'auto', null, 'tracking', null, null, true, null, '2026-11-06');
-- wish list imports that failed because the job could not save the wishes (the same wish list tried twice on the same list by A, once by B),
-- one that failed for another reason, and a finished one
insert into public.imports (id, user_id, list_id, url, status, note, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01', 'https://onskeskyen.dk/s/abc123', 'error', 'Ønskerne kunne ikke gemmes. Prøv igen senere.', '2026-11-24 08:00+00'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01', 'https://onskeskyen.dk/s/abc123', 'error', 'Ønskerne kunne ikke gemmes. Prøv igen senere.', '2026-11-24 09:00+00'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', null, 'https://onskeskyen.dk/s/other1', 'error', 'Ønskelisten er ikke offentlig eller findes ikke. Bed ejeren om at dele den offentligt.', '2026-11-20 08:00+00'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000b2', null, 'https://onskeskyen.dk/s/abc123', 'error', 'Ønskerne kunne ikke gemmes. Prøv igen senere.', '2026-11-23 08:00+00'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000a1', null, 'https://onskeskyen.dk/s/done12', 'done', null, '2026-11-10 08:00+00');
create function t.imp() returns text language sql security definer as $$
  select string_agg(right(id::text, 2) || ':' || status || ':' || (note is null)::text, ',' order by id) from public.imports $$;
grant execute on function t.imp() to public;
update public.resolver_secret set token = repeat('a', 64);
select t.chk('old schema: no schema_marks table, no retry columns, the failed rows are failed',
  to_regclass('public.schema_marks') is null
  and (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('lookup_failed_at', 'retry_requested_at', 'retry_log'))
  and (select count(*) = 4 from public.products where status = 'error'));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: schema_marks holds the one mark (closed to the browser roles, RLS on), the new columns and one products_guard exist',
  (select count(*) = 1 from public.schema_marks where name = 'requeue-failed-name-lookups')
  and (select relrowsecurity from pg_class where oid = 'public.schema_marks'::regclass)
  and not has_table_privilege('authenticated', 'public.schema_marks', 'select') and has_table_privilege('service_role', 'public.schema_marks', 'insert')
  and (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('lookup_failed_at', 'retry_requested_at', 'retry_log'))
  and (select count(*) = 1 from pg_proc where proname = 'products_guard' and pronamespace = 'public'::regnamespace));
select t.chk('migrated: imports that could not be saved wait again, only the newest attempt per person, wish list and list; other failures and finished ones are untouched',
  t.imp() = 'e1:error:false,e2:pending:true,e3:error:false,e4:pending:true,e5:done:true'
  and (select count(*) = 1 from public.schema_marks where name = 'requeue-imports-not-saved'));
select t.chk('migrated: the three failed name-only products are waiting again (pending, no note, no options), the rest is as it was',
  t.st('Playstation 5 pro') = 'pending|-|false' and t.st('Xiaomi Mijia 6') = 'pending|-|false' and t.st('Roborock R10') = 'pending|-|false'
  and t.st('ny vare') = 'pending|-|false' and t.st('med link i fejl') = 'error|Siden kunne ikke hentes.|false' and t.st('sporet') = 'tracking|-|false');
select t.chk('migrated: the person''s own fields are untouched',
  (select target_type = 'price' and target_value = 5000 and requirements = '2 TB' and active and list_id = '00000000-0000-0000-0000-00000000aa01' and source_url is null and created_at = '2026-11-01' from public.products where name = 'Playstation 5 pro')
  and (select not active and user_id = '00000000-0000-0000-0000-0000000000b2' from public.products where name = 'Roborock R10')
  and (select count(*) = 6 from public.products) and (select count(*) = 0 from public.products where lookup_failed_at is not null or retry_log is not null));
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
set role anon;
select t.chk('migrated: the agent''s queue (kind name) holds the repaired active ones and the waiting one', t.queue() = 'Playstation 5 pro,Xiaomi Mijia 6,ny vare');
reset role;

-- the agent gives up on one again, A uses "Prøv igen" after the hour
set role anon;
select t.chk('migrated: the agent fails the PlayStation again', public.resolver_fail('00000000-0000-0000-0000-0000000000f1', 'Kunne ikke finde produktet.'));
reset role;
update public.imports set status = 'error', note = 'Ønskerne kunne ikke gemmes. Prøv igen senere.' where id = '00000000-0000-0000-0000-0000000000e2';
\o /dev/null
\i :new
\o
select t.chk('migrated: a third run does not requeue the new failure, nor change anything else',
  t.st('Playstation 5 pro') = 'error|Kunne ikke finde produktet.|false' and t.st('Xiaomi Mijia 6') = 'pending|-|false'
  and (select count(*) = 1 from public.schema_marks where name = 'requeue-failed-name-lookups') and (select count(*) = 2 from public.schema_marks)
  and t.imp() = 'e1:error:false,e2:error:false,e3:error:false,e4:pending:true,e5:done:true');
set role authenticated;
select t.asA();
select t.chk('migrated: "Prøv igen" is refused within the hour', t.err($$update public.products set retry_requested_at = now() where name = 'Playstation 5 pro'$$) = 'Vent en time, før du prøver igen.');
reset role;
update public.products set lookup_failed_at = now() - interval '2 hours' where name = 'Playstation 5 pro';
set role authenticated;
select t.asB();
select t.chk('migrated: a member of the shared list cannot ask', t.err($$update public.products set retry_requested_at = now() where name = 'Playstation 5 pro'$$) like 'Kun den, der har tilføjet%');
select t.asA();
select t.chk('migrated: A asks after the hour', t.err($$update public.products set retry_requested_at = now() where name = 'Playstation 5 pro'$$) = 'ok1' and t.st('Playstation 5 pro') = 'pending|-|false');
reset role;
select t.chk('migrated: diag_products (token) lists the administrators'' products with the new columns',
  (select count(*) = 4 and bool_and(offers_count = 0) and bool_or(in_list) and bool_or(source_url = 'https://shop.example.dk/a') from public.diag_products()));
select 'RETRY MIGRATION CHECKS PASSED' as result;
