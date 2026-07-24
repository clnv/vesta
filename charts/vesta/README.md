# Vesta Helm chart

This chart deploys `vesta-web` and `vesta-api` as two containers in one Pod. The web container serves the embedded React UI and proxies same-origin application routes to the API sidecar. The chart expects a separately reachable VictoriaLogs or vmauth endpoint; it does not install VictoriaLogs.

## Local install

Build both images and install the chart with its development-only local-account defaults:

```sh
just docker
helm upgrade --install vesta ./charts/vesta --namespace vesta --create-namespace
kubectl -n vesta port-forward service/vesta 8080:80
```

The default source is `http://victorialogs:9428`. Override `config.data.sources` when VictoriaLogs uses a different service name. The default install also needs a default StorageClass because it creates a 1 GiB `ReadWriteOnce` PVC for SQLite.

After port-forwarding, sign in as `admin@localhost` with `vesta-local-password`. These values are intentionally local-only; replace the chart-managed Secret or use an existing Secret anywhere else.

## Production install

Copy `values-production.example.yaml`, replace the image, ingress, bootstrap account, source, upstream routing, and role settings, then create the referenced Secret:

```sh
kubectl -n vesta create secret generic vesta-secrets \
  --from-literal=VESTA_SESSION_SECRET="$(openssl rand -base64 32)" \
  --from-literal=VESTA_BOOTSTRAP_PASSWORD='replace-with-a-strong-password' \
  --from-literal=VESTA_PRODUCTION_TOKEN='replace-me'

helm upgrade --install vesta ./charts/vesta \
  --namespace vesta \
  --create-namespace \
  --values ./charts/vesta/values-production.example.yaml
```

For GitOps or external secret operators, set `secret.existingSecret`. If `secret.create` is enabled instead, every `secret.data` entry is rendered into a Kubernetes Secret and exposed to the API as an environment variable. Never commit real secret values.

When `config.existingConfigMap` is set, it must contain a `config.yml` key. The generated ConfigMap is then disabled.

## SQLite persistence

Users, bcrypt password hashes, teams, memberships, query folders, saved queries, and expiring share-link records are stored in SQLite at `config.data.storage.path`, which defaults to `/var/lib/vesta/vesta.db`. Persistence is enabled by default: the chart creates a PVC and mounts it only in the API container. The Pod security context sets `fsGroup: 65532` so the non-root API process can write the volume.

Set `persistence.storageClass` to select a StorageClass, or set `persistence.existingClaim` to reuse a PVC. The chart always requires `replicaCount: 1` and rejects autoscaling because accounts and memberships are local SQLite state. When persistence is enabled, it also uses the `Recreate` deployment strategy so only one API process can access the database. Set `persistence.enabled: false` only for disposable testing with an ephemeral `emptyDir`.

## Useful values

| Value | Default | Purpose |
| --- | --- | --- |
| `api.image.repository`, `api.image.tag` | `vesta-api:local` | API container image |
| `web.image.repository`, `web.image.tag` | `vesta-web:local` | Web gateway image |
| `api.resources`, `web.resources` | component defaults | Per-container requests and limits |
| `config.data` | development config | Complete Vesta YAML configuration |
| `config.existingConfigMap` | empty | Use a pre-existing `config.yml` ConfigMap |
| `secret.existingSecret` | empty | Import session, bootstrap-password, and upstream credentials |
| `persistence.enabled` | `true` | Store SQLite data on a PVC instead of an `emptyDir` |
| `persistence.existingClaim` | empty | Mount an existing PVC instead of creating one |
| `persistence.storageClass`, `persistence.size` | default class, `1Gi` | Configure the chart-managed PVC |
| `ingress.enabled` | `false` | Create a Kubernetes Ingress |
| `autoscaling.enabled` | `false` | Reserved; local SQLite mode rejects HPA enablement |
| `podDisruptionBudget.enabled` | `false` | Protect replicas during voluntary disruptions |

Render and validate before installation:

```sh
helm lint ./charts/vesta
helm template vesta ./charts/vesta --values ./charts/vesta/values-production.example.yaml
```
