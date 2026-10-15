{{/* Labels on every object, so you can find everything this release made */}}
{{- define "flashcards.labels" -}}
app.kubernetes.io/name: flashcards
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* Labels a Service or Deployment uses to find its pods. These must never change after the first install. */}}
{{- define "flashcards.selectorLabels" -}}
app.kubernetes.io/name: flashcards
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Full image name. Usage: include "flashcards.image" (list . "api") */}}
{{- define "flashcards.image" -}}
{{- $root := index . 0 -}}
{{- $app := index . 1 -}}
{{- with $root.Values.image.registry }}{{ . }}/{{ end }}flashcards-{{ $app }}:{{ required "image.tag is required" $root.Values.image.tag }}
{{- end }}

{{/* Restarts api and worker pods when the ConfigMap changes */}}
{{- define "flashcards.configChecksum" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- end }}

{{/* The api and worker images run as appuser (UID 1000) */}}
{{- define "flashcards.pythonSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/* Secret env vars, each one picked from the existing Secret by key */}}
{{- define "flashcards.secretEnv" -}}
{{- $secret := index . 0 -}}
{{- range $key := index . 1 }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $key }}
{{- end }}
{{- end }}
