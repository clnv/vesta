# Vesta Helm chart

This chart deploys the Vesta API and web gateway in one Pod. VictoriaLogs or vmauth must already be reachable; it is not installed by this chart.

## Install

Edit `values.yaml`, then install:

```sh
helm upgrade --install vesta ./charts/vesta \
  --namespace vesta \
  --create-namespace
```

The chart creates its own Secret and generates the session secret and bootstrap password. Retrieve the password with:

```sh
helm get notes vesta --namespace vesta
```

The default login email is `admin@localhost`. The default VictoriaLogs URL is `http://victorialogs:9428`.

## Use as a subchart

Add Vesta to the parent `Chart.yaml`:

```yaml
dependencies:
  - name: vesta
    version: 0.4.1
    repository: oci://ghcr.io/clnv/charts
```

Put overrides under `vesta` in the parent `values.yaml`:

```yaml
global:
  environment: production

vesta:
  config:
    data:
      server:
        external_url: https://logs.example.com
```

Helm's injected `global` object is accepted with schema validation enabled.

## Values

Every value has a default, so no override is required to render the chart. “Conditional” means the field is required when the related feature or authentication mode is used.

### Workload

| Field | Requirement | Description |
| --- | --- | --- |
| `replicaCount` | Required; fixed | Must remain `1` because Vesta uses local SQLite state. |
| `api.image.repository`, `api.image.tag`, `api.image.pullPolicy` | Optional | API image settings. |
| `web.image.repository`, `web.image.tag`, `web.image.pullPolicy` | Optional | Web image settings. |
| `api.resources`, `web.resources` | Optional | Container requests and limits. |
| `api.livenessProbe`, `api.readinessProbe`, `api.startupProbe` | Optional | API health probes. |
| `web.livenessProbe`, `web.readinessProbe`, `web.startupProbe` | Optional | Web health probes. |
| `imagePullSecrets` | Optional | Image registry Secret references. |
| `nameOverride`, `fullnameOverride` | Optional | Resource name overrides. |
| `serviceAccount.create`, `serviceAccount.automount` | Optional | Create the account and mount its token. |
| `serviceAccount.name` | Optional | Account name override; uses `default` when creation is disabled and no name is set. |
| `serviceAccount.annotations` | Optional | ServiceAccount annotations. |
| `podAnnotations`, `podLabels` | Optional | Additional Pod metadata. |
| `podSecurityContext`, `securityContext` | Optional | Pod and container security settings. |
| `terminationGracePeriodSeconds`, `revisionHistoryLimit` | Optional | Deployment lifecycle settings. |

### Service and ingress

| Field | Requirement | Description |
| --- | --- | --- |
| `service.type`, `service.port`, `service.annotations` | Optional | Service configuration. |
| `ingress.enabled` | Optional | Creates an Ingress when `true`. |
| `ingress.className`, `ingress.annotations`, `ingress.tls` | Optional | Ingress class, metadata, and TLS entries. |
| `ingress.hosts[].host` | Conditional | Required for each host when Ingress is enabled. |
| `ingress.hosts[].paths[].path`, `pathType` | Conditional | Required for each Ingress path. |

### Persistence

| Field | Requirement | Description |
| --- | --- | --- |
| `persistence.enabled` | Optional | Creates or mounts persistent SQLite storage when `true`. |
| `persistence.existingClaim` | Optional | Uses an existing PVC instead of creating one. |
| `persistence.storageClass`, `persistence.accessModes`, `persistence.size` | Conditional | Chart-managed PVC settings. |
| `persistence.annotations` | Optional | Chart-managed PVC annotations. |

### Vesta configuration

| Field | Requirement | Description |
| --- | --- | --- |
| `config.existingConfigMap` | Optional | Uses an existing ConfigMap containing `config.yml`; when set, `config.data` is ignored. |
| `config.data.server.listen` | Optional | API listen address. |
| `config.data.server.external_url` | Required | Public URL used by Vesta. |
| `config.data.auth.session_secret_env` | Optional | Environment variable holding the generated or supplied session secret. |
| `config.data.auth.session_ttl` | Optional | Login session lifetime. |
| `config.data.auth.bootstrap.email`, `name`, `team`, `roles` | Required | Initial administrator identity, team, and access roles. |
| `config.data.auth.bootstrap.password_env` | Required | Environment variable holding the generated or supplied bootstrap password. |
| `config.data.storage.path` | Required | SQLite database path. |
| `config.data.storage.share_ttl` | Optional | Shared-query lifetime. |
| `config.data.limits.*` | Optional | Query timeout, row, byte, concurrency, and line-size limits. |
| `config.data.sources` | Required | At least one VictoriaLogs or vmauth source. |
| `config.data.sources[].id`, `name`, `url`, `roles` | Required | Source identity, endpoint, and allowed roles. |
| `config.data.sources[].auth.type` | Optional | `none`, `basic`, or `bearer`. |
| `config.data.sources[].auth.username_env`, `password_env` | Conditional | Required for `basic` authentication. |
| `config.data.sources[].auth.token_env` | Conditional | Required for `bearer` authentication. |
| `config.data.sources[].account_id`, `project_id` | Conditional | Optional routing pair; set both or neither. |
| `config.data.sources[].hidden_fields` | Optional | Exact field names or suffix-wildcard patterns hidden from users. |

### Secrets and extensions

| Field | Requirement | Description |
| --- | --- | --- |
| `secret.create` | Optional | Creates a Secret when `true`; defaults to `true`. |
| `secret.existingSecret` | Conditional | Required only when `secret.create` is `false`. |
| `secret.annotations` | Optional | Chart-managed Secret annotations. |
| `secret.data` | Optional | Extra environment variables. Omitted `VESTA_SESSION_SECRET` and `VESTA_BOOTSTRAP_PASSWORD` are generated and retained across upgrades. |
| `extraEnv`, `extraEnvFrom` | Optional | Additional API container environment configuration. |
| `extraVolumes`, `extraVolumeMounts` | Optional | Additional API container volumes and mounts. |

### Scheduling and availability

| Field | Requirement | Description |
| --- | --- | --- |
| `nodeSelector`, `tolerations`, `affinity`, `topologySpreadConstraints` | Optional | Pod scheduling controls. |
| `podDisruptionBudget.enabled` | Optional | Creates a PodDisruptionBudget when `true`. |
| `podDisruptionBudget.minAvailable` | Conditional | Required when the PodDisruptionBudget is enabled. |
| `autoscaling.enabled` | Required; fixed | Must remain `false` while Vesta uses local SQLite state. |
| `autoscaling.minReplicas`, `maxReplicas`, `targetCPUUtilizationPercentage` | Unused | Reserved values; autoscaling is rejected. |

Validate the final values with:

```sh
helm lint --strict ./charts/vesta
helm template vesta ./charts/vesta
```
