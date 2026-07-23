{{/* Expand the chart name. */}}
{{- define "vesta.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Create a stable, DNS-safe release name. */}}
{{- define "vesta.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "vesta.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "vesta.labels" -}}
helm.sh/chart: {{ include "vesta.chart" . }}
{{ include "vesta.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "vesta.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vesta.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "vesta.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "vesta.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "vesta.configMapName" -}}
{{- default (include "vesta.fullname" .) .Values.config.existingConfigMap }}
{{- end }}

{{- define "vesta.secretName" -}}
{{- default (include "vesta.fullname" .) .Values.secret.existingSecret }}
{{- end }}
