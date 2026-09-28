# SPEC: Telemetry via OpenTelemetry

## 1. Objetivo

Coletar dados de uso do **Kiro Update Checker** (plataforma, versão do Kiro, comportamento de update) via OpenTelemetry, com backend self-hosted em Docker. O usuário mantém total controle sobre os dados.

## 2. Viabilidade

### O que é permitido no VS Code/Kiro

- **`vscode.env.isTelemetryEnabled`** — boolean que indica se o usuário optou por enviar telemetria (respeita a config `telemetry.telemetryLevel` do VS Code/Kiro)
- **`vscode.env.onDidChangeTelemetryEnabled`** — evento que notifica mudanças na preferência
- **`fetch()`** — extensions VS Code rodam em Node.js com acesso a `fetch()` para enviar dados customizados para qualquer endpoint

### Abordagem escolhida

**OTLP HTTP customizado** (não usa `@vscode/extension-telemetry` nem `createTelemetryLogger`)

| Abordagem | Endpoint | Controle do usuário |
|---|---|---|
| `@vscode/extension-telemetry` | Azure Application Insights | ❌ dados vão para cloud Microsoft/AWS |
| `vscode.env.createTelemetryLogger()` | Microsoft telemetry | ❌ dados vão para cloud Microsoft/AWS |
| **OTLP HTTP customizado** | **Endpoint próprio** | **✅ dados ficam no infra do usuário** |

**Justificativa:** O usuário quer um stack OpenTelemetry self-hosted. OTLP HTTP direto é leve (sem SDK pesado), sem dependências extras, e totalmente controlável.

## 3. Arquitetura

```
┌─────────────────────────────────────────────────────┐
│  Kiro (VS Code fork)                                │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  kiro-update-checker extension                │  │
│  │                                               │  │
│  │  telemetry.ts                                 │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │ ● initCollector(url, headers)           │  │  │
│  │  │ ● emit(event, attributes)               │  │  │
│  │  │ ● isConsented() → vscode.env check     │  │  │
│  │  │ ● flush() / dispose()                   │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └──────────────────────┬────────────────────────┘  │
│                         │ POST /v1/traces           │
└─────────────────────────┼───────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│  Docker Compose                                     │
│                                                     │
│  ┌─────────────────────┐   ┌─────────────────────┐  │
│  │  OTel Collector     │──▶│  Jaeger             │  │
│  │  :4318 (OTLP HTTP)  │   │  :16686 (UI)        │  │
│  │  :8888 (metrics)    │   │  :4317 (OTLP gRPC)  │  │
│  └─────────┬───────────┘   └─────────────────────┘  │
│            │                                         │
│            ▼                                         │
│  ┌─────────────────────┐   ┌─────────────────────┐  │
│  │  Prometheus         │   │  Grafana (optional) │  │
│  │  :9090              │   │  :3000              │  │
│  └─────────────────────┘   └─────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## 4. Eventos de Telemetria

### 4.1 `extension.activated`

| Atributo | Tipo | Descrição |
|---|---|---|
| `platform.os` | string | `win32`, `darwin`, `linux` |
| `platform.arch` | string | `x64`, `arm64` |
| `platform.distro` | string? | Nome da distro Linux (ex: `Ubuntu 22.04`) |
| `kiro.version` | string | Versão atual do Kiro |
| `extension.version` | string | Versão da extensão |
| `kiro.productName` | string | Nome do produto (`"Kiro IDE"`, `"Visual Studio Code"`, etc) |

### 4.2 `update.check`

| Atributo | Tipo | Descrição |
|---|---|---|
| `check.source` | string | `startup`, `interval`, `manual` |
| `update.available` | boolean | Se há versão mais nova disponível |
| `update.currentVersion` | string | Versão atual |
| `update.latestVersion` | string | Versão mais recente (ou `""` se não disponível) |
| `update.delta` | string? | Diff de versões (ex: `"0.2.2" → "0.3.0"`) |

### 4.3 `update.download`

| Atributo | Tipo | Descrição |
|---|---|---|
| `download.platform` | string | Plataforma alvo |
| `download.format` | string | `exe`, `dmg`, `deb`, `tar.gz` |
| `download.success` | boolean | Se o download foi bem-sucedido |
| `download.sizeBytes` | number? | Tamanho do arquivo em bytes |
| `download.durationMs` | number? | Duração do download em ms |
| `download.errorCode` | string? | Código de erro se falhou |

### 4.4 `update.install`

| Atributo | Tipo | Descrição |
|---|---|---|
| `install.method` | string | `terminal`, `finder`, `xdg-open` |
| `install.success` | boolean | Se a instalação foi iniciada |
| `install.errorCode` | string? | Código de erro se falhou |

### 4.5 `update.dismissed`

| Atributo | Tipo | Descrição |
|---|---|---|
| `dismiss.version` | string | Versão que o usuário dispensou |

## 5. Schema OTLP (Traces → Spans)

Cada evento é um **span** dentro de uma **trace** por sessão de extensão.

```
Trace: kiro-update-checker/{session-id}
  └─ Span: extension.activated
  └─ Span: update.check (check.source=startup)
  └─ Span: update.check (check.source=interval)
  └─ Span: update.download
  └─ Span: update.install
