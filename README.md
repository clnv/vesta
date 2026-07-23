# Vesta Log Explorer

Vesta is a self-hosted, keyboard-first LogsQL explorer for VictoriaLogs. It keeps query semantics visible: every run requires an explicit `_time:` filter, and the API never injects `start`, `end`, result limits, offsets, or extra filters.

## Run locally

Requirements: Go 1.26+, Node.js 24+, Just 1.57+, and a VictoriaLogs server on `localhost:9428`.

```sh
cp config.example.yml config.local.yml
npm install
npm run build
go run ./cmd/vesta -config config.local.yml
```

Open `http://localhost:8080`. For frontend development, run `npm run dev` in a second terminal; Vite proxies API and authentication requests to the Go service.

Development authentication is intentionally explicit in `config.local.yml`. Never expose a deployment with `dev_mode: true`.

## Production configuration

Start from `config.oidc.example.yml` and configure:

- A generic OpenID Connect client using Authorization Code flow. The callback is `/auth/callback`.
- `VESTA_SESSION_SECRET`, containing at least 32 random bytes encoded with base64.
- The OIDC client secret and each VictoriaLogs/vmauth credential through environment variables.
- Group-to-role mappings, source roles, and permitted tenant pairs. Access is default-deny.

Generate a session secret with:

```sh
openssl rand -base64 32
```

Vesta supports `none`, `basic`, and `bearer` authentication for an administrator-configured upstream. Upstream URLs and credentials are never returned to the browser. Configure TLS at the ingress and keep VictoriaLogs or vmauth on a trusted network.

## Query behavior

- `Shift+Enter` runs the current selection, or the full editor when there is no selection.
- Main queries are POSTed to `/select/logsql/query` with the LogsQL `query` value and authorized tenant/auth headers. The only server-added query parameter is an optional, administrator-fixed `hidden_fields_filters` security policy; Vesta also recursively redacts those fields at its response boundary and blocks their metadata calls.
- Queries without a real `_time:` filter are rejected in both the editor and API. Text inside strings and `#` comments does not count.
- The viewer stops at 50,000 rows, 32 MiB, or 30 seconds by default. Truncation is always visible and cancels the upstream request.
- Tabs and the last 100 query texts are saved in IndexedDB. Result rows are never persisted.
- Shared query state is compressed into the URL fragment, opens in protected mode, and is never executed automatically.

## Validate and package

```sh
just test
just build
docker build -t vesta:local .
just integration-test
just helm-lint
```

The integration target builds Vesta, starts a pinned VictoriaLogs `v1.52.0` container, seeds two tenants, and verifies regular and stats rows, field discovery, tenant isolation, hidden fields, and live tail. It removes its containers and volume after the run.

The Vesta container expects its configuration at `/etc/vesta/config.yml` by default. Health and Prometheus-format operational metrics are available at `/healthz` and `/metrics`. Logs include request IDs, subject IDs, source IDs, duration, row counts, and byte counts—never query text or result data.

## Kubernetes with Helm

The chart in [`charts/vesta`](charts/vesta) deploys the single Vesta container with a generated or existing ConfigMap, existing or chart-managed Secret, Service, optional Ingress, probes, non-root security contexts, optional HPA and PodDisruptionBudget, and a `helm test` health check.

```sh
helm upgrade --install vesta ./charts/vesta \
  --namespace vesta \
  --create-namespace \
  --values ./charts/vesta/values-production.example.yaml
```

Use [`charts/vesta/README.md`](charts/vesta/README.md) for secret creation, local installation, and production value guidance. The default chart values use development authentication and keep Ingress disabled; production deployments should start from `values-production.example.yaml`.

## Continuous integration

GitHub Actions configuration lives under [`.github/workflows`](.github/workflows):

- `CI` checks workflow syntax, Go formatting/module integrity/vet/race tests/coverage, reachable Go vulnerabilities, frontend tests and production builds, strict Helm linting and render variants, chart packaging, pull-request dependency changes, Dockerfile checks, the pinned VictoriaLogs integration suite, and the final container UID.
- `CodeQL` analyzes Go and TypeScript on `main`, pull requests, manual runs, and a weekly schedule.
- `Publish container image` publishes AMD64 images to `ghcr.io/<owner>/<repository>` from `master`, version tags, and manual runs. Version tags also produce semantic-version tags, while the default branch publishes `latest`.
- [Dependabot](.github/dependabot.yml) groups weekly npm, Go module, Docker, and GitHub Actions updates.

Actions are pinned to immutable commit SHAs with their release versions documented inline. CI has read-only repository permissions by default, with `security-events: write` granted only to CodeQL.
