# Vesta Helm chart

This chart deploys `vesta-web` and `vesta-api` as two containers in one Pod. The web container serves the embedded React UI and proxies same-origin application routes to the API sidecar. The chart expects a separately reachable VictoriaLogs or vmauth endpoint; it does not install VictoriaLogs.

## Local install

Build both images and install the chart with its development-only authentication defaults:

```sh
just docker
helm upgrade --install vesta ./charts/vesta --namespace vesta --create-namespace
kubectl -n vesta port-forward service/vesta 8080:80
```

The default source is `http://victorialogs:9428`. Override `config.data.sources` when VictoriaLogs uses a different service name.

## Production install

Copy `values-production.example.yaml`, replace the image, OIDC, ingress, source, tenant, and role settings, then create the referenced Secret:

```sh
kubectl -n vesta create secret generic vesta-secrets \
  --from-literal=VESTA_SESSION_SECRET="$(openssl rand -base64 32)" \
  --from-literal=VESTA_OIDC_CLIENT_SECRET='replace-me' \
  --from-literal=VESTA_PRODUCTION_TOKEN='replace-me'

helm upgrade --install vesta ./charts/vesta \
  --namespace vesta \
  --create-namespace \
  --values ./charts/vesta/values-production.example.yaml
```

For GitOps or external secret operators, set `secret.existingSecret`. If `secret.create` is enabled instead, every `secret.data` entry is rendered into a Kubernetes Secret and exposed to the API as an environment variable. Never commit real secret values.

When `config.existingConfigMap` is set, it must contain a `config.yml` key. The generated ConfigMap is then disabled.

## Useful values

| Value | Default | Purpose |
| --- | --- | --- |
| `api.image.repository`, `api.image.tag` | `vesta-api:local` | API container image |
| `web.image.repository`, `web.image.tag` | `vesta-web:local` | Web gateway image |
| `api.resources`, `web.resources` | component defaults | Per-container requests and limits |
| `config.data` | development config | Complete Vesta YAML configuration |
| `config.existingConfigMap` | empty | Use a pre-existing `config.yml` ConfigMap |
| `secret.existingSecret` | empty | Import session, OIDC, and upstream credentials |
| `ingress.enabled` | `false` | Create a Kubernetes Ingress |
| `autoscaling.enabled` | `false` | Create an HPA; concurrency limits remain per pod |
| `podDisruptionBudget.enabled` | `false` | Protect replicas during voluntary disruptions |

Render and validate before installation:

```sh
helm lint ./charts/vesta
helm template vesta ./charts/vesta --values ./charts/vesta/values-production.example.yaml
```
