# API

- Base URL: `https://sim.animahacks.com`
- OpenAPI: `/api/openapi.json`
- Handbook: `/docs/handbook.json`
- Runtime catalogue (sites, adapters, scenarios): `/api/catalogue`
- API key: read from `key.txt` and send as `Authorization: Bearer <key>`
- Search patients: `GET /api/sites/{site}/patients?q=...` (30 per page)
- Read records: `GET /api/sites/{site}/view?patient=SIM-000001` (`limit` up to 500, `offset` to page)
- Submit actions: `POST /api/sites/{site}/actions`
- Clock: `POST /api/clock {"paused":true,"advanceMinutes":N}`; stepping an unpaused clock returns 409
- Sites: `gp`, `hospital`, `pharmacy`, `community`, `diagnostics`, `wearables`, `referrals`
- Data is synthetic. Prefer read-only requests unless a change is explicitly requested.

# World

- One neighbourhood per world, fixed: Riverside Practice (gp), Northbank General (hospital), Riverside Community Services (community), Riverside Pharmacy (pharmacy). No endpoint adds sites, organisations, staff or capacity.
- `POST /api/keys {"teamName":"..."}` creates or joins a world. Same name returns the same world and key. Use a new name for a clean run.
- Worlds in use: `13health` (main, already ~25 sim hours in), `13health-scratch409` (throwaway for API checks), `13health-agent` (agent writes; key in `agent/key-agent.txt`).

# Agent

- `agent/` is the Anima ADK backend that drives `pathway.html`; see `ADK-INTEGRATION.md` for architecture, model route and how to run it.
- Run: `npm run proxy` then `SIM_KEY=$(cat key-agent.txt) OPENAI_BASE_URL=http://127.0.0.1:8788/v1 OPENAI_API_KEY=local npm run server`, open `http://127.0.0.1:8790/`.

# Actions

- `clientRequestId` must be a UUID, otherwise HTTP 400 validation error.
- Capacity is finite per service and readable as a `capacity` resource (`data.total`, `data.remaining`) in the site view. When exhausted, actions return `409 {"error":"No service capacity"}`. Verified: 4 community visits succeed, 5th returns 409, advancing the clock 120 minutes restores remaining to 4.
- Versioned updates send `expectedVersion`; a stale version also returns 409.
- Locked for our key: `report_absence`, `restore_staff`, `allocate_shift` (staff-management permission). Incidents such as winter pressure are organiser-only.
- Pharmacy First pathways (`pharmacyPathway`): Sinusitis, Sore throat, Acute otitis media, Infected insect bites, Impetigo, Shingles, Uncomplicated UTI, Minor illness, Urgent medicine supply.
- Hospital `hospitalCommand`: assign, assess, refer, admit, discharge. `acuity` is a string "1" to "5".
