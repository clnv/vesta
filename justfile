set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

build:
    npm run build
    mkdir -p bin
    go build -o ./bin/vesta-api ./cmd/api
    go build -o ./bin/vesta-web ./cmd/web

test:
    npm test
    go test ./...

integration-test:
    ./scripts/integration-test.sh

helm-lint:
    helm lint --strict ./charts/vesta
    helm lint --strict ./charts/vesta --values ./charts/vesta/values-production.example.yaml

dev:
    go run ./cmd/api -config config.local.yml

docker:
    docker build --file api.Dockerfile --tag vesta-api:local .
    docker build --file web.Dockerfile --tag vesta-web:local .
