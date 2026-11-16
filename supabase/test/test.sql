\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

create schema t;
grant usage on schema t to public;
create function t.chk(name text, ok boolean) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'ok   %', name;
end $$;
grant execute on function t.chk(text, boolean) to public;
-- as_(email): pretend to be a signed-in browser user; null = anon
create function t.denied(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function t.denied(text) to public;

-- 1. fresh database, whole file
\o /dev/null
\i :schema
\o
select t.chk('fresh run is clean', true);

-- 2. simulate the live project before this migration: no is_admin column, rows already there
alter table public.allowed_emails drop column is_admin;
insert into public.allowed_emails (email, note, added_at) values
  ('mor@familie.dk', 'owner', '2026-01-01'), ('far@familie.dk', null, '2026-02-01');
\o /dev/null
\i :schema
\o
select t.chk('migration adds column and makes the earliest row admin',
  (select array_agg(email order by email) from public.allowed_emails where is_admin) = array['mor@familie.dk']);
select t.chk('is_admin defaults to false', (select not is_admin from public.allowed_emails where email = 'far@familie.dk'));

-- 3. re-run: admin does not move, even if an older row appears
insert into public.allowed_emails (email, added_at) values ('aeldre@familie.dk', '2020-01-01');
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('re-run (twice) is clean and admin does not move',
  (select array_agg(email) from public.allowed_emails where is_admin) = array['mor@familie.dk']);
delete from public.allowed_emails where email = 'aeldre@familie.dk';

-- 4. is_admin()
set role authenticated;
select set_config('request.jwt.claims', '{"email":"Mor@Familie.dk"}', false);
select t.chk('is_admin() true for the admin (case-insensitive)', public.is_admin());
select set_config('request.jwt.claims', '{"email":"far@familie.dk"}', false);
select t.chk('is_admin() false for an allowed non-admin', not public.is_admin());
select set_config('request.jwt.claims', '{"email":"fremmed@x.dk"}', false);
select t.chk('is_admin() false for a stranger', not public.is_admin());
reset role;

-- 5. request_access, every return value
set role anon;
select set_config('request.jwt.claims', '', false);
select t.chk('requested', public.request_access('  Ny@Person.DK ', E'  Ny\nPerson  ') = 'requested');
reset role;
select t.chk('stored lower-cased and trimmed, newline stripped',
  (select email = 'ny@person.dk' and name = 'Ny Person' and status = 'pending' from public.access_requests where email = 'ny@person.dk'));
set role anon;
select t.chk('pending (no change)', public.request_access('ny@person.dk', 'Andet navn') = 'pending');
select t.chk('allowed', public.request_access('FAR@familie.dk', 'x') = 'allowed');
select t.chk('invalid: no @', public.request_access('hej', 'x') = 'invalid');
select t.chk('invalid: null', public.request_access(null, null) = 'invalid');
select t.chk('invalid: space inside', public.request_access('a b@c.dk', null) = 'invalid');
select t.chk('invalid: no dot in domain', public.request_access('a@b', null) = 'invalid');
select t.chk('invalid: two @', public.request_access('a@b@c.dk', null) = 'invalid');
select t.chk('invalid: over 200 chars', public.request_access(repeat('a', 196) || '@b.dk', null) = 'invalid');
select t.chk('under 200 chars is fine', public.request_access(repeat('a', 190) || '@b.dk', null) = 'requested');
select t.chk('long name is cut to 80, empty name -> null', public.request_access('lang@navn.dk', repeat('x', 300)) = 'requested'
  and public.request_access('tom@navn.dk', '   ') = 'requested');
reset role;
select t.chk('name cut to 80 / null', (select char_length(name) = 80 from public.access_requests where email = 'lang@navn.dk')
  and (select name is null from public.access_requests where email = 'tom@navn.dk'));
update public.access_requests set status = 'rejected', decided_at = now() where email = 'tom@navn.dk';
set role authenticated;
select set_config('request.jwt.claims', '{"email":"someone@x.dk"}', false);
select t.chk('rejected (no change), also for authenticated', public.request_access('tom@navn.dk', 'igen') = 'rejected');
reset role;
select t.chk('rejected row unchanged', (select status = 'rejected' and name is null from public.access_requests where email = 'tom@navn.dk'));

-- 6. the cap of 30 pending
delete from public.access_requests;
insert into public.access_requests (email) select 'p' || g || '@x.dk' from generate_series(1, 29) g;
set role anon;
select t.chk('29 pending: still room', public.request_access('p30@x.dk', null) = 'requested');
select t.chk('30 pending: full', public.request_access('p31@x.dk', null) = 'full');
select t.chk('30 pending: existing pending still answers pending', public.request_access('p1@x.dk', null) = 'pending');
select t.chk('30 pending: allowed still answers allowed', public.request_access('mor@familie.dk', null) = 'allowed');
reset role;
select t.chk('full: nothing inserted', (select count(*) = 30 from public.access_requests));

-- 7. anon and non-admin cannot call the admin functions; anon cannot read tables
set role anon;
select t.chk('anon: admin_list_requests denied', t.denied('select * from public.admin_list_requests()'));
select t.chk('anon: admin_decide denied', t.denied($$select public.admin_decide('p1@x.dk', true)$$));
select t.chk('anon: admin_list_allowed denied', t.denied('select * from public.admin_list_allowed()'));
select t.chk('anon: admin_remove_allowed denied', t.denied($$select public.admin_remove_allowed('far@familie.dk')$$));
select t.chk('anon: cannot read access_requests', t.denied('select * from public.access_requests'));
select t.chk('anon: cannot read allowed_emails', t.denied('select * from public.allowed_emails'));
reset role;
set role authenticated;
select set_config('request.jwt.claims', '{"email":"far@familie.dk"}', false);
select t.chk('non-admin: admin_list_requests denied (42501)', t.denied('select * from public.admin_list_requests()'));
select t.chk('non-admin: admin_decide denied', t.denied($$select public.admin_decide('p1@x.dk', true)$$));
select t.chk('non-admin: admin_list_allowed denied', t.denied('select * from public.admin_list_allowed()'));
select t.chk('non-admin: admin_remove_allowed denied', t.denied($$select public.admin_remove_allowed('mor@familie.dk')$$));
select t.chk('non-admin: cannot read access_requests', t.denied('select * from public.access_requests'));
select t.chk('non-admin: cannot update allowed_emails', t.denied($$update public.allowed_emails set is_admin = true$$));
select set_config('request.jwt.claims', '{"email":"fremmed@x.dk"}', false);
select t.chk('stranger (signed in, not allowed): admin_list_requests denied', t.denied('select * from public.admin_list_requests()'));
reset role;
select t.chk('nothing changed by the denied calls', (select count(*) = 30 from public.access_requests where status = 'pending')
  and (select count(*) = 2 from public.allowed_emails));
-- SQLSTATE really is 42501
set role authenticated;
select set_config('request.jwt.claims', '{"email":"far@familie.dk"}', false);
do $$ begin perform public.admin_list_requests(); raise exception 'no error'; exception when sqlstate '42501' then null; end $$;
reset role;

-- 8. admin functions
update public.access_requests set created_at = now() - (regexp_replace(email, '^p([0-9]+)@.*', '\1')::int || ' minutes')::interval where email ~ '^p[0-9]+@';
delete from public.access_requests where email in ('p10@x.dk', 'p11@x.dk', 'p12@x.dk', 'p13@x.dk', 'p14@x.dk', 'p15@x.dk', 'p16@x.dk', 'p17@x.dk', 'p18@x.dk', 'p19@x.dk');
set role authenticated;
select set_config('request.jwt.claims', '{"email":"mor@familie.dk"}', false);
select t.chk('admin_list_requests oldest first (p30 is oldest)', (select email from public.admin_list_requests() limit 1) = 'p30@x.dk');
select t.chk('admin_list_requests columns', (select count(*) from public.admin_list_requests() where email is not null) = 20);
reset role;
insert into public.access_requests (email) select 'q' || g || '@x.dk' from generate_series(1, 40) g;
set role authenticated;
select t.chk('admin_list_requests max 50', (select count(*) from public.admin_list_requests()) = 50);
select t.chk('approve returns true', public.admin_decide('P1@x.dk', true));
select t.chk('approve inserted into allowed_emails with a note, not admin',
  (select note like 'Godkendt%' and not is_admin from public.admin_list_allowed() where email = 'p1@x.dk'));
reset role;
select t.chk('approved status + decided_at, requester not yet notified', (select status = 'approved' and decided_at is not null and requester_notified_at is null from public.access_requests where email = 'p1@x.dk'));
set role authenticated;
select t.chk('approve again returns false', not public.admin_decide('p1@x.dk', true));
select t.chk('reject returns true', public.admin_decide('p2@x.dk', false));
select t.chk('reject does not touch allowed_emails', not exists (select 1 from public.admin_list_allowed() where email = 'p2@x.dk'));
select t.chk('rejected one is gone from the pending list', not exists (select 1 from public.admin_list_requests() where email = 'p2@x.dk'));
select t.chk('rejected can be approved later', public.admin_decide('p2@x.dk', true));
select t.chk('unknown address returns false', not public.admin_decide('ukendt@x.dk', true) and not public.admin_decide('ukendt@x.dk', false));
select t.chk('reject on an approved request does not revoke', not public.admin_decide('p1@x.dk', false)
  and exists (select 1 from public.admin_list_allowed() where email = 'p1@x.dk'));
select t.chk('admin_list_allowed shows admin first with is_admin', (select email = 'mor@familie.dk' and is_admin from public.admin_list_allowed() limit 1));
select t.chk('admin_remove_allowed never removes an admin', not public.admin_remove_allowed('mor@familie.dk')
  and exists (select 1 from public.admin_list_allowed() where email = 'mor@familie.dk'));
select t.chk('admin_remove_allowed removes a non-admin', public.admin_remove_allowed(' P1@x.dk '));
select t.chk('and it is gone from the list', not exists (select 1 from public.admin_list_allowed() where email = 'p1@x.dk'));
select t.chk('removing an unknown address returns false', not public.admin_remove_allowed('ukendt@x.dk'));
reset role;

-- 9. removed after approval: asking again starts a fresh request
delete from public.access_requests where status = 'pending';
set role anon;
select t.chk('approved-then-removed can ask again', public.request_access('p1@x.dk', 'Ny') = 'requested');
reset role;
select t.chk('request reset to pending, notifications cleared', (select status = 'pending' and decided_at is null and requester_notified_at is null and owner_notified_at is null from public.access_requests where email = 'p1@x.dk'));

-- 10. the sign-up hook is unchanged: approved addresses pass, others do not
select t.chk('hook lets an approved address in', public.hook_before_user_created('{"user":{"email":"P2@x.dk"}}') = '{}'::jsonb);
select t.chk('hook rejects a requested-but-not-approved address', public.hook_before_user_created('{"user":{"email":"p3@x.dk"}}') ? 'error');
select t.chk('hook rejects a rejected-then-removed address', public.hook_before_user_created('{"user":{"email":"stranger@x.dk"}}') ? 'error');

-- 11. service role can use the table
set role service_role;
select t.chk('service_role can read and update access_requests', (select count(*) > 0 from public.access_requests)
  and (select count(*) >= 0 from public.allowed_emails where is_admin));
update public.access_requests set owner_notified_at = now() where email = 'p3@x.dk';
reset role;

-- 11b. products.source_url: any https link with a dotted host; the old prisjagt-only check is replaced idempotently
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'mor@familie.dk');
-- the live database has the old constraint: put it back, then re-run the file
alter table public.products drop constraint products_source_url_check;
alter table public.products add constraint products_source_url_check
  check (source_url is null or (char_length(source_url) <= 500 and source_url ~ '^https://(www\.)?prisjagt\.dk/'));
