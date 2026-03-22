# Vare AI — Lovable Build Instructions

Paste everything below this line into Lovable.

---

Build the Vare AI frontend. It is a multi-tenant feed management platform for merchants who want to sell through AI agents (ChatGPT, Claude, etc.). The backend API is fully built and live. Wire up every screen to real data — no mocks.

---

## API

**Base URL** (use this until the production URL is ready):
```
https://7c5bc484-c306-4ba2-bb1f-64010814d3cf-00-tlp0xr8xs78q.picard.replit.dev/api
```

**Every request** (except `POST /onboarding/merchant` and `POST /test/seed-mock-data`) needs:
```
Authorization: Bearer <apiKey>
```

**All responses** follow this envelope:
```json
{ "data": { ... }, "generated_at": "..." }           // single object
{ "data": [ ... ], "total": 0, "page": 1, "limit": 20 } // paginated list
{ "error": "message", "code": "ERROR_CODE" }          // error
```

On any `401` response → clear localStorage and redirect to `/register`.

---

## Bootstrap: get demo data

Call this once on first load if there is no `apiKey` in localStorage. It creates a merchant pre-loaded with 50 000 products and 30 days of analytics:

```
POST /api/test/seed-mock-data
Content-Type: application/json

{ "force": false }
```

Response:
```json
{ "data": { "merchantId": "...", "apiKey": "vare_test_sk_..." } }
```

Save both to localStorage. Use `apiKey` as the Bearer token for all further calls.

---

## Auth store

```ts
// Zustand or React Context
{
  merchantId: string | null     // from localStorage
  apiKey: string | null         // from localStorage — inject as Bearer token
  currentPhase: number          // 1–10, from GET /api/onboarding/phase
  percentComplete: number
  isLive: boolean
  sourceType: "magento" | "csv" | null
}
```

On every app load: read `apiKey` from localStorage → call `GET /api/onboarding/phase` to rehydrate. If 401, clear and redirect to `/register`.

---

## Routes

```
/register                         Create merchant account
/onboarding                       Wizard shell — phases 1–10
/onboarding/source                Choose Magento or CSV (phase 1 → 2 branch)
/onboarding/magento/connect       Magento credentials (phase 2)
/onboarding/magento/test          Connection test result (phase 3)
/onboarding/magento/store-views   Select store views (phase 4)
/onboarding/magento/sync-config   Sync filters (phase 5)
/onboarding/magento/sync          Sync progress (phase 6)
/onboarding/csv/upload            File drop zone (phase 2)
/onboarding/csv/map               Column mapping table (phase 3)
/onboarding/csv/import            Import progress (phase 6)
/onboarding/normalization         Attribute heatmap + normalize (phase 7–8)
/onboarding/agent-config          Slug, keys, rate limits (phase 9)
/onboarding/review                Pre-launch checklist (phase 10)
/dashboard                        KPI overview (guard: isLive must be true)
/dashboard/transactions           Event log
/dashboard/feeds                  Catalog health
/dashboard/bot-defense            Bot defense
/dashboard/insights               AI narrative
/catalog                          Product browser
/settings                         Agent config + API keys
```

---

## Screen 1 — /register

Form fields: Company Name (required), Contact Email (required), Contact Name (required), Contact Phone (optional).

```
POST /api/onboarding/merchant
Body: { companyName, contactEmail, contactName, contactPhone }
```

On success: save `merchantId` + `apiKey` to localStorage. Show a one-time modal: "Your API key — copy it now, it won't be shown again" with a copy button. Redirect → `/onboarding/source`.

---

## Screen 2 — /onboarding (wizard shell)

Left sidebar: vertical stepper built from the `checklist` array returned by `GET /api/onboarding/phase`. Each item shows a green checkmark if `complete: true`, a pulsing dot for the current step, and a lock icon for future steps. Progress bar at the top shows `percentComplete`%.

Call `GET /api/onboarding/phase` on mount of every wizard step and after every wizard action to keep phase state fresh.

