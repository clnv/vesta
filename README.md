# Vesta Log Explorer

Vesta is a self-hosted, keyboard-first LogsQL explorer for VictoriaLogs. It keeps query semantics visible: every run requires an explicit `_time:` filter, and the API never injects `start`, `end`, result limits, offsets, or extra filters.

## Run locally

Requirements: Go 1.26.5+, Node.js 24+, Just 1.57+, Docker with Compose, and Zellij.

```sh
npm install
just dev
```

`just dev` uses the tracked `config.dev.yml` and local-only default credentials, starts VictoriaLogs and the continuous fake-log generator only when needed, and leaves running Compose containers untouched. It replaces the `vesta` Zellij session so the API, Vite, and log viewer restart each time. Zellij contains a two-pane `dev` tab for the API and Vite plus a `services` tab that follows the Compose logs. Open `http://localhost:5173` and sign in as `admin@localhost` with password `vesta-local-password`. Vite proxies API and authentication requests to the API on port 8080. Use a query such as `_time:5m` to inspect the generated local logs.

The development session secret and bootstrap password can be overridden by exporting `VESTA_SESSION_SECRET` and `VESTA_BOOTSTRAP_PASSWORD` before running `just dev`.

The development Compose stack is defined in [`build/dev/compose.yml`](build/dev/compose.yml). Manage its lifecycle separately:

```sh
just dev-services-restart  # Force-recreate VictoriaLogs and the generator.
just dev-services-destroy  # Remove the stack and its local VictoriaLogs data.
```

To run the production web gateway instead, use `go run ./cmd/web` and open `http://localhost:8081`.

On an empty database, Vesta creates the bootstrap administrator and team configured under `auth.bootstrap`; the password comes from `VESTA_BOOTSTRAP_PASSWORD`. Later restarts never overwrite accounts already stored in SQLite.

## Production configuration

Start from `config.production.example.yml` and configure:

- `VESTA_SESSION_SECRET`, containing at least 32 random bytes encoded with base64.
- `VESTA_BOOTSTRAP_PASSWORD`, used only if the SQLite database contains no users.
- The bootstrap user’s roles, source roles, and permitted tenant pairs. Access remains default-deny.
- Each VictoriaLogs/vmauth credential through environment variables.
- `storage.path`, the SQLite database used for users, password hashes, teams, memberships, folders, and shared queries. `storage.share_ttl` controls expiring private links.

Generate a session secret with:

```sh
openssl rand -base64 32
```

Passwords are hashed with bcrypt before storage. Administrators can create users and teams and assign memberships from the user-directory button in the header. Vesta supports `none`, `basic`, and `bearer` authentication for an administrator-configured VictoriaLogs upstream. Upstream URLs and credentials are never returned to the browser. Configure TLS at the ingress and keep VictoriaLogs or vmauth on a trusted network.

## Query behavior

- `Shift+Enter` runs the current selection, or the full editor when there is no selection.
- Main queries are POSTed to `/select/logsql/query` with the LogsQL `query` value and authorized tenant/auth headers. The only server-added query parameter is an optional, administrator-fixed `hidden_fields_filters` security policy; Vesta also recursively redacts those fields at its response boundary and blocks their metadata calls.
- Queries without a real `_time:` filter are rejected in both the editor and API. Text inside strings and `#` comments does not count.
- The viewer stops at 50,000 rows, 32 MiB, or 30 seconds by default. Truncation is always visible and cancels the upstream request.
- Tabs and the last 100 query texts are saved in IndexedDB. Result rows are never persisted.
- Private query links use random opaque IDs backed by SQLite, expire automatically, and can target a local user or one of the sharer’s teams. Opening a private link requires login and rechecks the recipient’s source and tenant authorization.
- Team members can save queries to a shared SQLite library and organize them into team folders. Loading a saved team query opens it as a protected draft and never executes it automatically.

## Validate and package

```sh
just test
just build
just docker
just integration-test
just helm-lint
```

The integration target builds the `vesta-web` image from `web.Dockerfile` and `vesta-api` from `api.Dockerfile`, starts a pinned VictoriaLogs `v1.52.0` container, seeds two tenants, and verifies local login, regular and stats rows, field discovery, tenant isolation, hidden fields, live tail, private links, and folder-grouped team queries across an API restart. It removes its containers and volumes after the run.

The `vesta-api` container expects its configuration at `/etc/vesta/config.yml` by default. `vesta-web` serves the SPA and proxies `/api`, `/auth`, and `/metrics` to the API, preserving a single browser origin. Health and Prometheus-format operational metrics are available at `/healthz` and `/metrics`. Logs include request IDs, subject IDs, source IDs, duration, row counts, and byte counts—never query text or result data.

## Kubernetes with Helm

The chart in [`charts/vesta`](charts/vesta) deploys the `vesta-web` and `vesta-api` images as two containers in one Pod, with a generated or existing ConfigMap, existing or chart-managed Secret, Service, optional Ingress, per-container probes, non-root security contexts, optional PodDisruptionBudget, and a `helm test` health check. By default, SQLite data is stored on a chart-managed `ReadWriteOnce` PVC. The local SQLite user directory deliberately requires one replica and disables the HPA; persistent deployments use a `Recreate` strategy.

```sh
helm upgrade --install vesta ./charts/vesta \
  --namespace vesta \
  --create-namespace \
  --values ./charts/vesta/values-production.example.yaml
```

Use [`charts/vesta/README.md`](charts/vesta/README.md) for secret creation, local installation, and production value guidance. The default chart values contain explicitly development-only bootstrap credentials and keep Ingress disabled; production deployments should start from `values-production.example.yaml`.

## Continuous integration

GitHub Actions configuration lives under [`.github/workflows`](.github/workflows):

- `CI` checks workflow syntax, Go formatting/module integrity/vet/race tests/coverage, reachable Go vulnerabilities, web tests and production builds, strict Helm linting and render variants, chart packaging, Dockerfile checks, the pinned VictoriaLogs integration suite, and the final container UID.
- `CodeQL` analyzes Go and TypeScript on `main`, pull requests, manual runs, and a weekly schedule.
- `Publish container images` publishes AMD64 images as `ghcr.io/<owner>/<repository>-web` and `ghcr.io/<owner>/<repository>-api` from `master`, version tags, and manual runs. Version tags also produce semantic-version tags, while the default branch publishes `latest`.
- [Dependabot](.github/dependabot.yml) groups weekly npm, Go module, Docker, and GitHub Actions updates.

Actions are pinned to immutable commit SHAs with their release versions documented inline. CI has read-only repository permissions by default, with `security-events: write` granted only to CodeQL.
