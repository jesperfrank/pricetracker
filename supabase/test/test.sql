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
select t.chk('authenticated: p_email is ignored, the JWT address is used (no request for others)',
  public.request_access('tom@navn.dk', 'igen') = 'requested');
reset role;
select t.chk('authenticated: request filed for the JWT address only', (select status = 'pending' and name = 'igen' from public.access_requests where email = 'someone@x.dk')
  and (select status = 'pending' from public.access_requests where email = 'tom@navn.dk') is not true);
delete from public.access_requests where email = 'someone@x.dk';
update public.access_requests set status = 'rejected', decided_at = now() where email = 'tom@navn.dk';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"Tom@Navn.dk"}', false);
select t.chk('authenticated: rejected for the own address, via the JWT', public.request_access('whatever@x.dk', 'igen') = 'rejected');
reset role;
select t.chk('authenticated: nothing created for the ignored p_email', not exists (select 1 from public.access_requests where email = 'whatever@x.dk'));
select t.chk('rejected row unchanged', (select status = 'rejected' and name is null from public.access_requests where email = 'tom@navn.dk'));

-- 5a. a request filed by a signed-in person shows up for the admin exactly like an anonymous one
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","email":"Via.Skaerm@x.dk"}', false);
select t.chk('signed-in request: requested for the JWT address', public.request_access('hvem-som-helst@x.dk', 'Via Skærm') = 'requested');
select t.chk('signed-in request: now pending in my_access', public.my_access() = 'pending');
select set_config('request.jwt.claims', '{"email":"Mor@Familie.dk"}', false);
select t.chk('signed-in request: listed for the admin like any other', exists (select 1 from public.admin_list_requests() where email = 'via.skaerm@x.dk' and name = 'Via Skærm'));
reset role;
delete from public.access_requests where email = 'via.skaerm@x.dk';

-- 5b. my_access(): the signed-in caller's own state
set role authenticated;
select set_config('request.jwt.claims', '{"email":"Far@Familie.dk"}', false);
select t.chk('my_access: allowed (case-insensitive)', public.my_access() = 'allowed');
select set_config('request.jwt.claims', '{"email":"Ny@Person.dk"}', false);
select t.chk('my_access: pending', public.my_access() = 'pending');
select set_config('request.jwt.claims', '{"email":"tom@navn.dk"}', false);
select t.chk('my_access: rejected', public.my_access() = 'rejected');
select set_config('request.jwt.claims', '{"email":"aldrig@set.dk"}', false);
select t.chk('my_access: none for an unknown address', public.my_access() = 'none');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2"}', false);
select t.chk('my_access: none without an e-mail claim', public.my_access() = 'none');
reset role;
update public.access_requests set status = 'approved', decided_at = now() where email = 'ny@person.dk';
set role authenticated;
select set_config('request.jwt.claims', '{"email":"ny@person.dk"}', false);
select t.chk('my_access: approved request but address no longer allowed: none', public.my_access() = 'none');
reset role;
update public.access_requests set status = 'pending', decided_at = null where email = 'ny@person.dk';
select t.chk('my_access: anon has no execute', (select not has_function_privilege('anon', 'public.my_access()', 'execute')
  and has_function_privilege('authenticated', 'public.my_access()', 'execute')));
set role anon;
select set_config('request.jwt.claims', '', false);
select t.chk('my_access: anon call denied', t.denied('select public.my_access()'));
reset role;

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
select set_config('request.jwt.claims', '', false);
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
drop table public.list_members;
drop policy products_select on public.products; drop policy products_update_shared on public.products;
drop trigger products_list_check_trg on public.products;
alter table public.products drop column list_id;
drop table public.lists cascade;
drop table if exists public.questions cascade;      -- its list_id key went with the lists table; the next run creates it again
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

-- opt-in mail: a new profile has everything off and has not been asked; the question is answered once, with the server's clock
delete from public.profiles where user_id = '00000000-0000-0000-0000-0000000000b2';
set role authenticated;
select t.asB();
insert into public.profiles (user_id) values ('00000000-0000-0000-0000-0000000000b2');
select t.chk('opt-in: a brand-new profile has mail off, the overview off and has not been asked',
  (select notify_email = false and mail_digest = false and mail_asked_at is null from public.profiles));
update public.profiles set notify_email = true, mail_asked_at = '2001-01-01';
select t.chk('opt-in: answering "ja tak" switches mail on and stamps the server time (not the sent time)',
  (select notify_email and mail_digest = false and mail_asked_at > now() - interval '1 minute' and mail_asked_at <= now() from public.profiles));
update public.profiles set notify_email = false, mail_asked_at = '2001-01-01';
select t.chk('opt-in: the person can change the switch later, but not the time of the answer', (select not notify_email and mail_asked_at > now() - interval '1 minute' from public.profiles));
update public.profiles set mail_asked_at = null;
select t.chk('opt-in: ... and cannot clear it (to be asked again)', (select mail_asked_at is not null from public.profiles));
reset role;
delete from public.profiles where user_id = '00000000-0000-0000-0000-0000000000b2';
set role authenticated;
select t.asB();
insert into public.profiles (user_id, notify_email, mail_asked_at) values ('00000000-0000-0000-0000-0000000000b2', false, '2001-01-01');
select t.chk('opt-in: an insert with an answer is stamped with the server time too', (select mail_asked_at > now() - interval '1 minute' and not notify_email from public.profiles));
reset role;
delete from public.profiles where user_id = '00000000-0000-0000-0000-0000000000b2';
insert into public.profiles (user_id, notify_email, mail_digest) values ('00000000-0000-0000-0000-0000000000b2', false, false);

-- one mail per deal: a changed goal (kind or value) or link clears the notified fields, nothing else does; notify_silent_until is not the browser's
insert into public.products (id, user_id, name, source_url, target_type, target_value, status, notified_price, notified_at, notify_silent_until)
values ('00000000-0000-0000-0000-00000000ee01', '00000000-0000-0000-0000-0000000000a1', 'maal-skift', 'https://shop.example.dk/m', 'price', 100, 'tracking', 90, '2026-11-10 10:00:00+00', '2030-01-01');
set role authenticated;
select t.asA();
update public.products set name = 'maal-skift2', shops_exclude = array['X'] where id = '00000000-0000-0000-0000-00000000ee01';
update public.products set target_value = 100.00 where id = '00000000-0000-0000-0000-00000000ee01';
select t.chk('goal change: a change of name or shops, or the same value written again, keeps the notified fields',
  (select notified_price = 90 and notified_at is not null and notify_silent_until = '2030-01-01' from public.products where id = '00000000-0000-0000-0000-00000000ee01'));
update public.products set target_value = 80, notify_silent_until = null where id = '00000000-0000-0000-0000-00000000ee01';
select t.chk('goal change: a new value clears notified_price and notified_at; the quiet period is not the browser''s to touch',
  (select notified_price is null and notified_at is null and target_value = 80 and notify_silent_until = '2030-01-01' from public.products where id = '00000000-0000-0000-0000-00000000ee01'));
reset role;
update public.products set notified_price = 70, notified_at = now() where id = '00000000-0000-0000-0000-00000000ee01';
set role authenticated;
select t.asA();
update public.products set target_type = 'auto', target_value = null where id = '00000000-0000-0000-0000-00000000ee01';
select t.chk('goal change: a new kind of goal clears them too', (select notified_price is null and notified_at is null and target_type = 'auto' from public.products where id = '00000000-0000-0000-0000-00000000ee01'));
reset role;
update public.products set notified_price = 70, notified_at = now() where id = '00000000-0000-0000-0000-00000000ee01';
set role authenticated;
select t.asA();
update public.products set source_url = 'https://shop.example.dk/anden' where id = '00000000-0000-0000-0000-00000000ee01';
select t.chk('goal change: a new link clears them (as before)', (select notified_price is null and notified_at is null and status = 'pending' from public.products where id = '00000000-0000-0000-0000-00000000ee01'));
insert into public.products (id, user_id, name, source_url, target_type, notify_silent_until) values ('00000000-0000-0000-0000-00000000ee02', '00000000-0000-0000-0000-0000000000a1', 'ny-uden-stilhed', 'https://shop.example.dk/n', 'auto', '2030-01-01');
select t.chk('quiet period: a new product has none, whatever the browser sends', (select notify_silent_until is null from public.products where id = '00000000-0000-0000-0000-00000000ee02'));
reset role;
delete from public.products where id in ('00000000-0000-0000-0000-00000000ee01', '00000000-0000-0000-0000-00000000ee02');

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

-- 11e. sharing a list. People: A = mor (owner of the list, admin), B = far and C = sara (allowed, will become members),
-- G = gerda (allowed, never a member: the outsider), D = fremmed (signed in, NOT allowed), E = ingen (allowed, has no account yet),
-- F = gammel (has an account, not allowed).
insert into public.allowed_emails (email) values ('sara@familie.dk'), ('gerda@familie.dk'), ('ingen@familie.dk') on conflict do nothing;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c5', 'sara@familie.dk'), ('00000000-0000-0000-0000-0000000000c3', 'fremmed@x.dk'),
  ('00000000-0000-0000-0000-0000000000f6', 'gammel@x.dk'),    ('00000000-0000-0000-0000-0000000000a7', 'Gerda@Familie.dk')
  on conflict (id) do nothing;
create function t.asC() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"sara@familie.dk","sub":"00000000-0000-0000-0000-0000000000c5"}', false) $$;
create function t.asG() returns void language sql as $$ select set_config('request.jwt.claims', '{"email":"gerda@familie.dk","sub":"00000000-0000-0000-0000-0000000000a7"}', false) $$;
grant execute on function t.asC(), t.asG() to public;
create function t.share(l uuid, e text) returns text language plpgsql as $$
declare r text; begin r := public.share_list(l, e); return r; exception when insufficient_privilege then return 'denied'; end $$;
create function t.rows(q text) returns integer language plpgsql as $$
declare n integer; begin execute q; get diagnostics n = row_count; return n; end $$;
grant execute on function t.share(uuid, text), t.rows(text) to public;
-- a product by name (any role), and a product's list by name
create function t.pid(n text) returns uuid language sql security definer as $$ select id from public.products where name = n $$;
grant execute on function t.pid(text) to public;

insert into public.lists (id, user_id, name) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'Gaver'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1', 'Privat'),
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000b2', 'Bs egen');
insert into public.products (user_id, name, source_url, target_type, target_value, status, title, offers, history, normal_price, verdict, notified_price, list_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'a-gave', 'https://shop.example.dk/gave', 'price', 100, 'tracking', 'Gave', '[{"price":90}]', '[{"t":1,"p":90}]', 120, '{"level":"good"}', 90, '00000000-0000-0000-0000-00000000aa01'),
  ('00000000-0000-0000-0000-0000000000a1', 'a-privat', 'https://shop.example.dk/privat', 'price', 100, 'tracking', 'Privat', '[{"price":80}]', null, 120, null, null, '00000000-0000-0000-0000-00000000aa02'),
  ('00000000-0000-0000-0000-0000000000a1', 'a-uden-liste', 'https://shop.example.dk/uden', 'auto', null, 'tracking', 'Uden', '[]', null, null, null, null, null),
  ('00000000-0000-0000-0000-0000000000b2', 'b-privat', 'https://shop.example.dk/bprivat', 'auto', null, 'tracking', 'B', '[]', null, null, null, null, null);

-- --- before anyone is invited: nobody but the owner sees or touches anything
set role authenticated;
select t.asB();
select t.chk('share: before inviting, B sees only B''s own product and no lists of A',
  (select count(*) = 1 and bool_and(name = 'b-privat') from public.products) and (select count(*) = 1 and bool_and(name = 'Bs egen') from public.lists));
select t.chk('share: B cannot invite to A''s list (42501), C-like call as a non-owner is refused too',
  t.share('00000000-0000-0000-0000-00000000aa01', 'sara@familie.dk') = 'denied');