Phase response:
```json
{
  "data": {
    "currentPhase": 3,
    "totalPhases": 10,
    "label": "Columns Mapped",
    "percentComplete": 30,
    "sourceType": "csv",
    "isLive": false,
    "nextAction": "POST /api/onboarding/csv/uploads/:id/import",
    "checklist": [
      { "phase": 1, "label": "Merchant Profile",  "complete": true  },
      { "phase": 2, "label": "CSV Uploaded",      "complete": true  },
      { "phase": 3, "label": "Columns Mapped",    "complete": true  },
      { "phase": 4, "label": "Ready to Import",   "complete": false, "nextAction": "..." }
    ]
  }
}
```

Smart routing on load — use `currentPhase` + `sourceType` to land the user on the right step:

| Phase | magento route | csv route |
|-------|--------------|-----------|
| 1 | `/onboarding/source` | `/onboarding/source` |
| 2 | `/onboarding/magento/connect` | `/onboarding/csv/upload` |
| 3 | `/onboarding/magento/test` | `/onboarding/csv/map` |
| 4 | `/onboarding/magento/store-views` | `/onboarding/csv/import` |
| 5 | `/onboarding/magento/sync-config` | `/onboarding/csv/import` |
| 6 | `/onboarding/magento/sync` | `/onboarding/csv/import` |
| 7–8 | `/onboarding/normalization` | same |
| 9 | `/onboarding/agent-config` | same |
| 10 | `/onboarding/review` | same |

---

## Screen 3 — /onboarding/source

Two large cards side by side. No API call — just navigate.

- **Connect Magento** → `/onboarding/magento/connect`
- **Upload CSV** → `/onboarding/csv/upload`

---

## Screen 4 — Magento path: /onboarding/magento/connect

Form: Magento Base URL (url input), API Username, API Password (password input).

```
POST /api/onboarding/connect
Body: { baseUrl, apiUser, apiPassword }
```

On success → `/onboarding/magento/test`.

---

## Screen 5 — Magento path: /onboarding/magento/test

On mount, fire automatically:
```
POST /api/onboarding/connect/test
```

States:
- Loading: spinner + "Testing connection…"
- Success: green card — show `magentoVersion`, `storeCount`, `catalogSize`. Button "Continue" → `/onboarding/magento/store-views`
- Error: red card + "Edit Credentials" button → back

---

## Screen 6 — Magento path: /onboarding/magento/store-views

On mount: `GET /api/onboarding/connect/store-views` — renders as checkbox list, pre-select all.

```
PATCH /api/onboarding/connect/store-views
Body: { storeViewIds: ["default", "us_en"] }
```

On success → `/onboarding/magento/sync-config`.

---

## Screen 7 — Magento path: /onboarding/magento/sync-config

Form: categories (comma-separated), max SKU count, sync interval (select: hourly/daily/weekly), include out-of-stock (toggle).

```
POST /api/onboarding/sync/configure
Body: { categories, maxSkuCount, syncInterval, includeOutOfStock }
```

On success → `/onboarding/magento/sync` and start sync automatically.

---

## Screen 8 — Magento path: /onboarding/magento/sync

On mount trigger: `POST /api/onboarding/sync/start` `{ mode: "full" }`.  
Poll `GET /api/onboarding/sync/status` every 3 seconds.

Show: circular progress ring with `progressPercent`%, synced/total/failed counters, ETA.  
Buttons: Pause (`POST /api/onboarding/sync/pause`), Cancel (`POST /api/onboarding/sync/cancel`).  
On `status: "completed"` → auto-navigate to `/onboarding/normalization`.

---

## Screen 9 — CSV path: /onboarding/csv/upload

Drag-and-drop zone. Accepted: `.csv`, `.txt`. Max 50 MB. Tip: "First row must be column headers."

**IMPORTANT — do NOT use FormData / multipart upload. Use this JSON endpoint instead:**

```
POST /api/onboarding/csv/upload-json
Content-Type: application/json
Authorization: Bearer <apiKey>

{ "filename": "products.csv", "content": "<base64>", "encoding": "base64" }
```

