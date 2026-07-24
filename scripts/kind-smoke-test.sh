#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
kind_bin="${KIND_BIN:-kind}"
cluster_name="${KIND_CLUSTER_NAME:-vesta-ci}"
context="kind-${cluster_name}"
namespace="${KIND_SMOKE_NAMESPACE:-vesta-kind-smoke}"
port="${VESTA_SMOKE_PORT:-18081}"
base_url="http://127.0.0.1:${port}"
cookie_file="$(mktemp)"
port_forward_log="$(mktemp)"
port_forward_pid=""
namespace_created=false

diagnostics() {
  kubectl --context "$context" --namespace "$namespace" get all,pvc,configmap,secret
  kubectl --context "$context" --namespace "$namespace" get events --sort-by=.lastTimestamp
  kubectl --context "$context" --namespace "$namespace" describe pods
  kubectl --context "$context" --namespace "$namespace" logs deployment/victorialogs --tail=200
  kubectl --context "$context" --namespace "$namespace" logs deployment/fake-logs --tail=200
  kubectl --context "$context" --namespace "$namespace" logs deployment/vesta --all-containers --tail=200
  if [[ -s "$port_forward_log" ]]; then
    echo "kubectl port-forward output:"
    sed -n '1,200p' "$port_forward_log"
  fi
}

cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [[ "$status" -ne 0 && "$namespace_created" == true ]]; then
    diagnostics
  fi
  if [[ -n "$port_forward_pid" ]]; then
    kill "$port_forward_pid" >/dev/null 2>&1
    wait "$port_forward_pid" >/dev/null 2>&1
  fi
  if [[ "$namespace_created" == true ]]; then
    kubectl --context "$context" delete namespace "$namespace" --wait=true --timeout=2m
  fi
  rm -f "$cookie_file" "$port_forward_log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! command -v "$kind_bin" >/dev/null 2>&1; then
  echo "Kind binary ${kind_bin} does not exist" >&2
  exit 1
fi
if ! "$kind_bin" get clusters | grep -Fxq "$cluster_name"; then
  echo "Kind cluster ${cluster_name} does not exist" >&2
  exit 1
fi
if kubectl --context "$context" get namespace "$namespace" >/dev/null 2>&1; then
  echo "Namespace ${namespace} already exists in ${context}" >&2
  exit 1
fi

docker image inspect vesta-api:local vesta-web:local >/dev/null
"$kind_bin" load docker-image --name "$cluster_name" vesta-api:local vesta-web:local

kubectl --context "$context" create namespace "$namespace"
namespace_created=true
kubectl --context "$context" --namespace "$namespace" create configmap fake-logs \
  --from-file="fake-logs.sh=${root}/build/dev/fake-logs.sh" \
  --dry-run=client \
  --output=yaml \
  | kubectl --context "$context" --namespace "$namespace" apply --filename=-
kubectl --context "$context" --namespace "$namespace" apply --filename="${root}/scripts/kind-smoke-fixture.yaml"
kubectl --context "$context" --namespace "$namespace" rollout status deployment/victorialogs --timeout=2m
kubectl --context "$context" --namespace "$namespace" rollout status deployment/fake-logs --timeout=2m

helm upgrade --install vesta "${root}/charts/vesta" \
  --kube-context "$context" \
  --namespace "$namespace" \
  --set api.image.repository=vesta-api \
  --set api.image.tag=local \
  --set api.image.pullPolicy=Never \
  --set web.image.repository=vesta-web \
  --set web.image.tag=local \
  --set web.image.pullPolicy=Never \
  --set-string secret.data.VESTA_SESSION_SECRET=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
  --set-string secret.data.VESTA_BOOTSTRAP_PASSWORD=vesta-local-password \
  --set persistence.enabled=false \
  --set-string "config.data.server.external_url=${base_url}" \
  --wait \
  --timeout=3m

helm test vesta \
  --kube-context "$context" \
  --namespace "$namespace" \
  --logs \
  --timeout=2m

kubectl --context "$context" --namespace "$namespace" port-forward service/vesta "${port}:80" \
  >"$port_forward_log" 2>&1 &
port_forward_pid=$!

attempt=0
until curl --fail --silent --show-error "${base_url}/healthz" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if ! kill -0 "$port_forward_pid" >/dev/null 2>&1 || [[ "$attempt" -ge 30 ]]; then
    echo "Vesta service did not become reachable through port-forward" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "${base_url}/" | grep -q '<div id="root"></div>'
curl --fail --silent --show-error \
  --output /dev/null \
  --cookie-jar "$cookie_file" \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"email":"admin@localhost","password":"vesta-local-password"}' \
  "${base_url}/auth/login"

session="$(curl --fail --silent --show-error --cookie "$cookie_file" "${base_url}/api/v1/session")"
csrf="$(sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p' <<<"$session")"
if [[ -z "$csrf" ]] || ! grep -q '"id":"local"' <<<"$session"; then
  echo "Authenticated session did not include a CSRF token and the local source" >&2
  exit 1
fi

rows=""
attempt=0
until grep -q '"status":"complete"' <<<"$rows" && grep -q '"request_id"' <<<"$rows"; do
  rows="$(curl --fail --silent --show-error \
    --cookie "$cookie_file" \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "X-CSRF-Token: ${csrf}" \
    --data '{"sourceId":"local","query":"_time:5m environment:=local | limit 20"}' \
    "${base_url}/api/v1/query")"
  attempt=$((attempt + 1))
  if [[ "$attempt" -ge 60 ]]; then
    echo "Fake logs did not become queryable through Vesta" >&2
    exit 1
  fi
  sleep 1
done
grep -q '"type":"meta"' <<<"$rows"
grep -q 'request completed successfully' <<<"$rows"

stats="$(curl --fail --silent --show-error \
  --cookie "$cookie_file" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "X-CSRF-Token: ${csrf}" \
  --data '{"sourceId":"local","query":"_time:5m | stats by (service) count()"}' \
  "${base_url}/api/v1/query")"
grep -q '"status":"complete"' <<<"$stats"
grep -q 'count' <<<"$stats"

echo "Kind Helm smoke test passed"
