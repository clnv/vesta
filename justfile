set shell := ["bash", "-euo", "pipefail", "-c"]

dev_compose := "docker compose --file build/dev/compose.yml"

# List all available recipes.
default:
    @just --list

# Build the web assets and the API and web binaries.
build:
    npm run build
    mkdir -p bin
    go build -o ./bin/vesta-api ./cmd/api
    go build -o ./bin/vesta-web ./cmd/web

# Run the web and Go unit tests.
test:
    npm test
    go test ./...

# Run the integration test suite against VictoriaLogs.
integration-test:
    ./scripts/integration-test.sh

# Lint the Helm chart with its default and production example values.
helm-lint:
    helm lint --strict ./charts/vesta
    helm lint --strict ./charts/vesta --values ./charts/vesta/values-production.example.yaml

# Ensure local dependencies are running, then restart the API, web, and logs Zellij session.
dev:
    {{dev_compose}} up --detach --no-recreate
    @zellij delete-session --force vesta >/dev/null 2>&1 || true
    zellij --layout .zellij/dev.kdl attach --create vesta

# Force-recreate the local VictoriaLogs and fake-log containers.
dev-services-restart:
    {{dev_compose}} up --detach --force-recreate --remove-orphans

# Destroy the local Compose stack and its VictoriaLogs data volume.
dev-services-destroy:
    {{dev_compose}} down --volumes --remove-orphans

# Build the local API and web container images.
docker:
    docker build --file api.Dockerfile --tag vesta-api:local .
    docker build --file web.Dockerfile --tag vesta-web:local .