Convert the `File` to base64 in JavaScript:
```js
const buffer = await file.arrayBuffer();
const content = btoa(String.fromCharCode(...new Uint8Array(buffer)));
// then POST { filename: file.name, content, encoding: "base64" }
```

Success response:
```json
{
  "data": {
    "uploadId": "uuid",
    "headers": ["SKU", "Product Name", "Price"],
    "rowCount": 4200,
    "suggestions": [
      { "csvHeader": "SKU",          "vareField": "sku",   "confidence": "high" },
      { "csvHeader": "Product Name", "vareField": "name",  "confidence": "high" },
      { "csvHeader": "Notes",        "vareField": null,    "confidence": "low"  }
    ]
  }
}
```

On success: save `uploadId` to sessionStorage, toast "4,200 rows detected →", navigate to `/onboarding/csv/map?uploadId=<id>`.

Also show previous uploads table below the drop zone: `GET /api/onboarding/csv/uploads`.

---

## Screen 10 — CSV path: /onboarding/csv/map

On mount:
```
GET /api/onboarding/csv/uploads/:uploadId
GET /api/onboarding/csv/fields
```

`/csv/fields` returns the full list of Vare field targets for the dropdown:
```json
{ "data": { "fields": [{ "field": "sku", "label": "SKU", "required": true }, ...] } }
```

Render a table — one row per CSV header column:

| Column header | Map To (dropdown) |
|---------------|-------------------|
| SKU | `[SKU ▾]` — auto-filled if confidence = "high" |
| Product Name | `[Product Name ▾]` — auto-filled |
| Notes | `[— Select field — ▾]` — blank if confidence = "low" |

Dropdown options = all fields from `/csv/fields` + "Skip this column" (value: `null`).  
Auto-fill any `confidence: "high"` suggestion.  
Show orange badge on `sku` and `name` rows until they are mapped (both required).

```
POST /api/onboarding/csv/uploads/:uploadId/mappings
Body: {
  "mappings": [
    { "csvHeader": "SKU",   "vareField": "sku"  },
    { "csvHeader": "Notes", "vareField": null   }
  ]
}
```

On success → `/onboarding/csv/import?uploadId=<id>`.

---

## Screen 11 — CSV path: /onboarding/csv/import

On mount, trigger import if status is `mapped`:
```
POST /api/onboarding/csv/uploads/:uploadId/import
```

Poll `GET /api/onboarding/csv/uploads/:uploadId` every 2 seconds.

| status | UI |
|--------|----|
| `importing` | Indeterminate progress bar |
| `completed` | Green card — `importedCount` imported, `errorCount` skipped |
| `failed` | Red card |

If `errorCount > 0` show "View errors" → `GET /api/onboarding/csv/uploads/:uploadId/errors` (table: row number + error message).  
On completed: "Continue to Normalization" → `/onboarding/normalization`.

---

## Screen 12 — /onboarding/normalization (phase 7–8)

On mount: `GET /api/onboarding/normalization/status` + `GET /api/onboarding/health-scan`.

Health scan card (top): 4 score pills from `dimensions` object (title quality, description coverage, brand coverage, image coverage). Color: green ≥ 80, amber 50–79, red < 50.

```
GET /api/onboarding/health-scan
→ { "data": { "readinessScore": 72, "dimensions": { "titleQuality": 80, ... }, "issues": [...] } }
```

Normalization section:
- If `status === "idle"` or `"completed"`: "Run Normalization" button
- If `status === "running"`: progress bar, poll every 3 seconds

```
POST /api/onboarding/normalization/run
GET /api/onboarding/normalization/status
→ { "data": { "status": "running", "progressPercent": 42, "normalizedCount": 21000, "totalProducts": 50000 } }
```

Attribute mappings tab below:
```
POST /api/onboarding/normalization/attribute-mappings/discover
GET /api/onboarding/normalization/attribute-mappings
PATCH /api/onboarding/normalization/attribute-mappings/:id   { status: "approved" | "rejected" }
```

Table: source attribute → Vare field → status → Approve / Reject buttons.  
"Continue" button → `/onboarding/agent-config`.

---

## Screen 13 — /onboarding/agent-config (phase 9)

