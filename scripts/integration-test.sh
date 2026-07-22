#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose="docker compose -f $root/compose.yml"
query_time='_time:1h'
csrf='vesta-development-csrf'
tail_pid=''

cleanup() {
  if [ -n "$tail_pid" ]; then
    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
  fi
  $compose down -v
}
trap cleanup EXIT INT TERM

$compose up --build -d

attempt=0
until curl -fsS http://localhost:19428/health >/dev/null 2>&1 && curl -fsS http://localhost:18080/healthz >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    $compose logs
    exit 1
  fi
  sleep 1
done

curl -fsS -X POST \
  -H 'Content-Type: application/stream+json' -H 'AccountID: 12' -H 'ProjectID: 34' \
  --data-binary '{"_time":"0","_msg":"checkout failed","service":"payments-api","level":"error","password_hash":"must-not-leak"}
{"_time":"0","_msg":"checkout recovered","service":"payments-api","level":"info"}' \
  http://localhost:19428/insert/jsonline

curl -fsS -X POST \
  -H 'Content-Type: application/stream+json' -H 'AccountID: 56' -H 'ProjectID: 78' \
  --data-binary '{"_time":"0","_msg":"index refreshed","service":"search-api","level":"info"}' \
  http://localhost:19428/insert/jsonline

attempt=0
until curl -fsS -H 'AccountID: 12' -H 'ProjectID: 34' -d "query=$query_time service:=payments-api" http://localhost:19428/select/logsql/query | grep -q 'checkout' \
  && curl -fsS -H 'AccountID: 56' -H 'ProjectID: 78' -d "query=$query_time service:=search-api" http://localhost:19428/select/logsql/query | grep -q 'index refreshed'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'seeded logs did not become queryable' >&2
    exit 1
  fi
  sleep 1
done

session=$(curl -fsS http://localhost:18080/api/v1/session)
echo "$session" | grep -q '"accountId":"12"'
echo "$session" | grep -q '"accountId":"56"'
if echo "$session" | grep -q 'victorialogs:9428'; then
  echo 'upstream URL leaked in session response' >&2
  exit 1
fi

rows=$(curl -fsS -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"integration","tenant":{"accountId":"12","projectId":"34"},"query":"_time:1h service:=payments-api | sort by (_time) desc | limit 20"}' \
  http://localhost:18080/api/v1/query)
echo "$rows" | grep -q '"type":"meta"'
echo "$rows" | grep -q 'checkout failed'
echo "$rows" | grep -q '"status":"complete"'
if echo "$rows" | grep -q 'must-not-leak'; then
  echo 'hidden field leaked through Vesta' >&2
  exit 1
fi

stats=$(curl -fsS -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"integration","tenant":{"accountId":"12","projectId":"34"},"query":"_time:1h | stats by (level) count()"}' \
  http://localhost:18080/api/v1/query)
echo "$stats" | grep -q 'count'

search=$(curl -fsS -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"integration","tenant":{"accountId":"56","projectId":"78"},"query":"_time:1h service:=search-api | limit 20"}' \
  http://localhost:18080/api/v1/query)
echo "$search" | grep -q 'index refreshed'
if echo "$search" | grep -q 'checkout'; then
  echo 'tenant data leaked across contexts' >&2
  exit 1
fi

fields=$(curl -fsS -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"integration","tenant":{"accountId":"12","projectId":"34"},"query":"_time:1h"}' \
  http://localhost:18080/api/v1/fields)
echo "$fields" | grep -q 'service'
if echo "$fields" | grep -q 'password_hash'; then
  echo 'hidden metadata leaked through Vesta' >&2
  exit 1
fi

tail_file=$(mktemp)
curl -fsS -N -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"integration","tenant":{"accountId":"12","projectId":"34"},"query":"_time:1h service:=tail-probe"}' \
  http://localhost:18080/api/v1/tail >"$tail_file" &
tail_pid=$!
sleep 1
curl -fsS -X POST \
  -H 'Content-Type: application/stream+json' -H 'AccountID: 12' -H 'ProjectID: 34' \
  --data-binary '{"_time":"0","_msg":"live event","service":"tail-probe","level":"info"}' \
  http://localhost:19428/insert/jsonline
attempt=0
until grep -q 'live event' "$tail_file"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'live tail did not receive the seeded event' >&2
    exit 1
  fi
  sleep 1
done

kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true
tail_pid=''
rm -f "$tail_file"
echo 'VictoriaLogs integration test passed'
