# Phase 0 Backend Evidence Pack (API)

This document captures **Phase 0** backend behaviour and evidence for the API service (`apps/api`).

Phase 0 focuses on three core flows:

1. **Health checks**  
   - Non-DB health (`/health` in default mode)  
   - DB-backed health (`/health` with DB check enabled)

2. **Version endpoint + hello audit emission**  
   - `/version` returns version metadata  
   - When enabled, each call emits a `HELLO_AUDIT_EVENT` into Postgres

3. **Hello audit evidence endpoint**  
   - `/audit/hello/latest` surfaces the latest `HELLO_AUDIT_EVENT` for demo/audit use

All flows are backed by **unit tests, integration tests, acceptance tests, and CI jobs**. Phase 0 is **pre-RBAC**: these endpoints are unauthenticated and intended for dev/CI/staging only.

---

## 1. Endpoints & Flags Overview

### 1.1 Endpoints

| Endpoint                 | Purpose                                             |
|--------------------------|-----------------------------------------------------|
| `GET /health`           | Basic and DB-backed health checks                   |
| `GET /version`          | Service metadata + optional hello audit emission    |
| `GET /audit/hello/latest` | Evidence endpoint for latest `HELLO_AUDIT_EVENT` |

### 1.2 Key environment flags

| Flag                          | Type    | Effect                                                                                                  |
|-------------------------------|---------|---------------------------------------------------------------------------------------------------------|
| `API_USE_DB_HEALTH`           | boolean | When `'true'`, `/health` performs a DB check and returns `"db": "up" \| "down"`                         |
| `ENABLE_HELLO_AUDIT`          | boolean | When `'true'`, `/version` writes `HELLO_AUDIT_EVENT` audit rows                                         |
| `ENABLE_HELLO_AUDIT_ENDPOINT` | boolean | When `'true'`, enables `/audit/hello/latest`; otherwise the route behaves as not present (404)         |
| `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` | string | Connection config for Postgres                                    |
| `NODE_ENV`                    | string  | Environment label; returned as `env` field in `/version` payload                                       |

---

## 2. Flow 1 – `/health` (non-DB and DB-backed)

### 2.1 Purpose

Show that the API is alive, and when configured, confirm connectivity to Postgres. Phase 0 provides:

- A **simple health** mode (no DB dependency).
- A **DB-backed health** mode that proves the Postgres check works end-to-end.

### 2.2 Endpoint

- **Method:** `GET`
- **Path:** `/health`

### 2.3 Behaviour – Non-DB mode (default)

**Configuration**

- `API_USE_DB_HEALTH` is **unset** or not exactly `'true'`.

**Response**

- **Status:** `200`
- **Body:**

  ```json
  {
    "status": "ok"
  }