On mount: `GET /api/onboarding/agent-config`.

**Slug field** (required first):
- Text input, lowercase + hyphens only
- `POST /api/onboarding/agent-config/set-slug` `{ slug }`
- Show live preview: `https://api.vare-ai.com/v1/merchants/<slug>/catalog`

**Settings form** (submit via `PATCH /api/onboarding/agent-config`):
- Rate limit per minute: number 1–1000
- Require cart confirmation: toggle
- Max order value: money input + "No limit" toggle (null)
- Allowed platforms: chip picker — `chatgpt`, `claude`, `gemini`, `openai`
- Enabled capabilities: toggles — `catalog_search`, `order_placement`, `inventory_check`
- Sandbox mode: toggle

**API key section**:
- Show last 4 chars hint from `apiKeyHint`
- "Rotate Test Key" → `POST /api/onboarding/agent-config/generate-key` `{ mode: "test" }`
- "Generate Live Key" → same endpoint `{ mode: "live" }`
- On rotation: one-time modal with full key + copy button. Warning: "Store this key securely."

"Continue" → `/onboarding/review`.

---

## Screen 14 — /onboarding/review (phase 10)

On mount: `GET /api/onboarding/review`.

```json
{
  "data": {
    "ready": true,
    "checks": [
      { "key": "has_products",      "label": "Catalog imported",        "pass": true,  "detail": "50,000 products" },
      { "key": "has_normalization", "label": "Products normalized",      "pass": true  },
      { "key": "has_slug",          "label": "Agent slug configured",    "pass": true,  "detail": "my-store" },
      { "key": "has_agent_config",  "label": "Agent settings confirmed", "pass": true  },
      { "key": "has_api_key",       "label": "Live API key generated",   "pass": false, "detail": "Generate a live key first" }
    ]
  }
}
```

Each check = row with green checkmark or red X. If `pass: false` show `detail` in red.  
"Go Live" button disabled if `ready: false`.

```
POST /api/onboarding/activate
```

On success: confetti, redirect → `/dashboard`.

---

## Screen 15 — /dashboard (KPI overview)

Guard: if `isLive === false` redirect → `/onboarding`. If no `apiKey` → `/register`.

Date range picker at top (Today / 7d / 30d / 90d / YTD) — passes `?range=` to all calls.

**KPI cards row** — call `GET /api/metrics/kpi?range=30d`:
```json
{
  "data": {
    "totalQueries":  { "value": 28450, "change": 12.4, "sparkline": [210, 230, ...] },
    "matchRate":     { "value": 87.3,  "change": 2.1,  "sparkline": [...] },
    "totalOrders":   { "value": 734,   "change": -3.2, "sparkline": [...] },
    "revenue":       { "value": 182450,"change": 8.7,  "sparkline": [...] },
    "avgOrderValue": { "value": 248.57,"change": 1.1,  "sparkline": [...] }
  }
}
```

5 cards in a row. Each: label, formatted value (revenue = $, matchRate = %, others = integers with commas), green ▲ or red ▼ change badge, 20-point sparkline.

**Charts row** — fetch in parallel:
- `GET /api/metrics/timeseries?range=30d` → `[{ date, queryCount, orderCount, revenue }]` — line chart
- `GET /api/metrics/platform-breakdown?range=30d` → `[{ platform, queryCount, orderCount }]` — bar chart

**Top products** `GET /api/metrics/top-products?range=30d&limit=10` → compact table: rank, name, queries, orders, revenue.

**Conversion funnel** `GET /api/metrics/conversion-funnel?range=30d` → horizontal funnel: Queries → Matched → Cart → Checkout → Ordered.

**Unmatched queries** `GET /api/metrics/unmatched-queries?limit=10` → tag cloud / list with counts.

---

## Screen 16 — /dashboard/transactions

Filters: search input, event type multi-select (`query`/`cart`/`checkout`/`order`), status filter (`success`/`failed`), date range.

```
GET /api/transactions?range=30d&page=1&limit=50&search=&eventType=&status=
```

Table columns: Timestamp, Event Type, Agent Platform, Query/SKU, Status, Value.  
Clicking a row expands it to show full payload.