create function t.ins(u text) returns text language plpgsql as $$
begin
  insert into public.products (user_id, name, source_url, target_type, target_value)
  values ('00000000-0000-0000-0000-0000000000a1', 'x', u, 'price', 100);
  return 'ok';
exception when check_violation then return 'rejected'; end $$;
select t.chk('old constraint (as on the live database) rejects a shop link', t.ins('https://shop.example.dk/vare') = 'rejected');
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('exactly one source_url constraint after re-runs', (select count(*) = 1 from pg_constraint where conname = 'products_source_url_check' and conrelid = 'public.products'::regclass));
select t.chk('prisjagt link accepted', t.ins('https://prisjagt.dk/product.php?p=123') = 'ok');
select t.chk('www prisjagt link accepted', t.ins('https://www.prisjagt.dk/product.php?p=1') = 'ok');
select t.chk('shop link accepted', t.ins('https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html') = 'ok');
select t.chk('shop link with query accepted', t.ins('https://shop.example.com/p?id=1&x=2#a') = 'ok');
select t.chk('host only accepted', t.ins('https://example.dk') = 'ok');
select t.chk('null (name only) accepted', t.ins(null) = 'ok');
select t.chk('http rejected', t.ins('http://shop.example.dk/p') = 'rejected');
select t.chk('no dot in host rejected', t.ins('https://localhost/p') = 'rejected' and t.ins('https://intranet/p') = 'rejected');
select t.chk('user:password@ rejected', t.ins('https://user:pw@shop.dk/p') = 'rejected' and t.ins('https://evil.dk@shop.dk/p') = 'rejected');
select t.chk('port rejected', t.ins('https://shop.dk:8443/p') = 'rejected');
select t.chk('spaces rejected', t.ins('https://shop.dk/a b') = 'rejected' and t.ins('https://sh op.dk/a') = 'rejected');
select t.chk('other schemes rejected', t.ins('javascript:alert(1)') = 'rejected' and t.ins('ftp://shop.dk/x') = 'rejected' and t.ins('shop.dk/x') = 'rejected');
select t.chk('empty host parts rejected', t.ins('https://.dk/x') = 'rejected' and t.ins('https://shop./x') = 'rejected');
select t.chk('500 characters accepted, 501 rejected',
  t.ins('https://shop.dk/' || repeat('a', 484)) = 'ok' and t.ins('https://shop.dk/' || repeat('a', 485)) = 'rejected');
