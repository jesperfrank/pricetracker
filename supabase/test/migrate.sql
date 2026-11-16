\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before list sharing (supabase/test/schema-pre-sharing.sql is that schema.sql, unchanged), with
-- rows in it. The new schema.sql is then applied twice, as the push to the live database does it.
create schema t;
grant usage on schema t to public;
create function t.chk(name text, ok boolean) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'ok   %', name;
end $$;
create function t.asA() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false) $$;
create function t.asB() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"far@familie.dk","sub":"00000000-0000-0000-0000-0000000000b2"}', false) $$;
create function t.rows(q text) returns integer language plpgsql as $$
declare n integer; begin execute q; get diagnostics n = row_count; return n; end $$;
grant execute on all functions in schema t to public;

\o /dev/null
\i :old
\o
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk'), ('00000000-0000-0000-0000-0000000000b2', 'far@familie.dk');
insert into public.allowed_emails (email, added_at) values ('mor@familie.dk', '2026-01-01'), ('far@familie.dk', '2026-02-01') on conflict (email) do nothing;
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'Gaver');
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, bought_at, bought_price, list_id) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'gammel-koebt', 'https://shop.example.dk/a', 'price', 100, 'tracking', now(), 90, '00000000-0000-0000-0000-00000000aa01'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'bs-ting', 'https://shop.example.dk/b', 'auto', null, 'tracking', null, null, null);
insert into public.imports (user_id, list_id, url, status) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01', 'https://onskeskyen.dk/s/x', 'done');
select t.chk('old schema: the single old policy is there', (select count(*) = 1 from pg_policies where tablename = 'products' and policyname = 'products_own'));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the old products policy is gone, the five new ones exist once',
  (select array_agg(policyname::text order by policyname) from pg_policies where tablename = 'products')
    = array['products_delete', 'products_insert', 'products_select', 'products_update_own', 'products_update_shared']);
select t.chk('migrated twice: list_members, bought_by, helper functions, triggers exist',
  (select count(*) = 1 from information_schema.columns where table_name = 'list_members' and column_name = 'added_at')
  and (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'bought_by')
  and (select count(*) = 8 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('owns_list', 'is_list_member', 'person_name', 'share_list', 'list_members_named', 'unshare_list', 'leave_list', 'list_members_guard'))
  and (select count(*) = 2 from pg_trigger where tgname in ('list_members_guard_trg', 'list_members_after_delete_trg')));
select t.chk('migrated twice: the rows are intact (the old bought mark has no bought_by, the list link is kept)',
  (select bought_at is not null and bought_by is null and bought_price = 90 and list_id is not null from public.products where name = 'gammel-koebt')
  and (select count(*) = 2 from public.products) and (select count(*) = 1 from public.imports) and (select count(*) = 1 from public.lists));
set role authenticated;
select t.asA();
select t.chk('migrated: A still sees and edits own products, B''s is invisible',
  (select count(*) = 1 and bool_and(name = 'gammel-koebt') from public.products) and t.rows($$update public.products set target_value = 80 where name = 'gammel-koebt'$$) = 1
  and t.rows($$update public.products set name = 'hacket' where name = 'bs-ting'$$) = 0);
select t.chk('migrated: A can undo the old bought mark (no bought_by yet) and mark it again',
  t.rows($$update public.products set bought_at = null, bought_price = null where name = 'gammel-koebt'$$) = 1);
select t.chk('migrated: ... marked again it is stamped with A', t.rows($$update public.products set bought_at = now(), bought_price = 70 where name = 'gammel-koebt'$$) = 1);
select t.chk('migrated: ... stamped', (select bought_by = '00000000-0000-0000-0000-0000000000a1' from public.products where name = 'gammel-koebt'));
select t.asB();
select t.chk('migrated: B sees only B''s product and cannot touch A''s list',
  (select count(*) = 1 and bool_and(name = 'bs-ting') from public.products) and (select count(*) = 0 from public.lists)
  and t.rows($$delete from public.products where name = 'gammel-koebt'$$) = 0);
select t.asA();
select t.chk('migrated: sharing works on the migrated data', public.share_list('00000000-0000-0000-0000-00000000aa01', 'far@familie.dk') = 'ok');
select t.asB();
select t.chk('migrated: B now sees the shared product and the list, still not more',
  (select count(*) = 2 from public.products) and (select count(*) = 1 from public.lists));
reset role;
select t.chk('migrated: a third run keeps the membership', (select count(*) = 1 from public.list_members));
\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the membership and everything else',
  (select count(*) = 1 from public.list_members) and (select count(*) = 2 from public.products));
select 'MIGRATION CHECKS PASSED' as result;