```

### Exemplo payload OTLP HTTP

```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        { "key": "service.name", "value": { "stringValue": "kiro-update-checker" } },
        { "key": "service.version", "value": { "stringValue": "0.3.0" } },
        { "key": "platform.os", "value": { "stringValue": "win32" } },
        { "key": "platform.arch", "value": { "stringValue": "x64" } },
        { "key": "kiro.version", "value": { "stringValue": "1.2.3" } }
      ]
    },
    "scopeSpans": [{
      "scope": { "name": "kiro-update-checker" },
      "spans": [{
        "traceId": "abc123...",
        "spanId": "def456...",
        "name": "update.check",
        "kind": 1,
        "startTimeUnixNano": "1692000000000000000",
        "endTimeUnixNano": "1692000000100000000",
        "attributes": [
          { "key": "check.source", "value": { "stringValue": "startup" } },
          { "key": "update.available", "value": { "boolValue": true } },
          { "key": "update.currentVersion", "value": { "stringValue": "0.2.2" } },
          { "key": "update.latestVersion", "value": { "stringValue": "0.3.0" } }
        ],
        "status": { "code": 1 }
      }]
    }]
  }]
}
```

## 6. Docker Compose

### Estrutura de arquivos

```
docker/
├── docker-compose.yml
├── collector/
│   └── config.yml          # OTel Collector config
└── grafana/
    └── provisioning/        # dashboards (opcional)
```

### docker-compose.yml

```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.110.0
    container_name: kuc-otel-collector
    command: ["--config=/etc/otelcol/config.yml"]
    volumes:
      - ./collector/config.yml:/etc/otelcol/config.yml
    ports:
      - "4318:4318"   # OTLP HTTP receiver
      - "8888:8888"   # Collector internal metrics (Prometheus)
      - "13133:13133" # Health check
    restart: unless-stopped

  jaeger:
    image: jaegertracing/all-in-one:1.62
    container_name: kuc-jaeger
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    ports:
      - "16686:16686" # Jaeger UI
      - "4317:4317"   # OTLP gRPC (alternative)
    restart: unless-stopped

  prometheus:
    image: prom/prometheus:v2.54.0
    container_name: kuc-prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    restart: unless-stopped

  grafana:
    image: grafana/grafana:11.2.0
    container_name: kuc-grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    ports:
      - "3000:3000"
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      - prometheus
    restart: unless-stopped

volumes:
  grafana-data:
```

### collector/config.yml

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 100

exporters:
  debug:
    verbosity: basic

  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

  prometheus:
    endpoint: 0.0.0.0:8888
    namespace: kuc

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger, debug]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus, debug]
```

### prometheus.yml

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'otel-collector'
    static_configs:
      - targets: ['otel-collector:8888']
