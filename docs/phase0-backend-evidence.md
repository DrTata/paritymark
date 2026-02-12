# Phase 0 Backend Evidence — Audit & Health

**Project**: ParityMark  
**Phase**: 0 — Minimal backend audit scaffolding + health/version endpoints  
**Scope**: `apps/api` only; no frontend/UI changes in this phase.

---

## 1. Objective & Scope

### 1.1 Objective

Implement and verify a minimal backend audit and health/version foundation:

- `/health` endpoint:
  - Simple (non-DB) mode.
  - DB-backed mode (Postgres health check).
- `/version` endpoint:
  - Returns API service metadata.
  - Optionally emits a `HELLO_AUDIT_EVENT` into Postgres when enabled.
- `/audit/hello/latest` endpoint:
  - Dev-only evidence endpoint to read back the latest `HELLO_AUDIT_EVENT`.

This file documents what is **actually implemented and tested** in Phase 0, and what is **explicitly not yet implemented**.

### 1.2 Out of Scope (Phase 0)

The following are **not** implemented or changed in this phase:

- No new web UI pages or flows.
- No RBAC/auth changes; all endpoints remain unauthenticated.
- No ConfigVersion/Deployment/ConfigArtifact implementation.
- No Cucumber/acceptance tests added or modified.
- No allocation/marking/standardisation/seeding/exports/multilingual features.
- No infra changes beyond existing GitHub Actions workflows (except adding the `docs-check` job that enforces the existence of this file).

---

## 2. Implemented Behaviour (Backend)

### 2.1 `/health` (apps/api)

- **Handler**: `apps/api/src/health.js`  
- **DB helper**: `apps/api/src/db.js`  

#### Behaviour

- **Default (non-DB) mode** (`API_USE_DB_HEALTH !== 'true'`):

  - `GET /health` → `200` with:

    ```json
    { "status": "ok" }
    ```

- **DB-backed mode** (`API_USE_DB_HEALTH='true'` and valid DB env vars):

  - Required environment variables:

    - `DB_HOST`
    - `DB_PORT`
    - `DB_USER`
    - `DB_PASSWORD`
    - `DB_NAME`

  - If Postgres is reachable:

    ```json
    { "status": "ok", "db": "up" }
    ```

  - If the Postgres health check fails:

    ```json
    { "status": "error", "db": "down" }
    ```

  - HTTP status:

    - `200` when DB is healthy.
    - `500` when DB is unhealthy or unreachable in DB-backed mode.

#### DB lifecycle helper (`apps/api/src/db.js`)

- Exports a singleton `pool` (pg `Pool` instance).
- `checkDbHealth()` executes `SELECT 1` to verify connectivity.
- `endPool()` cleanly closes the pool:
  - Guarded by a `poolEnded` flag so multiple calls are safe.
  - Used in integration tests’ `afterAll` to avoid Jest open-handle warnings/hangs.

---

### 2.2 `/version` and `HELLO_AUDIT_EVENT` (apps/api)

- **Handler**: `apps/api/src/version.js`  
- **Audit module**: `apps/api/src/audit.js`  

#### Base `/version` behaviour

- `GET /version` returns JSON derived from `apps/api/package.json` and environment:

  ```json
  {
    "service": "api",
    "name": "api",
    "version": "0.1.0",
    "env": "development"
  }
