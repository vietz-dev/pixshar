{{/*
Expand the name of the chart.
*/}}
{{- define "pixshar.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "pixshar.fullname" -}}
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

{{/* API component name */}}
{{- define "pixshar.api.fullname" -}}
{{- printf "%s-api" (include "pixshar.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Web component name */}}
{{- define "pixshar.web.fullname" -}}
{{- printf "%s-web" (include "pixshar.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Secret name */}}
{{- define "pixshar.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "pixshar.fullname" . }}
{{- end }}
{{- end }}

{{/* ConfigMap name */}}
{{- define "pixshar.configMapName" -}}
{{- printf "%s-config" (include "pixshar.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* PVC name (legacy; retained for compatibility) */}}
{{- define "pixshar.pvcName" -}}
{{- printf "%s-db" (include "pixshar.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Bundled Postgres component name */}}
{{- define "pixshar.postgres.fullname" -}}
{{- printf "%s-postgres" (include "pixshar.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Bundled Postgres secret name (chart-managed unless an existing secret is given) */}}
{{- define "pixshar.postgres.secretName" -}}
{{- if .Values.postgres.auth.existingSecret }}
{{- .Values.postgres.auth.existingSecret }}
{{- else }}
{{- include "pixshar.postgres.fullname" . }}
{{- end }}
{{- end }}

{{/*
DATABASE_URL env entries for the API + migrate initContainer. Branch order:
  1. postgres.enabled                         → bundled StatefulSet; password from chart secret.
  2. externalDatabase.existingSecret + URL key → full DSN pulled straight from a Secret (CNPG "uri").
  3. externalDatabase.existingSecret           → assembled DSN; password from a Secret key via $(VAR).
  4. otherwise                                 → assembled DSN from parts, no secret.
Renders cleanly with defaults (no DB configured) so `helm template`/lint pass; a real
deploy is expected to pick one of branches 1–3.
*/}}
{{- define "pixshar.databaseEnv" -}}
{{- if .Values.postgres.enabled }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "pixshar.postgres.secretName" . }}
      key: password
- name: DATABASE_URL
  value: "postgresql://{{ .Values.postgres.auth.username }}:$(POSTGRES_PASSWORD)@{{ include "pixshar.postgres.fullname" . }}:5432/{{ .Values.postgres.auth.database }}?schema=public"
{{- else if and .Values.externalDatabase.existingSecret .Values.externalDatabase.existingSecretUrlKey }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.externalDatabase.existingSecret }}
      key: {{ .Values.externalDatabase.existingSecretUrlKey }}
{{- else if .Values.externalDatabase.existingSecret }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.externalDatabase.existingSecret }}
      key: {{ .Values.externalDatabase.existingSecretPasswordKey }}
- name: DATABASE_URL
  value: "postgresql://{{ .Values.externalDatabase.username }}:$(POSTGRES_PASSWORD)@{{ .Values.externalDatabase.host }}:{{ .Values.externalDatabase.port }}/{{ .Values.externalDatabase.database }}?sslmode={{ .Values.externalDatabase.sslmode }}"
{{- else }}
- name: DATABASE_URL
  value: "postgresql://{{ .Values.externalDatabase.username }}@{{ .Values.externalDatabase.host }}:{{ .Values.externalDatabase.port }}/{{ .Values.externalDatabase.database }}?sslmode={{ .Values.externalDatabase.sslmode }}"
{{- end }}
{{- end }}

{{/* Chart name and version */}}
{{- define "pixshar.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels */}}
{{- define "pixshar.labels" -}}
helm.sh/chart: {{ include "pixshar.chart" . }}
{{ include "pixshar.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels */}}
{{- define "pixshar.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pixshar.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* API selector labels */}}
{{- define "pixshar.api.selectorLabels" -}}
{{ include "pixshar.selectorLabels" . }}
app.kubernetes.io/component: api
{{- end }}

{{/* Web selector labels */}}
{{- define "pixshar.web.selectorLabels" -}}
{{ include "pixshar.selectorLabels" . }}
app.kubernetes.io/component: web
{{- end }}

{{/* Service account name */}}
{{- define "pixshar.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "pixshar.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
