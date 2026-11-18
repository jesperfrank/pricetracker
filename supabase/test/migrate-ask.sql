\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
-- The live database at the commit before "Spørg om en vare" (supabase/test/schema-pre-ask.sql is that schema.sql, unchanged),
-- with rows in it, including one shared list and an answered alternatives request. The new schema.sql is then applied twice, as the
-- push to the live database does it, and a third time after the new table holds data. (This checks the last step on its own.)
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
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk'), ('00000000-0000-0000-0000-0000000000b2', 'far@familie.dk'), ('00000000-0000-0000-0000-0000000000c3', 'fremmed@x.dk');
insert into public.allowed_emails (email, added_at) values ('mor@familie.dk', '2026-01-01'), ('far@familie.dk', '2026-02-01') on conflict (email) do nothing;
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'Gaver');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2');
insert into public.products (id, user_id, name, source_url, target_type, status, title, offers, list_id, alt_requested_at, alt_done_at, alternatives) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'mors-ting', 'https://shop.example.dk/a', 'auto', 'tracking', 'Mors ting', '[{"store":"X","price":90,"inStock":true}]', '00000000-0000-0000-0000-00000000aa01', now() - interval '2 hours', now() - interval '1 hour',
   '[{"kind":"similar","name":"Lignende","url":"https://shop.example.dk/l","store":"Shop","price":99,"why":"Næsten det samme."}]');
select t.chk('old schema: no questions table, no log, no ai_ask functions',
  to_regclass('public.questions') is null and to_regclass('public.ask_attempts') is null and (select count(*) = 0 from pg_proc where proname like 'ai_ask%' or proname in ('ask_take_slot', 'questions_guard')));

\o /dev/null
\i :new
\i :new
\o
select t.chk('migrated twice: the table, the log, the four functions, the guard, the three policies and the two checks exist once',
  to_regclass('public.questions') is not null and to_regclass('public.ask_attempts') is not null
  and (select count(*) = 5 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('ai_ask_list', 'ai_ask_set', 'ai_ask_fail', 'ask_take_slot', 'questions_guard'))
  and (select count(*) = 1 from pg_trigger where tgname = 'questions_guard_trg')
  and (select count(*) = 3 from pg_policies where schemaname = 'public' and tablename = 'questions')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.questions'::regclass and pg_get_constraintdef(oid) ~ 'btrim'));
select t.chk('migrated twice: the old rows are intact and the alternatives answer too',
  (select count(*) = 1 from public.products) and (select alternatives -> 0 ->> 'name' = 'Lignende' from public.products) and (select count(*) = 1 from public.list_members)
  and (select count(*) = 0 from public.questions));
select t.chk('migrated twice: browser rights: select, insert, delete for authenticated, no update, nothing for anon',
  has_table_privilege('authenticated', 'public.questions', 'select') and has_table_privilege('authenticated', 'public.questions', 'insert') and has_table_privilege('authenticated', 'public.questions', 'delete')
  and not has_table_privilege('authenticated', 'public.questions', 'update') and not has_table_privilege('anon', 'public.questions', 'select'));

-- a person asks, the agent answers, on the migrated data
update public.resolver_secret set token = repeat('a', 64);
create function t.ask(q text, l uuid default null) returns text language plpgsql as $$
begin insert into public.questions (question, list_id) values (q, l); return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function t.ask(text, uuid) to public;
set role authenticated;
select t.asA();
select t.chk('migrated: A asks into the shared list', t.ask('Robotstøvsuger til lejlighed med hund, højst 3.000 kr.', '00000000-0000-0000-0000-00000000aa01') = 'ok');
select t.asB();
select t.chk('migrated: B (a member) asks too', t.ask('Kaffemaskine til kontoret', '00000000-0000-0000-0000-00000000aa01') = 'ok');
select t.chk('migrated: ... and sees only their own question', (select count(*) = 1 and bool_and(question like 'Kaffe%') from public.questions));
select set_config('request.jwt.claims', '{"email":"fremmed@x.dk","sub":"00000000-0000-0000-0000-0000000000c3"}', false);
select t.chk('migrated: a stranger sees none and asks nothing', (select count(*) = 0 from public.questions) and t.ask('Kaffemaskine til kontoret') like '42501%');
select t.asA();
select t.chk('migrated: A cannot write an answer (no UPDATE)', t.err($$update public.questions set status = 'done', summary = 'x' where true$$) like 'permission denied%');
reset role;
select t.chk('migrated: two questions are in the log', (select count(*) = 2 from public.ask_attempts));
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
set role anon;
select t.chk('migrated: the agent lists both, oldest first, answers one and fails the other',
  (select array_agg(question order by asked_at) from public.ai_ask_list()) = array['Robotstøvsuger til lejlighed med hund, højst 3.000 kr.', 'Kaffemaskine til kontoret']);
select t.chk('migrated: ... answer', public.ai_ask_set((select id from public.ai_ask_list() where question like 'Robot%'), 'Roborock passer bedst til hundehår.',
  '[{"name":"Roborock Q Revo","url":"https://prisjagt.dk/product.php?p=12345","store":"Elgiganten","price":2999,"was":3999,"why":"Børster mod hår."}]'));
select t.chk('migrated: ... fail', public.ai_ask_fail((select id from public.ai_ask_list() where question like 'Kaffe%'), 'Ikke nok oplysninger.'));
reset role;

-- a third run keeps the data and the state
\o /dev/null
\i :new
\o
select t.chk('migrated: a third run keeps the answer, the note, the log and the old rows',
  (select status = 'done' and picks -> 0 ->> 'name' = 'Roborock Q Revo' and list_id = '00000000-0000-0000-0000-00000000aa01' from public.questions where question like 'Robot%')
  and (select status = 'failed' and note = 'Ikke nok oplysninger.' from public.questions where question like 'Kaffe%')
  and (select count(*) = 2 from public.ask_attempts) and (select count(*) = 1 from public.products));
delete from public.lists where id = '00000000-0000-0000-0000-00000000aa01';
select t.chk('migrated: ... list_id is null, the question and its answer stay', (select count(*) = 2 and bool_and(list_id is null) from public.questions));
select 'ASK MIGRATION CHECKS PASSED' as result;
