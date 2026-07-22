.PHONY: build test integration-test helm-lint dev docker

build:
	npm run build
	go build -o vesta ./cmd/vesta

test:
	npm test
	go test ./...

integration-test:
	./scripts/integration-test.sh

helm-lint:
	helm lint --strict ./charts/vesta
	helm lint --strict ./charts/vesta --values ./charts/vesta/values-production.example.yaml

dev:
	go run ./cmd/vesta -config config.local.yml

docker:
	docker build -t vesta:local .