---

## Screen 17 — /dashboard/feeds

```
GET /api/feeds/connections        — connection type (Magento or CSV), status, last synced
GET /api/feeds/readiness-score    — overall score 0–100, dimensions object
GET /api/feeds/sync-timeline      — timeline of sync/import events
GET /api/feeds/data-quality       — field completeness per attribute
GET /api/feeds/inventory-health   — coverage%, low-stock%, out-of-stock%
GET /api/feeds/system-alerts      — active alerts with severity badges
```

Readiness score: large circular gauge + 4 dimension score bars.  
Data quality: horizontal bar per field (brand, description, image, etc.).  
Alerts: list of cards with info/warning/error badges.

---

## Screen 18 — /dashboard/bot-defense

```
GET /api/bot-defense/overview?range=30d         — total requests, match rate, flagged count
GET /api/bot-defense/suspicious-agents?range=30d — agents exceeding limits
GET /api/bot-defense/events?range=30d&page=1    — paginated event log
GET /api/bot-defense/settings                   — current config
PATCH /api/bot-defense/settings                 — update config
```

Settings form: rate limit slider (1–1000), require cart confirmation toggle, max order value, allowed platforms chip picker, enabled capabilities checkboxes, test orders toggle.

---

## Screen 19 — /dashboard/insights

```
GET /api/insights?range=30d
→ {
    "data": {
      "summary": "Your match rate improved...",
      "insights": [
        { "insightType": "trend", "badge": "↑ Match Rate", "text": "...", "actionLabel": "View details" }
      ]
    }
  }
```

Render summary paragraph at top, then each insight as a card with a colored badge.  
Note below: "Generated daily — last updated X hours ago" using `generated_at`.

---

## Screen 20 — /catalog

```
GET /api/v1/merchants/:slug/catalog?q=&category=&page=1&limit=24
```

(Read `slug` from the agent config: `GET /api/onboarding/agent-config` → `slug` field.)

Responsive card grid (4 col desktop, 2 mobile). Each card: image, SKU badge, title, brand, price, agent readiness score pill (green ≥ 80 / amber 50–79 / red < 50).

Click card → slide-in drawer:
```
GET /api/v1/merchants/:slug/catalog/:sku
GET /api/v1/merchants/:slug/catalog/:sku/inventory
```

Drawer shows all product fields + inventory status (`in_stock` / `low_stock` / `out_of_stock`).

---

## Screen 21 — /settings

Tabs: Agent Config | API Keys | Merchant Profile.

**Agent Config tab** — same form as `/onboarding/agent-config` but without wizard chrome.

**API Keys tab**:
```
GET /api/onboarding/agent-config  →  apiKeyHint field
POST /api/onboarding/agent-config/generate-key  { mode: "test" | "live" }
```
Show key hint, rotate buttons, one-time copy modal on rotation.

**Merchant Profile tab**:
```
GET /api/onboarding/merchant/:merchantId
PATCH /api/onboarding/merchant/:merchantId
Body: { companyName, contactEmail, contactName, contactPhone }
```

---

## Global rules

1. **No mocks.** Every number, chart, and label comes from a real API call.
2. **Loading skeletons** — not spinners — while data fetches.
3. **Empty states** with illustrated icons and contextual CTAs on every list/table.
4. **Toasts** for all success and error events.
5. **Error boundary** on every route — "Something went wrong" card with reload.
6. **Polling** — use `setInterval` (clear on unmount) for sync status, normalization status, and CSV import status. Interval: 3 seconds.
7. **All amounts ending in `Cents`** are in cents — divide by 100 before displaying.
8. **Revenue** from metrics endpoints is already in dollars (not cents).
9. **Slug validation** — lowercase letters, numbers, hyphens only. Validate client-side before submit.

---

## Design direction

Dark-mode primary with a clean SaaS aesthetic. Accent color: violet/purple. Use a sidebar layout for the dashboard. Wizard uses a left panel stepper + right content area. Card-based UI throughout. Typography: modern sans-serif (Inter or similar).
