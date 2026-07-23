#!/bin/sh
set -eu

victorialogs_url=${VICTORIALOGS_URL:-http://victorialogs:9428}
insert_url="${victorialogs_url}/insert/jsonline?_stream_fields=service,environment,instance&_time_field=_time&_msg_field=_msg"
interval=${LOG_INTERVAL_SECONDS:-1}

until curl --fail --silent --show-error "${victorialogs_url}/health" >/dev/null 2>&1; do
  echo "waiting for VictoriaLogs at ${victorialogs_url}"
  sleep 1
done

echo "sending fake logs to ${victorialogs_url} every ${interval}s"

sequence=0
while :; do
  sequence=$((sequence + 1))

  case $((sequence % 4)) in
    0)
      service=checkout-api
      method=POST
      route=/api/checkout
      ;;
    1)
      service=search-api
      method=GET
      route=/api/search
      ;;
    2)
      service=identity-api
      method=POST
      route=/api/session
      ;;
    *)
      service=notification-worker
      method=POST
      route=/jobs/deliver
      ;;
  esac

  if [ $((sequence % 17)) -eq 0 ]; then
    level=error
    status_code=500
    message="request failed with an upstream timeout"
  elif [ $((sequence % 7)) -eq 0 ]; then
    level=warn
    status_code=429
    message="request was throttled and will be retried"
  else
    level=info
    status_code=200
    message="request completed successfully"
  fi

  instance="dev-$((sequence % 3 + 1))"
  duration_ms=$((20 + sequence % 480))
  request_id=$(printf 'local-%08d' "${sequence}")

  payload=$(printf \
    '{"_time":"0","_msg":"%s","environment":"local","service":"%s","instance":"%s","level":"%s","method":"%s","route":"%s","status_code":"%s","duration_ms":"%s","request_id":"%s"}' \
    "${message}" "${service}" "${instance}" "${level}" "${method}" "${route}" \
    "${status_code}" "${duration_ms}" "${request_id}")

  printf '%s\n' "${payload}" | curl --fail --silent --show-error \
    --header 'Content-Type: application/stream+json' \
    --data-binary @- \
    "${insert_url}" \
    >/dev/null

  sleep "${interval}"
done
