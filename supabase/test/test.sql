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

-- 12. final whole-file run on the populated database
\o /dev/null
\i :schema
\o
select t.chk('final re-run clean, admin still the same', (select array_agg(email) from public.allowed_emails where is_admin) = array['mor@familie.dk']);
select 'ALL SQL CHECKS PASSED' as result;