-- a browser user can write a shop link and changing it starts the product over
set role authenticated;
select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false);
update public.products set source_url = 'https://shop.example.dk/vare' where source_url = 'https://prisjagt.dk/product.php?p=123';
select t.chk('authenticated user can change to a shop link', (select count(*) = 1 from public.products where source_url = 'https://shop.example.dk/vare' and status = 'pending'));
select t.chk('authenticated user cannot set a bad link', t.ins('http://x.dk/') = 'rejected');
reset role;
-- products.backfill_state (Internet Archive attempt marker) is written by the job only
alter table public.products drop column backfill_state;
\o /dev/null
\i :schema
\o
select t.chk('migration adds backfill_state idempotently', (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'backfill_state'));
update public.products set backfill_state = '{"result":"done","found":3}'::jsonb where source_url = 'https://shop.example.dk/vare';
set role authenticated;
select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false);
update public.products set backfill_state = null, name = 'omdoebt' where source_url = 'https://shop.example.dk/vare';
select t.chk('browser user cannot clear or change backfill_state (rest of the update goes through)', (select backfill_state->>'result' = 'done' and name = 'omdoebt' from public.products where source_url = 'https://shop.example.dk/vare'));
insert into public.products (user_id, name, source_url, target_type, target_value, backfill_state) values ('00000000-0000-0000-0000-0000000000a1', 'bf', 'https://shop.example.dk/bf', 'price', 5, '{"result":"done"}'::jsonb);
select t.chk('browser insert cannot preset backfill_state', (select backfill_state is null from public.products where name = 'bf'));
update public.products set source_url = 'https://shop.example.dk/anden' where source_url = 'https://shop.example.dk/vare';
select t.chk('a new link starts the product over, backfill_state included', (select backfill_state is null and status = 'pending' from public.products where source_url = 'https://shop.example.dk/anden'));
reset role;
delete from public.products where name = 'bf';
update public.products set source_url = 'https://shop.example.dk/vare' where source_url = 'https://shop.example.dk/anden';
-- resolver_set accepts prisjagt.dk links and any https link that passes the source_url rule
insert into public.products (user_id, name, target_type, target_value) values ('00000000-0000-0000-0000-0000000000a1', 'navn kun', 'price', 5);
update public.resolver_secret set token = repeat('a', 64);
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
create function t.rs(u text) returns text language plpgsql as $$
declare pid uuid := (select id from public.products where name = 'navn kun'); r boolean;
begin
  r := public.resolver_set(pid, u); return r::text;
exception when others then return 'error:' || sqlerrm; end $$;
create function t.nolink() returns boolean language sql as $$ select source_url is null from public.products where name = 'navn kun' $$;
select t.chk('resolver_set rejects http', t.rs('http://shop.dk/vare') like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set rejects port', t.rs('https://shop.dk:8443/vare') like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set rejects user:password@', t.rs('https://bruger:kode@shop.dk/vare') like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set rejects a host without a dot', t.rs('https://localhost/vare') like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set rejects a space', t.rs('https://shop.dk/en vare') like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set rejects javascript:', t.rs('javascript:alert(1)') like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set rejects 501 characters', t.rs('https://shop.dk/' || repeat('a', 485)) like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set rejects null', t.rs(null) like '%not a usable https link%' and t.nolink());
select t.chk('resolver_set accepts a shop link', t.rs('https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html') = 'true');
select t.chk('and stores a shop link as given', (select source_url = 'https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html' from public.products where name = 'navn kun'));
select t.chk('a second call finds no name-only product any more (false)', t.rs('https://shop.dk/andet') = 'false');
update public.products set source_url = null, status = 'pending' where name = 'navn kun';
select t.chk('resolver_set accepts 500 characters', t.rs('https://shop.dk/' || repeat('a', 484)) = 'true');
update public.products set source_url = null, status = 'pending' where name = 'navn kun';
select t.chk('resolver_set accepts a prisjagt product link', t.rs('https://www.prisjagt.dk/product.php?p=42') = 'true');
select t.chk('and stores it without www', (select source_url = 'https://prisjagt.dk/product.php?p=42' from public.products where name = 'navn kun'));
update public.products set source_url = null, status = 'pending' where name = 'navn kun';
-- the token check is unchanged
select set_config('request.headers', '{"x-resolver-token":"fel"}', false);
select t.chk('resolver_set still needs the token', t.rs('https://shop.dk/vare') like '%invalid or missing token%' and t.nolink());
select set_config('request.headers', '{"x-resolver-token":"' || repeat('a', 64) || '"}', false);
-- and still only touches pending rows without a link
update public.products set status = 'error' where name = 'navn kun';
select t.chk('resolver_set returns false for a product that is not pending', t.rs('https://shop.dk/vare') = 'false' and t.nolink());
delete from public.products where name = 'navn kun';

-- 11b. goal 'auto': constraint migration from the old (live) shape, then the new rules
alter table public.products drop constraint products_target_type_check;
alter table public.products drop constraint products_target_value_check;
alter table public.products alter column target_value set not null;
alter table public.products add constraint products_target_type_check check (target_type in ('price', 'pct'));
alter table public.products add constraint products_check check (target_value > 0 and (target_type <> 'pct' or target_value < 100));
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('old goal constraints are replaced (twice, idempotent)',
  (select array_agg(conname::text order by conname) from pg_constraint where conrelid = 'public.products'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'target_')
  = array['products_target_type_check', 'products_target_value_check']);
select t.chk('existing price and pct rows are untouched', (select count(*) > 0 from public.products where target_type in ('price', 'pct')));
create function t.goal(ty text, v numeric) returns text language plpgsql as $$
begin
  insert into public.products (user_id, name, target_type, target_value) values ('00000000-0000-0000-0000-0000000000a1', 'maal', ty, v);
  delete from public.products where name = 'maal';
  return 'ok';
exception when check_violation or not_null_violation then return 'rejected'; end $$;
select t.chk('goal auto with null value accepted', t.goal('auto', null) = 'ok');
select t.chk('goal auto with a value rejected', t.goal('auto', 5) = 'rejected');
select t.chk('goal price needs a value', t.goal('price', null) = 'rejected' and t.goal('price', 0) = 'rejected' and t.goal('price', 500) = 'ok');
select t.chk('goal pct needs 0 < value < 100', t.goal('pct', null) = 'rejected' and t.goal('pct', 100) = 'rejected' and t.goal('pct', 20) = 'ok');
select t.chk('unknown goal type rejected', t.goal('foo', 5) = 'rejected' and t.goal('foo', null) = 'rejected');
-- a browser user can switch an existing product to auto and back (the guard does not list goal types)
insert into public.products (user_id, name, target_type, target_value) values ('00000000-0000-0000-0000-0000000000a1', 'skift', 'price', 5);
set role authenticated;
select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false);
update public.products set target_type = 'auto', target_value = null where name = 'skift';
select t.chk('authenticated user can switch a product to auto', (select target_type = 'auto' and target_value is null from public.products where name = 'skift'));
insert into public.products (name, target_type) values ('skift2', 'auto');
select t.chk('authenticated user can insert auto without a value', (select count(*) = 1 from public.products where name = 'skift2' and target_value is null));
update public.products set target_type = 'price', target_value = 99 where name = 'skift';
select t.chk('and back to a price goal', (select target_type = 'price' and target_value = 99 from public.products where name = 'skift'));
reset role;
delete from public.products where name in ('skift', 'skift2');

