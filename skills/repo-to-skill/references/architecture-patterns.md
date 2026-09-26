# Architecture Patterns — Classification Guide

Reference for Step 3 (Architecture Extraction) of the Codebase Constitution skill.

---

## Primary Architecture Styles

### 1. Monolith

**Key signals:**
- Single deployable unit (one Dockerfile, one build output)
- All domain code shares one database connection/config
- No inter-service HTTP calls at runtime
- Flat or shallow module structure

**File evidence patterns:**
```
src/
  controllers/
  models/
  views/
  helpers/
config/database.yml   ← single DB
```

### 2. Modular Monolith

**Key signals:**
- Clear domain folders with internal boundaries
- Shared infrastructure layer (database, auth)
- No inter-service network calls, but explicit module contracts
- Domain modules avoid importing from sibling modules directly

**File evidence patterns:**
```
src/
  domains/
    users/
    orders/
    payments/
  infrastructure/
    database/
    auth/
  shared/
```

### 3. Microservices

**Key signals:**
- Multiple service directories or repositories
- Service discovery config (Consul, Eureka, k8s Services)
- Inter-service HTTP/gRPC client code
- Per-service Dockerfile and CI pipeline

**File evidence patterns:**
```
services/
  user-service/
  order-service/
  payment-service/
docker-compose.yml    ← multiple services
k8s/
  user-deployment.yaml
  order-deployment.yaml
```

### 4. Serverless

**Key signals:**
- `functions/` or `handlers/` directory
- No long-running server process
- Event/trigger configuration (API Gateway, SQS, S3 events)
- Short execution time assumptions (no background workers)

**File evidence patterns:**
```
functions/
  createUser.ts
  processOrder.ts
serverless.yml  / wrangler.toml / fly.toml
```

### 5. Layered (N-Tier)

**Key signals:**
- Explicit layer folders: controllers → services → repositories → models
- Strict downward dependency (controllers don't touch DB directly)
- Dependency injection container

**File evidence patterns:**
```
src/
  controllers/
  services/
  repositories/
  models/
  dto/
```

### 6. Hexagonal (Ports & Adapters)

**Key signals:**
- `ports/` or `domain/` as the core
- `adapters/` or `infrastructure/` as outer ring
- Domain has zero external imports
- Interfaces defined in domain, implemented in adapters

**File evidence patterns:**
```
src/
  domain/
    ports/
    entities/
    use-cases/
  adapters/
    http/
    database/
    messaging/
  infrastructure/
```

### 7. Event-Driven

**Key signals:**
- Event bus setup (RabbitMQ, Kafka, Redis Streams, EventEmitter)
- `events/`, `listeners/`, `subscribers/`, `sagas/` directories
- Commands and events as first-class objects
- Eventual consistency patterns (outbox, saga)

**File evidence patterns:**
```
src/
  events/
  listeners/
  sagas/
  commands/
```

### 8. CQRS

**Key signals:**
- Separate read and write models
- `commands/` and `queries/` directories
- Projections / read models
- Different DB connections for reads vs writes

### 9. Pipeline / ETL

**Key signals:**
- Sequential processor stages
- `stages/`, `transformers/`, `processors/` directories
- Data flows in → transform → out
- No user-facing API

---

## Communication Pattern Detection

| Pattern | Evidence |
|---|---|
| REST | `fetch`, `axios`, `httpx`, `express.Router()`, OpenAPI spec |
| gRPC | `.proto` files, `grpc` package imports |
| GraphQL | `schema.graphql`, `resolvers/`, Apollo/Hasura |
| WebSockets | `ws`, `socket.io`, `WebSocket` usage |
| Message Queue | RabbitMQ, Kafka, SQS, Redis Streams client code |
| Direct DB | No service layer; controllers hit DB directly |
| RPC/tRPC | `trpc` imports, `router` definitions |

---

## Layer Boundary Scoring

For each layer, record:

```yaml
layer:
  name: ""
  responsible_for: []
  owns_directories: []
  imports_from: []         # allowed dependencies
  must_not_import: []      # boundary violations
  evidence: []
```

---

## Confidence Scoring

When architecture is ambiguous:

- **high**: > 5 strong signals, consistent across directories
- **medium**: 2–5 signals, some contradictions
- **low**: < 2 signals or significant inconsistency

Always list alternative candidates when confidence < high.