```

## 7. Privacidade e Consentimento

### Princípios

1. **Opt-in respeitado** — se `vscode.env.isTelemetryEnabled === false`, nada é enviado
2. **Sem PII** — nenhum nome de arquivo, caminho, IP, email ou dados identificáveis
3. **Endpoint configurável** — usuário define o endpoint em settings
4. **Dados no local** — tudo fica na infra Docker do usuário
5. **Retenção configurável** — definida no backend (Jaeger/Prometheus retention policies)

### Setting da extensão

```json
{
  "kiroUpdateChecker.telemetryEndpoint": {
    "type": "string",
    "default": "http://localhost:4318",
    "description": "Endpoint do coletor OpenTelemetry (OTLP HTTP). Deixe vazio para desativar."
  },
  "kiroUpdateChecker.telemetryEnabled": {
    "type": "boolean",
    "default": true,
    "description": "Enviar dados de telemetria para o coletor configurado."
  }
}
```

### Fluxo de consentimento

```
Extensão inicia
  → vscode.env.isTelemetryEnabled? ──false──▶ STOP (nada enviado)
  → telemetryEnabled setting? ──────false──▶ STOP
  → endpoint vazio? ────────────────true───▶ STOP
  → ✅ Enviar telemetria
```

## 8. Dependências (Extension)

```bash
npm install @opentelemetry/sdk-trace-base
npm install @opentelemetry/exporter-trace-otlp-http
```

> **Alternativa leve (sem SDK):** Usar `fetch()` direto para montar o payload OTLP HTTP. Economiza ~200KB no bundle. Recomendado para extensões VS Code.

### Opção leve: fetch direto (recomendada)

Sem dependências extras. Módulo `telemetry.ts` (~150 linhas) que:
1. Gera `traceId` e `spanId` aleatórios (crypto.randomUUID)
2. Monta o payload OTLP JSON inline
3. Envia via `fetch(url, { method: 'POST', body })`
4. Usa `setTimeout` para flush periódico (batch de 5-10 eventos)

## 9. Métricas Derivadas (Grafana Dashboard)

| Métrica | Tipo | Descrição |
|---|---|---|
| `kuc_checks_total` | Counter | Total de checks realizados |
| `kuc_updates_available_total` | Counter | Total de updates disponíveis encontrados |
| `kuc_downloads_total` | Counter | Total de downloads (por plataforma, resultado) |
| `kuc_downloads_duration_seconds` | Histogram | Duração dos downloads |
| `kuc_installs_total` | Counter | Total de installs iniciados |
| `kuc_users_by_os` | Gauge | Usuários ativos por SO |
| `kuc_users_by_kiro_version` | Gauge | Usuários ativos por versão do Kiro |

## 10. Estrutura de Arquivos Nova

```
src/
├── extension.ts          (existente — adicionar hooks de telemetry)
├── telemetry.ts          (NOVO — módulo de telemetria OTLP HTTP)
└── ...

docker/                   (NOVO)
├── docker-compose.yml
├── collector/
│   └── config.yml
├── prometheus.yml
└── grafana/
    └── provisioning/
        └── dashboards/
            └── kuc-overview.json
```

## 11. Versão

- **0.4.0** — versão semântica com feature de telemetry
- Breaking: adiciona novas settings (com defaults seguros, opt-in)

## 12. Checklist de Implementação

- [ ] Criar `src/telemetry.ts` (módulo OTLP HTTP leve via fetch)
- [ ] Integrar hooks no `extension.ts` (activated, check, download, install, dismiss)
- [ ] Adicionar settings `telemetryEndpoint` e `telemetryEnabled` ao `package.json`
- [ ] Traduzir novas settings nos 14 arquivos `package.nls.*.json`
- [ ] Criar `docker/docker-compose.yml`
- [ ] Criar `docker/collector/config.yml`
- [ ] Criar `docker/prometheus.yml`
- [ ] Criar dashboard Grafana (opcional)
- [ ] Documentar no README (nova feature + instruções Docker)
- [ ] Atualizar CHANGELOG
- [ ] Testar: Docker up → extensão envia → Jaeger mostra traces
- [ ] Atualizar `.vscodeignore` (não incluir `docker/` na VSIX)
- [ ] Bump versão para 0.4.0