-- 11b. lists
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b2', 'far@familie.dk');
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('lists: table, column, triggers and policy exist after re-runs',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'list_id')
  and (select count(*) = 1 from pg_trigger where tgname = 'lists_limit_trg')
  and (select count(*) = 1 from pg_policies where tablename = 'lists' and policyname = 'lists_own'));
create function t.asA() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"mor@familie.dk","sub":"00000000-0000-0000-0000-0000000000a1"}', false) $$;
create function t.asB() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"far@familie.dk","sub":"00000000-0000-0000-0000-0000000000b2"}', false) $$;
create function t.asX() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"fremmed@x.dk","sub":"00000000-0000-0000-0000-0000000000c3"}', false) $$;
grant execute on function t.asA(), t.asB(), t.asX() to public;
-- t.try: run a statement, return 'ok' or a short reason
create function t.try(q text) returns text language plpgsql as $$
begin execute q; return 'ok';
exception when check_violation then return 'check';
  when unique_violation then return 'unique';
  when foreign_key_violation then return 'fk';
  when not_null_violation then return 'notnull';
  when insufficient_privilege then return 'denied'; end $$;
grant execute on function t.try(text) to public;
-- lists of A and B by name, and "put product p into list l" as a statement
create function t.lid(owner uuid, n text) returns uuid language sql security definer as $$ select id from public.lists where user_id = owner and name = n $$;
grant execute on function t.lid(uuid, text) to public;
create function t.put(p text, l uuid) returns text language plpgsql as $$
begin return t.try(format('update public.products set list_id = %L where name = %L', l, p)); end $$;
create function t.putnew(p text, l uuid) returns text language plpgsql as $$
begin return t.try(format('insert into public.products (name, target_type, target_value, list_id) values (%L, ''price'', 5, %L)', p, l)); end $$;
grant execute on function t.put(text, uuid), t.putnew(text, uuid) to public;

set role authenticated;
select t.asA();
insert into public.lists (name) values ('  Elektronik  ');
select t.chk('list: name is trimmed, user_id defaults to the caller', (select name = 'Elektronik' and user_id = '00000000-0000-0000-0000-0000000000a1' from public.lists));
select t.chk('list: empty name rejected', t.try($$insert into public.lists (name) values ('')$$) = 'check');
select t.chk('list: blank name rejected', t.try($$insert into public.lists (name) values ('   ')$$) = 'check');
select t.chk('list: 40 characters accepted', t.try(format('insert into public.lists (name) values (%L)', repeat('x', 40))) = 'ok');
select t.chk('list: 41 characters rejected', t.try(format('insert into public.lists (name) values (%L)', repeat('y', 41))) = 'check');
select t.chk('list: duplicate rejected ignoring case and spaces', t.try($$insert into public.lists (name) values ('ELEKTRONIK')$$) = 'unique'
  and t.try($$insert into public.lists (name) values (' elektronik ')$$) = 'unique');
select t.chk('list: rename to an existing name rejected', t.try(format('update public.lists set name = %L where name = %L', 'Elektronik', repeat('x', 40))) = 'unique');
update public.lists set name = '  Gaver ' where name = repeat('x', 40);
select t.chk('list: rename works and is trimmed', (select count(*) = 1 from public.lists where name = 'Gaver'));
select t.chk('list: renaming to blank rejected', t.try($$update public.lists set name = ' ' where name = 'Gaver'$$) = 'check');
update public.lists set user_id = '00000000-0000-0000-0000-0000000000b2' where name = 'Gaver';
select t.chk('list: cannot be handed to another user', (select user_id = '00000000-0000-0000-0000-0000000000a1' from public.lists where name = 'Gaver'));
select t.chk('list: cannot insert for another user (RLS)', t.try($$insert into public.lists (user_id, name) values ('00000000-0000-0000-0000-0000000000b2', 'Snyd')$$) = 'denied');
reset role;
select t.chk('list: nothing stored for B by A', (select count(*) = 0 from public.lists where user_id = '00000000-0000-0000-0000-0000000000b2'));

-- B has a list of their own; A and a stranger cannot see, change or delete it
insert into public.lists (user_id, name) values ('00000000-0000-0000-0000-0000000000b2', 'Elektronik');
select t.chk('list: same name for another user is fine', (select count(*) = 2 from public.lists where name = 'Elektronik'));
set role authenticated;
select t.asA();
select t.chk('RLS: A sees only own lists', (select count(*) = 2 and bool_and(user_id = '00000000-0000-0000-0000-0000000000a1') from public.lists));
update public.lists set name = 'Hacket' where user_id = '00000000-0000-0000-0000-0000000000b2';
delete from public.lists where user_id = '00000000-0000-0000-0000-0000000000b2';
reset role;
select t.chk('RLS: A can neither rename nor delete B''s list', (select count(*) = 1 from public.lists where user_id = '00000000-0000-0000-0000-0000000000b2' and name = 'Elektronik'));
set role authenticated;
select t.asB();
select t.chk('RLS: B sees only own list', (select count(*) = 1 and bool_and(user_id = '00000000-0000-0000-0000-0000000000b2') from public.lists));
select t.asX();
select t.chk('RLS: a signed-in stranger (not allowed) sees no lists', (select count(*) = 0 from public.lists));
select t.chk('RLS: a stranger cannot create a list', t.try($$insert into public.lists (name) values ('Fremmed')$$) = 'denied');
reset role;
set role anon;
select t.chk('anon cannot read lists', t.denied('select * from public.lists'));
reset role;

-- list_id ownership
insert into public.products (user_id, name, target_type, target_value) values ('00000000-0000-0000-0000-0000000000a1', 'tv', 'price', 5);
set role authenticated;
select t.asA();
select t.chk('list_id: A can put a product in own list', t.put('tv', t.lid('00000000-0000-0000-0000-0000000000a1', 'Elektronik')) = 'ok');
select t.chk('list_id: and it is stored', (select list_id = t.lid('00000000-0000-0000-0000-0000000000a1', 'Elektronik') from public.products where name = 'tv'));
select t.chk('list_id: A cannot attach a product to B''s list (update)', t.put('tv', t.lid('00000000-0000-0000-0000-0000000000b2', 'Elektronik')) = 'fk');
select t.chk('list_id: A cannot create a product in B''s list (insert)', t.putnew('snyd', t.lid('00000000-0000-0000-0000-0000000000b2', 'Elektronik')) = 'fk');
select t.chk('list_id: a made-up list id is rejected', t.put('tv', gen_random_uuid()) = 'fk');
select t.chk('list_id: still A''s own list after the failed attempts', (select list_id = t.lid('00000000-0000-0000-0000-0000000000a1', 'Elektronik') from public.products where name = 'tv'));
update public.products set list_id = null where name = 'tv';
select t.chk('list_id: can be cleared', (select list_id is null from public.products where name = 'tv'));
select t.chk('list_id: an insert into an own list works', t.putnew('radio', t.lid('00000000-0000-0000-0000-0000000000a1', 'Elektronik')) = 'ok');
reset role;
select t.chk('list_id: the SQL editor is checked too', t.put('tv', t.lid('00000000-0000-0000-0000-0000000000b2', 'Elektronik')) = 'fk');
select t.chk('list_id: no stray rows', (select count(*) = 0 from public.products where name = 'snyd') and (select list_id is null from public.products where name = 'tv'));
-- the job (service role) updates a product in a list without touching list_id
set role service_role;
update public.products set check_note = 'ok' where name = 'radio';
select t.chk('service role can still update products in a list', (select check_note = 'ok' and list_id is not null from public.products where name = 'radio'));
select t.chk('service role selects lists', (select count(*) = 3 from public.lists));
reset role;

