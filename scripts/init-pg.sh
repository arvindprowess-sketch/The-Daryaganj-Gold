#!/usr/bin/env bash
# Ensures the local Postgres cluster, audix role/db, schema and seed data exist.
# Safe to run repeatedly — every step is idempotent.
set -e

PGBIN=/usr/lib/postgresql/15/bin
PGDATA=/var/lib/postgresql/15/main
PGCONF=/etc/postgresql/15/main/postgresql.conf

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[init-pg] data dir missing — creating cluster"
  rm -rf "$PGDATA"
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  su postgres -c "$PGBIN/initdb -D $PGDATA"
fi

# Start the cluster if it is not accepting connections yet.
for i in $(seq 1 30); do
  if pg_isready -h 127.0.0.1 -p 5432 -q; then break; fi
  if [ "$i" = "1" ]; then
    echo "[init-pg] starting postgres"
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-c config_file=$PGCONF' -l /var/log/postgres-init.log start" || true
  fi
  sleep 1
done

pg_isready -h 127.0.0.1 -p 5432 -q || { echo "[init-pg] postgres not reachable"; exit 1; }

su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='audix'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE ROLE audix WITH LOGIN SUPERUSER PASSWORD 'audix';\""

su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='audix'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE DATABASE audix OWNER audix;\""

cd /app/server
npm run migrate

# Seed demo data only when the database is still empty.
COUNT=$(psql "postgres://audix:audix@127.0.0.1:5432/audix" -tAc "SELECT count(*) FROM users" 2>/dev/null || echo 0)
if [ "$COUNT" = "0" ]; then
  echo "[init-pg] empty database — seeding demo data"
  npm run seed
else
  echo "[init-pg] users already present ($COUNT) — skipping seed"
fi

echo "[init-pg] ready"
