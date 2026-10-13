#!/bin/sh
# A private Postgres for development and tests, in ./.pgdata on port 5544,
# using the local Postgres binaries (no Docker needed).
#   sh scripts/dev-db.sh start | stop | status
set -eu
cd "$(dirname "$0")/.."
PGDATA="${PGDATA:-$PWD/.pgdata}"
PORT="${PGPORT:-5544}"
# macOS: postgres refuses to start without a valid locale in the environment.
export LC_ALL=C

if ! command -v pg_ctl >/dev/null 2>&1; then
  for d in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /usr/lib/postgresql/*/bin; do
    [ -x "$d/pg_ctl" ] && PATH="$d:$PATH" && break
  done
fi

case "${1:-start}" in
  start)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      initdb -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
    fi
    if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
      pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -o "-p $PORT -k /tmp -c listen_addresses=localhost" -w start >/dev/null
    fi
    for db in portal portal_test; do
      psql -h localhost -p "$PORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 ||
        createdb -h localhost -p "$PORT" -U postgres "$db"
    done
    echo "postgres on localhost:$PORT (databases: portal, portal_test)"
    ;;
  stop) pg_ctl -D "$PGDATA" -m fast stop ;;
  status) pg_ctl -D "$PGDATA" status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