-- deleting a list keeps the products
set role authenticated;
select t.asA();
delete from public.lists where name = 'Elektronik';
reset role;
select t.chk('deleting a list keeps its products and sets list_id to null', (select count(*) = 1 and bool_and(list_id is null) from public.products where name = 'radio'));
select t.chk('deleting A''s list does not touch B''s list', (select count(*) = 2 from public.lists));

-- the cap of 30 per user
delete from public.lists where user_id = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select t.asA();
insert into public.lists (name) select 'L' || g from generate_series(1, 30) g;
select t.chk('cap: 30 lists accepted', (select count(*) = 30 from public.lists));
select t.chk('cap: the 31st is rejected', t.try($$insert into public.lists (name) values ('L31')$$) = 'check');
delete from public.lists where name = 'L30';
select t.chk('cap: room again after a delete', t.try($$insert into public.lists (name) values ('L31')$$) = 'ok');
select t.asB();
select t.chk('cap: counted per user (B unaffected)', t.try($$insert into public.lists (name) values ('B2')$$) = 'ok');
reset role;
delete from public.lists;
delete from public.products where name in ('tv', 'radio');

-- the live shape: a database without lists, then the schema is run (twice)
drop trigger products_list_check_trg on public.products;
alter table public.products drop column list_id;
drop table public.lists cascade;
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('lists: migration from a database without lists is clean (twice)',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'list_id')
  and (select count(*) = 3 from pg_trigger where tgname in ('lists_guard_trg', 'lists_limit_trg', 'products_list_check_trg')));
select t.chk('lists: existing products survived the migration', (select count(*) > 0 from public.products));

-- 11c. imports (shared wish lists). The lists test above dropped lists with cascade (and with it the foreign key from imports):
-- start from a database where imports is created on top of the existing lists table, as on the live project.
drop table public.imports cascade;
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('imports: table, policy, triggers exist after re-runs',
  (select count(*) = 1 from pg_policies where tablename = 'imports' and policyname = 'imports_own')
  and (select count(*) = 3 from pg_trigger where tgname in ('imports_guard_trg', 'imports_limit_trg', 'imports_list_check_trg')));
create function t.dels(q text) returns integer language plpgsql as $$
declare n integer; begin execute q; get diagnostics n = row_count; return n; end $$;
grant execute on function t.dels(text) to public;
create function t.imp(u text) returns text language plpgsql as $$
begin return t.try(format('insert into public.imports (url) values (%L)', u)); end $$;
grant execute on function t.imp(text) to public;
create function t.impl(u text, l uuid) returns text language plpgsql as $$
begin return t.try(format('insert into public.imports (url, list_id) values (%L, %L)', u, l)); end $$;
grant execute on function t.impl(text, uuid) to public;
delete from public.imports;
insert into public.lists (name, user_id) values ('Onsker A', '00000000-0000-0000-0000-0000000000a1'), ('Onsker B', '00000000-0000-0000-0000-0000000000b2');

set role authenticated;
select t.asA();
select t.chk('imports: share link accepted', t.imp('https://onskeskyen.dk/s/e0mfx8') = 'ok');
select t.chk('imports: www, gowish.com, /wishlists/<id>, locale prefix, query and trailing slash accepted',
  t.imp('https://www.onskeskyen.dk/s/abc-DEF_1') = 'ok' and t.imp('https://gowish.com/s/e0mfx8') = 'ok'
  and t.imp('https://onskeskyen.dk/wishlists/4seSLtIddxXUVB2Z?sharedBy=9lflg7q4Ybu7D4cx&utm_source=shortlink') = 'ok'
  and t.imp('https://onskeskyen.dk/da/wishlists/4seSLtIddxXUVB2Z') = 'ok');
delete from public.imports;
select t.chk('imports: da-dk locale and trailing slash', t.imp('https://gowish.com/da-dk/wishlists/4seSLtIddxXUVB2Z/') = 'ok');
select t.chk('imports: http is refused', t.imp('http://onskeskyen.dk/s/e0mfx8') = 'check');
select t.chk('imports: other hosts refused (lookalikes, userinfo, port, subdomain)',
  t.imp('https://onskeskyen.dk.evil.com/s/e0mfx8') = 'check' and t.imp('https://evil.com/onskeskyen.dk/s/e0mfx8') = 'check'
  and t.imp('https://onskeskyen.dk@evil.com/s/e0mfx8') = 'check' and t.imp('https://onskeskyen.dk:8443/s/e0mfx8') = 'check'
  and t.imp('https://api.gowish.com/graphql') = 'check' and t.imp('https://eviLonskeskyen.dk/s/e0mfx8') = 'check'
  and t.imp('https://prisjagt.dk/s/e0mfx8') = 'check');
select t.chk('imports: other paths refused', t.imp('https://onskeskyen.dk/') = 'check' and t.imp('https://onskeskyen.dk/s/') = 'check'
  and t.imp('https://onskeskyen.dk/wishlists/') = 'check' and t.imp('https://onskeskyen.dk/profile/abc') = 'check'
  and t.imp('https://onskeskyen.dk/s/a/b') = 'check' and t.imp('https://onskeskyen.dk/x/y/wishlists/abc') = 'check');
select t.chk('imports: spaces, empty, javascript: refused', t.imp('https://onskeskyen.dk/s/e0 mfx8') = 'check' and t.imp('') = 'check'
  and t.imp('javascript:alert(1)') = 'check' and t.imp('https://onskeskyen.dk/s/e0mfx8 ') = 'check');
select t.chk('imports: 300 characters accepted, 301 refused',
  t.imp('https://onskeskyen.dk/s/e0mfx8?' || repeat('x', 300 - length('https://onskeskyen.dk/s/e0mfx8?'))) = 'ok' and t.imp('https://onskeskyen.dk/s/e0mfx8?' || repeat('x', 301 - length('https://onskeskyen.dk/s/e0mfx8?'))) = 'check');
delete from public.imports;

-- the browser cannot choose the job-written columns
insert into public.imports (url, status, note, found, added, done_at) values ('https://onskeskyen.dk/s/e0mfx8', 'done', 'falsk', 99, 99, now());
select t.chk('imports: status, note, found, added, done_at are reset on insert; user_id defaults to the caller',
  (select status = 'pending' and note is null and found is null and added is null and done_at is null
     and user_id = '00000000-0000-0000-0000-0000000000a1' and list_id is null and created_at is not null from public.imports));
select t.chk('imports: cannot be created for someone else', t.try($$insert into public.imports (url, user_id) values ('https://onskeskyen.dk/s/e0mfx8', '00000000-0000-0000-0000-0000000000b2')$$) = 'denied');
select t.chk('imports: browser users have no UPDATE right', t.try($$update public.imports set status = 'done', added = 5$$) = 'denied');
select t.chk('imports: ... also not on other columns', t.try($$update public.imports set url = 'https://gowish.com/s/zzz'$$) = 'denied');

