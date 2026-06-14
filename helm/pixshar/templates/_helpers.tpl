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

{{/* PVC name */}}
{{- define "pixshar.pvcName" -}}
{{- printf "%s-db" (include "pixshar.fullname" .) | trunc 63 | trimSuffix "-" }}
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
