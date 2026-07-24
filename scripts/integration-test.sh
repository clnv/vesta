#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose="docker compose -f $root/compose.yml"
query_time='_time:1h'
cookie_file=$(mktemp)

cleanup() {
  rm -f "$cookie_file"
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

curl -fsS http://localhost:18080/ | grep -q '<div id="root"></div>'
curl -fsS -o /dev/null -c "$cookie_file" -X POST \
  -H 'Content-Type: application/json' \
  --data '{"email":"integration@localhost","password":"integration-password"}' \
  http://localhost:18080/auth/login

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

session=$(curl -fsS -b "$cookie_file" http://localhost:18080/api/v1/session)
csrf=$(echo "$session" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
team_id=$(echo "$session" | sed -n 's/.*"teams":\[{"id":"\([^"]*\)".*/\1/p')
if [ -z "$csrf" ] || [ -z "$team_id" ]; then
  echo 'authenticated session did not include CSRF token and bootstrap team' >&2
  exit 1
fi
echo "$session" | grep -q '"id":"payments"'
echo "$session" | grep -q '"id":"search"'
if echo "$session" | grep -q '"accountId"'; then
  echo 'source routing configuration leaked in session response' >&2
  exit 1
fi
if echo "$session" | grep -q 'victorialogs:9428'; then
  echo 'upstream URL leaked in session response' >&2
  exit 1
fi

share=$(curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"payload":{"query":"_time:1h service:=payments-api","sourceId":"payments","title":"Payments","resultMode":"table"}}' \
  http://localhost:18080/api/v1/shares)
share_token=$(echo "$share" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$share_token" ]; then
  echo 'share API returned no token' >&2
  exit 1
fi

folder=$(curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data "{\"teamId\":\"$team_id\",\"name\":\"Incidents\"}" \
  http://localhost:18080/api/v1/team-folders)
folder_id=$(echo "$folder" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$folder_id" ]; then
  echo 'team folder API returned no id' >&2
  exit 1
fi
curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data "{\"teamId\":\"$team_id\",\"folderId\":\"$folder_id\",\"payload\":{\"query\":\"_time:1h service:=payments-api\",\"sourceId\":\"payments\",\"title\":\"Payment incidents\",\"resultMode\":\"table\"}}" \
  http://localhost:18080/api/v1/team-queries | grep -q '"title":"Payment incidents"'

$compose restart vesta-api
attempt=0
until curl -fsS http://localhost:18080/healthz >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Vesta did not recover after API restart' >&2
    exit 1
  fi
  sleep 1
done
opened_share=$(curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data "{\"token\":\"$share_token\"}" \
  http://localhost:18080/api/v1/shares/open)
echo "$opened_share" | grep -q 'service:=payments-api'
team_library=$(curl -fsS -b "$cookie_file" http://localhost:18080/api/v1/team-library)
echo "$team_library" | grep -q '"name":"Incidents"'
echo "$team_library" | grep -q '"title":"Payment incidents"'

rows=$(curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"payments","query":"_time:1h service:=payments-api | sort by (_time) desc | limit 20"}' \
  http://localhost:18080/api/v1/query)
echo "$rows" | grep -q '"type":"meta"'
echo "$rows" | grep -q 'checkout failed'
echo "$rows" | grep -q '"status":"complete"'
if echo "$rows" | grep -q 'must-not-leak'; then
  echo 'hidden field leaked through Vesta' >&2
  exit 1
fi

stats=$(curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"payments","query":"_time:1h | stats by (level) count()"}' \
  http://localhost:18080/api/v1/query)
echo "$stats" | grep -q 'count'

search=$(curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"search","query":"_time:1h service:=search-api | limit 20"}' \
  http://localhost:18080/api/v1/query)
echo "$search" | grep -q 'index refreshed'
if echo "$search" | grep -q 'checkout'; then
  echo 'source routing leaked data across contexts' >&2
  exit 1
fi

fields=$(curl -fsS -b "$cookie_file" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  --data '{"sourceId":"payments","query":"_time:1h"}' \
  http://localhost:18080/api/v1/fields)
echo "$fields" | grep -q 'service'
if echo "$fields" | grep -q 'password_hash'; then
  echo 'hidden metadata leaked through Vesta' >&2
  exit 1
fi

echo 'VictoriaLogs integration test passed'