-- list_id: only the person's own lists
select t.chk('imports: own list accepted', t.impl('https://onskeskyen.dk/s/own1', t.lid('00000000-0000-0000-0000-0000000000a1', 'Onsker A')) = 'ok');
select t.chk('imports: someone else''s list refused', t.impl('https://onskeskyen.dk/s/own2', t.lid('00000000-0000-0000-0000-0000000000b2', 'Onsker B')) = 'fk');
select t.chk('imports: a list that does not exist refused', t.impl('https://onskeskyen.dk/s/own3', gen_random_uuid()) = 'fk');
select t.chk('imports: no list is fine', t.imp('https://onskeskyen.dk/s/own4') = 'ok');

-- isolation
select t.asB();
select t.chk('imports: B sees none of A''s rows', (select count(*) = 0 from public.imports));
select t.chk('imports: B cannot delete A''s rows', t.dels('delete from public.imports') = 0);
select t.chk('imports: B can create their own', t.imp('https://onskeskyen.dk/s/bbb') = 'ok');
select t.chk('imports: ... and sees exactly that one', (select count(*) = 1 from public.imports));
select t.asX();
select t.chk('imports: a person who is not on the allow-list sees nothing and cannot create', (select count(*) = 0 from public.imports) and t.imp('https://onskeskyen.dk/s/xxx') = 'denied');
reset role;
set role anon;
select t.chk('imports: anon is denied', t.try('select * from public.imports') = 'denied' and t.imp('https://onskeskyen.dk/s/anon') = 'denied');
reset role;
select t.chk('imports: A has 3, B has 1 (nothing leaked across)', (select count(*) = 3 from public.imports where user_id = '00000000-0000-0000-0000-0000000000a1')
  and (select count(*) = 1 from public.imports where user_id = '00000000-0000-0000-0000-0000000000b2'));

-- the guard on UPDATE, if UPDATE were ever granted
grant update on public.imports to authenticated;
set role authenticated;
select t.asA();
update public.imports set status = 'done', note = 'x', found = 9, added = 9, done_at = now(), url = 'https://gowish.com/s/zzz', user_id = '00000000-0000-0000-0000-0000000000b2';
reset role;
revoke update on public.imports from authenticated;
select t.chk('imports guard: an UPDATE cannot change status, note, found, added, done_at, url or owner',
  (select count(*) = 3 and bool_and(status = 'pending' and note is null and found is null and added is null and done_at is null
     and user_id = '00000000-0000-0000-0000-0000000000a1' and url like 'https://onskeskyen.dk/s/%') from public.imports where user_id = '00000000-0000-0000-0000-0000000000a1'));

-- cap: 5 pending
set role authenticated;
select t.asA();
select t.chk('imports cap: five pending are accepted', t.imp('https://onskeskyen.dk/s/fill1') = 'ok' and t.imp('https://onskeskyen.dk/s/fill2') = 'ok');
select t.chk('imports cap: the 6th pending import is refused', t.imp('https://onskeskyen.dk/s/six') = 'check');
select t.asB();
select t.chk('imports cap: counted per user (B unaffected)', t.imp('https://onskeskyen.dk/s/bbb2') = 'ok');
reset role;

-- the job (service role) writes the result
set role service_role;
update public.imports set status = 'done', note = 'Der var kun plads til 7 af 12 ønsker. Du kan højst følge 40 varer.', found = 12, added = 7, done_at = now()
 where url = 'https://onskeskyen.dk/s/own1';
update public.imports set status = 'error', note = 'Ønskeskyen svarede ikke. Prøv igen senere.', done_at = now() where url = 'https://onskeskyen.dk/s/own4';
select t.chk('imports: the service role can mark done and error',
  (select status = 'done' and found = 12 and added = 7 and done_at is not null from public.imports where url = 'https://onskeskyen.dk/s/own1')
  and (select status = 'error' and added is null from public.imports where url = 'https://onskeskyen.dk/s/own4'));
select t.chk('imports: status other than pending/done/error refused', t.try($$update public.imports set status = 'weird' where url = 'https://onskeskyen.dk/s/own1'$$) = 'check');
select t.chk('imports: note over 300 characters refused', t.try(format('update public.imports set note = %L where url = %L', repeat('n', 301), 'https://onskeskyen.dk/s/own1')) = 'check');
select t.chk('imports: negative found refused', t.try($$update public.imports set found = -1 where url = 'https://onskeskyen.dk/s/own1'$$) = 'check');
reset role;
set role authenticated;
select t.asA();
select t.chk('imports cap: room for new pending ones when others are done or failed', t.imp('https://onskeskyen.dk/s/seven') = 'ok' and t.imp('https://onskeskyen.dk/s/eight') = 'ok');
select t.chk('imports cap: ... but still not more than 5 pending', t.imp('https://onskeskyen.dk/s/nine') = 'check');
select t.chk('imports: the person sees the result written by the job', (select note like 'Der var kun plads til 7 af 12%' and added = 7 from public.imports where url = 'https://onskeskyen.dk/s/own1'));
reset role;

-- cap: 20 rows
update public.imports set status = 'done' where user_id = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select t.asA();
select t.chk('imports cap: 20 rows in total', (select count(*) from public.imports) = 7);
insert into public.imports (url) select 'https://onskeskyen.dk/s/r' || g from generate_series(1, 5) g;
reset role;
update public.imports set status = 'done' where user_id = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select t.asA();
insert into public.imports (url) select 'https://onskeskyen.dk/s/q' || g from generate_series(1, 5) g;
reset role;
update public.imports set status = 'error' where user_id = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select t.asA();
insert into public.imports (url) select 'https://onskeskyen.dk/s/p' || g from generate_series(1, 3) g;
select t.chk('imports cap: 20 rows reached', (select count(*) = 20 from public.imports));
select t.chk('imports cap: the 21st row is refused even if the others are done', t.imp('https://onskeskyen.dk/s/over') = 'check');
select t.chk('imports cap: hiding (deleting) a row makes room', t.dels($$delete from public.imports where url = 'https://onskeskyen.dk/s/p1'$$) = 1 and t.imp('https://onskeskyen.dk/s/again') = 'ok');
select t.asB();
select t.chk('imports cap: B can still create (counted per user)', t.imp('https://onskeskyen.dk/s/bbb3') = 'ok');
reset role;

-- deleting a list keeps the import, list_id becomes null
delete from public.imports where user_id = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select t.asA();
select t.chk('imports: a row with a list', t.impl('https://onskeskyen.dk/s/withlist', t.lid('00000000-0000-0000-0000-0000000000a1', 'Onsker A')) = 'ok');
select t.chk('imports: ... and it is stored', (select list_id is not null from public.imports where url = 'https://onskeskyen.dk/s/withlist'));
delete from public.lists where name = 'Onsker A';
select t.chk('imports: deleting the list keeps the import and clears list_id', (select count(*) = 1 and bool_and(list_id is null) from public.imports where url = 'https://onskeskyen.dk/s/withlist'));
reset role;

-- removing a user removes their imports
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d4', 'midlertidig@x.dk');
insert into public.imports (user_id, url) values ('00000000-0000-0000-0000-0000000000d4', 'https://onskeskyen.dk/s/tmp');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000d4';
select t.chk('imports: deleting the user deletes their imports', (select count(*) = 0 from public.imports where user_id = '00000000-0000-0000-0000-0000000000d4'));