select t.chk('share: B cannot insert a membership directly (no INSERT right)',
  t.try($$insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2')$$) = 'denied');
select t.chk('share: B cannot put a product into A''s list before being invited (fk)',
  t.putnew('snyd', '00000000-0000-0000-0000-00000000aa01') = 'fk');
select t.chk('share: list_members_named gives an outsider no rows', (select count(*) = 0 from public.list_members_named('00000000-0000-0000-0000-00000000aa01')));
select t.chk('share: unshare_list is refused for a non-owner', t.try($$select public.unshare_list('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2')$$) = 'denied');
select t.chk('share: leave_list on a list you are not in is a quiet false', not public.leave_list('00000000-0000-0000-0000-00000000aa01'));
select t.asX();   -- D: signed in, not allowed
select t.chk('share: D (not allowed) is refused by every function and sees nothing',
  t.share('00000000-0000-0000-0000-00000000aa01', 'sara@familie.dk') = 'denied'
  and t.try($$select public.unshare_list('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2')$$) = 'denied'
  and t.try($$select public.leave_list('00000000-0000-0000-0000-00000000aa01')$$) = 'denied'
  and (select count(*) = 0 from public.list_members_named('00000000-0000-0000-0000-00000000aa01'))
  and (select count(*) = 0 from public.products) and (select count(*) = 0 from public.lists) and (select count(*) = 0 from public.list_members));
select t.chk('share: the helper functions only ever speak about the caller (D owns and is member of nothing)',
  not public.owns_list('00000000-0000-0000-0000-00000000aa01') and not public.is_list_member('00000000-0000-0000-0000-00000000aa01'));
reset role;
set role anon;
select t.chk('share: anon cannot call any of the functions or read the tables',
  t.denied($$select public.share_list('00000000-0000-0000-0000-00000000aa01', 'x@y.dk')$$) and t.denied('select * from public.list_members_named(''00000000-0000-0000-0000-00000000aa01'')')
  and t.denied($$select public.unshare_list('00000000-0000-0000-0000-00000000aa01', null)$$) and t.denied($$select public.leave_list('00000000-0000-0000-0000-00000000aa01')$$)
  and t.denied('select * from public.list_members') and t.denied('select * from public.share_attempts') and t.denied($$select public.person_name('00000000-0000-0000-0000-0000000000a1')$$)
  and t.denied($$select public.owns_list('00000000-0000-0000-0000-00000000aa01')$$));
reset role;
set role authenticated;
select t.asA();
select t.chk('share: nobody, not even the owner, can call person_name (internal)', t.denied($$select public.person_name('00000000-0000-0000-0000-0000000000b2')$$));
select t.chk('share: nobody can read share_attempts', t.denied('select * from public.share_attempts'));

-- --- inviting: every answer, and no way to tell "no account" from "not allowed"
select t.chk('share: invalid addresses', t.share('00000000-0000-0000-0000-00000000aa01', 'hej') = 'invalid' and t.share('00000000-0000-0000-0000-00000000aa01', null) = 'invalid'
  and t.share('00000000-0000-0000-0000-00000000aa01', 'a b@c.dk') = 'invalid' and t.share('00000000-0000-0000-0000-00000000aa01', repeat('a', 200) || '@b.dk') = 'invalid');
select t.chk('share: your own address', t.share('00000000-0000-0000-0000-00000000aa01', ' MOR@familie.dk ') = 'self');
select t.chk('share: no account and not allowed give the same answer (no account oracle)',
  t.share('00000000-0000-0000-0000-00000000aa01', 'ingen@familie.dk') = 'unknown'          -- allowed, never signed in
  and t.share('00000000-0000-0000-0000-00000000aa01', 'gammel@x.dk') = 'unknown'          -- has an account, not allowed
  and t.share('00000000-0000-0000-0000-00000000aa01', 'findes-ikke@x.dk') = 'unknown'     -- neither
  and t.share('00000000-0000-0000-0000-00000000aa01', 'fremmed@x.dk') = 'unknown');
select t.chk('share: a list that is not yours is refused the same way as one that does not exist',
  t.share('00000000-0000-0000-0000-00000000bb01', 'sara@familie.dk') = 'denied' and t.share(gen_random_uuid(), 'sara@familie.dk') = 'denied');
select t.chk('share: nothing was stored by the misses', (select count(*) = 0 from public.list_members));
reset role;
select t.chk('share: look-ups are counted (4 so far)', (select count(*) = 4 from public.share_attempts));
-- rate limit: 20 look-ups an hour (hits count too), then "slow" for everything (also for a valid address), and it does not depend on the address
insert into public.share_attempts (user_id) select '00000000-0000-0000-0000-0000000000a1' from generate_series(1, 16);
set role authenticated;
select t.asA();
select t.chk('share: after 20 look-ups in an hour the answer is "slow", even for a good address',
  t.share('00000000-0000-0000-0000-00000000aa01', 'far@familie.dk') = 'slow' and t.share('00000000-0000-0000-0000-00000000aa01', 'nope@x.dk') = 'slow');
select t.asB();
select t.chk('share: the limit is per person (B is not slowed down, B only gets the normal refusal)', t.share('00000000-0000-0000-0000-00000000aa01', 'sara@familie.dk') = 'denied');
reset role;
update public.share_attempts set at = now() - interval '2 hours';
set role authenticated;
select t.asA();
select t.chk('share: look-ups older than an hour do not count', t.share('00000000-0000-0000-0000-00000000aa01', 'far@familie.dk') = 'ok');
select t.chk('share: ... and the old rows are cleaned up on the next miss', t.share('00000000-0000-0000-0000-00000000aa01', 'nope@x.dk') = 'unknown');
reset role;
update public.share_attempts set at = now() - interval '3 days';
set role authenticated; select t.asA();
select t.share('00000000-0000-0000-0000-00000000aa01', 'nope2@x.dk');
reset role;
select t.chk('share: rows older than a day are deleted', (select count(*) = 1 from public.share_attempts));
set role authenticated;
select t.asA();
select t.chk('share: a second invite of the same person is "already" (case-insensitive)', t.share('00000000-0000-0000-0000-00000000aa01', 'FAR@Familie.dk') = 'already');
select t.chk('share: the invite is stored once, the mixed-case account is found (Gerda@Familie.dk)', (select count(*) = 1 from public.list_members)
  and t.share('00000000-0000-0000-0000-00000000aa02', 'gerda@familie.dk') = 'ok');
select t.chk('share: A can remove G from Privat again', public.unshare_list('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a7') and not public.unshare_list('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a7'));
select t.chk('share: invite C as well', t.share('00000000-0000-0000-0000-00000000aa01', 'sara@familie.dk') = 'ok');
select t.chk('share: A sees both members', (select count(*) = 2 from public.list_members));
reset role;
select t.chk('share: hits are counted as look-ups too (already, gerda, sara and the last miss)', (select count(*) = 4 from public.share_attempts));

-- --- what a member sees
set role authenticated;
select t.asB();
select t.chk('member: B sees the shared list, not A''s other lists, and still their own',
  (select array_agg(name order by name) from public.lists) = array['Bs egen', 'Gaver']);
select t.chk('member: B sees the shared product (with price data), not A''s other products',
  (select count(*) = 1 from public.products where name = 'a-gave' and offers is not null and normal_price = 120 and verdict is not null)
  and (select count(*) = 0 from public.products where name in ('a-privat', 'a-uden-liste')) and (select count(*) = 2 from public.products));
select t.chk('member: B sees their own membership and C''s (co-member), never memberships of other lists',
  (select count(*) = 2 from public.list_members where list_id = '00000000-0000-0000-0000-00000000aa01'));
select t.chk('member: B cannot guess A''s other products by id', (select count(*) = 0 from public.products where id = t.pid('a-privat')));
select t.chk('member: the lists row of a shared list is read-only for B',
  t.rows($$update public.lists set name = 'Hacket' where id = '00000000-0000-0000-0000-00000000aa01'$$) = 0
  and t.rows($$delete from public.lists where id = '00000000-0000-0000-0000-00000000aa01'$$) = 0
  and t.try($$insert into public.lists (user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'Snyd')$$) = 'denied');
select t.chk('member: B cannot move the shared list to B, nor rename A''s list via user_id tricks',
  t.rows($$update public.lists set user_id = '00000000-0000-0000-0000-0000000000b2' where id = '00000000-0000-0000-0000-00000000aa01'$$) = 0);
select t.chk('member: B cannot add, change or remove members (no INSERT/UPDATE right, DELETE of other rows hits nothing)',
  t.try($$insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a7')$$) = 'denied'
  and t.try($$update public.list_members set user_id = '00000000-0000-0000-0000-0000000000a7'$$) = 'denied'
  and t.rows($$delete from public.list_members where user_id = '00000000-0000-0000-0000-0000000000c5'$$) = 0
  and t.share('00000000-0000-0000-0000-00000000aa01', 'gerda@familie.dk') = 'denied'
  and t.try($$select public.unshare_list('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000c5')$$) = 'denied');
select t.chk('member: B''s names list shows people, no e-mail addresses',
  (select count(*) = 3 and bool_and(email is null) from public.list_members_named('00000000-0000-0000-0000-00000000aa01')));
select t.chk('member: the names are Mor (owner), Far, Sara',
  (select array_agg(name || ':' || role order by name) from public.list_members_named('00000000-0000-0000-0000-00000000aa01')) = array['Far:member', 'Mor:owner', 'Sara:member']);
select t.chk('member: B''s names list for A''s other list is empty', (select count(*) = 0 from public.list_members_named('00000000-0000-0000-0000-00000000aa02')));
reset role;

-- --- what a member can add, and what they cannot change on someone else's product
set role authenticated;
select t.asB();
select t.chk('member: B can add a product to the shared list', t.putnew('b-i-gaver', '00000000-0000-0000-0000-00000000aa01') = 'ok');
select t.chk('member: ... it is B''s (user_id), pending, in the list',
  (select user_id = '00000000-0000-0000-0000-0000000000b2' and list_id = '00000000-0000-0000-0000-00000000aa01' and status = 'pending' from public.products where name = 'b-i-gaver'));
select t.chk('member: B cannot add a product as someone else', t.try($$insert into public.products (user_id, name, target_type) values ('00000000-0000-0000-0000-0000000000a1', 'som-mor', 'auto')$$) = 'denied');
select t.chk('member: B cannot add a product to A''s other list', t.putnew('snyd2', '00000000-0000-0000-0000-00000000aa02') = 'fk');
select t.chk('member: B cannot put an own product into A''s other list', t.put('b-privat', '00000000-0000-0000-0000-00000000aa02') = 'fk');
select t.chk('member: B can put an own product into the shared list', t.put('b-privat', '00000000-0000-0000-0000-00000000aa01') = 'ok');
select t.chk('member: ... and back out', t.put('b-privat', null) = 'ok');
reset role;
-- a donor row that differs from a-gave in every column but the bought ones, used to try every column
insert into public.products (id, user_id, name, source_url, target_type, target_value, tracked_variants, shops_always, shops_exclude, shops_only, active, created_at,
  status, title, variants, offers, history, normal_price, verdict, warning, check_note, last_checked, notified_price, notified_at, backfill_state, digest_price, digest_at, list_id,
  alt_requested_at, alternatives, alt_done_at, alt_note, compare_state, compare_at, shop_url, image_url, compare_tries, extra_urls, extra_state, requirements, req_state, notify_silent_until)
values ('00000000-0000-0000-0000-00000000dd01', '00000000-0000-0000-0000-0000000000b2', 'donor', 'https://shop.example.dk/donor', 'pct', 15, array['v9'], array['Proshop'], array['CDON'], true, false, '2001-01-01',
  'error', 'Donor', '[{"id":9}]', '[{"price":1}]', '[{"t":2,"p":1}]', 999, '{"level":"poor"}', 'w', 'n', '2001-02-02', 1, '2001-03-03', '{"at":"x"}', 5, '2001-04-04', '00000000-0000-0000-0000-00000000bb01',
  '2001-05-05', '[{"kind":"deal"}]', '2001-06-06', 'donor', 'done', '2001-07-07', 'https://shop.example.dk/donor-original', 'https://img.example.dk/donor.jpg', 2, '["https://andet.example.dk/donor"]', '{"https://andet.example.dk/donor":{"seen":true}}', 'donor krav', '{"want":true}', '2001-08-08');
update public.products set tracked_variants = array['v1'], shops_always = array['Elgiganten'], shops_exclude = array['Power'], shops_only = false, active = true,
  variants = '[{"id":1}]', warning = 'ww', check_note = 'nn', last_checked = '2002-02-02', notified_at = '2002-03-03', backfill_state = '{"at":"y"}', digest_price = 7, digest_at = '2002-04-04',
  alt_requested_at = '2002-05-05', alternatives = '[{"kind":"similar"}]', alt_done_at = '2002-06-06', alt_note = 'gave', image_url = 'https://img.example.dk/gave.jpg', extra_urls = '["https://tredje.example.dk/gave"]', extra_state = '{"x":{"fails":3}}', requirements = 'gave krav', req_state = '{"for":"gave krav","by":"agent"}', notify_silent_until = '2002-07-07'
 where name = 'a-gave';
create table t.donor as select * from public.products where name = 'donor';
create table t.snap as select id, to_jsonb(p) as j from public.products p where name = 'a-gave';
grant select on t.donor, t.snap to public;
select t.chk('forbidden columns: the donor row differs from the target in every column except the bought ones',
  (select count(*) = 0 from jsonb_each((select to_jsonb(p) from public.products p where name = 'a-gave')) e
     join jsonb_each((select to_jsonb(d) from t.donor d)) f using (key)
    where e.value = f.value and key not in ('bought_at', 'bought_price', 'bought_by', 'name_options')));   -- name_options needs a product without a link: tested on its own ("Mente du")
-- t.forbid(product): try to change every column but the bought ones; returns the columns where it did NOT fail with check_violation
create function t.forbid(pid uuid) returns text language plpgsql as $$
declare c record; bad text := ''; n integer; same boolean;
begin
  for c in select a.attname from pg_attribute a where a.attrelid = 'public.products'::regclass and a.attnum > 0 and not a.attisdropped
             and a.attname not in ('bought_at', 'bought_price', 'bought_by') loop
    execute format('select (select %I from public.products where id = %L) is not distinct from (select %I from t.donor)', c.attname, pid, c.attname) into same;
    continue when same;     -- the donor has the same value here (fx the owner), nothing to try
    begin
      execute format('update public.products set %I = (select %I from t.donor) where id = %L', c.attname, c.attname, pid);
      get diagnostics n = row_count;
      bad := bad || c.attname || '(no error, ' || n || ' rows) ';
    exception when check_violation then null;
      when others then bad := bad || c.attname || '(' || sqlstate || ') ';
    end;
  end loop;
  return bad;
end $$;
grant execute on function t.forbid(uuid) to public;
set role authenticated;
select t.asB();
select t.chk('forbidden: B (member) cannot change ANY column of A''s product except the bought ones', t.forbid(t.pid('a-gave')) = '');
select t.chk('forbidden: ... and nothing changed', (select to_jsonb(p) = s.j from public.products p, t.snap s where p.id = s.id));
select t.chk('forbidden: B cannot delete A''s product in the shared list', t.rows($$delete from public.products where name = 'a-gave'$$) = 0);
select t.chk('forbidden: B cannot set several columns at once with a harmless one',
  t.try($$update public.products set name = 'x', bought_at = now() where name = 'a-gave'$$) = 'check');
select t.chk('forbidden: B cannot hand A''s product to B or pull it out of the list in one go',
  t.try($$update public.products set user_id = '00000000-0000-0000-0000-0000000000b2' where name = 'a-gave'$$) = 'check'
  and t.try($$update public.products set list_id = null where name = 'a-gave'$$) = 'check');
reset role;
select t.chk('forbidden: still untouched after the attempts', (select to_jsonb(p) = s.j from public.products p, t.snap s where p.id = s.id));
set role authenticated;
select t.asC();
select t.chk('forbidden: C (the other member) is held to the same rule', t.forbid(t.pid('a-gave')) = '');
select t.chk('forbidden: ... and cannot change B''s product in the list either', t.forbid(t.pid('b-i-gaver')) = '');
select t.asA();
select t.chk('forbidden: A, the list''s owner, also cannot change B''s product (only the bought columns)', t.forbid(t.pid('b-i-gaver')) = '');
select t.chk('forbidden: A cannot delete B''s product in A''s list', t.rows($$delete from public.products where name = 'b-i-gaver'$$) = 0);
select t.chk('forbidden: A sees B''s product in the list', (select count(*) = 1 from public.products where name = 'b-i-gaver'));
reset role;
select t.chk('forbidden: B''s product is untouched', (select user_id = '00000000-0000-0000-0000-0000000000b2' and name = 'b-i-gaver' from public.products where name = 'b-i-gaver'));

-- --- bought: who may mark, who may undo
set role authenticated;
select t.asB();
update public.products set bought_at = '2000-01-01', bought_price = 1099, bought_by = '00000000-0000-0000-0000-0000000000c5' where name = 'a-gave';
select t.chk('bought: B marks A''s product; the time is the server''s, bought_by is B (not what was sent)',
  (select bought_price = 1099 and abs(extract(epoch from now() - bought_at)) < 60 and bought_by = '00000000-0000-0000-0000-0000000000b2' from public.products where name = 'a-gave'));
select t.chk('bought: nothing else changed by the member''s mark',
  (select to_jsonb(p) - 'bought_at' - 'bought_price' - 'bought_by' = s.j - 'bought_at' - 'bought_price' - 'bought_by' from public.products p, t.snap s where p.id = s.id));
select t.asC();
select t.chk('bought: C sees who bought it', (select bought_by = '00000000-0000-0000-0000-0000000000b2' from public.products where name = 'a-gave'));
select t.chk('bought: C (a plain member) cannot undo B''s mark, nor change its price', t.try($$update public.products set bought_at = null, bought_price = null where name = 'a-gave'$$) = 'check'
  and t.try($$update public.products set bought_price = 1 where name = 'a-gave'$$) = 'check');
update public.products set bought_at = now(), bought_by = '00000000-0000-0000-0000-0000000000c5' where name = 'a-gave';
select t.chk('bought: C cannot take over the mark (bought_by and time stay B''s)',
  (select bought_by = '00000000-0000-0000-0000-0000000000b2' and bought_price = 1099 and bought_at < now() - interval '0 seconds' from public.products where name = 'a-gave'));
select t.chk('bought: C cannot write bought_by directly either (the update is accepted, the value ignored)', t.rows($$update public.products set bought_by = '00000000-0000-0000-0000-0000000000c5' where name = 'a-gave'$$) = 1);
select t.chk('bought: ... bought_by is still B', (select bought_by = '00000000-0000-0000-0000-0000000000b2' from public.products where name = 'a-gave'));
select t.asB();
update public.products set bought_price = 999.5 where name = 'a-gave';
select t.chk('bought: B (who set it) can change the price', (select bought_price = 999.5 from public.products where name = 'a-gave'));
select t.asA();
update public.products set bought_price = 950 where name = 'a-gave';
select t.chk('bought: A (product owner and list owner) can change the price', (select bought_price = 950 and bought_by = '00000000-0000-0000-0000-0000000000b2' from public.products where name = 'a-gave'));
update public.products set bought_at = null, bought_price = null where name = 'a-gave';
select t.chk('bought: A can undo B''s mark; bought_by is cleared', (select bought_at is null and bought_price is null and bought_by is null from public.products where name = 'a-gave'));
-- the other direction: A marks own product, B cannot undo it
update public.products set bought_at = now() where name = 'a-gave';
select t.chk('bought: A''s own mark is stamped with A', (select bought_by = '00000000-0000-0000-0000-0000000000a1' from public.products where name = 'a-gave'));
select t.asB();
select t.chk('bought: B cannot undo A''s mark', t.try($$update public.products set bought_at = null where name = 'a-gave'$$) = 'check');
select t.chk('bought: ... nor fake a price on it', t.try($$update public.products set bought_price = 5 where name = 'a-gave'$$) = 'check');
-- B's own product in the list, bought by C: B (the product's owner) and A (list owner) may undo, C may
select t.asC();
update public.products set bought_at = now(), bought_price = 50 where name = 'b-i-gaver';
select t.chk('bought: C marks B''s product', (select bought_by = '00000000-0000-0000-0000-0000000000c5' from public.products where name = 'b-i-gaver'));
select t.asA();
select t.chk('bought: A (list owner, not product owner, not marker) can undo', t.rows($$update public.products set bought_at = null, bought_price = null where name = 'b-i-gaver'$$) = 1);
select t.chk('bought: ... and bought_by is cleared', (select bought_at is null and bought_by is null from public.products where name = 'b-i-gaver'));
select t.asC();
update public.products set bought_at = now() where name = 'b-i-gaver';
select t.asB();
select t.chk('bought: B (product owner) can undo C''s mark on B''s own product', t.rows($$update public.products set bought_at = null where name = 'b-i-gaver'$$) = 1);
select t.chk('bought: ... it is undone', (select bought_at is null from public.products where name = 'b-i-gaver'));
select t.chk('bought: a member can mark again after an undo', t.rows($$update public.products set bought_at = now() where name = 'b-i-gaver'$$) = 1);
select t.chk('bought: ... stamped with B', (select bought_by = '00000000-0000-0000-0000-0000000000b2' from public.products where name = 'b-i-gaver'));
update public.products set bought_at = null where name = 'b-i-gaver';
-- an insert with a bought mark is stamped too, bought_by cannot be preset
insert into public.products (name, target_type, bought_at, bought_price, bought_by, list_id) values ('b-koebt', 'auto', '1999-01-01', 5, '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-00000000aa01');
select t.chk('bought: an insert gets the server time and bought_by = the inserting person', (select bought_by = '00000000-0000-0000-0000-0000000000b2' and abs(extract(epoch from now() - bought_at)) < 60 from public.products where name = 'b-koebt'));
insert into public.products (name, target_type, bought_by) values ('b-ikke-koebt', 'auto', '00000000-0000-0000-0000-0000000000c5');
select t.chk('bought: bought_by without a mark is dropped on insert', (select bought_by is null from public.products where name = 'b-ikke-koebt'));
update public.products set bought_by = '00000000-0000-0000-0000-0000000000c5' where name = 'b-ikke-koebt';
select t.chk('bought: bought_by without a mark is dropped on update', (select bought_by is null from public.products where name = 'b-ikke-koebt'));
reset role;
delete from public.products where name in ('b-koebt', 'b-ikke-koebt');

-- --- the owner of a product in the shared list keeps full control of it
set role authenticated;
select t.asB();
update public.products set name = 'b-i-gaver2', target_type = 'price', target_value = 7, shops_only = false where name = 'b-i-gaver';
select t.chk('own product: B can edit own product in the shared list', (select count(*) = 1 from public.products where name = 'b-i-gaver2' and target_value = 7));
select t.asA();
select t.chk('own product: A (list owner) sees the change', (select count(*) = 1 from public.products where name = 'b-i-gaver2'));
select t.asB();
select t.chk('own product: B can delete own product', t.rows($$delete from public.products where name = 'b-i-gaver2'$$) = 1);
reset role;

-- --- a third person (G, allowed but not a member) and a removed-from-allowed member
set role authenticated;
select t.asG();
select t.chk('outsider: G (allowed, not a member) sees nothing of A''s, and is refused by every function',
  (select count(*) = 0 from public.products) and (select count(*) = 0 from public.lists) and (select count(*) = 0 from public.list_members)
  and (select count(*) = 0 from public.list_members_named('00000000-0000-0000-0000-00000000aa01'))
  and t.share('00000000-0000-0000-0000-00000000aa01', 'gerda@familie.dk') = 'denied'
  and t.try($$select public.unshare_list('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2')$$) = 'denied'
  and not public.leave_list('00000000-0000-0000-0000-00000000aa01'));
select t.chk('outsider: G cannot add to, change or delete in the shared list',
  t.putnew('snyd3', '00000000-0000-0000-0000-00000000aa01') = 'fk'
  and t.rows($$update public.products set bought_at = now() where name = 'a-gave'$$) = 0
  and t.rows($$delete from public.products where name = 'a-gave'$$) = 0
  and t.rows($$update public.lists set name = 'x'$$) = 0 and t.rows($$delete from public.list_members$$) = 0);
reset role;
select t.chk('outsider: nothing happened', (select count(*) = 1 from public.products where name = 'a-gave' and bought_at is not null and bought_by = '00000000-0000-0000-0000-0000000000a1'));
-- B loses access to the site: no reading, no writing, even though still a member row
delete from public.allowed_emails where email = 'far@familie.dk';
set role authenticated;
select t.asB();
select t.chk('allowed: a member who is no longer allowed sees and changes nothing',
  (select count(*) = 0 from public.products) and (select count(*) = 0 from public.lists) and (select count(*) = 0 from public.list_members)
  and t.rows($$update public.products set bought_at = now() where name = 'a-gave'$$) = 0 and t.putnew('nej', '00000000-0000-0000-0000-00000000aa01') = 'denied'
  and (select count(*) = 0 from public.list_members_named('00000000-0000-0000-0000-00000000aa01')) and t.try($$select public.leave_list('00000000-0000-0000-0000-00000000aa01')$$) = 'denied');
reset role;
insert into public.allowed_emails (email) values ('far@familie.dk');

-- --- removal and leaving: the person's own products leave the list and stay theirs; read access ends at once
insert into public.products (user_id, name, target_type, list_id) values
  ('00000000-0000-0000-0000-0000000000b2', 'b-1', 'auto', '00000000-0000-0000-0000-00000000aa01'),
  ('00000000-0000-0000-0000-0000000000b2', 'b-2', 'auto', '00000000-0000-0000-0000-00000000aa01'),
  ('00000000-0000-0000-0000-0000000000c5', 'c-1', 'auto', '00000000-0000-0000-0000-00000000aa01');
update public.products set bought_at = now(), bought_by = '00000000-0000-0000-0000-0000000000b2', bought_price = 10 where name = 'a-gave';
set role authenticated;
select t.asB();
select t.chk('remove: B sees 4 products before (a-gave, b-1, b-2, c-1)', (select count(*) = 4 from public.products where list_id = '00000000-0000-0000-0000-00000000aa01'));
select t.asC();
select t.chk('remove: only the owner can remove (C cannot)', t.try($$select public.unshare_list('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2')$$) = 'denied');
select t.asA();
select t.chk('remove: A removes B', public.unshare_list('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b2'));
select t.asB();
select t.chk('remove: B immediately sees nothing of the list: not a-gave, not c-1, not the list, not the members',
  (select count(*) = 0 from public.products where name in ('a-gave', 'c-1')) and (select count(*) = 0 from public.lists where name = 'Gaver')
  and (select count(*) = 0 from public.list_members) and (select count(*) = 0 from public.list_members_named('00000000-0000-0000-0000-00000000aa01'))
  and t.rows($$update public.products set bought_at = null where name = 'a-gave'$$) = 0 and t.putnew('nej2', '00000000-0000-0000-0000-00000000aa01') = 'fk');
select t.chk('remove: B''s own products stay B''s, now without a list (and B still sees them)',
  (select count(*) = 3 and bool_and(list_id is null) and bool_and(user_id = '00000000-0000-0000-0000-0000000000b2') from public.products where name in ('b-1', 'b-2', 'b-privat')));
select t.asA();
select t.chk('remove: A no longer sees B''s products, still sees own and C''s',
  (select count(*) = 0 from public.products where name in ('b-1', 'b-2')) and (select count(*) = 2 from public.products where list_id = '00000000-0000-0000-0000-00000000aa01'));
select t.chk('remove: the mark B left on a-gave stays; B still has a name for A (former member)',
  (select bought_by = '00000000-0000-0000-0000-0000000000b2' from public.products where name = 'a-gave')
  and (select role = 'former' and name = 'Far' and email is null from public.list_members_named('00000000-0000-0000-0000-00000000aa01') where user_id = '00000000-0000-0000-0000-0000000000b2'));
select t.asC();
select t.chk('remove: C sees a former member by name but never an e-mail', (select count(*) = 3 and bool_and(email is null) from public.list_members_named('00000000-0000-0000-0000-00000000aa01')));
select t.chk('remove: C (remaining member) can undo nothing of B''s old mark', t.try($$update public.products set bought_at = null where name = 'a-gave'$$) = 'check');
select t.asA();
select t.chk('remove: A can (list owner)', t.rows($$update public.products set bought_at = null, bought_price = null where name = 'a-gave'$$) = 1);
-- leaving
select t.asC();
select t.chk('leave: C leaves', public.leave_list('00000000-0000-0000-0000-00000000aa01') and not public.leave_list('00000000-0000-0000-0000-00000000aa01'));
select t.chk('leave: C''s own product is out of the list and still C''s; C sees no more of A''s',
  (select count(*) = 1 and bool_and(list_id is null) from public.products where name = 'c-1') and (select count(*) = 1 from public.products)
  and (select count(*) = 0 from public.lists));
select t.chk('leave: C cannot leave by deleting someone else''s row, only their own', t.rows($$delete from public.list_members$$) = 0);
reset role;
select t.chk('leave/remove: A''s product is untouched and still in the list', (select list_id = '00000000-0000-0000-0000-00000000aa01' and user_id = '00000000-0000-0000-0000-0000000000a1' from public.products where name = 'a-gave'));
select t.chk('leave/remove: no members left', (select count(*) = 0 from public.list_members));
-- a member can also leave by deleting their own row (RLS), and the products still leave the list
set role authenticated; select t.asA();
select t.share('00000000-0000-0000-0000-00000000aa01', 'far@familie.dk'), t.share('00000000-0000-0000-0000-00000000aa01', 'sara@familie.dk');
select t.asB();
select t.chk('leave: B back in; adds a product', t.putnew('b-3', '00000000-0000-0000-0000-00000000aa01') = 'ok');
select t.chk('leave: B leaves with a plain DELETE of the own row', t.rows($$delete from public.list_members where user_id = '00000000-0000-0000-0000-0000000000b2'$$) = 1);
select t.chk('leave: ... and the product left the list', (select list_id is null from public.products where name = 'b-3'));
reset role;

-- --- deleting the list: products stay with whoever added them, members lose access, memberships go
set role authenticated; select t.asC();
select t.chk('delete list: C adds a product to the shared list', t.putnew('c-2', '00000000-0000-0000-0000-00000000aa01') = 'ok');
select t.asA();
delete from public.lists where id = '00000000-0000-0000-0000-00000000aa01';
reset role;
select t.chk('delete list: all products stay, none in a list, with their adders',
  (select count(*) = 1 and bool_and(list_id is null) and bool_and(user_id = '00000000-0000-0000-0000-0000000000c5') from public.products where name = 'c-2')
  and (select count(*) = 1 and bool_and(list_id is null) from public.products where name = 'a-gave')
  and (select count(*) = 0 from public.list_members));
set role authenticated; select t.asC();
select t.chk('delete list: C keeps own product, sees nothing else', (select count(*) = 2 and bool_and(user_id = '00000000-0000-0000-0000-0000000000c5') from public.products));
reset role;

-- --- the cap: 10 members per list, 40 products per adding person
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000a1', 'Stor');
insert into auth.users (id, email) select ('00000000-0000-0000-0000-000000000' || lpad(g::text, 3, '0'))::uuid, 'medlem' || g || '@familie.dk' from generate_series(101, 111) g;
insert into public.allowed_emails (email) select 'medlem' || g || '@familie.dk' from generate_series(101, 111) g;
set role authenticated; select t.asA();
select t.chk('cap: ten members are fine',
  (select bool_and(t.share('00000000-0000-0000-0000-00000000aa03', 'medlem' || g || '@familie.dk') = 'ok') from generate_series(101, 110) g));
select t.chk('cap: the eleventh gets "full", also for an unknown address (the cap comes first, it says nothing about the address)',
  t.share('00000000-0000-0000-0000-00000000aa03', 'medlem111@familie.dk') = 'full' and t.share('00000000-0000-0000-0000-00000000aa03', 'nope@x.dk') = 'full');
reset role;
select t.chk('cap: the trigger enforces it for every role', t.try($$insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-000000000111')$$) = 'check');
select t.chk('cap: the owner cannot be a member', t.try($$insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1')$$) = 'fk');
select t.chk('cap: only allowed people can be members (checked for every role)',
  t.try($$insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000f6')$$) = 'check'
  and t.try($$insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa03', gen_random_uuid())$$) in ('fk', 'check'));
delete from public.list_members where user_id = '00000000-0000-0000-0000-000000000110';
select t.chk('cap: ... the eleventh fits now', t.try($$insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-000000000111')$$) = 'ok');
-- 40 products per adding person: member products count for the member, not for the owner
insert into public.products (user_id, name, target_type, list_id) select '00000000-0000-0000-0000-000000000101', 'm' || g, 'auto', '00000000-0000-0000-0000-00000000aa03' from generate_series(1, 40) g;
set role authenticated;
select set_config('request.jwt.claims', '{"email":"medlem101@familie.dk","sub":"00000000-0000-0000-0000-000000000101"}', false);
select t.chk('cap: the 41st product of a member is refused, even in the shared list', t.putnew('m41', '00000000-0000-0000-0000-00000000aa03') = 'check');
select t.asA();
select t.chk('cap: the owner''s own count is separate (A can still add to the shared list)', t.putnew('a-ny', '00000000-0000-0000-0000-00000000aa03') = 'ok');
reset role;
delete from public.products where name ~ '^m[0-9]+$' or name = 'a-ny';

-- --- the price job (service role) and imports
set role service_role;
select t.chk('job: the service role can add a product for a member to the shared list', t.try($$insert into public.products (user_id, name, target_type, list_id) values ('00000000-0000-0000-0000-000000000102', 'job-m', 'auto', '00000000-0000-0000-0000-00000000aa03')$$) = 'ok');
select t.chk('job: ... and for the owner', t.try($$insert into public.products (user_id, name, target_type, list_id) values ('00000000-0000-0000-0000-0000000000a1', 'job-a', 'auto', '00000000-0000-0000-0000-00000000aa03')$$) = 'ok');
select t.chk('job: ... but not for a person who is not a member (checked for every role)', t.try($$insert into public.products (user_id, name, target_type, list_id) values ('00000000-0000-0000-0000-0000000000c5', 'job-c', 'auto', '00000000-0000-0000-0000-00000000aa03')$$) = 'fk');
update public.products set check_note = 'tjekket', status = 'tracking', title = 'T' where name = 'job-m';
select t.chk('job: updates keep user_id and list_id', (select user_id = '00000000-0000-0000-0000-000000000102' and list_id = '00000000-0000-0000-0000-00000000aa03' and title = 'T' from public.products where name = 'job-m'));
reset role;
set role authenticated;
select set_config('request.jwt.claims', '{"email":"medlem101@familie.dk","sub":"00000000-0000-0000-0000-000000000101"}', false);
select t.chk('imports: a member cannot create an import into the shared list (only the owner can)',
  t.impl('https://onskeskyen.dk/s/medlem', '00000000-0000-0000-0000-00000000aa03') = 'fk');
select t.chk('imports: a member can still make one without a list', t.imp('https://onskeskyen.dk/s/medlem2') = 'ok');
select t.chk('imports: ... and sees only their own imports', (select count(*) = 1 from public.imports));
select t.asA();
select t.chk('imports: the owner can create one into the shared list, and a member does not see it',
  t.impl('https://onskeskyen.dk/s/ejer', '00000000-0000-0000-0000-00000000aa03') = 'ok');
select set_config('request.jwt.claims', '{"email":"medlem101@familie.dk","sub":"00000000-0000-0000-0000-000000000101"}', false);
select t.chk('imports: the member cannot read or stop the owner''s import', (select count(*) = 1 and bool_and(url like '%medlem2') from public.imports)
  and t.rows($$delete from public.imports where url like '%ejer'$$) = 0);
reset role;
delete from public.imports;

-- --- the shared list's names
update public.access_requests set status = 'approved', name = '  Jesper Frank ' where email = 'p1@x.dk';
update public.access_requests set status = 'pending', name = 'Snyder' where email = 'p2@x.dk';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e8', 'p1@x.dk'), ('00000000-0000-0000-0000-0000000000e9', 'p2@x.dk'),
  ('00000000-0000-0000-0000-0000000000ea', 'Anne-Mette.Hansen+pris@x.dk'), ('00000000-0000-0000-0000-0000000000eb', '.@x.dk');
select t.chk('names: the first word of the name given when asking for access; only when approved; else the start of the e-mail',
  (select string_agg(n, ',' order by n) from (select public.person_name(id) n from auth.users where id in
     ('00000000-0000-0000-0000-0000000000e8', '00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000a1')) x) = 'Anne,Jesper,Mor,P2');
select t.chk('names: nothing usable gives a fallback', public.person_name('00000000-0000-0000-0000-0000000000eb') = 'Ukendt');
set role authenticated;
select t.asA();
select t.chk('names: the owner sees the e-mail address (lower-case) of the members they invited',
  (select email from public.list_members_named('00000000-0000-0000-0000-00000000aa03') where name = 'Medlem101') = 'medlem101@familie.dk'
  and (select email is null from public.list_members_named('00000000-0000-0000-0000-00000000aa03') where role = 'owner'));
select set_config('request.jwt.claims', '{"email":"medlem101@familie.dk","sub":"00000000-0000-0000-0000-000000000101"}', false);
select t.chk('names: a member sees names and not one e-mail address (not the owner''s, not a co-member''s)',
  (select count(*) = 11 and bool_and(email is null) from public.list_members_named('00000000-0000-0000-0000-00000000aa03')));
reset role;
delete from public.lists where id = '00000000-0000-0000-0000-00000000aa03';
delete from public.products where name like 'job-%';
delete from public.list_members;
delete from public.lists where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.products where user_id in (select id from auth.users where id <> '00000000-0000-0000-0000-0000000000a1' and id <> '00000000-0000-0000-0000-0000000000b2');
drop table t.donor, t.snap;

-- a person leaves the site: the memberships, products and attempts go with them
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000a1', 'Slut');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000c5');
insert into public.products (user_id, name, target_type, list_id, bought_at, bought_by, bought_price) values
  ('00000000-0000-0000-0000-0000000000a1', 'slut-a', 'auto', '00000000-0000-0000-0000-00000000aa04', now(), '00000000-0000-0000-0000-0000000000c5', 5);
delete from auth.users where id = '00000000-0000-0000-0000-0000000000c5';
select t.chk('delete user: the membership goes, the bought mark stays without a name, the product is untouched',
  (select count(*) = 0 from public.list_members) and (select bought_at is not null and bought_by is null from public.products where name = 'slut-a'));
delete from public.products where name = 'slut-a'; delete from public.lists where name = 'Slut';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c5', 'sara@familie.dk');

-- 11f. alternatives ("Alternativer"): the request from the browser, the limit, and the AI agent's three functions.
-- People: A = mor (asks), B = far (member of A's list, and asks for B's own), C = sara (stranger, no list).
delete from public.alt_attempts;
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-0000000000a1', 'Alt');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-0000000000b2');
insert into public.products (user_id, name, source_url, target_type, status, title, offers, normal_price, list_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'alt1', 'https://www.shop.example.dk/p/1?x=1', 'auto', 'tracking', 'Sony XM5',
     '[{"store":"A","price":2100,"inStock":false},{"store":"B","price":2300,"inStock":true},{"store":"C","price":2250.5,"inStock":true},{"store":"D","price":"x","inStock":true}]', 2600, '00000000-0000-0000-0000-00000000aa05'),
  ('00000000-0000-0000-0000-0000000000a1', 'alt2', 'https://shop.example.dk/2', 'auto', 'tracking', null, '[]', null, null),
  ('00000000-0000-0000-0000-0000000000a1', 'alt3', 'https://shop.example.dk/3', 'auto', 'tracking', 'Tre', '[{"store":"A","price":5,"inStock":false}]', null, null),
  ('00000000-0000-0000-0000-0000000000a1', 'alt4', 'https://shop.example.dk/4', 'auto', 'tracking', 'Fire', null, null, null),
  ('00000000-0000-0000-0000-0000000000a1', 'alt5', 'https://shop.example.dk/5', 'auto', 'tracking', 'Fem', 'null', null, null),
  ('00000000-0000-0000-0000-0000000000a1', 'alt6', 'https://shop.example.dk/6', 'auto', 'tracking', 'Seks', '{"price":5}', null, null),
  ('00000000-0000-0000-0000-0000000000b2', 'bs-alt', 'https://shop.example.dk/b', 'auto', 'tracking', 'Bs', '[]', null, null);
-- the message of a statement, or 'ok'
create function t.err(q text) returns text language plpgsql as $$
declare n integer; begin execute q; get diagnostics n = row_count; return 'ok' || n; exception when others then return sqlerrm; end $$;
-- a request from the browser for a product by name, with a forged client value; returns 'ok' or the message
create function t.req(n text) returns text language plpgsql as $$
declare c integer; begin
  update public.products set alt_requested_at = '2000-01-01' where name = n; get diagnostics c = row_count;
  return case when c = 1 then 'ok' else 'rows ' || c end;
exception when others then return sqlerrm; end $$;
-- the agent answers: marks a product as answered (any role) and makes it pending again
create function t.answered(n text) returns void language sql security definer as $$
  update public.products set alt_done_at = now(), alternatives = '[{"kind":"similar","name":"Gammel","url":"https://x.dk/a","store":"X","price":1,"why":"g"}]' where name = n $$;
create function t.age(n text, h numeric) returns void language sql security definer as $$
  update public.products set alt_requested_at = now() - (h || ' hours')::interval where name = n $$;
-- the value of a query (as text), run on its own snapshot: use it to read after a change made in the same select
create function t.q(q text) returns text language plpgsql security definer as $$ declare r text; begin execute q into r; return r; end $$;
grant execute on function t.q(text) to public;
grant execute on function t.err(text), t.req(text), t.answered(text), t.age(text, numeric) to public;

set role authenticated;
select t.asA();
select t.chk('alt: A asks', t.req('alt1') = 'ok');
select t.chk('alt: ... the time is the server clock (whatever the client sent)', (select abs(extract(epoch from now() - alt_requested_at)) < 60 from public.products where name = 'alt1'));
select t.chk('alt: nothing else changed by asking', (select alternatives is null and alt_done_at is null and alt_note is null from public.products where name = 'alt1'));
select t.chk('alt: a second request while pending is refused with a clear message', t.req('alt1') = 'Der er allerede bedt om alternativer. Vent på svaret.');
select t.chk('alt: ... also when the client sends a future time or null (null is ignored)',
  t.err($$update public.products set alt_requested_at = now() + interval '1 day' where name = 'alt1'$$) like 'Der er allerede bedt%'
  and t.err($$update public.products set alt_requested_at = null where name = 'alt1'$$) = 'ok1'
  and t.q($$select (alt_requested_at is not null)::text from public.products where name = 'alt1'$$) = 'true');
select t.chk('alt: sending the same value is no request (no change, no slot used)',
  t.err($$update public.products set alt_requested_at = (select alt_requested_at from public.products where name = 'alt1'), name = 'alt1' where name = 'alt1'$$) = 'ok1');
reset role;
select t.chk('alt: only the one accepted request used a slot', (select count(*) = 1 from public.alt_attempts));
set role authenticated;
select t.asA();
-- forging the AI columns from the browser
select t.chk('alt: the browser cannot write alternatives, alt_done_at or alt_note (the rest of the update goes through)',
  t.err($$update public.products set alternatives = '[{"kind":"deal"}]', alt_done_at = now() + interval '1 hour', alt_note = 'snyd', name = 'alt1-nyt' where name = 'alt1'$$) = 'ok1'
  and t.q($$select (alternatives is null and alt_done_at is null and alt_note is null and name = 'alt1-nyt')::text from public.products where name = 'alt1-nyt'$$) = 'true');
update public.products set name = 'alt1' where name = 'alt1-nyt';
select t.chk('alt: a browser insert cannot preset any alt column',
  t.err($$insert into public.products (name, target_type, alt_requested_at, alternatives, alt_done_at, alt_note) values ('alt-ny', 'auto', now(), '[]', now(), 'x')$$) = 'ok1'
  and t.q($$select (alt_requested_at is null and alternatives is null and alt_done_at is null and alt_note is null)::text from public.products where name = 'alt-ny'$$) = 'true');
delete from public.products where name = 'alt-ny';
reset role;
select t.chk('alt: the check constraints reject a non-array, 7 items and a 201-character note',
  t.err($$update public.products set alternatives = '{"a":1}' where name = 'alt3'$$) like '%alternatives_check%'
  and t.err($$update public.products set alternatives = '[1,2,3,4,5,6,7]' where name = 'alt3'$$) like '%alternatives_check%'
  and t.err($$update public.products set alt_note = repeat('x', 201) where name = 'alt3'$$) like '%alt_note_check%'
  and t.err($$update public.products set alternatives = '[]', alt_note = repeat('x', 200) where name = 'alt3'$$) = 'ok1');
update public.products set alternatives = null, alt_note = null where name = 'alt3';

-- a list member and others
set role authenticated;
select t.asB();
select t.chk('alt: B (member of A''s list) can see A''s product, but cannot ask for alternatives on it',
  (select count(*) = 1 from public.products where name = 'alt1') and t.req('alt3') = 'rows 0' and t.req('alt1') like 'Kun den, der har tilføjet%');
select t.chk('alt: ... nor write any alt column on it',
  t.err($$update public.products set alternatives = '[]' where name = 'alt1'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set alt_done_at = now() where name = 'alt1'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set alt_note = 'x' where name = 'alt1'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set alt_requested_at = null where name = 'alt1'$$) like 'Kun den, der har tilføjet%');
select t.chk('alt: ... but marking it as bought still works', t.err($$update public.products set bought_at = now(), bought_price = 5 where name = 'alt1'$$) = 'ok1');
select t.chk('alt: ... and A''s request time is untouched by that', (select alt_requested_at > now() - interval '1 minute' from public.products where name = 'alt1'));
update public.products set bought_at = null, bought_price = null where name = 'alt1';
select t.chk('alt: B asks for B''s own product', t.req('bs-alt') = 'ok');
select t.asC();
select t.chk('alt: C (a stranger) sees nothing and can ask for nothing', (select count(*) = 0 from public.products) and t.req('alt1') = 'rows 0' and t.req('bs-alt') = 'rows 0');
select t.chk('alt: a browser user cannot call alt_take_slot() directly', t.err($$select public.alt_take_slot()$$) = 'not allowed');
reset role;
select t.chk('alt: the refused direct calls used no slot (A: 1, B: 1)', (select count(*) = 2 from public.alt_attempts));
set role anon;
select t.chk('alt: anon cannot touch the log table, nor call alt_take_slot', t.denied('select * from public.alt_attempts') and t.denied($$select public.alt_take_slot()$$));
reset role;
set role authenticated;
select t.chk('alt: authenticated cannot read or write the log table', t.denied('select * from public.alt_attempts') and t.denied($$delete from public.alt_attempts$$));
reset role;

-- a pending request over 6 hours old counts as failed: a new request is allowed (and takes a slot)
select t.age('alt1', 5);
set role authenticated;
select t.asA();
select t.chk('alt: pending for 5 hours: still refused', t.req('alt1') like 'Der er allerede%');
reset role;
select t.age('alt1', 7);
set role authenticated;
select t.asA();
select t.chk('alt: pending for 7 hours: a new request is allowed', t.req('alt1') = 'ok');
select t.chk('alt: ... stamped now', (select alt_requested_at > now() - interval '1 minute' from public.products where name = 'alt1'));
reset role;
select t.chk('alt: that one used a slot (A: 2, B: 1)', (select count(*) = 2 from public.alt_attempts where user_id = '00000000-0000-0000-0000-0000000000a1')
  and (select count(*) = 1 from public.alt_attempts where user_id = '00000000-0000-0000-0000-0000000000b2'));
-- an answered request can be asked again at once; the limit is 5 in 24 hours counted over all products
select t.answered('alt1'); select t.answered('alt4');
set role authenticated;
select t.asA();
select t.chk('alt: the answered product can be asked again (3 of 5)', t.req('alt1') = 'ok');
select t.chk('alt: another product (4 of 5)', t.req('alt4') = 'ok');
reset role;
select t.answered('alt4');
set role authenticated;
select t.asA();
select t.chk('alt: 5 of 5 (counted across products)', t.req('alt4') = 'ok');
reset role;
select t.answered('alt4');
set role authenticated;
select t.asA();
select t.chk('alt: the 6th request in 24 hours is refused with the sentence the page shows', t.req('alt4') = 'Du kan bede om alternativer 5 gange i døgnet.');
select t.chk('alt: ... also on another product', t.req('alt5') = 'Du kan bede om alternativer 5 gange i døgnet.');
select t.chk('alt: ... and the refused request changed nothing', (select alt_requested_at is not null from public.products where name = 'alt4') and (select alt_requested_at is null from public.products where name = 'alt5'));
select t.asB();
reset role;
select t.answered('bs-alt');
set role authenticated;
select t.asB();
select t.chk('alt: B is not affected by A''s limit', t.req('bs-alt') = 'ok');
reset role;
select t.chk('alt: the log holds 5 for A and 2 for B (the refused ones are not in it)',
  (select count(*) = 5 from public.alt_attempts where user_id = '00000000-0000-0000-0000-0000000000a1')
  and (select count(*) = 2 from public.alt_attempts where user_id = '00000000-0000-0000-0000-0000000000b2'));
-- after 24 hours the slots are free again, old log rows are removed
update public.alt_attempts set at = now() - interval '25 hours' where user_id = '00000000-0000-0000-0000-0000000000a1' and ctid in (select ctid from public.alt_attempts where user_id = '00000000-0000-0000-0000-0000000000a1' limit 3);
select t.answered('alt4');
set role authenticated;
select t.asA();
select t.chk('alt: 3 of A''s requests are 25 hours old: 2 left in the window, so a request is allowed', t.req('alt4') = 'ok');
reset role;
update public.alt_attempts set at = now() - interval '3 days' where user_id = '00000000-0000-0000-0000-0000000000a1';
select t.answered('alt4');
set role authenticated;
select t.asA();
select t.chk('alt: ... and old log rows are cleaned away on the next request', t.req('alt4') = 'ok');
reset role;
select t.chk('alt: ... only the newest A row is left', (select count(*) = 1 from public.alt_attempts where user_id = '00000000-0000-0000-0000-0000000000a1'));
-- a new link starts the product over, alternatives go with it
update public.products set alternatives = '[{"kind":"deal"}]', alt_done_at = now(), alt_note = 'n', alt_requested_at = now() - interval '1 hour' where name = 'alt6';
set role authenticated;
select t.asA();
update public.products set source_url = 'https://shop.example.dk/6b' where name = 'alt6';
reset role;
select t.chk('alt: a new link drops the alternatives and the request', (select alternatives is null and alt_done_at is null and alt_note is null and alt_requested_at is null and status = 'pending' from public.products where name = 'alt6'));

-- ---- the AI agent's functions: same token and grants as the resolver functions
update public.products set alt_requested_at = null, alt_done_at = null, alternatives = null, alt_note = null;
delete from public.alt_attempts;
update public.resolver_secret set token = repeat('a', 64);
update public.products set status = 'tracking', active = true, source_url = 'https://shop.example.dk/6' where name = 'alt6';
update public.products set title = '   ' where name = 'alt6';
insert into public.products (user_id, name, source_url, target_type, status, title, offers) values
  ('00000000-0000-0000-0000-0000000000a1', 'alt7', 'https://shop.example.dk/7', 'auto', 'tracking', 'Syv', '[{"store":"A","price":70,"inStock":true}]'),
  ('00000000-0000-0000-0000-0000000000a1', 'alt8', 'https://shop.example.dk/8', 'auto', 'tracking', 'Otte', '[]'),
  ('00000000-0000-0000-0000-0000000000a1', 'alt9', 'https://shop.example.dk/9', 'auto', 'tracking', 'Ni', '[]');
select t.age('bs-alt', 10); select t.age('alt1', 9); select t.age('alt6', 8); select t.age('alt7', 7); select t.age('alt8', 6); select t.age('alt9', 1);
select t.age('alt2', 5); select t.age('alt3', 5); select t.age('alt4', 5); select t.age('alt5', 5);
update public.products set status = 'choose' where name = 'alt3';
update public.products set alt_done_at = alt_requested_at + interval '1 hour' where name = 'alt4';
update public.products set active = false where name = 'alt5';
select set_config('request.headers', '{}', false);
create function t.tok(h text) returns void language sql as $$ select set_config('request.headers', case when h is null then '{}' else '{"x-resolver-token":"' || h || '"}' end, false) $$;
grant execute on function t.tok(text) to public;
create function t.cnt() returns text language plpgsql as $$ begin return (select count(*) from public.ai_alt_list())::text; exception when others then return sqlerrm; end $$;
grant execute on function t.cnt() to public;

select t.chk('ai: ai_alt_list takes the resolver token: none, empty, wrong, a prefix: all refused with the resolver''s error (as anon and as a signed-in user)', (
  select bool_and(r) from (
    select t.cnt() = 'resolver: invalid or missing token' as r from (select t.tok(null)) x union all
    select t.cnt() = 'resolver: invalid or missing token' from (select t.tok('')) x union all
    select t.cnt() = 'resolver: invalid or missing token' from (select t.tok('fel')) x union all
    select t.cnt() = 'resolver: invalid or missing token' from (select t.tok(repeat('a', 63))) x) y));
set role anon;
select t.tok(null);
select t.chk('ai: anon without a token: refused with 42501', t.err($$select * from public.ai_alt_list()$$) = 'resolver: invalid or missing token');
do $$ begin perform public.ai_alt_list(); raise exception 'no error'; exception when sqlstate '42501' then null; end $$;
select t.chk('ai: set and fail also need the token (anon)',
  t.err(format($$select public.ai_alt_set(%L, '[]')$$, t.pid('alt1'))) = 'resolver: invalid or missing token'
  and t.err(format($$select public.ai_alt_fail(%L, 'x')$$, t.pid('alt1'))) = 'resolver: invalid or missing token');
reset role;
set role authenticated;
select t.asA();
select t.chk('ai: ... and as a signed-in user without the token',
  t.cnt() = 'resolver: invalid or missing token'
  and t.err(format($$select public.ai_alt_set(%L, '[]')$$, t.pid('alt1'))) = 'resolver: invalid or missing token'
  and t.err(format($$select public.ai_alt_fail(%L, 'x')$$, t.pid('alt1'))) = 'resolver: invalid or missing token');
reset role;
select t.chk('ai: nothing was changed by the refused calls', (select count(*) = 0 from public.products where alt_done_at is not null and name <> 'alt4'));

select t.tok(repeat('a', 64));
set role anon;
select t.chk('ai: with the token anon can list (5 at most)', t.cnt() = '5');
select t.chk('ai: oldest request first; only tracking, active, titled, pending ones; at most 5',
  (select array_agg(title order by requested_at, id) from public.ai_alt_list()) = array['Bs', 'Sony XM5', 'alt6', 'Syv', 'Otte']
  and (select array_agg(title) from public.ai_alt_list()) = array['Bs', 'Sony XM5', 'alt6', 'Syv', 'Otte']);
select t.chk('ai: ai_alt_list columns are exactly id, title, price, normal_price, host, requested_at',
  (select proargnames from pg_proc where proname = 'ai_alt_list') = array['id', 'title', 'price', 'normal_price', 'host', 'requested_at']);
select t.chk('ai: lowest in-stock price (out of stock and non-numeric prices ignored), normal price, host without www and path',
  (select price = 2250.5 and normal_price = 2600 and host = 'shop.example.dk' and title = 'Sony XM5' from public.ai_alt_list() where id = t.pid('alt1')));
select t.chk('ai: no in-stock offer, or offers that are not an array: price null', (select price is null and normal_price is null from public.ai_alt_list() where title = 'Bs'));
select t.chk('ai: one in-stock offer', (select price = 70 from public.ai_alt_list() where title = 'Syv'));
select t.chk('ai: a blank title falls back to the product name', (select count(*) = 1 from public.ai_alt_list() where title = 'alt6'));
select t.chk('ai: nothing about the person (no user_id, no e-mail, no list, no full url)',
  (select to_jsonb(l)::text !~ '(@|user|list|https|0000-0000-0000-0000-0000000000a1)' from public.ai_alt_list() l limit 1));
reset role;
-- offers where the product has a string price, a non-object entry
update public.products set offers = '[1, "x", null, {"price": 3, "inStock": "true"}, {"price": 9, "inStock": true}]' where name = 'alt7';
select t.chk('ai: odd offers entries are skipped, never an error', (select price = 9 from public.ai_alt_list() where title = 'Syv'));
update public.products set offers = '[{"store":"A","price":70,"inStock":true}]' where name = 'alt7';

-- ai_alt_set
create function t.pend(n text) returns void language sql security definer as $$
  update public.products set alt_requested_at = now() - interval '1 hour', alt_done_at = null, alternatives = null, alt_note = null, active = true, status = 'tracking' where name = n $$;
grant execute on function t.pend(text) to public;
create function t.base() returns jsonb language sql as $$
  select '{"kind":"deal","name":"Bose QC 45","url":"https://shop.example.dk/bose?id=1","store":"Shop","price":1999,"was":2499,"why":"Rabat på 20 % i dag."}'::jsonb $$;
create function t.items(patch jsonb, drop_key text default null) returns jsonb language sql as $$
  select jsonb_build_array((t.base() || coalesce(patch, '{}'::jsonb)) - coalesce(drop_key, '')) $$;
create function t.aset(items jsonb) returns text language plpgsql as $$
begin return public.ai_alt_set(t.pid('alt1'), items)::text; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function t.base(), t.items(jsonb, text), t.aset(jsonb) to public;
select t.pend('alt1');
set role anon;
select t.chk('ai: set: not an array, empty, 7 items, items that are not objects',
  t.aset('{"a":1}') like '22023 ai_alt: items must be%' and t.aset('[]') like '22023%' and t.aset(null) like '22023%' and t.aset('"x"') like '22023%'
  and t.aset((select jsonb_agg(t.base()) from generate_series(1, 7))) like '22023%' and t.aset('[1]') like '22023 ai_alt: item 1: not an object' and t.aset('[null]') like '22023%');
select t.chk('ai: set: extra key, and every required key missing or null',
  t.aset(t.items('{"extra":1}')) like '22023 ai_alt: item 1: unknown key extra'
  and t.aset(t.items(null, 'kind')) like '%kind is missing' and t.aset(t.items(null, 'name')) like '%name is missing' and t.aset(t.items(null, 'url')) like '%url is missing'
  and t.aset(t.items(null, 'store')) like '%store is missing' and t.aset(t.items(null, 'price')) like '%price is missing' and t.aset(t.items(null, 'why')) like '%why is missing'
  and t.aset(t.items('{"name":null}')) like '%name is missing');
select t.chk('ai: set: kind', t.aset(t.items('{"kind":"other"}')) like '22023%kind is not valid' and t.aset(t.items('{"kind":"Deal"}')) like '22023%' and t.aset(t.items('{"kind":1}')) like '%must be a string'
  and t.aset(t.items('{"kind":" "}')) like '22023%');
select t.chk('ai: set: name 1-120 characters', t.aset(t.items('{"name":""}')) like '%name is not valid' and t.aset(t.items('{"name":"   "}')) like '%name is not valid'
  and t.aset(t.items(jsonb_build_object('name', repeat('x', 121)))) like '%name is not valid' and t.aset(t.items('{"name":5}')) like '%name must be a string');
select t.chk('ai: set: store 1-60, why 1-160',
  t.aset(t.items(jsonb_build_object('store', repeat('x', 61)))) like '%store is not valid' and t.aset(t.items('{"store":""}')) like '%store is not valid'
  and t.aset(t.items(jsonb_build_object('why', repeat('x', 161)))) like '%why is not valid' and t.aset(t.items('{"why":""}')) like '%why is not valid');
select t.chk('ai: set: url must be https like products.source_url (no http, port, user:password@, dotless host, space, javascript:, 501 characters)',
  t.aset(t.items('{"url":"http://shop.dk/x"}')) like '%url is not valid' and t.aset(t.items('{"url":"https://shop.dk:8443/x"}')) like '%url is not valid'
  and t.aset(t.items('{"url":"https://u:p@shop.dk/x"}')) like '%url is not valid' and t.aset(t.items('{"url":"https://localhost/x"}')) like '%url is not valid'
  and t.aset(t.items('{"url":"https://shop.dk/a b"}')) like '%url is not valid' and t.aset(t.items('{"url":"javascript:alert(1)"}')) like '%url is not valid'
  and t.aset(t.items(jsonb_build_object('url', 'https://shop.dk/' || repeat('a', 485)))) like '%url is not valid' and t.aset(t.items('{"url":""}')) like '%url is not valid'
  and t.aset(t.items('{"url":7}')) like '%url must be a string');
select t.chk('ai: set: text with control characters, newlines, tabs, angle brackets or invisible direction marks is refused in every text field', (
  select bool_and(t.aset(t.items(jsonb_build_object(f, v))) like '22023%')
    from (values ('name'), ('store'), ('why'), ('url')) a(f),
         (values ('a' || chr(10) || 'b'), ('a' || chr(9) || 'b'), ('a' || chr(7) || 'b'), ('a<b'), ('a>b'), ('<script>x</script>'), ('a' || chr(8238) || 'b'), ('a' || chr(8203) || 'b'), ('a' || chr(65279) || 'b'), ('a' || chr(8232) || 'b')) b(v)));
select t.chk('ai: set: price must be a number above 0 and below 10 million',
  t.aset(t.items('{"price":0}')) like '%price must be above 0%' and t.aset(t.items('{"price":-5}')) like '%price must be above 0%' and t.aset(t.items('{"price":"12"}')) like '%price must be a number'
  and t.aset(t.items('{"price":10000000}')) like '%price must be above 0%' and t.aset(t.items('{"price":0.001}')) like '%price must be above 0%'
  and t.aset(t.items('{"price":true}')) like '%price must be a number');
select t.chk('ai: set: was must be a number above price and below 10 million',
  t.aset(t.items('{"was":1999}')) like '%was must be above price%' and t.aset(t.items('{"was":1000}')) like '%was must be above price%' and t.aset(t.items('{"was":"2499"}')) like '%was must be a number'
  and t.aset(t.items('{"was":10000000}')) like '%was must be above price%' and t.aset(t.items('{"was":1999.001}')) like '%was must be above price%');
select t.chk('ai: set: nothing was stored by any refused call', t.q($$select (alternatives is null and alt_done_at is null)::text from public.products where name = 'alt1'$$) = 'true');
-- a good answer
select t.chk('ai: set: a good answer returns true', t.aset(t.items('{"name":"  Bose QC 45  ","price":1999.456,"why":" Rabat. "}')) = 'true');
reset role;
select t.chk('ai: set: stored as a cleaned copy (trimmed, rounded), alt_done_at = now, alt_note null',
  (select alternatives = '[{"kind":"deal","name":"Bose QC 45","url":"https://shop.example.dk/bose?id=1","store":"Shop","price":1999.46,"was":2499,"why":"Rabat."}]'::jsonb
      and abs(extract(epoch from now() - alt_done_at)) < 60 and alt_note is null and alt_done_at >= alt_requested_at from public.products where name = 'alt1'));
set role anon;
select t.chk('ai: set: the answer is given once: no longer pending, so false and nothing changes', t.aset(t.items('{"name":"Anden"}')) = 'false'
  and t.q($$select (alternatives -> 0 ->> 'name' = 'Bose QC 45')::text from public.products where name = 'alt1'$$) = 'true');
select t.chk('ai: ... and it is gone from the list', (select count(*) = 0 from public.ai_alt_list() where title = 'Sony XM5'));
reset role;
select t.pend('alt1');
set role anon;
select t.chk('ai: set: 6 items, similar without was, was null is dropped, 500-character url, 120-character name, extreme prices',
  t.aset((select jsonb_agg(t.base() || jsonb_build_object('kind', 'similar', 'was', null, 'name', repeat('n', 120), 'price', 0.01, 'url', 'https://shop.dk/' || repeat('a', 484)) ) from generate_series(1, 6))) = 'true');
reset role;
select t.chk('ai: ... stored with 6 items, no was key, the new answer replaced the old',
  (select jsonb_array_length(alternatives) = 6 and not (alternatives -> 0 ? 'was') and alternatives -> 0 ->> 'kind' = 'similar' and char_length(alternatives -> 0 ->> 'url') = 500 from public.products where name = 'alt1'));
select t.pend('alt1');
set role anon;
select t.chk('ai: set: price 9999999.99 with was above price is not possible, below the limit is fine', t.aset(t.items('{"price":9999999.99,"was":9999999.995}')) like '%was must be above price%'
  and t.aset(t.items('{"price":9999999.98,"was":9999999.99}')) = 'true');
reset role;

-- ai_alt_fail
select t.pend('alt1');
update public.products set alternatives = '[{"kind":"deal","name":"x","url":"https://x.dk/a","store":"X","price":1,"why":"g"}]' where name = 'alt1';
set role anon;
select t.chk('ai: fail: returns true, drops alternatives, stores the note, alt_done_at = now',
  public.ai_alt_fail(t.pid('alt1'), '  Fandt intet, der passer.  ') and true);
reset role;
select t.chk('ai: fail: stored', (select alternatives is null and alt_note = 'Fandt intet, der passer.' and abs(extract(epoch from now() - alt_done_at)) < 60 from public.products where name = 'alt1'));
set role anon;
select t.chk('ai: fail: not pending any more: false, nothing changes', not public.ai_alt_fail(t.pid('alt1'), 'igen')
  and t.q($$select (alt_note = 'Fandt intet, der passer.')::text from public.products where name = 'alt1'$$) = 'true'
  and not public.ai_alt_fail(t.pid('alt4'), 'x') and not public.ai_alt_fail('00000000-0000-0000-0000-000000000000', 'x'));
select t.chk('ai: set: not pending (never asked, or unknown id): false', not public.ai_alt_set(t.pid('alt4'), jsonb_build_array(t.base())) and not public.ai_alt_set('00000000-0000-0000-0000-000000000000', jsonb_build_array(t.base())));
reset role;
select t.pend('alt1');
set role anon;
select t.chk('ai: fail: a 300-character note is cut to 200, control characters and angle brackets become spaces',
  public.ai_alt_fail(t.pid('alt1'), repeat('x', 300)));
reset role;
select t.chk('ai: fail: ... 200 characters', (select char_length(alt_note) = 200 from public.products where name = 'alt1'));
select t.pend('alt1');
set role anon;
select public.ai_alt_fail(t.pid('alt1'), 'a' || chr(10) || '<b>fed</b>' || chr(7) || 'b');
reset role;
select t.chk('ai: fail: ... cleaned', (select alt_note = 'a b fed /b b' from public.products where name = 'alt1'));
select t.pend('alt1');
set role anon;
select public.ai_alt_fail(t.pid('alt1'), '   ');
reset role;
select t.chk('ai: fail: an empty note gets a plain sentence', (select alt_note = 'Kunne ikke finde alternativer.' from public.products where name = 'alt1'));
select t.pend('alt1');
set role anon;
select public.ai_alt_fail(t.pid('alt1'), null);
reset role;
select t.chk('ai: fail: a null note too', (select alt_note = 'Kunne ikke finde alternativer.' from public.products where name = 'alt1'));

-- the functions work for a request the browser made, end to end, and the person sees the answer
update public.products set alt_requested_at = null, alt_done_at = null, alternatives = null, alt_note = null;
set role authenticated;
select t.asA();
select t.chk('e2e: A asks', t.req('alt1') = 'ok');
reset role;
set role anon;
select t.chk('e2e: the agent sees it', (select count(*) = 1 from public.ai_alt_list() where title = 'Sony XM5'));
select t.chk('e2e: ... answers it', public.ai_alt_set(t.pid('alt1'), jsonb_build_array(t.base())));
select t.chk('e2e: ... and it is not listed again', (select count(*) = 0 from public.ai_alt_list() where title = 'Sony XM5'));
reset role;
set role authenticated;
select t.asA();
select t.chk('e2e: A reads the answer on the product; the shared list member reads it too, but writes nothing',
  (select alternatives -> 0 ->> 'name' = 'Bose QC 45' from public.products where name = 'alt1'));
select t.asB();
select t.chk('e2e: B (member) reads it', (select alternatives -> 0 ->> 'name' = 'Bose QC 45' from public.products where name = 'alt1'));
select t.asC();
select t.chk('e2e: C (stranger) does not', (select count(*) = 0 from public.products where name = 'alt1'));
reset role;
select t.tok(null);
-- grants: the same as the resolver functions
select t.chk('ai: grants as the resolver functions (anon and authenticated may execute, public may not); alt_take_slot not for anon',
  has_function_privilege('anon', 'public.ai_alt_list()', 'execute') and has_function_privilege('authenticated', 'public.ai_alt_set(uuid, jsonb)', 'execute')
  and has_function_privilege('anon', 'public.ai_alt_fail(uuid, text)', 'execute') and not has_function_privilege('anon', 'public.alt_take_slot()', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name like 'ai_alt%' and grantee = 'PUBLIC'));
-- clean up for the final run
delete from public.products where name ~ '^(alt[0-9]|bs-alt)';
delete from public.lists where name = 'Alt';
delete from public.alt_attempts;
select set_config('request.jwt.claims', '', false);

-- 11c. compare: "find the cheapest shop" (compare_state / compare_at / shop_url, resolver_list kind, resolver_compare)
delete from public.products;
delete from public.lists where name = 'Cmp';
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa0c', '00000000-0000-0000-0000-0000000000a1', 'Cmp');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa0c', '00000000-0000-0000-0000-0000000000b2') on conflict do nothing;
update public.resolver_secret set token = repeat('a', 64);
select t.tok(null);
-- the whole state of a product that has been tracked from one shop, to see what a switch resets and what it keeps
create function t.cmpmk(n text, u text, st text, ca timestamptz, su text) returns void language sql security definer as $$
  insert into public.products (user_id, name, source_url, target_type, target_value, status, title, variants, offers, history, normal_price, verdict, warning, check_note,
    last_checked, notified_price, notified_at, backfill_state, digest_price, digest_at, tracked_variants, shops_always, list_id, compare_state, compare_at, shop_url,
    alt_requested_at, alternatives, alt_done_at, alt_note)
  values ('00000000-0000-0000-0000-0000000000a1', n, u, 'pct', 15, 'tracking', 'Titel ' || n, '[{"id":"shop"}]', '[{"store":"Shop","price":450,"inStock":true},{"store":"Andet","price":400,"inStock":false}]',
    '[{"d":"2026-11-01","p":500,"s":"Shop","src":"check"}]', 600, '{"level":"poor"}', 'w', 'n', '2026-11-02', 450, '2026-11-03', '{"result":"done"}', 440, '2026-11-04', array['shop'], array['Proshop'],
    '00000000-0000-0000-0000-00000000aa0c', st, ca, su, '2026-10-01', '[{"kind":"deal"}]', '2026-10-02', null) $$;
grant execute on function t.cmpmk(text, text, text, timestamptz, text) to public;
select t.cmpmk('cmp-w1', 'https://www.adidas.dk/sko/x', 'wanted', now() - interval '2 days', null);
select t.cmpmk('cmp-w2', 'https://proshop.dk/vare/y', 'wanted', now() - interval '1 day', null);
select t.cmpmk('cmp-null', 'https://shop.example.dk/z', null, null, null);
select t.cmpmk('cmp-pj', 'https://prisjagt.dk/product.php?p=5', null, null, null);
select t.cmpmk('cmp-pj2', 'https://www.prisjagt.dk/product.php?p=6', null, null, null);
select t.cmpmk('cmp-done', 'https://prisjagt.dk/product.php?p=7', 'done', now() - interval '1 day', 'https://shop.example.dk/original');
select t.cmpmk('cmp-none-new', 'https://shop.example.dk/n1', 'none', now() - interval '59 minutes', null);
select t.cmpmk('cmp-none-old', 'https://shop.example.dk/n2', 'none', now() - interval '61 minutes', null);
insert into public.products (user_id, name, target_type) values ('00000000-0000-0000-0000-0000000000a1', 'cmp-navn', 'auto');

select t.chk('compare: the columns exist and are null on an ordinary product',
  (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('compare_state', 'compare_at', 'shop_url'))
  and (select compare_state is null and compare_at is null and shop_url is null from public.products where name = 'cmp-navn'));
select t.chk('compare: the checks reject an unknown state and a bad shop_url',
  t.err($$update public.products set compare_state = 'ja' where name = 'cmp-null'$$) like '%products_compare_state_check%'
  and t.err($$update public.products set shop_url = 'http://shop.dk/x' where name = 'cmp-null'$$) like '%products_shop_url_check%'
  and t.err($$update public.products set shop_url = 'https://shop.dk/' || repeat('a', 485) where name = 'cmp-null'$$) like '%products_shop_url_check%'
  and t.err($$update public.products set shop_url = 'https://shop.dk/x', compare_state = 'done' where name = 'cmp-none-new'$$) = 'ok1');
update public.products set shop_url = null, compare_state = 'none' where name = 'cmp-none-new';
select t.chk('compare: exactly one check on each', (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_compare_state_check')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_shop_url_check'));

-- ---- the person
set role authenticated;
select t.asA();
select t.chk('compare: a browser insert cannot preset any compare column',
  t.err($$insert into public.products (name, source_url, target_type, compare_state, compare_at, shop_url) values ('cmp-ny', 'https://shop.example.dk/ny', 'auto', 'done', now(), 'https://x.dk/a')$$) = 'ok1'
  and t.q($$select (compare_state is null and compare_at is null and shop_url is null)::text from public.products where name = 'cmp-ny'$$) = 'true');
delete from public.products where name = 'cmp-ny';
select t.chk('compare: A requests a comparison for a single-shop product, the time is the server clock (and nothing else is written by it)',
  t.err($$update public.products set compare_state = 'wanted', compare_at = '2000-01-01', shop_url = 'https://evil.dk/x' where name = 'cmp-null'$$) = 'ok1'
  and t.q($$select (compare_state = 'wanted' and abs(extract(epoch from now() - compare_at)) < 60 and shop_url is null and status = 'tracking' and title is not null and alternatives is not null)::text from public.products where name = 'cmp-null'$$) = 'true');
select t.chk('compare: a second request changes nothing (still wanted, same time)',
  t.q($$select compare_at::text from public.products where name = 'cmp-null'$$) = (select compare_at::text from public.products where name = 'cmp-null')
  and t.err($$update public.products set compare_state = 'wanted' where name = 'cmp-null'$$) = 'ok1');
select t.chk('compare: A cannot request for a prisjagt link (with or without www), a name-only product, a done product or a recent none',
  t.err($$update public.products set compare_state = 'wanted' where name in ('cmp-pj', 'cmp-pj2', 'cmp-navn', 'cmp-done', 'cmp-none-new')$$) = 'ok5'
  and (select count(*) = 0 from public.products where name in ('cmp-pj', 'cmp-pj2', 'cmp-navn', 'cmp-done', 'cmp-none-new') and compare_state = 'wanted'));
select t.chk('compare: ... the states of those products are what they were',
  (select compare_state is null from public.products where name = 'cmp-pj') and (select compare_state = 'done' and shop_url = 'https://shop.example.dk/original' from public.products where name = 'cmp-done')
  and (select compare_state = 'none' from public.products where name = 'cmp-none-new'));
select t.chk('compare: a none older than 1 hour (61 minutes) can be asked again, one of 59 minutes cannot (above), with a new time',
  t.err($$update public.products set compare_state = 'wanted' where name = 'cmp-none-old'$$) = 'ok1'
  and t.q($$select (compare_state = 'wanted' and compare_at > now() - interval '1 minute')::text from public.products where name = 'cmp-none-old'$$) = 'true');
select t.chk('compare: the browser cannot set done, none or null, nor the time or shop_url (the rest of the update goes through)',
  t.err($$update public.products set compare_state = 'done', compare_at = now(), shop_url = 'https://shop.example.dk/q', name = 'cmp-null2' where name = 'cmp-w1'$$) = 'ok1'
  and t.err($$update public.products set compare_state = 'none' where name = 'cmp-w2'$$) = 'ok1'
  and t.err($$update public.products set compare_state = null where name = 'cmp-null'$$) = 'ok1'
  and t.err($$update public.products set compare_state = 'done', shop_url = 'https://shop.example.dk/q', compare_at = now() where name = 'cmp-pj'$$) = 'ok1'
  and t.err($$update public.products set compare_state = 'none', compare_at = null where name = 'cmp-done'$$) = 'ok1'
  and t.q($$select (compare_state = 'wanted' and shop_url is null and name = 'cmp-null2' and compare_at < now() - interval '1 day')::text from public.products where name = 'cmp-null2'$$) = 'true'
  and t.q($$select (compare_state = 'wanted')::text from public.products where name = 'cmp-w2'$$) = 'true' and t.q($$select (compare_state = 'wanted')::text from public.products where name = 'cmp-null'$$) = 'true'
  and t.q($$select (compare_state is null and shop_url is null and compare_at is null)::text from public.products where name = 'cmp-pj'$$) = 'true'
  and t.q($$select (compare_state = 'done' and shop_url = 'https://shop.example.dk/original' and compare_at is not null)::text from public.products where name = 'cmp-done'$$) = 'true');
update public.products set name = 'cmp-w1' where name = 'cmp-null2';
select t.chk('compare: asking changes no job state', (select status = 'tracking' and offers is not null and history is not null and last_checked is not null and notified_price = 450 and backfill_state is not null and digest_price = 440 from public.products where name = 'cmp-null'));

-- compare_tries: the job's counter. The browser cannot write it, a manual request does not touch it, a new link resets it
select t.chk('compare: 59 minutes after a none is refused, 61 minutes is accepted (and the time is now)',
  t.q($$select (compare_state = 'none')::text from public.products where name = 'cmp-none-new'$$) = 'true'
  and t.q($$select (compare_state = 'wanted')::text from public.products where name = 'cmp-none-old'$$) = 'true');
reset role;
update public.products set compare_tries = 2 where name = 'cmp-none-new';
set role authenticated;
select t.asA();
select t.chk('compare: A cannot write compare_tries (the rest of the update goes through)',
  t.err($$update public.products set compare_tries = 0, name = 'cmp-none-new' where name = 'cmp-none-new'$$) = 'ok1'
  and t.q($$select (compare_tries = 2)::text from public.products where name = 'cmp-none-new'$$) = 'true');
reset role;
update public.products set compare_tries = 3, compare_at = now() - interval '2 hours' where name = 'cmp-none-new';
set role authenticated;
select t.asA();
select t.chk('compare: with compare_tries at 3 a manual request still works and leaves the counter at 3',
  t.err($$update public.products set compare_state = 'wanted' where name = 'cmp-none-new'$$) = 'ok1'
  and t.q($$select (compare_state = 'wanted' and compare_tries = 3)::text from public.products where name = 'cmp-none-new'$$) = 'true');
select t.chk('compare: a new source_url resets compare_tries',
  t.err($$update public.products set source_url = 'https://shop.example.dk/n1-ny' where name = 'cmp-none-new'$$) = 'ok1'
  and t.q($$select (compare_tries = 0 and compare_state is null)::text from public.products where name = 'cmp-none-new'$$) = 'true');
select t.chk('compare: a browser insert starts at 0',
  t.err($$insert into public.products (name, source_url, target_type, compare_tries) values ('cmp-tries-ny', 'https://shop.example.dk/tn', 'auto', 3)$$) = 'ok1'
  and t.q($$select (compare_tries = 0)::text from public.products where name = 'cmp-tries-ny'$$) = 'true');
reset role;
delete from public.products where name = 'cmp-tries-ny';
update public.products set compare_state = 'none', compare_at = now() - interval '59 minutes', source_url = 'https://shop.example.dk/n1' where name = 'cmp-none-new';
set role authenticated;
select t.asA();

-- a member of the shared list sees the products but changes nothing in them
select t.asB();
select t.chk('compare: B (member) sees A''s product and cannot ask for a comparison, nor write any compare column',
  (select count(*) >= 1 from public.products where name = 'cmp-null2' or name = 'cmp-w1')
  and t.err($$update public.products set compare_state = 'wanted' where name = 'cmp-none-new'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set compare_state = 'none' where name = 'cmp-w1'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set compare_at = now() where name = 'cmp-w1'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set shop_url = 'https://shop.example.dk/b' where name = 'cmp-w1'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set source_url = 'https://shop.example.dk/b' where name = 'cmp-done'$$) like 'Kun den, der har tilføjet%');
select t.chk('compare: ... and the bought mark still works for B on a product with a comparison',
  t.err($$update public.products set bought_at = now(), bought_price = 300 where name = 'cmp-done'$$) = 'ok1');
update public.products set bought_at = null, bought_price = null where name = 'cmp-done';
select t.asA();
-- a new link starts over; going back to the original link after a switch is 'none'
select t.chk('compare: a new link (not the original one) wipes compare_state, compare_at and shop_url, and the job state',
  t.err($$update public.products set source_url = 'https://shop.example.dk/helt-ny' where name = 'cmp-done'$$) = 'ok1'
  and t.q($$select (compare_state is null and compare_at is null and shop_url is null and status = 'pending' and history is null and alternatives is null)::text from public.products where name = 'cmp-done'$$) = 'true');
select t.chk('compare: a new link on a wanted product wipes the request',
  t.err($$update public.products set source_url = 'https://prisjagt.dk/product.php?p=11' where name = 'cmp-w2'$$) = 'ok1'
  and t.q($$select (compare_state is null and compare_at is null and shop_url is null and status = 'pending')::text from public.products where name = 'cmp-w2'$$) = 'true');
reset role;
update public.products set source_url = 'https://prisjagt.dk/product.php?p=7', shop_url = 'https://shop.example.dk/original', compare_state = 'done', compare_at = now() - interval '1 day', status = 'tracking',
  history = '[{"d":"2026-11-10","p":300,"s":"X","src":"check"}]', title = 'T', notified_price = 300, backfill_state = '{"result":"done"}' where name = 'cmp-done';
set role authenticated;
select t.asA();
select t.chk('compare: undo: source_url = shop_url gives compare_state none from now, shop_url null, job state reset, person''s fields kept',
  t.err($$update public.products set source_url = 'https://shop.example.dk/original' where name = 'cmp-done'$$) = 'ok1'
  and t.q($$select (compare_state = 'none' and compare_at > now() - interval '1 minute' and shop_url is null and source_url = 'https://shop.example.dk/original' and status = 'pending' and history is null and title is null
        and notified_price is null and backfill_state is null and alternatives is null and target_type = 'pct' and target_value = 15 and list_id is not null and shops_always = array['Proshop'])::text from public.products where name = 'cmp-done'$$) = 'true');
select t.chk('compare: ... and the product cannot be asked for again for an hour', t.err($$update public.products set compare_state = 'wanted' where name = 'cmp-done'$$) = 'ok1'
  and t.q($$select (compare_state = 'none')::text from public.products where name = 'cmp-done'$$) = 'true');
reset role;
update public.products set source_url = 'https://prisjagt.dk/product.php?p=7', shop_url = 'https://shop.example.dk/original', compare_state = 'done', compare_at = now() where name = 'cmp-done';
set role authenticated;
select t.asA();
select t.chk('compare: only exactly shop_url counts as going back (another address, or one that differs in the query, is a new link)',
  t.err($$update public.products set source_url = 'https://shop.example.dk/original?x=1' where name = 'cmp-done'$$) = 'ok1'
  and t.q($$select (compare_state is null and shop_url is null)::text from public.products where name = 'cmp-done'$$) = 'true');
reset role;

-- ---- the AI agent: resolver_list
update public.products set compare_state = 'wanted', compare_at = now() - interval '2 days', source_url = 'https://www.adidas.dk/sko/x', title = 'Adidas Samba OG', status = 'error' where name = 'cmp-w1';
update public.products set compare_state = 'wanted', compare_at = now() - interval '3 days', source_url = 'https://proshop.dk/vare/y', title = null, offers = null, status = 'pending' where name = 'cmp-w2';
update public.products set compare_state = 'wanted', compare_at = null, source_url = 'https://shop.example.dk/z' where name = 'cmp-null';
update public.products set created_at = now() - interval '5 days' where name = 'cmp-navn';
update public.products set compare_state = null, compare_at = null where name = 'cmp-none-old';
insert into public.products (user_id, name, target_type, created_at) values ('00000000-0000-0000-0000-0000000000a1', 'cmp-navn-gammel', 'auto', now() - interval '10 days'), ('00000000-0000-0000-0000-0000000000a1', 'cmp-navn-ny', 'auto', now() - interval '1 day');
select t.tok(repeat('a', 64));
create function t.cmplist() returns text language sql as $$
  select string_agg(kind || ':' || name, ' | ' order by ord) from (select row_number() over () as ord, * from public.resolver_list()) x $$;
grant execute on function t.cmplist() to public;
set role anon;
select t.chk('compare: resolver_list: name-only products first (oldest first), then compare rows by when they were asked (created_at when never); kind on every row',
  t.cmplist() = 'name:cmp-navn-gammel | name:cmp-navn | name:cmp-navn-ny | compare:cmp-w2 | compare:Adidas Samba OG | compare:Titel cmp-null');
select t.chk('compare: ... host without www and path, price = lowest in-stock offer (null without offers), host and price null for name rows',
  (select host = 'adidas.dk' and price = 450 from public.resolver_list() where name = 'Adidas Samba OG')
  and (select host = 'proshop.dk' and price is null from public.resolver_list() where kind = 'compare' and host = 'proshop.dk')
  and (select bool_and(host is null and price is null) from public.resolver_list() where kind = 'name')
  and (select count(*) = 3 from public.resolver_list() where kind = 'name'));
select t.chk('compare: ... the columns are id, name, created_at, kind, host, price, req, variants',
  (select proargnames = array['id', 'name', 'created_at', 'kind', 'host', 'price', 'req', 'variants'] from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace));
select t.chk('compare: ... a compare row shows the stored title, else the name, and the product''s own created_at',
  (select id = t.pid('cmp-w1') and created_at = t.q($$select created_at::text from public.products where name = 'cmp-w1'$$)::timestamptz from public.resolver_list() where name = 'Adidas Samba OG')
  and exists (select 1 from public.resolver_list() where kind = 'compare' and name = 'cmp-w2'));
reset role;
-- what is not listed: an inactive product, a done / none / plain one; and at most 10 rows
update public.products set active = false where name = 'cmp-w2';
set role anon;
select t.chk('compare: ... an inactive product is not listed, nor a done, none or plain single-shop one',
  (select count(*) = 5 from public.resolver_list()) and not exists (select 1 from public.resolver_list() where name in ('cmp-w2', 'cmp-pj', 'cmp-done', 'cmp-none-new', 'cmp-none-old')));
reset role;
update public.products set active = true where name = 'cmp-w2';
insert into public.products (user_id, name, source_url, target_type, compare_state, created_at)
  select '00000000-0000-0000-0000-0000000000a1', 'cmp-m' || g, 'https://shop.example.dk/m' || g, 'auto', null, now() from generate_series(1, 12) g;
update public.products set compare_state = 'wanted', compare_at = now() - (g || ' hours')::interval from (select name as n, substr(name, 6)::int as g from public.products where name ~ '^cmp-m[0-9]+$') x where name = x.n;
set role anon;
select t.chk('compare: ... at most 10 rows in all, name rows first, then compare rows oldest first',
  (select count(*) = 10 from public.resolver_list())
  and (select array_agg(kind order by ord) = array['name', 'name', 'name', 'compare', 'compare', 'compare', 'compare', 'compare', 'compare', 'compare'] from (select row_number() over () as ord, kind from public.resolver_list()) y)
  and (select array_agg(name order by ord) = array['cmp-w2', 'Adidas Samba OG', 'cmp-m12', 'cmp-m11', 'cmp-m10', 'cmp-m9', 'cmp-m8'] from (select row_number() over () as ord, name from public.resolver_list() where kind = 'compare') y));
reset role;
delete from public.products where name ~ '^cmp-m[0-9]+$';

-- ---- the token on the new and the changed function; grants
create function t.ccount() returns text language plpgsql as $$ begin return (select count(*) from public.resolver_list())::text; exception when others then return sqlerrm; end $$;
grant execute on function t.ccount() to public;
create function t.rc(n text, u text) returns text language plpgsql as $$
declare pid uuid := t.pid(n); r boolean;
begin r := public.resolver_compare(pid, u); return coalesce(r::text, 'null'); exception when others then return 'error:' || sqlerrm; end $$;
grant execute on function t.rc(text, text) to public;
select t.chk('compare: the token is needed (none, empty, wrong, a prefix) for resolver_list and resolver_compare, as anon and as a signed-in user, and nothing changes',
  (select bool_and(r) from (
    select t.ccount() = 'resolver: invalid or missing token' and t.rc('cmp-w1', null) = 'error:resolver: invalid or missing token' and t.rc('cmp-w1', 'https://prisjagt.dk/product.php?p=1') = 'error:resolver: invalid or missing token' as r from (select t.tok(null)) x union all
    select t.ccount() = 'resolver: invalid or missing token' and t.rc('cmp-w1', null) = 'error:resolver: invalid or missing token' from (select t.tok('')) x union all
    select t.ccount() = 'resolver: invalid or missing token' and t.rc('cmp-w1', null) = 'error:resolver: invalid or missing token' from (select t.tok('fel')) x union all
    select t.ccount() = 'resolver: invalid or missing token' and t.rc('cmp-w1', null) = 'error:resolver: invalid or missing token' from (select t.tok(repeat('a', 63))) x) y)
  and t.q($$select (compare_state = 'wanted' and source_url = 'https://www.adidas.dk/sko/x')::text from public.products where name = 'cmp-w1'$$) = 'true');
set role anon; select t.tok(null);
select t.chk('compare: anon without a token: refused', t.ccount() = 'resolver: invalid or missing token' and t.rc('cmp-w1', null) = 'error:resolver: invalid or missing token');
reset role; set role authenticated; select t.asA(); select t.tok('fel');
select t.chk('compare: a signed-in user without the token: refused', t.ccount() = 'resolver: invalid or missing token' and t.rc('cmp-w1', null) = 'error:resolver: invalid or missing token');
reset role;
select t.chk('compare: grants as the other resolver functions (anon and authenticated may execute, public may not)',
  has_function_privilege('anon', 'public.resolver_compare(uuid, text, jsonb)', 'execute') and has_function_privilege('authenticated', 'public.resolver_compare(uuid, text, jsonb)', 'execute')
  and has_function_privilege('anon', 'public.resolver_list()', 'execute') and has_function_privilege('authenticated', 'public.resolver_list()', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name in ('resolver_list', 'resolver_compare', 'resolver_set', 'resolver_fail') and grantee = 'PUBLIC')
  and (select count(*) = 1 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace));

-- ---- resolver_compare
select t.tok(repeat('a', 64));
set role anon;
select t.chk('compare: resolver_compare refuses anything but https://prisjagt.dk/product.php?p=<digits> (www dropped), and changes nothing',
  t.rc('cmp-w1', 'http://prisjagt.dk/product.php?p=1') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://shop.example.dk/vare') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk.evil.com/product.php?p=1') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://evil.com/https://prisjagt.dk/product.php?p=1') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk/product.php?p=abc') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk/product.php?p=') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk/product.php?p=12&x=1') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk/product.php?p=12#a') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk/search?search=sko') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://user:pw@prisjagt.dk/product.php?p=12') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk:8443/product.php?p=12') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'javascript:alert(1)') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', '') like '%not a prisjagt.dk product link%'
  and t.rc('cmp-w1', 'https://prisjagt.dk/product.php?p=' || repeat('1', 19)) like '%not a prisjagt.dk product link%');
reset role;
select t.chk('compare: ... the product is exactly as it was', (select compare_state = 'wanted' and source_url = 'https://www.adidas.dk/sko/x' and shop_url is null and status = 'error' and title = 'Adidas Samba OG' from public.products where name = 'cmp-w1'));
-- the same product, changed once through the browser's way and once through resolver_compare: the job-written state must end up identical
update public.products set status = 'tracking', check_note = 'n', last_checked = now(), history = '[{"d":"2026-11-01","p":1,"s":"S","src":"check"}]', tracked_variants = array['shop'],
  offers = '[{"store":"A","price":1,"inStock":true}]', notified_price = 1, notified_at = now(), backfill_state = '{"result":"done"}', digest_price = 1, digest_at = now() where name in ('cmp-w1', 'cmp-w2');
-- browser way, on a copy of cmp-w1 owned by A
insert into public.products (id, user_id, name, source_url, target_type, target_value, shops_always, shops_exclude, shops_only, status, tracked_variants, title, variants, offers, history, normal_price, verdict, warning, check_note, last_checked,
  notified_price, notified_at, backfill_state, digest_price, digest_at, list_id, alternatives, alt_done_at, alt_requested_at, compare_state, compare_at, shop_url)
  select '00000000-0000-0000-0000-00000000cc01', user_id, 'cmp-cc', source_url, target_type, target_value, shops_always, shops_exclude, shops_only, status, tracked_variants, title, variants, offers, history, normal_price, verdict, warning, check_note, last_checked,
    notified_price, notified_at, backfill_state, digest_price, digest_at, list_id, alternatives, alt_done_at, alt_requested_at, compare_state, compare_at, shop_url from public.products where name = 'cmp-w1';
set role authenticated; select t.asA();
update public.products set source_url = 'https://prisjagt.dk/product.php?p=42' where name = 'cmp-cc';
reset role;
set role anon;
select t.chk('compare: resolver_compare switches a waiting product to its Prisjagt page (www dropped); true', t.rc('cmp-w1', ' https://www.prisjagt.dk/product.php?p=42 ') = 'true');
reset role;
select t.chk('compare: ... source_url is the Prisjagt page, shop_url the original shop link, compare_state done, compare_at now',
  (select source_url = 'https://prisjagt.dk/product.php?p=42' and shop_url = 'https://www.adidas.dk/sko/x' and compare_state = 'done' and compare_at > now() - interval '1 minute' from public.products where name = 'cmp-w1'));
select t.chk('compare: ... the job-written state is reset exactly as a browser link change resets it (same values in every column the guard resets)',
  (select count(*) = 0 from (
     select e.key from jsonb_each((select to_jsonb(p) from public.products p where name = 'cmp-w1')) e
       join jsonb_each((select to_jsonb(p) from public.products p where name = 'cmp-cc')) f using (key)
      where e.value is distinct from f.value
        and e.key not in ('id', 'name', 'created_at', 'compare_state', 'compare_at', 'shop_url', 'alternatives', 'alt_done_at', 'alt_requested_at', 'alt_note')) z)
  and (select status = 'pending' and tracked_variants is null and title is null and variants is null and offers is null and history is null and normal_price is null and verdict is null and warning is null
        and check_note is null and last_checked is null and notified_price is null and notified_at is null and backfill_state is null and digest_price is null and digest_at is null from public.products where name = 'cmp-w1'));
select t.chk('compare: ... the person''s fields stay (name, goal, list, shop choices, variants chosen are reset with the page) and so do the alternatives',
  (select name = 'cmp-w1' and target_type = 'pct' and target_value = 15 and list_id = '00000000-0000-0000-0000-00000000aa0c' and shops_always = array['Proshop'] and active
     and alternatives -> 0 ->> 'kind' = 'deal' and alt_done_at is not null and alt_requested_at is not null from public.products where name = 'cmp-w1'));
select t.chk('compare: ... a browser link change drops the alternatives, as before', (select alternatives is null and alt_done_at is null and alt_requested_at is null from public.products where name = 'cmp-cc'));
delete from public.products where name = 'cmp-cc';
set role anon;
select t.chk('compare: a second call for the same product (no longer waiting) returns false and changes nothing',
  t.rc('cmp-w1', 'https://prisjagt.dk/product.php?p=43') = 'false' and t.rc('cmp-w1', null) = 'false'
  and t.q($$select (source_url = 'https://prisjagt.dk/product.php?p=42' and compare_state = 'done')::text from public.products where name = 'cmp-w1'$$) = 'true');
select t.chk('compare: a product that is not waiting (never asked, none, done, prisjagt link) returns false',
  t.rc('cmp-pj', 'https://prisjagt.dk/product.php?p=9') = 'false' and t.rc('cmp-none-new', 'https://prisjagt.dk/product.php?p=9') = 'false'
  and t.rc('cmp-none-new', null) = 'false' and t.rc('cmp-navn', 'https://prisjagt.dk/product.php?p=9') = 'false');
select t.chk('compare: null = not found: compare_state none, compare_at now, nothing else changes',
  t.rc('cmp-w2', null) = 'true'
  and t.q($$select (compare_state = 'none' and compare_at > now() - interval '1 minute' and source_url = 'https://proshop.dk/vare/y' and shop_url is null and status = 'tracking' and history is not null and notified_price = 1 and backfill_state is not null and offers is not null
       )::text from public.products where name = 'cmp-w2'$$) = 'true');
select t.chk('compare: an unknown product id and an inactive product return false', public.resolver_compare('00000000-0000-0000-0000-00000000ffff', null) = false);
reset role;
update public.products set compare_state = 'wanted', active = false where name = 'cmp-w2';
set role anon;
select t.chk('compare: ... inactive', t.rc('cmp-w2', null) = 'false' and t.rc('cmp-w2', 'https://prisjagt.dk/product.php?p=3') = 'false');
reset role;
-- after the switch the person can go back, the product is then 'none' and is not listed
set role authenticated; select t.asA();
select t.chk('compare: after the switch the person can undo it (source_url = shop_url), then it is none and not listed',
  t.err($$update public.products set source_url = 'https://www.adidas.dk/sko/x' where name = 'cmp-w1'$$) = 'ok1'
  and t.q($$select (compare_state = 'none' and shop_url is null and status = 'pending' and source_url = 'https://www.adidas.dk/sko/x')::text from public.products where name = 'cmp-w1'$$) = 'true');
reset role;
select t.chk('compare: ... going back is a link change like any other: the guard drops the alternatives with it',
  (select alternatives is null from public.products where name = 'cmp-w1'));
select t.tok(repeat('a', 64));
set role anon;
select t.chk('compare: the list no longer shows the undone product', not exists (select 1 from public.resolver_list() where name = 'cmp-w1'));
-- resolver_set and resolver_fail are unchanged: they only touch name-only pending products
reset role;
set role anon;
select t.chk('compare: resolver_set / resolver_fail do not touch a compare product',
  public.resolver_set(t.pid('cmp-null'), 'https://prisjagt.dk/product.php?p=77') = false
  and public.resolver_fail(t.pid('cmp-null'), 'x') = false
  and public.resolver_set(t.pid('cmp-navn'), 'https://prisjagt.dk/product.php?p=78') = true);
reset role;
select t.tok(null);
delete from public.products where name ~ '^cmp-';
delete from public.lists where name = 'Cmp';
select set_config('request.jwt.claims', '', false);

-- 11e. image_url: a small picture of the product, written by the job only
delete from public.products;
select t.chk('image: the column exists and is null on an ordinary product',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'image_url' and is_nullable = 'YES')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_image_url_check'));
-- the job (not restricted) writes it; the check is the same rule as for source_url
insert into public.products (id, user_id, name, source_url, target_type, status, image_url)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'img-a', 'https://shop.example.dk/img-a', 'auto', 'tracking', 'https://cdn.example.dk/a.jpg');
select t.chk('image: the job may store an https address',
  (select image_url = 'https://cdn.example.dk/a.jpg' from public.products where name = 'img-a'));
select t.chk('image: the check rejects http, other schemes, a port, user:password@, spaces, no dot in the host and over 500 characters',
  t.err($$update public.products set image_url = 'http://cdn.example.dk/a.jpg' where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'javascript:alert(1)' where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'data:image/png;base64,AAAA' where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'https://cdn.example.dk:8443/a.jpg' where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'https://u:p@cdn.example.dk/a.jpg' where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'https://cdn.example.dk/a b.jpg' where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'https://localhost/a.jpg' where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'https://cdn.example.dk/' || repeat('a', 480) where name = 'img-a'$$) like '%products_image_url_check%'
  and t.err($$update public.products set image_url = 'https://cdn.example.dk/' || repeat('a', 470) where name = 'img-a'$$) = 'ok1'
  and t.err($$update public.products set image_url = null where name = 'img-a'$$) = 'ok1');
update public.products set image_url = 'https://cdn.example.dk/a.jpg' where name = 'img-a';
set role authenticated; select t.asA();
select t.chk('image: a new product from the browser cannot preset it',
  t.err($$insert into public.products (name, source_url, target_type, image_url) values ('img-ny', 'https://shop.example.dk/ny', 'auto', 'https://evil.example.com/x.jpg')$$) = 'ok1'
  and t.q($$select (image_url is null)::text from public.products where name = 'img-ny'$$) = 'true');
select t.chk('image: the owner cannot change it with an update that goes through otherwise (the rest of the update is kept)',
  t.err($$update public.products set image_url = 'https://evil.example.com/x.jpg', name = 'img-a2' where name = 'img-a'$$) = 'ok1'
  and t.q($$select (image_url = 'https://cdn.example.dk/a.jpg' and name = 'img-a2')::text from public.products where id = '00000000-0000-0000-0000-0000000000e1'$$) = 'true'
  and t.err($$update public.products set image_url = null where id = '00000000-0000-0000-0000-0000000000e1'$$) = 'ok1'
  and t.q($$select (image_url = 'https://cdn.example.dk/a.jpg')::text from public.products where id = '00000000-0000-0000-0000-0000000000e1'$$) = 'true');
select t.chk('image: a new link starts the product over without the old picture',
  t.err($$update public.products set source_url = 'https://shop.example.dk/anden' where id = '00000000-0000-0000-0000-0000000000e1'$$) = 'ok1'
  and t.q($$select (image_url is null and status = 'pending')::text from public.products where id = '00000000-0000-0000-0000-0000000000e1'$$) = 'true');
reset role;
delete from public.products where name ~ '^img-';

-- 11g. extra shops: extra_urls / extra_state, the guard (remove one entry only), resolver_compare with p_shops
delete from public.products;
delete from public.lists where name = 'Ext';
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa0e', '00000000-0000-0000-0000-0000000000a1', 'Ext');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa0e', '00000000-0000-0000-0000-0000000000b2') on conflict do nothing;
update public.resolver_secret set token = repeat('a', 64);
select t.tok(null);
-- a tracked single-shop product with job-written state (st = compare_state, ex = extra_urls)
create function t.exmk(n text, u text, st text, ex jsonb, lst uuid default null) returns void language sql security definer as $$
  insert into public.products (user_id, name, source_url, target_type, target_value, status, title, variants, offers, history, normal_price, verdict, warning, check_note,
    last_checked, notified_price, notified_at, backfill_state, digest_price, digest_at, tracked_variants, list_id, compare_state, compare_at, extra_urls, extra_state, image_url)
  values ('00000000-0000-0000-0000-0000000000a1', n, u, 'pct', 15, 'tracking', 'Titel ' || n, '[{"id":"shop"}]', '[{"store":"Shop","price":450,"inStock":true}]',
    '[{"d":"2026-11-01","p":500,"s":"Shop","src":"check"}]', 600, '{"level":"poor"}', 'w', 'n', '2026-11-02', 450, '2026-11-03', '{"result":"done"}', 440, '2026-11-04', array['shop'],
    lst, st, case when st is null then null else now() - interval '2 days' end, ex, case when ex is null then null else '{"x":{"seen":true}}'::jsonb end, 'https://img.example.dk/i.jpg') $$;
grant execute on function t.exmk(text, text, text, jsonb, uuid) to public;
create function t.rs3(n text, u text, s jsonb) returns text language plpgsql as $$
declare r boolean; begin r := public.resolver_compare(t.pid(n), u, s); return coalesce(r::text, 'null'); exception when others then return 'error:' || sqlerrm; end $$;
grant execute on function t.rs3(text, text, jsonb) to public;
create function t.ex(n text) returns text language sql security definer as $$ select coalesce(extra_urls::text, 'null') from public.products where name = n $$;
grant execute on function t.ex(text) to public;
create function t.snapstate(n text) returns jsonb language sql security definer as $$
  select to_jsonb(p) - 'extra_urls' - 'extra_state' - 'compare_state' - 'compare_at' from public.products p where name = n $$;
grant execute on function t.snapstate(text) to public;

select t.chk('extra: the columns and checks exist (one check each), extra_urls_error exists',
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('extra_urls', 'extra_state') and is_nullable = 'YES')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_extra_urls_check')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_extra_state_check')
  and (select count(*) = 1 from pg_proc where proname = 'extra_urls_error' and pronamespace = 'public'::regnamespace));

select t.exmk('ex-base', 'https://www.shop.example.dk/vare/1', null, null);
select t.exmk('ex-pj', 'https://prisjagt.dk/product.php?p=5', null, null);
select t.chk('extra: the check accepts 1 and 5 links (one per shop), the null, and a link with a query or path',
  t.err($$update public.products set extra_urls = '["https://a.example.dk/vare?id=1"]' where name = 'ex-base'$$) = 'ok1'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/2","https://c.example.dk/3","https://d.example.dk/4","https://e.example.dk/5"]' where name = 'ex-base'$$) = 'ok1'
  and t.err($$update public.products set extra_urls = null where name = 'ex-base'$$) = 'ok1');
select t.chk('extra: the check rejects none, six, a non-array, a non-text entry, and a null entry',
  t.err($$update public.products set extra_urls = '[]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/2","https://c.example.dk/3","https://d.example.dk/4","https://e.example.dk/5","https://f.example.dk/6"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '{"a":"https://a.example.dk/1"}' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '"https://a.example.dk/1"' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '[5]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '[null]' where name = 'ex-base'$$) like '%products_extra_urls_check%');
select t.chk('extra: the check rejects http, a port, user:password@, spaces, no dot, an entry over 500 characters',
  t.err($$update public.products set extra_urls = '["http://a.example.dk/1"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk:8443/1"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://u:p@a.example.dk/1"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/a b"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://localhost/1"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = to_jsonb(array['https://a.example.dk/' || repeat('a', 485)]) where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = to_jsonb(array['https://a.example.dk/' || repeat('a', 470)]) where name = 'ex-base'$$) = 'ok1');
update public.products set extra_urls = null where name = 'ex-base';
select t.chk('extra: the check rejects prisjagt.dk (also www and upper case), the product''s own shop (also www, case, another path), a second link to one shop, shops on a prisjagt product',
  t.err($$update public.products set extra_urls = '["https://prisjagt.dk/product.php?p=1"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://www.PRISJAGT.dk/product.php?p=1"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://shop.example.dk/vare/2"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://WWW.Shop.Example.dk/andet"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://www.a.example.dk/2"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/1","https://A.example.dk/3"]' where name = 'ex-base'$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1"]' where name = 'ex-pj'$$) like '%products_extra_urls_check%');
select t.chk('extra: a name-only product (no link) cannot have extra shops; extra_state must be an object',
  t.err($$insert into public.products (user_id, name, target_type, extra_urls) values ('00000000-0000-0000-0000-0000000000a1', 'ex-navn', 'auto', '["https://a.example.dk/1"]')$$) like '%products_extra_urls_check%'
  and t.err($$update public.products set extra_state = '[1]' where name = 'ex-base'$$) like '%products_extra_state_check%'
  and t.err($$update public.products set extra_state = '{"a":{"fails":1}}' where name = 'ex-base'$$) = 'ok1'
  and t.err($$update public.products set extra_state = null where name = 'ex-base'$$) = 'ok1');
select t.chk('extra: a link change (by the job, postgres) to a host that is among the extras is refused by the check',
  t.err($$update public.products set extra_urls = '["https://a.example.dk/1"]' where name = 'ex-base'$$) = 'ok1'
  and t.err($$update public.products set source_url = 'https://a.example.dk/andet' where name = 'ex-base'$$) like '%products_extra_urls_check%');
delete from public.products;

-- ---- the person (browser): never adds or changes, may remove one entry of their own product
select t.exmk('ex-own', 'https://shop.example.dk/vare', 'done', '["https://a.example.dk/1","https://b.example.dk/2","https://c.example.dk/3"]', '00000000-0000-0000-0000-00000000aa0e');
select t.exmk('ex-one', 'https://shop.example.dk/en', 'done', '["https://a.example.dk/1"]');
select t.exmk('ex-null', 'https://shop.example.dk/ingen', 'none', null);
set role authenticated;
select t.asA();
select t.chk('extra: a browser insert cannot preset extra_urls or extra_state',
  t.err($$insert into public.products (name, source_url, target_type, extra_urls, extra_state) values ('ex-ny', 'https://shop.example.dk/ny', 'auto', '["https://a.example.dk/1"]', '{"a":{"seen":true}}')$$) = 'ok1'
  and t.q($$select (extra_urls is null and extra_state is null)::text from public.products where name = 'ex-ny'$$) = 'true');
select t.chk('extra: the owner cannot add (null to a list): ignored, the rest of the update goes through',
  t.err($$update public.products set extra_urls = '["https://z.example.dk/9"]', name = 'ex-null2' where name = 'ex-null'$$) = 'ok1'
  and t.ex('ex-null2') = 'null');
select t.chk('extra: the owner cannot change an entry, add one, reorder, duplicate, empty, null, replace, or shrink to something that is not the old list minus one entry',
  t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/CHANGED","https://c.example.dk/3"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/2","https://c.example.dk/3","https://d.example.dk/4"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '["https://c.example.dk/3","https://b.example.dk/2","https://a.example.dk/1"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/2","https://c.example.dk/3","https://c.example.dk/3"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '[]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = null where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '"x"' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://x.example.dk/9"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '["https://b.example.dk/2"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]'
  and t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://c.example.dk/CHANGED"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2", "https://c.example.dk/3"]');
select t.chk('extra: the owner cannot write extra_state, and compare_state stays',
  t.err($$update public.products set extra_state = '{"https://a.example.dk/1":{"fails":99}}' where name = 'ex-own'$$) = 'ok1'
  and t.q($$select (extra_state = '{"x":{"seen":true}}'::jsonb and compare_state = 'done')::text from public.products where name = 'ex-own'$$) = 'true');
reset role;
create table t.exsnap as select t.snapstate('ex-own') as j;
grant select on t.exsnap to public;
set role authenticated; select t.asA();
select t.chk('extra: the owner removes the middle entry: the same array minus one, order kept; the job state is dropped (the job rebuilds it), nothing else changes',
  t.err($$update public.products set extra_urls = '["https://a.example.dk/1","https://c.example.dk/3"]' where name = 'ex-own'$$) = 'ok1'
  and t.ex('ex-own') = '["https://a.example.dk/1", "https://c.example.dk/3"]'
  and t.q($$select (extra_state is null and compare_state = 'done')::text from public.products where name = 'ex-own'$$) = 'true'
  and t.snapstate('ex-own') = (select j from t.exsnap));
select t.chk('extra: ... then the first, leaving one', t.err($$update public.products set extra_urls = '["https://c.example.dk/3"]' where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = '["https://c.example.dk/3"]');
select t.chk('extra: removing the last entry gives null and compare_state none (compare_at now): the product counts as not found elsewhere',
  t.err($$update public.products set extra_urls = null where name = 'ex-own'$$) = 'ok1' and t.ex('ex-own') = 'null'
  and t.q($$select (compare_state = 'none' and compare_at > now() - interval '1 minute')::text from public.products where name = 'ex-own'$$) = 'true');
select t.chk('extra: with one entry, an empty array or another link changes nothing; only null removes it',
  t.err($$update public.products set extra_urls = '[]' where name = 'ex-one'$$) = 'ok1' and t.ex('ex-one') = '["https://a.example.dk/1"]'
  and t.err($$update public.products set extra_urls = '["https://z.example.dk/1"]' where name = 'ex-one'$$) = 'ok1' and t.ex('ex-one') = '["https://a.example.dk/1"]'
  and t.err($$update public.products set extra_urls = null where name = 'ex-one'$$) = 'ok1' and t.ex('ex-one') = 'null');
reset role;
update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/2"]', extra_state = '{"x":{"seen":true}}', compare_state = 'done' where name = 'ex-own';
set role authenticated; select t.asA();
select t.chk('extra: a link change by the person resets extra_urls and extra_state (and the comparison starts over)',
  t.err($$update public.products set source_url = 'https://anden.example.dk/vare' where name = 'ex-own'$$) = 'ok1'
  and t.q($$select (extra_urls is null and extra_state is null and compare_state is null and status = 'pending')::text from public.products where name = 'ex-own'$$) = 'true');
reset role;
update public.products set extra_urls = '["https://a.example.dk/1","https://b.example.dk/2"]', compare_state = 'done', source_url = 'https://shop.example.dk/vare' where name = 'ex-own';
set role authenticated; select t.asB();
select t.chk('extra: a list member (B) cannot change extra_urls on A''s product: not even to remove one',
  t.err($$update public.products set extra_urls = '["https://a.example.dk/1"]' where name = 'ex-own'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set extra_urls = null where name = 'ex-own'$$) like 'Kun den, der har tilføjet%'
  and t.err($$update public.products set extra_state = '{}' where name = 'ex-own'$$) like 'Kun den, der har tilføjet%'
  and t.ex('ex-own') = '["https://a.example.dk/1", "https://b.example.dk/2"]');
reset role;
insert into public.products (user_id, name, source_url, target_type, compare_state, extra_urls) values ('00000000-0000-0000-0000-0000000000b2', 'ex-b', 'https://b.example.dk/x', 'auto', 'done', '["https://k.example.dk/1","https://l.example.dk/2"]');
set role authenticated; select t.asA();
select t.chk('extra: A cannot see or change B''s own product', (select count(*) = 0 from public.products where name = 'ex-b') and t.err($$update public.products set extra_urls = '["https://k.example.dk/1"]' where name = 'ex-b'$$) = 'ok0');
select t.asB();
select t.chk('extra: B removes one entry of their own product', t.err($$update public.products set extra_urls = '["https://l.example.dk/2"]' where name = 'ex-b'$$) = 'ok1' and t.ex('ex-b') = '["https://l.example.dk/2"]');
reset role;
delete from public.products;

-- ---- resolver_compare: the token
select t.exmk('sh-w1', 'https://www.shop.example.dk/vare/1', 'wanted', null);
select t.exmk('sh-w2', 'https://proshop.example.dk/y', 'wanted', null);
select t.exmk('sh-w3', 'https://shop3.example.dk/y', 'wanted', null);
select t.exmk('sh-w4', 'https://shop4.example.dk/y', 'wanted', null);
select t.exmk('sh-none', 'https://shop5.example.dk/y', 'none', null);
select t.exmk('sh-pjw', 'https://prisjagt.dk/product.php?p=3', 'wanted', null);
select t.chk('extra shops: the token is needed for the new form too (none, empty, wrong, a prefix); nothing changes',
  (select bool_and(r) from (
    select t.rs3('sh-w1', null, '["https://a.example.dk/1"]') = 'error:resolver: invalid or missing token' as r from (select t.tok(null)) x union all
    select t.rs3('sh-w1', null, '["https://a.example.dk/1"]') = 'error:resolver: invalid or missing token' from (select t.tok('')) x union all
    select t.rs3('sh-w1', null, '["https://a.example.dk/1"]') = 'error:resolver: invalid or missing token' from (select t.tok('fel')) x union all
    select t.rs3('sh-w1', null, '["https://a.example.dk/1"]') = 'error:resolver: invalid or missing token' from (select t.tok(repeat('a', 63))) x) y)
  and t.ex('sh-w1') = 'null' and t.q($$select (compare_state = 'wanted')::text from public.products where name = 'sh-w1'$$) = 'true');
set role anon; select t.tok(null);
select t.chk('extra shops: anon without a token: refused', t.rs3('sh-w1', null, '["https://a.example.dk/1"]') = 'error:resolver: invalid or missing token');
reset role; set role authenticated; select t.asA(); select t.tok('fel');
select t.chk('extra shops: a signed-in user without the token: refused', t.rs3('sh-w1', null, '["https://a.example.dk/1"]') = 'error:resolver: invalid or missing token');
reset role;
select t.chk('extra shops: grants as the other resolver functions, exactly one resolver_compare (three arguments, one default)',
  has_function_privilege('anon', 'public.resolver_compare(uuid, text, jsonb)', 'execute') and has_function_privilege('authenticated', 'public.resolver_compare(uuid, text, jsonb)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name in ('resolver_list', 'resolver_compare', 'resolver_set', 'resolver_fail') and grantee = 'PUBLIC')
  and (select count(*) = 1 from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace)
  and (select pronargs = 3 and pronargdefaults = 1 from pg_proc where proname = 'resolver_compare' and pronamespace = 'public'::regnamespace));

-- ---- resolver_compare: the answers
select t.tok(repeat('a', 64));
set role anon;
select t.chk('extra shops: p_url and p_shops together: refused (22023), nothing changes',
  t.rs3('sh-w1', 'https://prisjagt.dk/product.php?p=1', '["https://a.example.dk/1"]') = 'error:resolver: give either a prisjagt.dk link or other shops, not both'
  and t.q($$select (compare_state = 'wanted' and extra_urls is null and source_url = 'https://www.shop.example.dk/vare/1')::text from public.products where name = 'sh-w1'$$) = 'true');
select t.chk('extra shops: a bad call names the bad entry and changes nothing (not an array, empty, six, not text, http, prisjagt, own shop, same shop twice, not a link, a port)',
  t.rs3('sh-w1', null, '"https://a.example.dk/1"') like 'error:resolver: shops must be an array%'
  and t.rs3('sh-w1', null, '{"a":1}') like 'error:resolver: shops must be an array%'
  and t.rs3('sh-w1', null, '[]') like 'error:resolver: shops must hold 1 to 5 links, not 0%'
  and t.rs3('sh-w1', null, '["https://a.example.dk/1","https://b.example.dk/1","https://c.example.dk/1","https://d.example.dk/1","https://e.example.dk/1","https://f.example.dk/1"]') like 'error:resolver: shops must hold 1 to 5 links, not 6%'
  and t.rs3('sh-w1', null, '["https://a.example.dk/1", 7]') like 'error:resolver: shops entry 2 is not a link%'
  and t.rs3('sh-w1', null, '["https://a.example.dk/1", null]') like 'error:resolver: shops entry 2 is not a link%'
  and t.rs3('sh-w1', null, '["https://a.example.dk/1", "http://b.example.dk/2"]') = 'error:resolver: shops entry 2 is not an https product link: http://b.example.dk/2'
  and t.rs3('sh-w1', null, '["ikke et link"]') = 'error:resolver: shops entry 1 is not an https product link: ikke et link'
  and t.rs3('sh-w1', null, '["https://a.example.dk/1", "https://www.prisjagt.dk/product.php?p=4"]') = 'error:resolver: shops entry 2 is a prisjagt.dk link: https://www.prisjagt.dk/product.php?p=4'
  and t.rs3('sh-w1', null, '["https://a.example.dk/1", "https://shop.example.dk/vare/2"]') = 'error:resolver: shops entry 2 is the shop of the product itself: https://shop.example.dk/vare/2'
  and t.rs3('sh-w1', null, '["https://a.example.dk/1", "https://WWW.A.example.dk/2"]') = 'error:resolver: shops entry 2 is a second link to the same shop: https://WWW.A.example.dk/2'
  and t.rs3('sh-w1', null, '["https://a.example.dk:81/1"]') like 'error:resolver: shops entry 1 is not an https product link%'
  and t.ex('sh-w1') = 'null' and t.q($$select (compare_state = 'wanted')::text from public.products where name = 'sh-w1'$$) = 'true');
select t.chk('extra shops: a bad call is an error also for a product that is not waiting; a good one for it is false',
  t.rs3('sh-none', null, '["http://a.example.dk/1"]') like 'error:resolver: shops entry 1 is not an https%'
  and t.rs3('sh-none', null, '["https://a.example.dk/1"]') = 'false' and t.ex('sh-none') = 'null');
reset role;
create table t.exsnap2 as select t.snapstate('sh-w1') as j;
grant select on t.exsnap2 to public;
set role anon;
select t.chk('extra shops: a good answer (links trimmed) returns true: the product keeps its link, extra_urls is set, compare_state done, compare_at now',
  t.rs3('sh-w1', null, '[" https://a.example.dk/vare?id=1 ", "https://www.b.example.dk/2"]') = 'true'
  and t.ex('sh-w1') = '["https://a.example.dk/vare?id=1", "https://www.b.example.dk/2"]'
  and t.q($$select (compare_state = 'done' and compare_at > now() - interval '1 minute' and source_url = 'https://www.shop.example.dk/vare/1' and shop_url is null and extra_state is null)::text from public.products where name = 'sh-w1'$$) = 'true');
select t.chk('extra shops: ... the job-written state is NOT reset: every other column is exactly as it was (price, history, offers, title, check, notification, picture ...)',
  t.snapstate('sh-w1') = (select j from t.exsnap2));
select t.chk('extra shops: ... a second answer for the same product (no longer waiting) returns false and changes nothing',
  t.rs3('sh-w1', null, '["https://z.example.dk/9"]') = 'false' and t.rs3('sh-w1', null, null) = 'false'
  and t.ex('sh-w1') = '["https://a.example.dk/vare?id=1", "https://www.b.example.dk/2"]');
select t.chk('extra shops: five links are fine; the entries keep their order',
  t.rs3('sh-w2', null, '["https://e.example.dk/5","https://d.example.dk/4","https://c.example.dk/3","https://b.example.dk/2","https://a.example.dk/1"]') = 'true'
  and t.ex('sh-w2') = '["https://e.example.dk/5", "https://d.example.dk/4", "https://c.example.dk/3", "https://b.example.dk/2", "https://a.example.dk/1"]');
select t.chk('extra shops: not waiting (none) returns false and changes nothing; a waiting prisjagt product cannot get shops (error); an unknown id returns false',
  t.rs3('sh-none', null, '["https://a.example.dk/1"]') = 'false' and t.ex('sh-none') = 'null'
  and t.rs3('sh-pjw', null, '["https://a.example.dk/1"]') = 'error:resolver: only a product that follows one shop can have extra shops'
  and public.resolver_compare('00000000-0000-0000-0000-00000000ffff', null, '["https://a.example.dk/1"]') = false);
reset role;
update public.products set active = false where name = 'sh-w3';
set role anon;
select t.chk('extra shops: an inactive product returns false', t.rs3('sh-w3', null, '["https://a.example.dk/1"]') = 'false' and t.ex('sh-w3') = 'null');
select t.chk('extra shops: a json null in place of the array means "not found": compare_state none, nothing else changes',
  t.rs3('sh-w4', null, 'null'::jsonb) = 'true'
  and t.q($$select (compare_state = 'none' and extra_urls is null and status = 'tracking' and history is not null)::text from public.products where name = 'sh-w4'$$) = 'true');
reset role;
update public.products set compare_state = 'wanted' where name = 'sh-w4';
set role anon;
select t.chk('extra shops: the old two-argument call form still works (id, null) = none',
  public.resolver_compare(t.pid('sh-w4'), null) = true
  and t.q($$select (compare_state = 'none')::text from public.products where name = 'sh-w4'$$) = 'true');
reset role;
update public.products set compare_state = 'wanted', extra_urls = '["https://a.example.dk/1"]', extra_state = '{"https://a.example.dk/1":{"seen":true}}' where name = 'sh-w4';
set role anon;
select t.chk('extra shops: ... and (id, prisjagt link) = the switch, which also clears extra_urls and extra_state and still resets the job state',
  public.resolver_compare(t.pid('sh-w4'), 'https://www.prisjagt.dk/product.php?p=77') = true
  and t.q($$select (source_url = 'https://prisjagt.dk/product.php?p=77' and extra_urls is null and extra_state is null and status = 'pending' and shop_url = 'https://shop4.example.dk/y' and compare_state = 'done' and offers is null)::text from public.products where name = 'sh-w4'$$) = 'true');
select t.chk('extra shops: resolver_list does not list a product that has been answered with shops', not exists (select 1 from public.resolver_list() where name in ('sh-w1', 'sh-w2')));
reset role;
select t.tok(null);
delete from public.products;
delete from public.lists where name = 'Ext';
select set_config('request.jwt.claims', '', false);

-- ---- requirements and the variant work of the AI agent
select t.tok(null);
create function t.vs(n integer) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('id', 'v' || g, 'label', 'Variant ' || g, 'lowest', 100 + g, 'offers', 2, 'sample', 'x') order by g) from generate_series(1, n) g $$;
grant execute on function t.vs(integer) to public;
-- a product of A: n, link, status, number of variants, tracked variants, requirements, list
create function t.rmk(n text, u text, st text, nv integer, tr text[], rq text, lst uuid default null) returns void language sql security definer as $$
  insert into public.products (user_id, name, source_url, target_type, status, title, variants, tracked_variants, requirements, list_id, offers, last_checked)
  values ('00000000-0000-0000-0000-0000000000a1', n, u, 'auto', st, 'Titel ' || n, case when nv = 0 then null else t.vs(nv) end, tr, rq, lst,
    '[{"store":"Shop","price":450,"inStock":true}]', now()) $$;
grant execute on function t.rmk(text, text, text, integer, text[], text, uuid) to public;
create function t.st(n text) returns text language sql security definer as $$ select coalesce(req_state::text, 'null') from public.products where name = n $$;
create function t.cs(n text) returns text language sql security definer as $$ select coalesce(compare_state, 'null') || '/' || compare_tries || '/' || coalesce(compare_at::text, 'null') from public.products where name = n $$;
create function t.rq(n text) returns text language sql security definer as $$ select coalesce(requirements, 'null') from public.products where name = n $$;
grant execute on function t.st(text), t.cs(text), t.rq(text) to public;
create function t.rv(n text, ids jsonb) returns text language plpgsql as $$
declare r boolean; begin r := public.resolver_variants(t.pid(n), ids); return coalesce(r::text, 'null'); exception when others then return 'error:' || sqlerrm; end $$;
grant execute on function t.rv(text, jsonb) to public;
create function t.tv(n text) returns text language sql security definer as $$ select coalesce(array_to_string(tracked_variants, ','), 'null') from public.products where name = n $$;
grant execute on function t.tv(text) to public;

select t.chk('requirements: two nullable columns, the check (one each), the helper and resolver_variants exist once',
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name in ('requirements', 'req_state') and is_nullable = 'YES')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_requirements_check')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_req_state_check')
  and (select count(*) = 1 from pg_proc where proname = 'req_variant_waiting' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'resolver_variants' and pronamespace = 'public'::regnamespace));

-- the person's words are only a preference: cleaned, never a reason to refuse a product
create function t.ireq(n text, r text) returns text language plpgsql as $$
begin
  execute format('insert into public.products (name, target_type, requirements) values (%L, ''auto'', %L)', n, r); return 'ok';
exception when others then return 'fail ' || sqlerrm; end $$;
grant execute on function t.ireq(text, text) to public;
set role authenticated; select t.asA();
select t.chk('requirements: insert trims, empty and blank become null, a tab or newline around is trimmed',
  t.ireq('q1', '  hvid/grøn, str. 43  ') = 'ok' and t.ireq('q2', '') = 'ok' and t.ireq('q3', '   ') = 'ok' and t.ireq('q4', E'\t sort \n') = 'ok'
  and t.rq('q1') = 'hvid/grøn, str. 43' and t.rq('q2') = 'null' and t.rq('q3') = 'null' and t.rq('q4') = 'sort');
select t.chk('requirements: 120 characters are kept (also multibyte); longer text is cut at 120 and the product is still saved',
  t.ireq('q5', repeat('æ', 120)) = 'ok' and t.ireq('q6', repeat('x', 300)) = 'ok' and t.ireq('q7', repeat('x', 119) || '   yy') = 'ok'
  and t.rq('q5') = repeat('æ', 120) and t.rq('q6') = repeat('x', 120) and t.rq('q7') = repeat('x', 119));
select t.chk('requirements: control characters and angle brackets are replaced by a space (never an error), spaces collapse; quotes and & stay',
  t.ireq('q8', E'hvid\nstr. 43') = 'ok' and t.ireq('q9', E'hvid\tstr') = 'ok' and t.ireq('q10', E'a\u0085b') = 'ok' and t.ireq('q11', E'a\u007fb') = 'ok'
  and t.ireq('q12', 'a<b') = 'ok' and t.ireq('q13', '<<<>>>') = 'ok' and t.ireq('q14', '<script>alert(1)</script>') = 'ok' and t.ireq('q15', 'str. 43 & "hvid" ''grøn''') = 'ok'
  and t.rq('q8') = 'hvid str. 43' and t.rq('q9') = 'hvid str' and t.rq('q10') = 'a b' and t.rq('q11') = 'a b' and t.rq('q12') = 'a b' and t.rq('q13') = 'null'
  and t.rq('q14') = 'script alert(1) /script' and t.rq('q15') = 'str. 43 & "hvid" ''grøn''');
select t.chk('requirements: a browser insert cannot forge req_state',
  t.try($$insert into public.products (name, target_type, requirements, req_state) values ('q16', 'auto', 'rød', '{"for":"rød","by":"agent"}')$$) = 'ok' and t.st('q16') = 'null');
select t.chk('requirements: an update is cleaned the same way',
  t.try($$update public.products set requirements = E'  <b>sort</b>\n ' where name = 'q16'$$) = 'ok' and t.rq('q16') = 'b sort /b');
reset role;
delete from public.products where name ~ '^q[0-9]+$';

-- a shared list: A owns it, B is a member
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa77', '00000000-0000-0000-0000-0000000000a1', 'Krav');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa77', '00000000-0000-0000-0000-0000000000b2');
select t.rmk('r-sh', 'https://www.adidas.dk/sko/stan', 'tracking', 1, array['shop'], 'hvid/grøn', '00000000-0000-0000-0000-00000000aa77');
set role authenticated; select t.asB();
select t.chk('requirements: a member can read them, but not set, change or clear them on the owner''s product',
  (select requirements = 'hvid/grøn' from public.products where name = 'r-sh')
  and t.try($$update public.products set requirements = 'sort' where name = 'r-sh'$$) = 'check'
  and t.try($$update public.products set requirements = null where name = 'r-sh'$$) = 'check'
  and t.try($$update public.products set req_state = '{"for":"hvid/grøn","by":"agent"}' where name = 'r-sh'$$) = 'check'
  and t.rq('r-sh') = 'hvid/grøn' and t.st('r-sh') = 'null');
select t.chk('requirements: a member''s own product in the list has its own requirements, which the owner cannot change',
  t.try($$insert into public.products (name, target_type, requirements, list_id) values ('r-b', 'auto', 'str. 40', '00000000-0000-0000-0000-00000000aa77')$$) = 'ok');
select t.chk('requirements: ... they are stored', (select requirements = 'str. 40' from public.products where name = 'r-b'));
select t.asA();
select t.chk('requirements: ... A cannot change B''s', t.try($$update public.products set requirements = 'str. 41' where name = 'r-b'$$) = 'check' and t.rq('r-b') = 'str. 40');
reset role;

-- reset rules: single-shop product with compare state done and extra shops
select t.exmk('r-single', 'https://www.adidas.dk/sko/stan', 'done', '["https://a.example.dk/stan"]');
update public.products set compare_tries = 2 where name = 'r-single';
create table t.rsnap as select t.snapstate('r-single') as j, (select extra_urls from public.products where name = 'r-single') as x;
grant select on t.rsnap to public;
set role authenticated; select t.asA();
update public.products set requirements = '  hvid/grøn, str. 43 ' where name = 'r-single';
select t.chk('requirements: new words on a single-shop product restart the lookup (compare_state null, compare_at null, tries 0) and change nothing else',
  t.cs('r-single') = 'null/0/null' and t.rq('r-single') = 'hvid/grøn, str. 43'
  and (select t.snapstate('r-single') - 'requirements' - 'compare_tries' = s.j - 'requirements' - 'compare_tries' from t.rsnap s)
  and (select x = (select extra_urls from public.products where name = 'r-single') from t.rsnap s) and t.st('r-single') = 'null');
reset role;
update public.products set compare_state = 'done', compare_at = now(), compare_tries = 1 where name = 'r-single';
set role authenticated; select t.asA();
update public.products set requirements = 'hvid/grøn, str. 43', name = 'r-single' where name = 'r-single';
select t.chk('requirements: the same words again (or an update of something else) restart nothing', t.cs('r-single') like 'done/1/%');
update public.products set requirements = null where name = 'r-single';
select t.chk('requirements: removing them restarts nothing either, and the field is null', t.cs('r-single') like 'done/1/%' and t.rq('r-single') = 'null');
reset role;
update public.products set compare_state = 'none', compare_at = now() where name = 'r-single';
set role authenticated; select t.asA();
update public.products set requirements = 'sort' where name = 'r-single';
select t.chk('requirements: a single-shop product that was not found (none) is looked for again', t.cs('r-single') = 'null/0/null');
reset role;
update public.products set compare_state = 'wanted', compare_at = now() where name = 'r-single';
set role authenticated; select t.asA();
update public.products set requirements = 'rød' where name = 'r-single';
select t.chk('requirements: ... also while it is waiting (the agent then reads the new words)', t.cs('r-single') = 'null/0/null');
reset role;
update public.products set req_state = '{"for":"rød","by":"agent","n":1}' where name = 'r-single';
set role authenticated; select t.asA();
update public.products set source_url = 'https://www.andenbutik.dk/stan' where name = 'r-single';
select t.chk('requirements: a new link starts over (req_state null) and keeps the requirements', t.st('r-single') = 'null' and t.rq('r-single') = 'rød');
select t.chk('requirements: the browser cannot write req_state or the compare columns when it changes requirements',
  t.try($$update public.products set requirements = 'blå', req_state = '{"for":"blå","by":"agent"}', compare_state = 'done', compare_tries = 9 where name = 'r-single'$$) = 'ok'
  and t.st('r-single') = 'null' and t.cs('r-single') = 'null/0/null');
reset role;

-- a Prisjagt product the person added directly (no shop_url)
select t.rmk('r-pj', 'https://prisjagt.dk/product.php?p=11', 'choose', 3, null, null);
select t.rmk('r-pj1', 'https://prisjagt.dk/product.php?p=12', 'tracking', 1, array['v1'], null);
select t.rmk('r-pjt', 'https://prisjagt.dk/product.php?p=13', 'tracking', 3, array['v1'], null);
select t.rmk('r-sw', 'https://prisjagt.dk/product.php?p=14', 'tracking', 2, array['v1'], null);
update public.products set compare_state = 'done', compare_at = now(), shop_url = 'https://www.adidas.dk/sko/old', compare_tries = 1 where name = 'r-sw';
set role authenticated; select t.asA();
update public.products set requirements = 'hvid' where name in ('r-pj', 'r-pj1', 'r-pjt', 'r-sw');
select t.chk('requirements: a direct Prisjagt product never gets a compare lookup (state stays null, link kept); only variants are re-evaluated',
  t.cs('r-pj') = 'null/0/null' and t.cs('r-pjt') = 'null/0/null' and t.cs('r-pj1') = 'null/0/null'
  and (select bool_and(source_url ~ '^https://prisjagt.dk/product.php') and bool_and(shop_url is null) from public.products where name in ('r-pj', 'r-pj1', 'r-pjt')));
select t.chk('requirements: 2 or more variants: req_state {"want": true}; one variant: nothing to choose',
  t.q($$select (req_state ->> 'want' = 'true')::text from public.products where name = 'r-pjt'$$) = 'true'
  and t.q($$select (req_state ->> 'want' = 'true')::text from public.products where name = 'r-pj'$$) = 'true' and t.st('r-pj1') = 'null');
select t.chk('requirements: a product the agent switched to Prisjagt (shop_url kept) is looked for again: state reset, link, shop_url, price state kept, variants flagged',
  t.cs('r-sw') = 'null/0/null' and (select shop_url = 'https://www.adidas.dk/sko/old' and source_url = 'https://prisjagt.dk/product.php?p=14' and tracked_variants = array['v1'] and offers is not null from public.products where name = 'r-sw')
  and t.q($$select (req_state ->> 'want' = 'true')::text from public.products where name = 'r-sw'$$) = 'true');
update public.products set name = 'r-pjt' where name = 'r-pjt';
select t.chk('requirements: an update of something else keeps req_state; the browser cannot write it', t.q($$select (req_state ->> 'want' = 'true')::text from public.products where name = 'r-pjt'$$) = 'true'
  and t.try($$update public.products set req_state = null where name = 'r-pjt'$$) = 'ok' and t.q($$select (req_state ->> 'want' = 'true')::text from public.products where name = 'r-pjt'$$) = 'true');
reset role;
update public.products set req_state = '{"for":"hvid","by":"agent","n":1}' where name = 'r-pjt';
set role authenticated; select t.asA();
update public.products set requirements = 'blå' where name = 'r-pjt';
select t.chk('requirements: new words replace an answer for the old words by the flag', t.q($$select (req_state ->> 'want' = 'true' and req_state -> 'for' is null)::text from public.products where name = 'r-pjt'$$) = 'true');
update public.products set source_url = 'https://prisjagt.dk/product.php?p=99' where name = 'r-pjt';
select t.chk('requirements: a new link resets the flag and the product (as always)', t.st('r-pjt') = 'null' and t.rq('r-pjt') = 'blå' and t.tv('r-pjt') = 'null');
reset role;
delete from public.products where name in ('r-pj', 'r-pj1', 'r-pjt', 'r-sw', 'r-single', 'r-sh', 'r-b');

-- ---- resolver_list: three kinds
delete from public.products;
select t.rmk('v-ch', 'https://prisjagt.dk/product.php?p=21', 'choose', 3, null, 'hvid/grøn, str. 43');
select t.rmk('v-want', 'https://prisjagt.dk/product.php?p=22', 'tracking', 2, array['v1'], 'sort');
update public.products set req_state = '{"want":true,"at":"2026-11-01T10:00:00Z"}', created_at = now() - interval '9 days' where name = 'v-want';
update public.products set created_at = now() - interval '2 days', last_checked = '2026-11-02T10:00:00Z' where name = 'v-ch';
select t.rmk('c-w', 'https://www.adidas.dk/sko/x', 'tracking', 1, array['shop'], 'str. 43');
update public.products set compare_state = 'wanted', compare_at = now() - interval '1 day' where name = 'c-w';
select t.rmk('c-w0', 'https://www.proshop.dk/x', 'tracking', 1, array['shop'], null);
update public.products set compare_state = 'wanted', compare_at = now() - interval '3 days' where name = 'c-w0';
insert into public.products (user_id, name, target_type, created_at, requirements) values ('00000000-0000-0000-0000-0000000000a1', 'n-1', 'auto', now() - interval '1 day', 'XL'), ('00000000-0000-0000-0000-0000000000a1', 'n-0', 'auto', now() - interval '2 days', null);
-- not waiting for a variant decision
select t.rmk('x-noreq', 'https://prisjagt.dk/product.php?p=31', 'choose', 3, null, null);
select t.rmk('x-one', 'https://prisjagt.dk/product.php?p=32', 'choose', 1, null, 'sort');
select t.rmk('x-inact', 'https://prisjagt.dk/product.php?p=33', 'choose', 3, null, 'sort');
update public.products set active = false where name = 'x-inact';
select t.rmk('x-bought', 'https://prisjagt.dk/product.php?p=34', 'choose', 3, null, 'sort');
update public.products set bought_at = now() where name = 'x-bought';
select t.rmk('x-shop', 'https://www.adidas.dk/sko/y', 'choose', 3, null, 'sort');
select t.rmk('x-track', 'https://prisjagt.dk/product.php?p=35', 'tracking', 3, array['v1'], 'sort');
select t.rmk('x-chosen', 'https://prisjagt.dk/product.php?p=36', 'choose', 3, array['v2'], 'sort');
select t.rmk('x-answered', 'https://prisjagt.dk/product.php?p=37', 'choose', 3, null, 'sort');
update public.products set req_state = '{"for":"sort","by":"agent","n":0}' where name = 'x-answered';
select t.rmk('x-stale', 'https://prisjagt.dk/product.php?p=38', 'choose', 3, null, 'sort');
update public.products set req_state = '{"for":"gamle ord","by":"agent","n":0}' where name = 'x-stale';
select t.rmk('x-novar', 'https://prisjagt.dk/product.php?p=39', 'pending', 0, null, 'sort');
select t.tok(repeat('a', 64));
set role anon;
select t.chk('variant: resolver_list: name rows first, then variant rows, then compare rows (oldest request first)',
  (select array_agg(kind order by o) = array['name', 'name', 'variant', 'variant', 'variant', 'compare', 'compare'] from (select row_number() over () o, kind from public.resolver_list()) y)
  and (select array_agg(name order by o) filter (where kind <> 'variant') = array['n-0', 'n-1', 'Titel c-w0', 'Titel c-w'] from (select row_number() over () o, * from public.resolver_list()) y));
select t.chk('variant: ... only the waiting products are variant rows (no requirements, one variant, inactive, bought, a shop link, tracking without the flag, a choice already made, answered for these words, no variants yet: none of them)',
  (select count(*) = 3 and bool_and(name in ('Titel v-want', 'Titel v-ch', 'Titel x-stale')) from public.resolver_list() where kind = 'variant'));
select t.chk('variant: ... req on every row (the person''s words or null), variants only on variant rows',
  (select req = 'XL' from public.resolver_list() where name = 'n-1') and (select req is null from public.resolver_list() where name = 'n-0')
  and (select req = 'str. 43' from public.resolver_list() where name = 'Titel c-w') and (select req is null from public.resolver_list() where name = 'Titel c-w0')
  and (select bool_and(req is not null) from public.resolver_list() where kind = 'variant')
  and (select bool_and(variants is null) from public.resolver_list() where kind <> 'variant') and (select bool_and(variants is not null) from public.resolver_list() where kind = 'variant'));
select t.chk('variant: ... variants = [{id, name}] with the label as name, in the page''s order; host and price null',
  (select variants = '[{"id":"v1","name":"Variant 1"},{"id":"v2","name":"Variant 2"},{"id":"v3","name":"Variant 3"}]'::jsonb and host is null and price is null and req = 'hvid/grøn, str. 43' and id = t.pid('v-ch') from public.resolver_list() where kind = 'variant' and name = 'Titel v-ch'));
select t.chk('variant: ... the columns are id, name, created_at, kind, host, price, req, variants; the compare rows are as before',
  (select proargnames = array['id', 'name', 'created_at', 'kind', 'host', 'price', 'req', 'variants'] from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace)
  and (select host = 'adidas.dk' and price = 450 and variants is null from public.resolver_list() where name = 'Titel c-w'));
reset role;
update public.products set variants = (select jsonb_agg(jsonb_build_object('id', 'w' || g, 'label', repeat('å', 100) || g) order by g) from generate_series(1, 60) g) where name = 'v-ch';
set role anon;
select t.chk('variant: ... at most 40 variants, names cut at 80 characters, ids unchanged',
  (select jsonb_array_length(variants) = 40 and (variants -> 0 ->> 'id') = 'w1' and (variants -> 39 ->> 'id') = 'w40' and (select bool_and(char_length(e ->> 'name') = 80) from jsonb_array_elements(variants) e) from public.resolver_list() where name = 'Titel v-ch'));
reset role;
insert into public.products (user_id, name, source_url, target_type, status, variants, requirements, created_at)
  select '00000000-0000-0000-0000-0000000000a1', 'vv' || g, 'https://prisjagt.dk/product.php?p=' || (100 + g), 'auto', 'choose', t.vs(2), 'sort', now() - (g || ' hours')::interval from generate_series(1, 12) g;
set role anon;
select t.chk('variant: at most 10 rows in all: the 2 name rows first, then variant rows, compare rows only when room is left',
  (select count(*) = 10 from public.resolver_list())
  and (select array_agg(kind order by o) = array['name', 'name', 'variant', 'variant', 'variant', 'variant', 'variant', 'variant', 'variant', 'variant'] from (select row_number() over () o, kind from public.resolver_list()) y));
reset role;
delete from public.products where name ~ '^vv[0-9]+$';

-- ---- resolver_variants
select t.tok(repeat('a', 64));
set role anon;
select t.chk('variant: resolver_variants refuses a bad shape (not an array, empty, 21 ids, an id that is not text) and changes nothing',
  t.rv('v-ch', '"v1"') like 'error:resolver: ids must be an array%' and t.rv('v-ch', '{"a":1}') like 'error:resolver: ids must be an array%'
  and t.rv('v-ch', '[]') like 'error:resolver: ids must hold 1 to 20 variant ids, not 0%'
  and t.rv('v-ch', (select jsonb_agg('w' || g) from generate_series(1, 21) g)) like 'error:resolver: ids must hold 1 to 20 variant ids, not 21%'
  and t.rv('v-ch', '["w1", 2]') like 'error:resolver: a variant id must be text: 2%'
  and t.rv('n-1', '[]') like 'error:resolver: ids must hold%' and t.st('v-ch') = 'null' and t.tv('v-ch') = 'null');
select t.chk('variant: an id that is not among the product''s variants is refused, naming it, and nothing changes (also when one of several is good)',
  t.rv('v-ch', '["w1", "nej-tak"]') = 'error:resolver: variant id not found in the product: nej-tak'
  and t.rv('v-ch', '["w999"]') = 'error:resolver: variant id not found in the product: w999'
  and t.rv('v-ch', jsonb_build_array(repeat('å', 200))) like 'error:resolver: variant id not found in the product: ååå%'
  and t.st('v-ch') = 'null' and t.tv('v-ch') = 'null');
select t.chk('variant: a product that is not waiting gives false (no requirements, tracking without the flag, a choice already made, answered, a shop link, a name-only product, inactive, bought, one variant)',
  t.rv('x-noreq', '["v1"]') = 'false' and t.rv('x-track', '["v1"]') = 'false' and t.rv('x-chosen', '["v1"]') = 'false' and t.rv('x-answered', '["v1"]') = 'false'
  and t.rv('x-shop', '["v1"]') = 'false' and t.rv('n-1', '["v1"]') = 'false' and t.rv('x-inact', '["v1"]') = 'false' and t.rv('x-bought', null) = 'false' and t.rv('x-one', null) = 'false');
select t.chk('variant: ... and nothing was written for them', t.tv('x-noreq') = 'null' and t.tv('x-chosen') = 'v2' and t.st('x-answered') = '{"n": 0, "by": "agent", "for": "sort"}');
select t.chk('variant: an answer with ids sets tracked_variants exactly (status untouched: the job starts on its next run), records the answer for these requirements, and leaves the queue',
  t.rv('v-ch', '["w2", "w5", "w2"]') = 'true' and t.tv('v-ch') = 'w2,w5'
  and t.q($$select (req_state ->> 'for' = 'hvid/grøn, str. 43' and req_state ->> 'by' = 'agent' and (req_state ->> 'n')::int = 2 and status = 'choose' and requirements = 'hvid/grøn, str. 43')::text from public.products where name = 'v-ch'$$) = 'true'
  and t.rv('v-ch', '["w1"]') = 'false' and t.tv('v-ch') = 'w2,w5');
select t.chk('variant: ... and the row has left the queue', not exists (select 1 from public.resolver_list() where name = 'Titel v-ch'));
select t.chk('variant: the same for a tracking product that was flagged: the variants change, the flag is gone, status and prices stay',
  t.rv('v-want', '["v2"]') = 'true' and t.tv('v-want') = 'v2' and t.q($$select (req_state ->> 'by' = 'agent' and req_state -> 'want' is null)::text from public.products where name = 'v-want'$$) = 'true'
  and t.q($$select (status = 'tracking' and offers is not null)::text from public.products where name = 'v-want'$$) = 'true');
select t.chk('variant: ... and leaves the queue', not exists (select 1 from public.resolver_list() where name = 'Titel v-want'));
select t.chk('variant: null = cannot decide: only the answer is recorded (n 0), a product at "Vælg variant" stays there with nothing chosen, and it leaves the queue',
  t.rv('x-stale', 'null'::jsonb) = 'true' and t.tv('x-stale') = 'null' and t.q($$select (status = 'choose' and (req_state ->> 'n')::int = 0 and req_state ->> 'for' = 'sort')::text from public.products where name = 'x-stale'$$) = 'true'
  and t.rv('x-stale', null) = 'false');
select t.chk('variant: ... and leaves the queue too', not exists (select 1 from public.resolver_list() where name = 'Titel x-stale'));
reset role;
update public.products set req_state = '{"want":true}' where name = 'x-track';
set role anon;
select t.chk('variant: null for a flagged tracking product: it keeps following what it followed',
  t.rv('x-track', null) = 'true' and t.tv('x-track') = 'v1' and t.q($$select ((req_state ->> 'n')::int = 0)::text from public.products where name = 'x-track'$$) = 'true' and t.rv('x-track', null) = 'false');
reset role;
update public.products set req_state = null, tracked_variants = null, status = 'choose' where name = 'v-ch';
set role authenticated; select t.asA();
update public.products set requirements = 'sort, str. 42' where name = 'v-ch';
select t.chk('variant: new words from the person put the product back in the queue (the answer for the old words no longer counts)',
  t.q($$select (req_state ->> 'want' = 'true')::text from public.products where name = 'v-ch'$$) = 'true');
reset role; set role anon;
select t.chk('variant: ... and the agent sees the new words', (select count(*) = 1 and bool_and(req = 'sort, str. 42') from public.resolver_list() where name = 'Titel v-ch'));
reset role;
set role authenticated; select t.asA();
update public.products set tracked_variants = array['w3'] where name = 'v-ch';
select t.chk('variant: the person''s own choice wins: tracked_variants as written, the requirements marked as answered by the person',
  t.tv('v-ch') = 'w3' and t.q($$select (req_state ->> 'for' = 'sort, str. 42' and req_state ->> 'by' = 'person' and req_state -> 'want' is null)::text from public.products where name = 'v-ch'$$) = 'true');
reset role; set role anon;
select t.chk('variant: ... and the row is out of the agent''s queue; the agent''s late answer is refused (false) and changes nothing',
  t.rv('v-ch', '["w1"]') = 'false' and t.tv('v-ch') = 'w3' and not exists (select 1 from public.resolver_list() where name = 'Titel v-ch'));
reset role;
update public.products set req_state = '{"want":true}', tracked_variants = array['v1'] where name = 'v-want';
set role authenticated; select t.asA();
update public.products set tracked_variants = array['v1', 'v2'] where name = 'v-want';
select t.chk('variant: the same for a flagged tracking product', t.tv('v-want') = 'v1,v2' and t.q($$select (req_state ->> 'by' = 'person')::text from public.products where name = 'v-want'$$) = 'true');
reset role; set role anon;
select t.chk('variant: ... out of the queue', not exists (select 1 from public.resolver_list() where name = 'Titel v-want'));
reset role;
update public.products set requirements = null, req_state = null where name = 'v-want';
set role authenticated; select t.asA();
update public.products set tracked_variants = array['v1'] where name = 'v-want';
select t.chk('variant: a choice on a product without requirements writes no req_state', t.st('v-want') = 'null');
reset role;

-- the token and the grants
select t.tok(null);
create function t.rvc() returns text language plpgsql as $$ begin return (select count(*) from public.resolver_list())::text; exception when others then return sqlerrm; end $$;
grant execute on function t.rvc() to public;
update public.products set req_state = '{"want":true}', requirements = 'sort' where name = 'v-want';
select t.chk('variant: the token is needed (none, empty, wrong, a prefix) for resolver_variants and resolver_list; nothing changes',
  (select bool_and(r) from (
    select t.rv('v-want', '["v1"]') = 'error:resolver: invalid or missing token' and t.rv('v-want', null) = 'error:resolver: invalid or missing token' as r from (select t.tok(null)) x union all
    select t.rv('v-want', '["v1"]') = 'error:resolver: invalid or missing token' from (select t.tok('')) x union all
    select t.rv('v-want', '["v1"]') = 'error:resolver: invalid or missing token' from (select t.tok('fel')) x union all
    select t.rv('v-want', '["v1"]') = 'error:resolver: invalid or missing token' from (select t.tok(repeat('a', 63))) x) y)
  and t.rv('v-want', '[]') = 'error:resolver: invalid or missing token' and t.rvc() = 'resolver: invalid or missing token' and t.st('v-want') = '{"want": true}' and t.tv('v-want') = 'v1');
set role anon; select t.tok(null);
select t.chk('variant: anon without a token: refused', t.rv('v-want', '["v1"]') = 'error:resolver: invalid or missing token');
reset role; set role authenticated; select t.asA(); select t.tok('fel');
select t.chk('variant: a signed-in user without the token: refused', t.rv('v-want', '["v1"]') = 'error:resolver: invalid or missing token' and t.rvc() = 'resolver: invalid or missing token');
reset role;
select t.chk('variant: grants as the other resolver functions; one resolver_list and one resolver_variants; the helper is not callable by the browser',
  has_function_privilege('anon', 'public.resolver_variants(uuid, jsonb)', 'execute') and has_function_privilege('authenticated', 'public.resolver_variants(uuid, jsonb)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name in ('resolver_variants', 'resolver_list') and grantee = 'PUBLIC')
  and not has_function_privilege('anon', 'public.req_variant_waiting(public.products)', 'execute') and not has_function_privilege('authenticated', 'public.req_variant_waiting(public.products)', 'execute')
  and (select count(*) = 1 from pg_proc where proname = 'resolver_list' and pronamespace = 'public'::regnamespace)
  and (select count(*) = 1 from pg_proc where proname = 'resolver_variants' and pronamespace = 'public'::regnamespace));

-- resolver_compare with the new state: a product switched earlier, looked for again
select t.tok(repeat('a', 64));
delete from public.products;
select t.rmk('k-sw', 'https://prisjagt.dk/product.php?p=51', 'tracking', 2, array['v1'], 'hvid');
update public.products set compare_state = 'wanted', compare_at = now(), shop_url = 'https://www.adidas.dk/sko/old', req_state = '{"want":true}' where name = 'k-sw';
set role anon;
select t.chk('requirements: resolver_list lists a switched product for compare (host prisjagt.dk) with its req, and for variants',
  (select count(*) = 2 from public.resolver_list()) and (select host = 'prisjagt.dk' and req = 'hvid' from public.resolver_list() where kind = 'compare'));
select t.chk('requirements: the agent keeps the page it is on (same link): state done, nothing reset, the original shop link kept',
  t.rc('k-sw', 'https://www.prisjagt.dk/product.php?p=51') = 'true'
  and t.q($$select (compare_state = 'done' and status = 'tracking' and offers is not null and tracked_variants = array['v1'] and shop_url = 'https://www.adidas.dk/sko/old' and req_state ->> 'want' = 'true')::text from public.products where name = 'k-sw'$$) = 'true');
reset role;
update public.products set compare_state = 'wanted' where name = 'k-sw';
set role anon;
select t.chk('requirements: not found elsewhere for a switched product: it stays switched (done), not none',
  t.rc('k-sw', null) = 'true' and t.cs('k-sw') like 'done/%');
reset role;
update public.products set compare_state = 'wanted' where name = 'k-sw';
set role anon;
select t.chk('requirements: a different Prisjagt page: the new page, the ORIGINAL shop link kept in shop_url, state reset including req_state',
  t.rc('k-sw', 'https://prisjagt.dk/product.php?p=52') = 'true'
  and t.q($$select (source_url = 'https://prisjagt.dk/product.php?p=52' and shop_url = 'https://www.adidas.dk/sko/old' and compare_state = 'done' and status = 'pending' and offers is null and tracked_variants is null and req_state is null)::text from public.products where name = 'k-sw'$$) = 'true');
reset role;
select t.tok(null);
delete from public.products;
delete from public.lists where id = '00000000-0000-0000-0000-00000000aa77';
select set_config('request.jwt.claims', '', false);

-- 11d. questions ("Spørg om en vare"): the table, its limits and guard, and the AI agent's three functions
delete from public.products;
insert into public.lists (id, user_id, name) values
  ('00000000-0000-0000-0000-00000000aa0d', '00000000-0000-0000-0000-0000000000a1', 'Ask A'),
  ('00000000-0000-0000-0000-00000000aa0e', '00000000-0000-0000-0000-0000000000c5', 'Ask C');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa0d', '00000000-0000-0000-0000-0000000000b2') on conflict do nothing;
update public.resolver_secret set token = repeat('a', 64);
select t.tok(null);
create function t.ask(q text, l uuid default null) returns text language plpgsql as $$
begin insert into public.questions (question, list_id) values (q, l); return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create function t.qid(q text) returns uuid language sql security definer as $$ select id from public.questions where question = q $$;
create function t.qage(h numeric) returns void language sql security definer as $$ update public.questions set created_at = created_at - make_interval(hours => h::int) $$;
create function t.alog(h numeric) returns void language sql security definer as $$ update public.ask_attempts set at = at - make_interval(hours => h::int) $$;
create function t.qpend(q text) returns void language sql security definer as $$
  update public.questions set status = 'pending', summary = null, picks = null, note = null, answered_at = null where question = q $$;
grant execute on function t.ask(text, uuid), t.qid(text), t.qage(numeric), t.alog(numeric), t.qpend(text) to public;

select t.chk('ask: the table, the log and the functions exist; no anon rights; no UPDATE for authenticated; no rights at all on the log',
  to_regclass('public.questions') is not null and to_regclass('public.ask_attempts') is not null
  and (select count(*) = 4 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('ai_ask_list', 'ai_ask_set', 'ai_ask_fail', 'ask_take_slot'))
  and not has_table_privilege('anon', 'public.questions', 'select') and not has_table_privilege('anon', 'public.questions', 'insert')
  and has_table_privilege('authenticated', 'public.questions', 'select') and has_table_privilege('authenticated', 'public.questions', 'insert')
  and has_table_privilege('authenticated', 'public.questions', 'delete') and not has_table_privilege('authenticated', 'public.questions', 'update')
  and has_table_privilege('service_role', 'public.questions', 'update')
  and not has_table_privilege('authenticated', 'public.ask_attempts', 'select') and not has_table_privilege('anon', 'public.ask_attempts', 'insert')
  and (select relrowsecurity from pg_class where oid = 'public.questions'::regclass) and (select relrowsecurity from pg_class where oid = 'public.ask_attempts'::regclass));
select t.chk('ask: grants of the functions as ai_alt (anon and authenticated, never public); ask_take_slot not for anon',
  has_function_privilege('anon', 'public.ai_ask_list()', 'execute') and has_function_privilege('authenticated', 'public.ai_ask_set(uuid, text, jsonb)', 'execute')
  and has_function_privilege('anon', 'public.ai_ask_fail(uuid, text)', 'execute') and not has_function_privilege('anon', 'public.ask_take_slot()', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name like 'ai_ask%' and grantee = 'PUBLIC'));

set role anon;
select t.chk('ask: anon cannot read or write questions', t.denied('select * from public.questions') and t.denied($$insert into public.questions (question) values ('hej hej hej')$$));
reset role;
set role authenticated;
select t.asX();
select t.chk('ask: a signed-in stranger (not allowed) sees nothing and cannot insert', (select count(*) = 0 from public.questions) and t.ask('Robotstøvsuger til hund') like '42501%');
select t.asA();
select t.chk('ask: A asks', t.ask('  Robotstøvsuger   til lejlighed med hund, højst 3.000 kr.  ') = 'ok');
select t.chk('ask: ... stored trimmed, single spaces, pending, own, server time, AI columns empty',
  (select question = 'Robotstøvsuger til lejlighed med hund, højst 3.000 kr.' and status = 'pending' and user_id = '00000000-0000-0000-0000-0000000000a1'
      and summary is null and picks is null and note is null and answered_at is null and abs(extract(epoch from now() - created_at)) < 60 and list_id is null from public.questions));
select t.chk('ask: control characters and angle brackets are cleaned', t.ask('Kaffe' || chr(10) || 'maskine <b>til</b>' || chr(7) || ' kontor') = 'ok');
select t.chk('ask: ... and not stored', (select count(*) = 1 from public.questions where question = 'Kaffe maskine b til /b kontor'));
reset role;
delete from public.questions; delete from public.ask_attempts;
set role authenticated;
select t.asA();
select t.chk('ask: too short (after cleaning) or empty: a clear Danish error', t.ask('abcd') = '23514 Skriv mindst 5 tegn.' and t.ask('   ') like '23514 Skriv mindst%' and t.ask('<><><>') like '23514 Skriv mindst%' and t.ask(null) like '23514 Skriv mindst%');
reset role;
delete from public.questions; delete from public.ask_attempts;
set role authenticated;
select t.asA();
select t.chk('ask: 300 characters are fine, longer is cut at 300', t.ask(repeat('a', 300)) = 'ok' and t.ask(repeat('b', 400)) = 'ok');
select t.chk('ask: ... as stored', (select count(*) = 1 from public.questions where question = repeat('b', 300)) and (select count(*) = 1 from public.questions where question = repeat('a', 300)));
reset role;
delete from public.questions; delete from public.ask_attempts;
set role authenticated;
select t.asA();
select t.chk('ask: the browser cannot set the AI columns, the status, the time (on insert), and cannot insert for someone else',
  t.err($$insert into public.questions (question, status, summary, picks, note, answered_at, created_at) values ('Hylde til garage', 'done', 'x', '[1]', 'n', now(), now() - interval '3 days')$$) = 'ok1');
select t.chk('ask: ... as stored, and nobody else as owner',
  (select status = 'pending' and summary is null and picks is null and note is null and answered_at is null and created_at > now() - interval '1 minute' from public.questions where question = 'Hylde til garage')
  and t.err($$insert into public.questions (user_id, question) values ('00000000-0000-0000-0000-0000000000b2', 'Fars spørgsmål')$$) like '%row-level security%');
select t.chk('ask: no browser UPDATE at all (privilege)', t.denied($$update public.questions set question = 'noget andet her' where true$$) and t.denied($$update public.questions set status = 'done' where true$$));
reset role;
delete from public.questions; delete from public.ask_attempts;

-- lists and isolation
set role authenticated;
select t.asA();
select t.chk('ask: a list: the person''s own is accepted; another person''s or an unknown one is refused',
  t.ask('Hvilken støvsuger', '00000000-0000-0000-0000-00000000aa0d') = 'ok'
  and t.ask('Hvilken kaffemaskine', '00000000-0000-0000-0000-00000000aa0e') = '23503 Listen findes ikke.'
  and t.ask('Hvilken printer', '00000000-0000-0000-0000-0000deadbeef') = '23503 Listen findes ikke.');
select t.asB();
select t.chk('ask: B (a member of A''s list) can ask into it', t.ask('Hvilken ovn', '00000000-0000-0000-0000-00000000aa0d') = 'ok');
select t.chk('ask: ... and does not see A''s question', (select count(*) = 1 and bool_and(question = 'Hvilken ovn') from public.questions));
select t.asC();
select t.chk('ask: C (not a member) cannot use A''s list; C sees none of the others'' questions', t.ask('Hvilken ovn', '00000000-0000-0000-0000-00000000aa0d') = '23503 Listen findes ikke.' and (select count(*) = 0 from public.questions));
select t.asB();
select t.chk('ask: B cannot delete A''s question (nothing deleted), can delete own',
  t.err($$delete from public.questions where question = 'Hvilken støvsuger'$$) = 'ok0' and t.err($$delete from public.questions where question = 'Hvilken ovn'$$) = 'ok1');
select t.asA();
select t.chk('ask: A still has the question', (select count(*) = 1 from public.questions where question = 'Hvilken støvsuger'));
reset role;
delete from public.lists where id = '00000000-0000-0000-0000-00000000aa0d';
select t.chk('ask: deleting the list keeps the question, list_id null', (select list_id is null from public.questions where question = 'Hvilken støvsuger'));
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa0d', '00000000-0000-0000-0000-0000000000a1', 'Ask A');
delete from public.questions; delete from public.ask_attempts;

-- the limits
set role authenticated;
select t.asA();
select t.chk('ask: limit: three pending at a time; the fourth is refused with a clear message',
  t.ask('Spørgsmål nummer et') = 'ok' and t.ask('Spørgsmål nummer to') = 'ok' and t.ask('Spørgsmål nummer tre') = 'ok'
  and t.ask('Spørgsmål nummer fire') = '23514 Der er allerede 3 spørgsmål i gang. Vent på svar.');
select t.chk('ask: ... a refused question leaves nothing (no row, no log entry)', (select count(*) = 3 from public.questions));
reset role;
select t.chk('ask: ... the log has the three that were accepted', (select count(*) = 3 from public.ask_attempts where user_id = '00000000-0000-0000-0000-0000000000a1'));
select t.tok(repeat('a', 64));
set role anon;
select public.ai_ask_fail(t.qid('Spørgsmål nummer et'), 'x') and public.ai_ask_fail(t.qid('Spørgsmål nummer to'), 'x');
reset role;
set role authenticated;
select t.asA();
select t.chk('ask: limit: five a day: the fourth and fifth are fine once answers are in',
  t.ask('Spørgsmål nummer fire') = 'ok' and t.ask('Spørgsmål nummer fem') = 'ok');
select t.chk('ask: limit: the sixth in 24 hours says "Du kan stille 5 spørgsmål i døgnet."', t.ask('Spørgsmål nummer seks') = '23514 Du kan stille 5 spørgsmål i døgnet.');
select t.chk('ask: ... removing questions does not give slots back', t.err($$delete from public.questions$$) = 'ok5' and t.ask('Spørgsmål nummer seks') = '23514 Du kan stille 5 spørgsmål i døgnet.');
select t.asB();
select t.chk('ask: ... B has a limit of their own', t.ask('Fars spørgsmål') = 'ok');
reset role;
select t.alog(25);
set role authenticated;
select t.asA();
select t.chk('ask: ... after 24 hours the slots are back', t.ask('Spørgsmål nummer seks') = 'ok');
reset role;
select t.alog(49);
set role authenticated;
select t.asA();
select t.chk('ask: ... log rows older than 2 days are cleaned on the next question', t.ask('Spørgsmål nummer syv') = 'ok');
reset role;
select t.chk('ask: ... only the new row is left for A', (select count(*) = 1 from public.ask_attempts where user_id = '00000000-0000-0000-0000-0000000000a1'));
delete from public.questions; delete from public.ask_attempts;
-- a pending question that has waited more than 6 hours no longer counts as pending (the page calls it failed)
set role authenticated;
select t.asA();
select t.ask('Gammelt et') = 'ok' and t.ask('Gammelt to') = 'ok' and t.ask('Gammelt tre') = 'ok';
reset role;
select t.qage(7);
set role authenticated;
select t.asA();
select t.chk('ask: limit: three pending that are more than 6 hours old do not block a new question', t.ask('Nyt spørgsmål efter svigt') = 'ok');
reset role;
delete from public.questions; delete from public.ask_attempts;
-- 30 stored
insert into public.questions (user_id, question, status, summary, picks, answered_at)
  select '00000000-0000-0000-0000-0000000000a1', 'Gemt spørgsmål nr ' || g, 'done', 'Kort svar.', '[]', now() from generate_series(1, 30) g;
set role authenticated;
select t.asA();
select t.chk('ask: limit: at most 30 stored per person, with a clear message; nothing is deleted automatically',
  t.ask('Spørgsmål nummer 31') = '23514 Du kan gemme 30 spørgsmål. Fjern et først.' and (select count(*) = 30 from public.questions));
select t.chk('ask: ... removing one makes room', t.err($$delete from public.questions where question = 'Gemt spørgsmål nr 1'$$) = 'ok1' and t.ask('Spørgsmål nummer 31') = 'ok');
select t.asB();
select t.chk('ask: ... B is not affected by A''s 30', t.ask('Fars spørgsmål') = 'ok');
reset role;
set role authenticated;
select t.asA();
select t.chk('ask: ask_take_slot is no RPC: refused outside a trigger (and anon has no right to it)', t.err($$select public.ask_take_slot()$$) = 'not allowed');
reset role;
delete from public.questions; delete from public.ask_attempts;

-- the service role and the SQL editor are not restricted by the limits, but the text is still cleaned
insert into public.questions (user_id, question, status, summary, picks, answered_at)
  select '00000000-0000-0000-0000-0000000000a1', 'Service spørgsmål ' || g || '<x>', 'done', 'Kort svar.', '[]', now() from generate_series(1, 7) g;
select t.chk('ask: the owner role: no limits, the guard still cleans the text and keeps the AI columns it was given',
  (select count(*) = 7 and bool_and(question ~ '^Service spørgsmål [0-9] x$') and bool_and(status = 'done') from public.questions));
select t.chk('ask: a question must be 5 to 300 characters, trimmed, without angle brackets also by constraint',
  t.err($$update public.questions set question = 'ab' where true$$) like '%questions_question_check%' and t.err($$update public.questions set question = ' ab cdef ' where true$$) like '%questions_question_check%'
  and t.err($$update public.questions set question = 'ab<cdef' where true$$) like '%questions_question_check%' and t.err($$update public.questions set status = 'x' where true$$) like '%status%'
  and t.err($$update public.questions set summary = repeat('x', 601) where true$$) like '%summary%' and t.err($$update public.questions set note = repeat('x', 201) where true$$) like '%note%'
  and t.err($$update public.questions set picks = '{}' where true$$) like '%picks%' and t.err($$update public.questions set picks = '[1,2,3,4,5,6]' where true$$) like '%picks%');
delete from public.questions; delete from public.ask_attempts;

-- the AI agent's functions
insert into public.questions (user_id, question, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'Fjerde ældste', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000a1', 'Sæt-test spørgsmål', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-0000000000b2', 'Ældste spørgsmål', now() - interval '9 hours'),
  ('00000000-0000-0000-0000-0000000000a1', 'Tredje ældste', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000a1', 'Allerede besvaret', now() - interval '10 hours');
update public.questions set status = 'done', summary = 'x', picks = '[]', answered_at = now() where question = 'Allerede besvaret';
create function t.ccnt() returns text language plpgsql as $$ begin return (select count(*) from public.ai_ask_list())::text; exception when others then return sqlerrm; end $$;
create function t.pickb() returns jsonb language sql as $$
  select '{"name":"Roborock Q Revo","url":"https://prisjagt.dk/product.php?p=12345","store":"Elgiganten","price":2999,"was":3999,"why":"God til hundehår."}'::jsonb $$;
create function t.picks(patch jsonb, drop_key text default null) returns jsonb language sql as $$
  select jsonb_build_array((t.pickb() || coalesce(patch, '{}'::jsonb)) - coalesce(drop_key, '')) $$;
create function t.kset(summ text, p jsonb) returns text language plpgsql as $$
begin return public.ai_ask_set(t.qid('Sæt-test spørgsmål'), summ, p)::text; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function t.ccnt(), t.pickb(), t.picks(jsonb, text), t.kset(text, jsonb) to public;

select t.chk('ai_ask: list takes the resolver token: none, empty, wrong, a prefix: all refused (anon and signed in); set and fail too', (
  select bool_and(r) from (
    select t.ccnt() = 'resolver: invalid or missing token' as r from (select t.tok(null)) x union all
    select t.ccnt() = 'resolver: invalid or missing token' from (select t.tok('')) x union all
    select t.ccnt() = 'resolver: invalid or missing token' from (select t.tok('fel')) x union all
    select t.ccnt() = 'resolver: invalid or missing token' from (select t.tok(repeat('a', 63))) x) y));
set role anon;
select t.tok(null);
select t.chk('ai_ask: anon without a token: refused with 42501, also set and fail',
  t.err($$select * from public.ai_ask_list()$$) = 'resolver: invalid or missing token'
  and t.err(format($$select public.ai_ask_set(%L, 'Svar.', %L)$$, t.qid('Sæt-test spørgsmål'), t.picks(null))) = 'resolver: invalid or missing token'
  and t.err(format($$select public.ai_ask_fail(%L, 'x')$$, t.qid('Sæt-test spørgsmål'))) = 'resolver: invalid or missing token');
do $$ begin perform public.ai_ask_list(); raise exception 'no error'; exception when sqlstate '42501' then null; end $$;
reset role;
set role authenticated;
select t.asA();
select t.chk('ai_ask: ... and as a signed-in user without the token', t.ccnt() = 'resolver: invalid or missing token'
  and t.err(format($$select public.ai_ask_fail(%L, 'x')$$, t.qid('Sæt-test spørgsmål'))) = 'resolver: invalid or missing token');
reset role;
select t.chk('ai_ask: nothing was changed by the refused calls', (select count(*) = 4 from public.questions where status = 'pending'));

select t.tok(repeat('a', 64));
set role anon;
select t.chk('ai_ask: list: at most 3, oldest first, only pending (of all people, nothing about them)',
  t.ccnt() = '3' and (select array_agg(question order by asked_at, id) from public.ai_ask_list()) = array['Ældste spørgsmål', 'Sæt-test spørgsmål', 'Tredje ældste']
  and (select array_agg(question) from public.ai_ask_list()) = array['Ældste spørgsmål', 'Sæt-test spørgsmål', 'Tredje ældste']);
select t.chk('ai_ask: list: the columns are exactly id, question, asked_at, and nothing identifies the person',
  (select proargnames from pg_proc where proname = 'ai_ask_list') = array['id', 'question', 'asked_at']
  and (select to_jsonb(l)::text !~ '(@|user|list_id|0000-0000-0000-0000-0000000000)' from public.ai_ask_list() l limit 1));
-- set
select t.chk('ai_ask: set: summary missing, empty, blank, over 600, or with control characters, a line break, a tab or angle brackets',
  t.kset(null, t.picks(null)) like '22023%' and t.kset('', t.picks(null)) like '22023%summary must be 1 to 600%' and t.kset('   ', t.picks(null)) like '22023%'
  and t.kset(repeat('x', 601), t.picks(null)) like '22023%' and t.kset('a' || chr(10) || 'b', t.picks(null)) like '22023%control characters%'
  and t.kset('a' || chr(9) || 'b', t.picks(null)) like '22023%' and t.kset('a' || chr(7) || 'b', t.picks(null)) like '22023%' and t.kset('a<b', t.picks(null)) like '22023%' and t.kset('a>b', t.picks(null)) like '22023%'
  and t.kset('<b>fed</b>', t.picks(null)) like '22023%' and t.kset('a' || chr(8238) || 'b', t.picks(null)) like '22023%' and t.kset('a' || chr(8203) || 'b', t.picks(null)) like '22023%');
select t.chk('ai_ask: set: picks: not an array, empty, 6 items, items that are not objects',
  t.kset('Svar.', '{"a":1}') like '22023 ai_ask: picks must be%' and t.kset('Svar.', '[]') like '22023%' and t.kset('Svar.', null) like '22023%' and t.kset('Svar.', '"x"') like '22023%'
  and t.kset('Svar.', (select jsonb_agg(t.pickb()) from generate_series(1, 6))) like '22023%' and t.kset('Svar.', '[1]') like '22023 ai_ask: pick 1: not an object' and t.kset('Svar.', '[null]') like '22023%');
select t.chk('ai_ask: set: five picks are the most that is accepted (checked below)', t.kset('Svar.', (select jsonb_agg(t.pickb()) from generate_series(1, 5))) = 'true');
reset role;
select t.qpend('Sæt-test spørgsmål');
set role anon;
select t.chk('ai_ask: set: extra key (also "kind", which ai_alt has), and every required key missing or null',
  t.kset('Svar.', t.picks('{"extra":1}')) like '22023 ai_ask: pick 1: unknown key extra' and t.kset('Svar.', t.picks('{"kind":"deal"}')) like '22023%unknown key kind'
  and t.kset('Svar.', t.picks(null, 'name')) like '%name is missing' and t.kset('Svar.', t.picks(null, 'url')) like '%url is missing'
  and t.kset('Svar.', t.picks(null, 'store')) like '%store is missing' and t.kset('Svar.', t.picks(null, 'price')) like '%price is missing' and t.kset('Svar.', t.picks(null, 'why')) like '%why is missing'
  and t.kset('Svar.', t.picks('{"name":null}')) like '%name is missing');
select t.chk('ai_ask: set: name 1-120, store 1-60, why 1-160 characters',
  t.kset('Svar.', t.picks('{"name":""}')) like '%name is not valid' and t.kset('Svar.', t.picks('{"name":"   "}')) like '%name is not valid'
  and t.kset('Svar.', t.picks(jsonb_build_object('name', repeat('x', 121)))) like '%name is not valid' and t.kset('Svar.', t.picks('{"name":5}')) like '%name must be a string'
  and t.kset('Svar.', t.picks(jsonb_build_object('store', repeat('x', 61)))) like '%store is not valid' and t.kset('Svar.', t.picks('{"store":""}')) like '%store is not valid'
  and t.kset('Svar.', t.picks(jsonb_build_object('why', repeat('x', 161)))) like '%why is not valid' and t.kset('Svar.', t.picks('{"why":""}')) like '%why is not valid');
select t.chk('ai_ask: set: url must be https like products.source_url (no http, port, user:password@, dotless host, space, javascript:, 501 characters)',
  t.kset('Svar.', t.picks('{"url":"http://shop.dk/x"}')) like '%url is not valid' and t.kset('Svar.', t.picks('{"url":"https://shop.dk:8443/x"}')) like '%url is not valid'
  and t.kset('Svar.', t.picks('{"url":"https://u:p@shop.dk/x"}')) like '%url is not valid' and t.kset('Svar.', t.picks('{"url":"https://localhost/x"}')) like '%url is not valid'
  and t.kset('Svar.', t.picks('{"url":"https://shop.dk/a b"}')) like '%url is not valid' and t.kset('Svar.', t.picks('{"url":"javascript:alert(1)"}')) like '%url is not valid'
  and t.kset('Svar.', t.picks(jsonb_build_object('url', 'https://shop.dk/' || repeat('a', 485)))) like '%url is not valid' and t.kset('Svar.', t.picks('{"url":""}')) like '%url is not valid'
  and t.kset('Svar.', t.picks('{"url":7}')) like '%url must be a string');
select t.chk('ai_ask: set: text with control characters, newlines, tabs, angle brackets or invisible direction marks is refused in every pick field', (
  select bool_and(t.kset('Svar.', t.picks(jsonb_build_object(f, v))) like '22023%')
    from (values ('name'), ('store'), ('why'), ('url')) a(f),
         (values ('a' || chr(10) || 'b'), ('a' || chr(9) || 'b'), ('a' || chr(7) || 'b'), ('a<b'), ('a>b'), ('<script>x</script>'), ('a' || chr(8238) || 'b'), ('a' || chr(8203) || 'b'), ('a' || chr(65279) || 'b'), ('a' || chr(8232) || 'b')) b(v)));
select t.chk('ai_ask: set: price must be a number above 0 and below 10 million',
  t.kset('Svar.', t.picks('{"price":0}')) like '%price must be above 0%' and t.kset('Svar.', t.picks('{"price":-5}')) like '%price must be above 0%' and t.kset('Svar.', t.picks('{"price":"12"}')) like '%price must be a number'
  and t.kset('Svar.', t.picks('{"price":10000000}')) like '%price must be above 0%' and t.kset('Svar.', t.picks('{"price":0.001}')) like '%price must be above 0%' and t.kset('Svar.', t.picks('{"price":true}')) like '%price must be a number');
select t.chk('ai_ask: set: was must be a number above price (null counts as absent) and below 10 million',
  t.kset('Svar.', t.picks('{"was":2999}')) like '%was must be above price%' and t.kset('Svar.', t.picks('{"was":1000}')) like '%was must be above price%' and t.kset('Svar.', t.picks('{"was":"3999"}')) like '%was must be a number'
  and t.kset('Svar.', t.picks('{"was":10000000}')) like '%was must be above price%' and t.kset('Svar.', t.picks('{"was":2999.001}')) like '%was must be above price%');
select t.chk('ai_ask: set: nothing was stored by any refused call', t.q($$select (status = 'pending' and summary is null and picks is null and answered_at is null)::text from public.questions where question = 'Sæt-test spørgsmål'$$) = 'true');
select t.chk('ai_ask: set: unknown id and a question that is not pending: false', public.ai_ask_set('00000000-0000-0000-0000-000000000000', 'Svar.', t.picks(null)) = false
  and public.ai_ask_set(t.qid('Allerede besvaret'), 'Nyt svar.', t.picks(null)) = false and t.q($$select summary from public.questions where question = 'Allerede besvaret'$$) = 'x');
-- a good answer, with a question that has waited more than 6 hours (it can still be answered)
select t.chk('ai_ask: set: a good answer returns true (also for a question that waited more than 6 hours)',
  (select count(*) = 1 from public.ai_ask_list() where question = 'Sæt-test spørgsmål') and
  t.kset('  Roborock passer bedst til hundehår.  ', t.picks('{"name":"  Roborock Q Revo  ","price":2999.456,"why":" Børster mod hår. "}')) = 'true');
reset role;
select t.chk('ai_ask: set: stored as a cleaned copy (trimmed, rounded), status done, answered_at now, note null',
  (select status = 'done' and summary = 'Roborock passer bedst til hundehår.' and note is null and abs(extract(epoch from now() - answered_at)) < 60
      and picks = '[{"name":"Roborock Q Revo","url":"https://prisjagt.dk/product.php?p=12345","store":"Elgiganten","price":2999.46,"was":3999,"why":"Børster mod hår."}]'::jsonb
    from public.questions where question = 'Sæt-test spørgsmål'));
set role anon;
select t.chk('ai_ask: set: the answer is given once: no longer pending, false, nothing changes, and it is gone from the list',
  t.kset('Andet svar.', t.picks(null)) = 'false' and t.q($$select (summary like 'Roborock%')::text from public.questions where question = 'Sæt-test spørgsmål'$$) = 'true'
  and (select count(*) = 0 from public.ai_ask_list() where question = 'Sæt-test spørgsmål'));
select t.chk('ai_ask: set: a 600-character summary and a pick without "was" (or with it null) are fine', (select public.ai_ask_set(t.qid('Fjerde ældste'), repeat('x', 600), jsonb_build_array(t.pickb() - 'was', t.pickb() || '{"was":null}')))
  and t.q($$select (char_length(summary) = 600 and not (picks -> 0) ? 'was' and not (picks -> 1) ? 'was')::text from public.questions where question = 'Fjerde ældste'$$) = 'true');
-- fail
select t.chk('ai_ask: fail: stores the note (trimmed), status failed, no picks, answered_at now',
  public.ai_ask_fail(t.qid('Tredje ældste'), '  Ikke et spørgsmål om en vare.  '));
select t.chk('ai_ask: fail: not pending any more: false, nothing changes', not public.ai_ask_fail(t.qid('Tredje ældste'), 'igen') and not public.ai_ask_fail(t.qid('Sæt-test spørgsmål'), 'x')
  and not public.ai_ask_fail('00000000-0000-0000-0000-000000000000', 'x'));
reset role;
select t.chk('ai_ask: fail: the stored row', (select status = 'failed' and note = 'Ikke et spørgsmål om en vare.' and summary is null and picks is null and abs(extract(epoch from now() - answered_at)) < 60 from public.questions where question = 'Tredje ældste'));
select t.qpend('Tredje ældste');
set role anon;
select public.ai_ask_fail(t.qid('Tredje ældste'), repeat('x', 300));
reset role;
select t.chk('ai_ask: fail: cut at 200 characters', (select char_length(note) = 200 from public.questions where question = 'Tredje ældste'));
select t.qpend('Tredje ældste');
set role anon;
select public.ai_ask_fail(t.qid('Tredje ældste'), 'a' || chr(10) || '<b>fed</b>' || chr(7) || 'b');
reset role;
select t.chk('ai_ask: fail: control characters and angle brackets removed', (select note = 'a b fed /b b' from public.questions where question = 'Tredje ældste'));
select t.qpend('Tredje ældste');
set role anon;
select public.ai_ask_fail(t.qid('Tredje ældste'), '   ');
reset role;
select t.chk('ai_ask: fail: an empty note gives a plain sentence', (select note = 'Kunne ikke finde et svar.' from public.questions where question = 'Tredje ældste'));
select t.qpend('Tredje ældste');
set role anon;
select public.ai_ask_fail(t.qid('Tredje ældste'), null);
reset role;
select t.chk('ai_ask: fail: a null note gives the same sentence', (select note = 'Kunne ikke finde et svar.' from public.questions where question = 'Tredje ældste'));
-- the person reads the answer, nobody else does
set role authenticated;
select t.asA();
select t.chk('e2e: A reads the answer (summary and picks), and cannot change it', (select summary like 'Roborock%' and picks -> 0 ->> 'name' = 'Roborock Q Revo' from public.questions where question = 'Sæt-test spørgsmål')
  and t.denied($$update public.questions set summary = 'mit eget svar' where true$$));
select t.asB();
select t.chk('e2e: B does not see A''s questions (but the own one)', (select count(*) = 1 and bool_and(question = 'Ældste spørgsmål') from public.questions));
select t.asC();
select t.chk('e2e: C sees none', (select count(*) = 0 from public.questions));
reset role;
select t.tok(null);
delete from public.questions; delete from public.ask_attempts;
delete from public.lists where id in ('00000000-0000-0000-0000-00000000aa0d', '00000000-0000-0000-0000-00000000aa0e');
select set_config('request.jwt.claims', '', false);

-- 11h. "Mente du": name_options, resolver_suggest, the queue, the guard (browser, member) and the re-queue after a new name
delete from public.products;
update public.resolver_secret set token = repeat('a', 64);
select t.tok(repeat('a', 64));
insert into public.lists (id, user_id, name) values ('00000000-0000-0000-0000-00000000aa0f', '00000000-0000-0000-0000-0000000000a1', 'Mente');
insert into public.list_members (list_id, user_id) values ('00000000-0000-0000-0000-00000000aa0f', '00000000-0000-0000-0000-0000000000b2') on conflict do nothing;
create function t.sg(n text, o jsonb) returns text language plpgsql as $$
begin return public.resolver_suggest(t.pid(n), o)::text; exception when others then return 'error ' || sqlstate || ' ' || sqlerrm; end $$;
create function t.opt(n text) returns jsonb language sql security definer as $$ select name_options from public.products where name = n $$;
create function t.queue() returns text language plpgsql as $$
begin return (select coalesce(string_agg(name, ',' order by name), '') from public.resolver_list() where kind = 'name'); exception when others then return sqlerrm; end $$;
create function t.pst(n text) returns text language sql security definer as $$ select status || '|' || coalesce(check_note, '-') || '|' || coalesce(source_url, '-') || '|' || (name_options is not null)::text from public.products where name = n $$;
grant execute on function t.sg(text, jsonb), t.opt(text), t.queue(), t.pst(text) to public;
select t.chk('mente: the column, the helper, the check and the function exist; grants as the other resolver functions',
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'name_options' and data_type = 'jsonb')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_name_options_check')
  and has_function_privilege('anon', 'public.resolver_suggest(uuid, jsonb)', 'execute') and has_function_privilege('authenticated', 'public.resolver_suggest(uuid, jsonb)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges where routine_name = 'resolver_suggest' and grantee = 'PUBLIC'));

-- A adds three products by name (one in a list shared with B), and one with a link
set role authenticated;
select t.asA();
insert into public.products (name, target_type, list_id) values ('airfryer fra philips', 'auto', '00000000-0000-0000-0000-00000000aa0f');
insert into public.products (name, target_type) values ('sony hovedtelefoner', 'auto');
insert into public.products (name, target_type) values ('tredje navn', 'auto');
insert into public.products (name, source_url, target_type) values ('med link', 'https://shop.example.dk/a', 'auto');
select t.chk('mente: a browser insert cannot preset name_options', t.try($$insert into public.products (name, target_type, name_options) values ('snyd', 'auto', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]')$$) = 'ok'
  and t.opt('snyd') is null);
delete from public.products where name = 'snyd';
reset role;
set role anon;
select t.chk('mente: the three name-only products are in the queue, the one with a link is not', t.queue() = 'airfryer fra philips,sony hovedtelefoner,tredje navn');
-- validation: every bad call is an error naming the option, nothing is stored
select t.tok('fel');
select t.chk('mente: needs the token', t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like '%invalid or missing token%'
  and t.opt('airfryer fra philips') is null);
select t.tok(null);
select t.chk('mente: ... and without a token header', t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like '%invalid or missing token%');
select t.tok(repeat('a', 64));
select t.chk('mente: not an array, null, json null, one option, five options are refused',
  t.sg('airfryer fra philips', '{"name":"a"}') like 'error 22023%' and t.sg('airfryer fra philips', null) like 'error 22023%' and t.sg('airfryer fra philips', 'null'::jsonb) like 'error 22023%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a"}]') like 'error 22023%options must hold 2 to 4%'
  and t.sg('airfryer fra philips', '[]') like 'error 22023%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://s.dk/1"},{"name":"b","url":"https://s.dk/2"},{"name":"c","url":"https://s.dk/3"},{"name":"d","url":"https://s.dk/4"},{"name":"e","url":"https://s.dk/5"}]') like 'error 22023%2 to 4%');
select t.chk('mente: an entry that is not an object, an unknown key, a missing name or url are refused',
  t.sg('airfryer fra philips', '["x", {"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1 is not an object'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","why":"fordi"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: unknown key why'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a"},{"url":"https://shop.example.dk/b"}]') like 'error 22023%option 2: name is missing'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b"}]') like 'error 22023%option 2: url is missing'
  and t.sg('airfryer fra philips', '[{"name":"a","url":null},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: url is missing');
select t.chk('mente: text rules: empty, 121 characters, angle brackets, control characters, direction marks, a store over 60 or empty, not a string',
  t.sg('airfryer fra philips', '[{"name":"  ","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: name is not valid'
  and t.sg('airfryer fra philips', jsonb_build_array(jsonb_build_object('name', repeat('a', 121), 'url', 'https://shop.example.dk/a'), jsonb_build_object('name', 'b', 'url', 'https://shop.example.dk/b'))) like 'error 22023%option 1: name is not valid'
  and t.sg('airfryer fra philips', '[{"name":"a<b>","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: name has control characters or angle brackets'
  and t.sg('airfryer fra philips', jsonb_build_array(jsonb_build_object('name', 'a' || chr(10) || 'b', 'url', 'https://shop.example.dk/a'), jsonb_build_object('name', 'b', 'url', 'https://shop.example.dk/b'))) like 'error 22023%control characters%'
  and t.sg('airfryer fra philips', jsonb_build_array(jsonb_build_object('name', 'a' || chr(8238) || 'b', 'url', 'https://shop.example.dk/a'), jsonb_build_object('name', 'b', 'url', 'https://shop.example.dk/b'))) like 'error 22023%control characters%'
  and t.sg('airfryer fra philips', jsonb_build_array(jsonb_build_object('name', 'a', 'url', 'https://shop.example.dk/a', 'store', repeat('s', 61)), jsonb_build_object('name', 'b', 'url', 'https://shop.example.dk/b'))) like 'error 22023%option 1: store is not valid'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","store":""},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: store is not valid'
  and t.sg('airfryer fra philips', '[{"name":7,"url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: name must be a string');
select t.chk('mente: prices: zero, negative, text, 10 million, boolean are refused',
  t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","price":0},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: price must be above 0%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","price":-5},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%price must be above 0%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","price":"12"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%price must be a number'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","price":10000000},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%price must be above 0%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","price":true},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%price must be a number'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a","price":0.001},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%price must be above 0%');
select t.chk('mente: urls: http, port, spaces, no dot, a prisjagt search or other prisjagt page, extra query, over 500, duplicates (also with www and case) are refused',
  t.sg('airfryer fra philips', '[{"name":"a","url":"http://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: url is not a usable https link'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk:8443/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%url is not a usable https link'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/en vare"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%url is not a usable https link'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://localhost/a"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%url is not a usable https link'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://prisjagt.dk/search?search=airfryer"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%option 1: a prisjagt.dk link must be exactly%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://www.prisjagt.dk/product.php?p=12&x=1"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%a prisjagt.dk link must be exactly%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://prisjagt.dk/product.php?p=abc"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%a prisjagt.dk link must be exactly%'
  and t.sg('airfryer fra philips', jsonb_build_array(jsonb_build_object('name', 'a', 'url', 'https://shop.example.dk/' || repeat('a', 480)), jsonb_build_object('name', 'b', 'url', 'https://shop.example.dk/b'))) like 'error 22023%url is not a usable https link'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://prisjagt.dk/product.php?p=12"},{"name":"b","url":"https://www.prisjagt.dk/product.php?p=12"}]') like 'error 22023%option 2: the same url as another option'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/A"},{"name":"b","url":"https://shop.example.dk/a"}]') like 'error 22023%the same url%'
  and t.sg('airfryer fra philips', '[{"name":"a","url":"javascript:alert(1)"},{"name":"b","url":"https://shop.example.dk/b"}]') like 'error 22023%url is not a usable https link');
select t.chk('mente: after all that nothing is stored and the product is still in the queue', t.opt('airfryer fra philips') is null and t.pst('airfryer fra philips') = 'pending|-|-|false' and t.queue() like 'airfryer fra philips%');

-- a good call: cleaned copy, the product leaves the queue, source_url stays null
select t.chk('mente: a good call returns true',
  t.sg('airfryer fra philips', '[{"name":"  Philips Airfryer HD9270/90  ","url":"https://www.prisjagt.dk/product.php?p=1234567","price":1299.499,"store":" Proshop "},{"name":"Philips Airfryer 3000","url":"https://shop.example.dk/philips-3000","price":null},{"name":"Philips Airfryer XXL","url":"https://prisjagt.dk/product.php?p=777","store":null}]') = 'true');
select t.chk('mente: ... stored cleaned (trimmed, www dropped, price rounded, null keys left out), in the given order',
  t.opt('airfryer fra philips') = '[{"name":"Philips Airfryer HD9270/90","url":"https://prisjagt.dk/product.php?p=1234567","price":1299.50,"store":"Proshop"},{"name":"Philips Airfryer 3000","url":"https://shop.example.dk/philips-3000"},{"name":"Philips Airfryer XXL","url":"https://prisjagt.dk/product.php?p=777"}]'::jsonb);
select t.chk('mente: ... source_url stays null, status pending, and the row is out of the queue', t.pst('airfryer fra philips') = 'pending|-|-|true' and t.queue() = 'sony hovedtelefoner,tredje navn');
select t.chk('mente: a second call finds the product not waiting (false), also a good one', t.sg('airfryer fra philips', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') = 'false'
  and t.opt('airfryer fra philips') -> 0 ->> 'name' = 'Philips Airfryer HD9270/90');
select t.chk('mente: a bad shape is an error even for a product that is not waiting', t.sg('airfryer fra philips', '[{"name":"a"}]') like 'error 22023%');
select t.chk('mente: a product with a link, an unknown id: false', t.sg('med link', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') = 'false'
  and public.resolver_suggest('00000000-0000-0000-0000-00000000dead', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') = false);
reset role;
update public.products set status = 'error', check_note = 'x' where name = 'tredje navn';
set role anon;
select t.chk('mente: a failed product is not waiting: false', t.sg('tredje navn', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') = 'false');
reset role;
update public.products set status = 'pending', check_note = null where name = 'tredje navn';

-- the browser: cannot write the options, choosing a link clears them, a new name clears and re-queues
set role authenticated;
select t.asA();
select t.chk('mente: A sees the options of the own product', (select jsonb_array_length(name_options) = 3 from public.products where name = 'airfryer fra philips'));
update public.products set name_options = null where name = 'airfryer fra philips';
select t.chk('mente: A cannot clear the options (ignored)', t.opt('airfryer fra philips') is not null);
update public.products set name_options = '[{"name":"x","url":"https://shop.example.dk/x"},{"name":"y","url":"https://shop.example.dk/y"}]' where name = 'airfryer fra philips';
select t.chk('mente: ... nor replace them (ignored)', t.opt('airfryer fra philips') -> 0 ->> 'name' = 'Philips Airfryer HD9270/90');
update public.products set target_value = null, shops_only = false where name = 'airfryer fra philips';
select t.chk('mente: other edits leave the options and the status alone', t.pst('airfryer fra philips') = 'pending|-|-|true');
reset role;
-- B is a member of the shared list: reads, cannot touch
set role authenticated;
select t.asB();
select t.chk('mente: B (a member) sees the options', (select jsonb_array_length(name_options) = 3 from public.products where name = 'airfryer fra philips'));
select t.chk('mente: B cannot change the options, the name or the link of A''s product (check violation each)',
  t.try($$update public.products set name_options = null where name = 'airfryer fra philips'$$) = 'check'
  and t.try($$update public.products set name = 'andet navn' where name = 'airfryer fra philips'$$) = 'check'
  and t.try($$update public.products set source_url = 'https://shop.example.dk/x' where name = 'airfryer fra philips'$$) = 'check'
  and t.pst('airfryer fra philips') = 'pending|-|-|true');
select t.chk('mente: B may still mark it bought (the options stay)',
  t.try($$update public.products set bought_at = now() where name = 'airfryer fra philips'$$) = 'ok' and t.pst('airfryer fra philips') = 'pending|-|-|true');
update public.products set bought_at = null, bought_price = null where name = 'airfryer fra philips';
reset role;
set role anon;
select t.chk('mente: anon sees no products', t.denied('select * from public.products'));
reset role;
-- A chooses an option: the link is set through the ordinary path, the options are gone, the product starts as a new link
set role authenticated;
select t.asA();
update public.products set source_url = 'https://prisjagt.dk/product.php?p=1234567' where name = 'airfryer fra philips';
select t.chk('mente: A sets source_url to an option: options gone, status pending, name unchanged', t.pst('airfryer fra philips') = 'pending|-|https://prisjagt.dk/product.php?p=1234567|false'
  and (select name = 'airfryer fra philips' from public.products where name = 'airfryer fra philips'));
reset role;
-- "Ingen af dem": a new name clears the options, the failure note and re-queues
set role anon;
select t.chk('mente: second product gets options', t.sg('sony hovedtelefoner', '[{"name":"Sony WH-1000XM5","url":"https://prisjagt.dk/product.php?p=11"},{"name":"Sony WH-CH720N","url":"https://prisjagt.dk/product.php?p=12","price":699,"store":"Elgiganten"}]') = 'true' and t.queue() = 'tredje navn');
reset role;
set role authenticated;
select t.asA();
update public.products set name = 'sony wh-1000xm4 sort' where name = 'sony hovedtelefoner';
select t.chk('mente: A types a new name: options gone, pending, no note', t.pst('sony wh-1000xm4 sort') = 'pending|-|-|false');
reset role;
set role anon;
select t.chk('mente: ... and the product is in the agent''s queue again', t.queue() = 'sony wh-1000xm4 sort,tredje navn');
select t.chk('mente: resolver_fail on a waiting product marks it as failed', public.resolver_fail(t.pid('tredje navn'), 'Fandt ikke varen.') = true and t.pst('tredje navn') = 'error|Fandt ikke varen.|-|false');
reset role;
set role authenticated;
select t.asA();
update public.products set name = 'tredje navn igen' where name = 'tredje navn';
select t.chk('mente: a new name on a failed name-only product: pending again, the note is gone, queued', t.pst('tredje navn igen') = 'pending|-|-|false');
update public.products set name = 'tredje navn igen' where name = 'tredje navn igen';
update public.products set name = 'tredje navn igen', target_value = null where name = 'tredje navn igen';
select t.chk('mente: the same name again changes nothing', t.pst('tredje navn igen') = 'pending|-|-|false');
reset role;
set role anon;
select t.chk('mente: queue has both', t.queue() = 'sony wh-1000xm4 sort,tredje navn igen');
select t.chk('mente: resolver_set clears options too', t.sg('sony wh-1000xm4 sort', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') = 'true'
  and public.resolver_set(t.pid('sony wh-1000xm4 sort'), 'https://prisjagt.dk/product.php?p=55') = true and t.pst('sony wh-1000xm4 sort') = 'pending|-|https://prisjagt.dk/product.php?p=55|false');
select t.chk('mente: resolver_fail clears options too', t.sg('tredje navn igen', '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]') = 'true'
  and public.resolver_fail(t.pid('tredje navn igen'), 'Intet passer.') = true and t.pst('tredje navn igen') = 'error|Intet passer.|-|false');
reset role;
-- a rename of a product that has a link is just a rename (no re-queue, nothing reset)
update public.products set status = 'tracking', title = 'T' where name = 'med link';
set role authenticated;
select t.asA();
update public.products set name = 'med link 2' where name = 'med link';
select t.chk('mente: a rename of a product with a link does not restart it', (select status = 'tracking' and title = 'T' from public.products where name = 'med link 2'));
reset role;
-- the safety net: a product with a link cannot hold options, and one option is not enough (even for the service role)
select t.chk('mente: the check: options need a product without a link', t.try($$update public.products set name_options = '[{"name":"a","url":"https://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]' where name = 'med link 2'$$) = 'check');
select t.chk('mente: the check: one option or a bad option is refused for the service role too',
  t.try($$update public.products set source_url = null, status = 'pending', name_options = '[{"name":"a","url":"https://shop.example.dk/a"}]' where name = 'med link 2'$$) = 'check'
  and t.try($$update public.products set source_url = null, status = 'pending', name_options = '[{"name":"a","url":"http://shop.example.dk/a"},{"name":"b","url":"https://shop.example.dk/b"}]' where name = 'med link 2'$$) = 'check');
-- the whole file again on the data (twice)
\o /dev/null
\i :schema
\i :schema
\o
select t.chk('mente: a re-run keeps the data', t.pst('sony wh-1000xm4 sort') = 'pending|-|https://prisjagt.dk/product.php?p=55|false');
delete from public.products;
delete from public.lists where id = '00000000-0000-0000-0000-00000000aa0f';
select set_config('request.jwt.claims', '', false);
select t.tok(null);

-- 12. final whole-file run on the populated database
\o /dev/null
\i :schema
\o
select t.chk('final re-run clean, admin still the same', (select array_agg(email) from public.allowed_emails where is_admin) = array['mor@familie.dk']);
select 'ALL SQL CHECKS PASSED' as result;
