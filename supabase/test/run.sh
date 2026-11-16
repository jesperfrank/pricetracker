#!/usr/bin/env bash
# Runs supabase/schema.sql against a throw-away local Postgres database with a mock auth schema.
# Needs a running Postgres and psql (set PGHOST/PGPORT/PGUSER as usual): bash supabase/test/run.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
db="pv_schema_test_$$"
psql -qAt -d postgres -c "create database $db" >/dev/null || { echo "cannot create database"; exit 2; }
trap 'psql -qAt -d postgres -c "drop database $db" >/dev/null 2>&1' EXIT
export PGDATABASE="$db"
psql -q -v ON_ERROR_STOP=1 -f "$here/mock-auth.sql" >/dev/null || exit 2
psql -q -v ON_ERROR_STOP=1 -v schema="$here/../schema.sql" -f "$here/test.sql" 2>&1 | grep -E "NOTICE:  ok |FAIL|ERROR|PASSED|PASS" | sed -E "s/^psql:[^ ]+ NOTICE:  //"; exit "${PIPESTATUS[0]}"
