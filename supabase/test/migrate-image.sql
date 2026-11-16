\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before product pictures (supabase/test/schema-pre-image.sql is that schema.sql, unchanged), with rows
-- in it, one of them in a shared list. The new schema.sql is applied twice, as the push to the live database does it, and a third time
-- after the new column holds data. (migrate-compare.sql checks the step before this one.)
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
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, title, offers, history, notified_price, list_id, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', null, 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', '[{"d":"2026-11-01","p":95,"s":"X","src":"check"}]', 90, '00000000-0000-0000-0000-00000000aa01', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'fars-ting', 'https://prisjagt.dk/product.php?p=1', 'price', 50, 'pending', null, null, null, null, null, now() - interval '1 day');
select t.chk('old schema: no image_url column',
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'image_url'));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: one nullable image_url column and exactly one check',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'image_url' and is_nullable = 'YES')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_image_url_check'));
select t.chk('migrated twice: the rows are intact and have no picture',
  (select count(*) = 2 from public.products) and (select count(*) = 2 from public.products where image_url is null)
  and (select notified_price = 90 and history is not null and list_id is not null from public.products where name = 'mors-ting'));

-- the browser cannot write it; the job (the owner of the connection here) can
set role authenticated;
select t.asA();
select t.chk('migrated: A cannot set the picture on an existing row, but the rest of the update goes through',
  t.err($$update public.products set image_url = 'https://evil.example.com/x.jpg', name = 'mors-ting2' where name = 'mors-ting'$$) = 'ok1'
  and t.q($$select (image_url is null and name = 'mors-ting2')::text from public.products where id = '00000000-0000-0000-0000-0000000000f1'$$) = 'true');
select t.asB();
select t.chk('migrated: B (member of the list) cannot set it on A''s product either',
  t.err($$update public.products set image_url = 'https://evil.example.com/x.jpg' where id = '00000000-0000-0000-0000-0000000000f1'$$) like 'Kun den, der har tilføjet%');
reset role;
update public.products set image_url = 'https://cdn.example.dk/mor.jpg' where id = '00000000-0000-0000-0000-0000000000f1';
select t.chk('migrated: the job can store it', (select image_url = 'https://cdn.example.dk/mor.jpg' from public.products where name = 'mors-ting2'));
select t.chk('migrated: and the check refuses a bad one', t.err($$update public.products set image_url = 'http://cdn.example.dk/x.jpg' where name = 'mors-ting2'$$) like '%products_image_url_check%');

-- a third run keeps the data
\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the picture and everything else',
  (select count(*) = 2 from public.products) and (select image_url = 'https://cdn.example.dk/mor.jpg' and notified_price = 90 from public.products where name = 'mors-ting2')
  and (select count(*) = 1 from public.list_members));
select 'IMAGE MIGRATION CHECKS PASSED' as result;
