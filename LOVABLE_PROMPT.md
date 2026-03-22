Connect this app to the Vare AI backend API.

**Base URL:**
```
https://7c5bc484-c306-4ba2-bb1f-64010814d3cf-00-tlp0xr8xs78q.picard.replit.dev/api
```

**Auth — every request needs:**
```
Authorization: Bearer <apiKey>
```
The `apiKey` comes from `POST /api/onboarding/merchant` on registration (returned once, store in localStorage). On any `401` → clear localStorage and redirect to registration.

**Response envelope:**
```json
{ "data": { ... }, "generated_at": "..." }
{ "data": [ ... ], "total": 0, "page": 1, "limit": 20 }
{ "error": "Human-readable message", "code": "ERROR_CODE" }
```

**Demo data** — call once to seed 50k products + 30 days of analytics:
```
POST /api/test/seed-mock-data
Body: { "force": false }
→ { "data": { "merchantId": "...", "apiKey": "vare_test_sk_..." } }
```

---

**Onboarding phase** — single source of truth for wizard state:
```
GET /api/onboarding/phase
→ {
    "currentPhase": 3,          // 1–10
    "percentComplete": 30,
    "sourceType": "csv",        // "magento" | "csv"
    "isLive": false,
    "nextAction": "POST /api/onboarding/csv/uploads/:id/import",
    "checklist": [
      { "phase": 1, "label": "Merchant Profile", "complete": true },
      { "phase": 2, "label": "CSV Uploaded",     "complete": true },
      { "phase": 3, "label": "Columns Mapped",   "complete": false, "nextAction": "..." }
    ]
  }
```

---

**CSV upload — do NOT use FormData/multipart** (it breaks through the Supabase edge function proxy). Convert the file to base64 and POST as JSON:

```js
const buffer = await file.arrayBuffer();
const content = btoa(String.fromCharCode(...new Uint8Array(buffer)));

POST /api/onboarding/csv/upload-json
Content-Type: application/json
{ "filename": file.name, "content": content, "encoding": "base64" }
```

Returns: `{ uploadId, headers, rowCount, suggestions: [{ csvHeader, vareField, confidence: "high"|"low" }] }`

---

**Key endpoint groups:**

| Area | Prefix |
|------|--------|
| Merchant registration | `POST /api/onboarding/merchant` |
| Wizard phase | `GET /api/onboarding/phase` |
| Magento connection | `/api/onboarding/connect/*` |
| Catalog sync | `/api/onboarding/sync/*` |
| CSV import | `/api/onboarding/csv/*` |
| Normalization | `/api/onboarding/normalization/*` |
| Agent config + slug | `/api/onboarding/agent-config/*` |
| Go live | `POST /api/onboarding/activate` |
| Dashboard KPIs | `GET /api/metrics/kpi?range=30d` |
| Timeseries | `GET /api/metrics/timeseries?range=30d` |
| Platform breakdown | `GET /api/metrics/platform-breakdown?range=30d` |
| Top products | `GET /api/metrics/top-products?range=30d` |
| Conversion funnel | `GET /api/metrics/conversion-funnel?range=30d` |
| Unmatched queries | `GET /api/metrics/unmatched-queries` |
| Transactions log | `GET /api/transactions?range=30d&page=1&limit=50` |
| Feed health | `/api/feeds/*` |
| Bot defense | `/api/bot-defense/*` |
| AI insights | `GET /api/insights?range=30d` |
| Product catalog | `GET /api/v1/merchants/:slug/catalog?q=&page=1` |
| Single product | `GET /api/v1/merchants/:slug/catalog/:sku` |

`?range=` accepts: `today`, `7d`, `30d`, `90d`, `ytd`

**`slug`** comes from `GET /api/onboarding/agent-config` → `slug` field.

---

**Two things that are different from the norm:**
1. CSV upload = base64 JSON to `/csv/upload-json`, never multipart (see above)
2. Amounts with `Cents` in the field name (e.g. `maxOrderValueCents`) are in cents — divide by 100 to display
