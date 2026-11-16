#!/usr/bin/env bash
# Runs supabase/schema.sql against throw-away local Postgres databases with a mock auth schema:
#  1. test.sql: the whole file from scratch and in many simulated older shapes, plus the permission tests
#  2. migrate.sql: the schema as it was before list sharing (schema-pre-sharing.sql) with rows in it, then the new file twice
#  3. migrate-alt.sql: the schema as it was before "Alternativer" (schema-pre-alternatives.sql), the last step on its own
#  4. migrate-compare.sql: the schema as it was before "find the cheapest shop" (schema-pre-compare.sql), the last step on its own
#  5. migrate-image.sql: the schema as it was before product pictures (schema-pre-image.sql), the last step on its own
# Needs a running Postgres and psql (set PGHOST/PGPORT/PGUSER as usual): bash supabase/test/run.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
filter() { grep -E "NOTICE:  ok |FAIL|ERROR|PASSED|PASS" | sed -E "s/^psql:[^ ]+ NOTICE:  //"; }
status=0
for step in test migrate migrate-alt migrate-compare migrate-image; do
  db="pv_schema_${step//-/_}_$$"
  psql -qAt -d postgres -c "create database $db" >/dev/null || { echo "cannot create database"; exit 2; }
  export PGDATABASE="$db"
  psql -q -v ON_ERROR_STOP=1 -f "$here/mock-auth.sql" >/dev/null || { psql -qAt -d postgres -c "drop database $db" >/dev/null 2>&1; exit 2; }
  if [ "$step" = test ]; then
    psql -q -v ON_ERROR_STOP=1 -v schema="$here/../schema.sql" -f "$here/test.sql" 2>&1 | filter; rc=${PIPESTATUS[0]}
  elif [ "$step" = migrate ]; then
    psql -q -v ON_ERROR_STOP=1 -v old="$here/schema-pre-sharing.sql" -v new="$here/../schema.sql" -f "$here/migrate.sql" 2>&1 | filter; rc=${PIPESTATUS[0]}
  elif [ "$step" = migrate-alt ]; then
    psql -q -v ON_ERROR_STOP=1 -v old="$here/schema-pre-alternatives.sql" -v new="$here/../schema.sql" -f "$here/migrate-alt.sql" 2>&1 | filter; rc=${PIPESTATUS[0]}
  elif [ "$step" = migrate-compare ]; then
    psql -q -v ON_ERROR_STOP=1 -v old="$here/schema-pre-compare.sql" -v new="$here/../schema.sql" -f "$here/migrate-compare.sql" 2>&1 | filter; rc=${PIPESTATUS[0]}
  else
    psql -q -v ON_ERROR_STOP=1 -v old="$here/schema-pre-image.sql" -v new="$here/../schema.sql" -f "$here/migrate-image.sql" 2>&1 | filter; rc=${PIPESTATUS[0]}
  fi
  unset PGDATABASE
  psql -qAt -d postgres -c "drop database $db" >/dev/null 2>&1
  [ "$rc" -ne 0 ] && status=$rc
done
exit $status