-- a database without imports, then the schema (twice)
drop table public.imports cascade;
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('imports: migration from a database without the table is clean (twice)',
  (select count(*) = 1 from pg_policies where tablename = 'imports' and policyname = 'imports_own')
  and (select count(*) = 3 from pg_trigger where tgname in ('imports_guard_trg', 'imports_limit_trg', 'imports_list_check_trg'))
  and not has_table_privilege('authenticated', 'public.imports', 'update') and has_table_privilege('service_role', 'public.imports', 'update'));
delete from public.imports; delete from public.lists;

create function t.denied_as_a(q text) returns boolean language plpgsql as $$
begin
  set local role authenticated;
  perform t.asA();
  begin execute q; reset role; return false; exception when insufficient_privilege then reset role; return true; end;
end $$;
-- 11d. bought products, the morning mail and standing imports: start from the shape the live database has at HEAD
-- (none of the new columns, no profiles guard), with rows in it, then run the file twice.
insert into public.lists (name, user_id) values ('Onsker A', '00000000-0000-0000-0000-0000000000a1');
insert into public.profiles (user_id, notify_email) values ('00000000-0000-0000-0000-0000000000a1', true), ('00000000-0000-0000-0000-0000000000b2', false);
insert into public.products (user_id, name, source_url, target_type, target_value, status, notified_price) values
  ('00000000-0000-0000-0000-0000000000a1', 'gammel', 'https://shop.example.dk/gammel', 'price', 100, 'tracking', 90);
insert into public.imports (user_id, url, status, found, added, done_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'https://onskeskyen.dk/s/gammel', 'done', 12, 12, now());
drop trigger profiles_guard_trg on public.profiles;
drop function public.profiles_guard();
alter table public.products drop column bought_at, drop column bought_price, drop column digest_price, drop column digest_at;
alter table public.profiles drop column mail_digest, drop column digest_sent_at;
drop index public.imports_sync_idx;
alter table public.imports drop column synced_at, drop column seen, drop column title, drop column sync_fails;
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('migration at HEAD shape: new columns exist exactly once after two runs',
  (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('bought_at', 'bought_price', 'digest_price', 'digest_at'))
  and (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('mail_digest', 'digest_sent_at'))
  and (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'imports' and column_name in ('synced_at', 'seen', 'title', 'sync_fails'))
  and (select count(*) = 1 from pg_trigger where tgname = 'profiles_guard_trg')
  and (select count(*) = 1 from pg_constraint where conname = 'products_bought_price_check' and conrelid = 'public.products'::regclass));
select t.chk('migration keeps the rows and gives sane defaults',
  (select bool_and(not mail_digest) and bool_and(digest_sent_at is null) and count(*) = 2 from public.profiles)
  and (select bought_at is null and bought_price is null and digest_price is null and notified_price = 90 from public.products where name = 'gammel')
  and (select sync_fails = 0 and seen is null and synced_at is null and title is null and status = 'done' and added = 12 from public.imports where url = 'https://onskeskyen.dk/s/gammel'));
select t.chk('profiles: the guard does not get in the way of reading',
  (select count(*) = 2 from public.profiles));

-- bought: written by the owner in the browser
set role authenticated;
select t.asA();
update public.products set bought_at = '2000-01-01', bought_price = 1099 where name = 'gammel';
select t.chk('bought: the owner can mark a product, the time is the server clock',
  (select bought_price = 1099 and abs(extract(epoch from now() - bought_at)) < 60 from public.products where name = 'gammel'));
update public.products set bought_price = 999.5 where name = 'gammel';
select t.chk('bought: the price can be edited afterwards, the time stays',
  (select bought_price = 999.5 and abs(extract(epoch from now() - bought_at)) < 60 from public.products where name = 'gammel'));
update public.products set bought_at = '2001-01-01', name = 'gammel2' where name = 'gammel';
select t.chk('bought: bought_at cannot be edited once set (the rest of the update goes through)',
  (select bought_at > now() - interval '1 minute' and name = 'gammel2' from public.products where name = 'gammel2'));
select t.chk('bought: a price without bought_at is refused', t.try($$update public.products set bought_at = null where name = 'gammel2'$$) = 'check');
select t.chk('bought: zero, negative and absurd prices refused',
  t.try($$update public.products set bought_price = 0 where name = 'gammel2'$$) = 'check'
  and t.try($$update public.products set bought_price = -5 where name = 'gammel2'$$) = 'check'
  and t.try($$update public.products set bought_price = 10000001 where name = 'gammel2'$$) = 'check');
select t.chk('bought: the upper bound itself is fine', t.try($$update public.products set bought_price = 10000000 where name = 'gammel2'$$) = 'ok');
update public.products set bought_at = null, bought_price = null where name = 'gammel2';
select t.chk('bought: undo clears both', (select bought_at is null and bought_price is null from public.products where name = 'gammel2'));
update public.products set bought_at = now() where name = 'gammel2';
select t.chk('bought: a time without a price is fine (price not known)', (select bought_at is not null and bought_price is null from public.products where name = 'gammel2'));
update public.products set bought_at = null where name = 'gammel2';
insert into public.products (name, target_type, bought_at, bought_price) values ('koebt-ved-oprettelse', 'auto', '1999-01-01', 50);
select t.chk('bought: an insert gets the server time too', (select abs(extract(epoch from now() - bought_at)) < 60 and bought_price = 50 from public.products where name = 'koebt-ved-oprettelse'));
-- job columns stay out of reach
update public.products set digest_price = 5, digest_at = now() where name = 'gammel2';
select t.chk('digest columns: a browser update cannot set them', (select digest_price is null and digest_at is null from public.products where name = 'gammel2'));
insert into public.products (name, target_type, digest_price, digest_at) values ('digest-forsoeg', 'auto', 5, now());
select t.chk('digest columns: a browser insert cannot preset them', (select digest_price is null and digest_at is null from public.products where name = 'digest-forsoeg'));
reset role;
update public.products set digest_price = 80, digest_at = now() where name = 'gammel2';
set role authenticated;
select t.asA();
update public.products set digest_price = null, digest_at = null, target_value = 120 where name = 'gammel2';
select t.chk('digest columns: a browser update cannot clear them either', (select digest_price = 80 and digest_at is not null and target_value = 120 from public.products where name = 'gammel2'));
update public.products set source_url = 'https://shop.example.dk/ny-adresse' where name = 'gammel2';
select t.chk('digest columns: a new link starts the product over, digest included', (select digest_price is null and digest_at is null and status = 'pending' from public.products where name = 'gammel2'));
-- isolation
select t.asB();
select t.chk('bought: B sees none of A''s products and cannot change them', (select count(*) = 0 from public.products)
  and t.try($$update public.products set bought_at = now()$$) = 'ok' and (select count(*) = 0 from public.products));
reset role;
select t.chk('bought: A''s product untouched by B', (select bought_at is null from public.products where name = 'gammel2'));
set role service_role;
update public.products set bought_at = now(), bought_price = 10, digest_price = 7, digest_at = now() where name = 'gammel2';
select t.chk('bought/digest: the job (service role) can write all of them', (select bought_price = 10 and digest_price = 7 from public.products where name = 'gammel2'));
reset role;
delete from public.products where name in ('gammel2', 'koebt-ved-oprettelse', 'digest-forsoeg');

-- profiles: mail_digest is the person's, digest_sent_at is the job's
set role authenticated;
select t.asA();
update public.profiles set mail_digest = true, digest_sent_at = '2020-01-01' where user_id = '00000000-0000-0000-0000-0000000000a1';
select t.chk('profiles: the owner can switch the morning mail on; digest_sent_at cannot be set',
  (select mail_digest and digest_sent_at is null from public.profiles));
select t.chk('profiles: an upsert of the settings is accepted', t.try($$insert into public.profiles (user_id, mail_digest, digest_sent_at) values ('00000000-0000-0000-0000-0000000000a1', false, '2020-01-01')
          on conflict (user_id) do update set mail_digest = excluded.mail_digest, digest_sent_at = excluded.digest_sent_at$$) = 'ok');
select t.chk('profiles: ... and it cannot touch digest_sent_at', (select not mail_digest and digest_sent_at is null from public.profiles));
select t.chk('profiles: mail_digest cannot be null', t.try($$update public.profiles set mail_digest = null$$) = 'notnull');
reset role;
set role service_role;
update public.profiles set digest_sent_at = '2026-11-16 06:10:00+00' where user_id = '00000000-0000-0000-0000-0000000000a1';
reset role;
select t.chk('profiles: the job can write digest_sent_at', (select digest_sent_at = '2026-11-16 06:10:00+00' from public.profiles where user_id = '00000000-0000-0000-0000-0000000000a1'));
set role authenticated;
select t.asA();
update public.profiles set digest_sent_at = null, mail_digest = true where user_id = '00000000-0000-0000-0000-0000000000a1';
select t.chk('profiles: the owner cannot clear digest_sent_at (to get a second mail the same day)', (select mail_digest and digest_sent_at = '2026-11-16 06:10:00+00' from public.profiles));
select t.asB();
select t.chk('profiles: B sees only own profile, cannot change A''s', (select count(*) = 1 and bool_and(user_id = '00000000-0000-0000-0000-0000000000b2') from public.profiles)
  and t.try($$update public.profiles set mail_digest = true where user_id = '00000000-0000-0000-0000-0000000000a1'$$) = 'ok');
reset role;
select t.chk('profiles: A''s setting untouched by B', (select mail_digest from public.profiles where user_id = '00000000-0000-0000-0000-0000000000a1')
  and (select not mail_digest from public.profiles where user_id = '00000000-0000-0000-0000-0000000000b2'));
delete from public.profiles where user_id = '00000000-0000-0000-0000-0000000000b2';
set role authenticated;
select t.asB();
insert into public.profiles (user_id, notify_email, mail_digest, digest_sent_at) values ('00000000-0000-0000-0000-0000000000b2', true, true, '2020-01-01');
select t.chk('profiles: a browser insert cannot preset digest_sent_at', (select mail_digest and digest_sent_at is null from public.profiles));
select t.asX();
select t.chk('profiles: a signed-in stranger sees and writes nothing', (select count(*) = 0 from public.profiles)
  and t.try($$insert into public.profiles (user_id, mail_digest) values ('00000000-0000-0000-0000-0000000000c3', true)$$) = 'denied');
reset role;

-- imports: the sync columns belong to the job
set role authenticated;
select t.asA();
insert into public.imports (url, synced_at, seen, title, sync_fails) values ('https://onskeskyen.dk/s/ny1', now(), '["a","b"]'::jsonb, 'Falsk', 5);
select t.chk('imports sync: a browser insert cannot preset synced_at, seen, title or sync_fails',
  (select synced_at is null and seen is null and title is null and sync_fails = 0 from public.imports where url = 'https://onskeskyen.dk/s/ny1'));
reset role;
grant update on public.imports to authenticated;
set role authenticated;
select t.asA();
update public.imports set synced_at = now(), seen = '["x"]'::jsonb, title = 'Hacket', sync_fails = 7 where url = 'https://onskeskyen.dk/s/gammel';
reset role;
revoke update on public.imports from authenticated;
select t.chk('imports sync guard: an UPDATE cannot change synced_at, seen, title or sync_fails',
  (select synced_at is null and seen is null and title is null and sync_fails = 0 from public.imports where url = 'https://onskeskyen.dk/s/gammel'));
select t.chk('imports sync: browser users still have no UPDATE right', t.denied_as_a($$update public.imports set seen = '[]'::jsonb$$));
set role service_role;
update public.imports set synced_at = '2026-11-16 05:00:00+00', seen = '["w1","w2"]'::jsonb, title = 'Bastians ønskeliste', sync_fails = 2, status = 'done'
 where url = 'https://onskeskyen.dk/s/gammel';
reset role;
select t.chk('imports sync: the job writes all four', (select seen = '["w1","w2"]'::jsonb and title = 'Bastians ønskeliste' and sync_fails = 2 and synced_at is not null from public.imports where url = 'https://onskeskyen.dk/s/gammel'));
select t.chk('imports sync: seen must be an array of at most 500', t.try($$update public.imports set seen = '{"a":1}'::jsonb where url = 'https://onskeskyen.dk/s/gammel'$$) = 'check'
  and t.try($$update public.imports set seen = '"x"'::jsonb where url = 'https://onskeskyen.dk/s/gammel'$$) = 'check'
  and t.try($$update public.imports set seen = (select jsonb_agg(g) from generate_series(1, 501) g) where url = 'https://onskeskyen.dk/s/gammel'$$) = 'check'
  and t.try($$update public.imports set seen = (select jsonb_agg(g) from generate_series(1, 500) g) where url = 'https://onskeskyen.dk/s/gammel'$$) = 'ok');
select t.chk('imports sync: title over 100 and negative sync_fails refused', t.try(format('update public.imports set title = %L where url = %L', repeat('t', 101), 'https://onskeskyen.dk/s/gammel')) = 'check'
  and t.try($$update public.imports set sync_fails = -1 where url = 'https://onskeskyen.dk/s/gammel'$$) = 'check');
-- the person stops following: the row goes, the products stay
insert into public.products (user_id, name, target_type) values ('00000000-0000-0000-0000-0000000000a1', 'fra-oenskelisten', 'auto');
set role authenticated;
select t.asB();
select t.chk('imports sync: B cannot stop (delete) A''s import', t.dels($$delete from public.imports where url = 'https://onskeskyen.dk/s/gammel'$$) = 0);
select t.asA();
select t.chk('imports sync: A can stop an import', t.dels($$delete from public.imports where url = 'https://onskeskyen.dk/s/gammel'$$) = 1);
reset role;
select t.chk('imports sync: stopping keeps the products', (select count(*) = 1 from public.products where name = 'fra-oenskelisten'));
delete from public.products where name = 'fra-oenskelisten';
delete from public.imports; delete from public.lists; delete from public.profiles;

-- 12. final whole-file run on the populated database
\o /dev/null
\i :schema
\o
select t.chk('final re-run clean, admin still the same', (select array_agg(email) from public.allowed_emails where is_admin) = array['mor@familie.dk']);
select 'ALL SQL CHECKS PASSED' as result;
