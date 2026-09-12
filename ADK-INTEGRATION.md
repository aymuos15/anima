# Anima ADK integration

`@animahealth/adk` (0.6.0, MIT, Node ≥ 22) provides the agent layer for the pathway app: it reads the simulator, stitches a pathway, decides the next nudge for the patient, and performs write actions only after explicit confirmation.

## Architecture

```text
pathway.html (NHS UI, five patients, unchanged look)
   │  POST /api/chat        {sessionId?, input:{message | tools:[{callId,input}], state?}}
   │  GET  /api/patients/:id/pathway
   ▼
agent/  (Node 22 + TypeScript via tsx)              key.txt and all sim calls live here
   server.ts      http server: /api/chat (ADK REST handler), /api/patients/:id/pathway, static pathway.html
   app.ts         adk({ name:'pathway', schema, store: sqliteStore('agent/sessions.db') })
   sim.ts         typed sim client: bearer auth, UUID clientRequestId, Idempotency-Key, 409/502 handling
   pathway.ts     port of making-a-pathway.py: fetch all sites, filter by patientId, sort, classify, flag
   tools/read.ts  search_patients, get_patient_pathway, get_capacity, get_resource
   tools/write.ts yielding tools: create_task, send_message, book_appointment, share_record,
                  progress_referral, schedule_visit, order_test
   agents.ts      pathway_agent: system prompt, context renderers, tools, hooks
   codex-proxy.ts local proxy that lets the ADK use the ChatGPT OAuth token (see Model)
   test/          runTest scenarios per patient, no model key needed
```

Keep `key.txt` and all simulator API calls on the backend. The browser never receives the API key or the model token.

## Model

Decision: OpenAI `gpt-5.6-luna`, reasoning effort `low`, authenticated with the ChatGPT OAuth token that Codex CLI already holds on this machine.

- Token: `~/.codex/auth.json` → `tokens.access_token`, `tokens.account_id`, `tokens.refresh_token` (ChatGPT Pro plan; access token expires roughly every 10 days, refresh token renews it).
- Endpoint: `https://chatgpt.com/backend-api/codex/responses` (Responses API). Verified 12 Sep 2026: a tool call to `get_capacity` returns `function_call` with correct arguments.
- Required by that endpoint: headers `Authorization: Bearer <access_token>`, `chatgpt-account-id: <account_id>`, `OpenAI-Beta: responses=experimental`, `originator: codex_cli_rs`; body must have `stream: true` and `store: false` (both enforced, HTTP 400 otherwise). `system` or `developer` roles inside `input` are accepted, as is `instructions`.
- The ADK OpenAI adapter already sends `store:false`, `instructions`, `include:["reasoning.encrypted_content"]` and streams via `responses.stream`. It builds `new OpenAI({ apiKey, baseURL })` with no custom headers, so it cannot add `chatgpt-account-id` itself.
- Therefore `codex-proxy.ts`: a localhost HTTP server (`127.0.0.1:8788/v1`) that forwards `/responses` to the ChatGPT endpoint, adds the headers above, forces `stream:true`, reads `auth.json` on each request and refreshes the token when within an hour of expiry (`POST https://auth.openai.com/oauth/token`, `grant_type=refresh_token`, Codex client id; write the new tokens back to `auth.json`).
- Wiring is env only, no adapter code: `OPENAI_BASE_URL=http://127.0.0.1:8788/v1 OPENAI_API_KEY=local`. Agent config: `openai('gpt-5.6-luna', { reasoning: { effort: 'low' } })`.
- Caveat: the token is a personal ChatGPT login intended for Codex; usage counts against that plan's limits and the proxy must never be exposed beyond localhost.

Rejected options, with reasons:

- OpenCode Zen `muse-spark-1.3-contributor-free` (`OPENCODE_ZEN_API_KEY` is set): direct API calls return `MissingSessionID: OpenCode's free tier can only be used in OpenCode`. The paid `muse-spark-1.3` needs a payment method on the workspace. `deepseek-v4-flash-free` returned a 500.
- Gemini via `GEMINI_API_KEY`: works with the ADK `/gemini` subpath and is the fallback if the OAuth route breaks.
- Claude: ADK supports it only through Vertex AI; not set up.

## Tools

Read tools (plain `app.tool`, no confirmation):

- `search_patients({ q })` → `GET /api/sites/gp/patients?q=`
- `get_patient_pathway({ patientId })` → all seven site views, filtered by `patientId`, sorted by `createdAt`, each resource labelled with a stage (`referred`, `assessed`, `waiting`, `treated`, `discharged`, `other`) and flags (`waiting`, `rejected`, `capacity_exhausted`). Deterministic code, not the model.
- `get_capacity({ site })` → `capacity` resources (`data.total`, `data.remaining`)
- `get_resource({ site, resourceId })` → one resource with its current `version`, read immediately before any write

Write tools (yielding, `yieldSchema` + `finalize`): the run pauses, the UI shows the proposal as reply chips, the human answer resumes it, and `finalize` performs the sim action only when `approved: true`.

| Tool | Sim action | Fields |
|---|---|---|
| `create_task` | `create_task` on gp | `patientId`, `title` |
| `send_message` | `send_message` with `messagingCommand.create` | `subject`, `body`, `channel` sms/email, `allowReply` |
| `book_appointment` | `book_appointment` on gp | `sessionId`, `sessionVersion`, `startsAt`, `patientId`, `title` (sessions from `GET /api/sites/gp/appointments`) |
| `share_record` | `share_record` | `resourceId`, `target` |
| `progress_referral` | `review` / `accept` / `complete` on `/api/sites/referrals/actions` | `resourceId`, `expectedVersion` (same referral id throughout) |
| `schedule_visit` | `schedule_visit` from gp or hospital | `patientId`, `title`; capacity-backed, 409 when exhausted |
| `order_test` | `order_test` with `bloodTestOrder` | `panelId` fbc/ue/hba1c/lft/crp/lipids, `priority`, `collection`, `clinicalDetails` |

Every write sends `clientRequestId: randomUUID()`, an `Idempotency-Key` header, and `expectedVersion` from the read that immediately preceded it. A 409 is returned to the model as "capacity exhausted or stale version: re-read and offer an alternative"; it is never retried silently.

Locked for our key and not exposed: `report_absence`, `restore_staff`, `allocate_shift`, incidents, population.

## Agent

- One agent, `pathway_agent`, one session per patient. Its job is to decide the next nudge and write it in NHS plain-English tone; stage classification and risk flags come from `get_patient_pathway`.
- Typed state via `adk({ schema })`: `patientId`, `stage`, `blockers[]`, `pendingOffers[]`, `contactPreference`, `needs[]`, `goals[]`. Rendered into context explicitly so the prompt stays small while the ledger keeps the full history.
- Context: `system` (role, tone rules, "always propose before acting, one question per message, never invent dates that are not in a session or slot"), a state renderer, `history()`.
- Hooks: a `tool_call` hook that rejects any write tool whose yield was not answered `approved: true` in the same session; a logging hook that mirrors tool calls into the app's "Recent activity" timeline.
- Structured output for the nudge: `{ text, chips?: [{ label, input }], updates?: { tag, callout } }` so the UI never parses prose.

## Website connection

- `pathway.html` keeps the five-patient NHS UI and the Ctrl+K switcher. The scripted `script()` arrays are replaced by live turns: login → `POST /api/chat` with `state:{patientId}` and message `start`; the reply text becomes a care-team bubble; each entry in `yieldedTools` becomes a chip group; a chip click resumes with `input.tools:[{callId, input}]`.
- After every turn the page re-renders from `GET /api/patients/:id/pathway`, so the stepper, callout, details and Home cards reflect real sim state instead of local patches.
- Pushes: in demo mode the server advances the sim clock between turns (`POST /api/clock {"paused":true,"advanceMinutes":N}`) so results and slots actually appear; the UI polls the pathway endpoint and shows the banner when the agent posts.
- Streaming (AG-UI, `app.handler.agui`) is optional; the REST handler is enough for chips.

## Milestones

1. Backend skeleton and read tools. `sim.ts`, `pathway.ts`, `get_patient_pathway` verified against SIM-000007, SIM-000504, SIM-000023, SIM-000002, SIM-000070 with `runTest` from `@animahealth/adk/testing` (no model).
2. Model route. `codex-proxy.ts`, `pathway_agent` on `gpt-5.6-luna` low, `/api/chat` answering `start` for Mohammed from live data.
3. Wire the UI. Replace scripts with `/api/chat`, chips ↔ yields, pathway re-render, Ctrl+K creates a fresh session.
4. Write tools. `create_task` as the smoke test, then `book_appointment` as the first real demo action (the core moment for Mohammed, Ben and George Evans; capacity-backed and versioned, low blast radius), then `progress_referral` for George Evans and `schedule_visit`. Run against a fresh world (`POST /api/keys {"teamName":"13health-agent"}`) so `13health` stays clean.
5. Evals with `/eval`: one scenario per patient checking the agent proposes before acting, never writes on a rejected yield, and handles a 409 by offering an alternative.
6. Optional: AG-UI streaming for typing indicators; voice via `/voice` (LiveKit) only if wanted for the demo.

## Status (12 Sep 2026)

Working end to end: login → agent reads the patient's live records → message on Home and in Messages → proposals appear as chips → approval resumes the run and performs the sim write → pathway page re-renders from the sim. Verified in the browser for Mohammed Ali (`SIM-000007`, information only) and George Evans (`SIM-000002`, `share_record` executed after approval).

Implemented in `agent/`: `sim.ts`, `pathway.ts`, `tools/read.ts`, `tools/write.ts`, `app.ts`, `agents.ts`, `server.ts`, `codex-proxy.ts`, `test/pathway.test.ts` (five patients, passes), `test/debug-run.ts` (prints the event stream).

Gotchas found while building:

- The Codex backend's `response.completed` carries `output: []`; items only arrive as `response.output_item.done`. The proxy rebuilds `output` from those items, otherwise the ADK sees an empty step.
- Free text typed while a tool is yielded produces `400 No tool output found for function call`. The UI therefore answers the pending yield with the typed text (`approved` inferred, `note` = text) instead of starting a new turn.
- Writes run in the world `13health-agent` (key in `agent/key-agent.txt`, gitignored) so `13health` stays clean. `POST /api/keys` returns the key as `apiKey`.

## Medicines pathway (Amira Khan, SIM-000001)

`pathway.ts` also returns a `medicines` section: prescriptions with status/version/linked product, tests, visits, open practice tasks, the occupied bed and its discharge barrier, the hospital attendance, an overall stage (`prescribed → approved → dispensed → collected`) and medicine-specific blockers. The UI shows it as a second stepper on the pathway page.

Write tools for it: `prescription_action` (`link_stock`, `review`, `accept`, `dispense`, `collect` on `/api/sites/pharmacy/actions`; dispensing deducts real stock), `order_test` (`bloodTestOrder`, result appears in diagnostics after the clock advances), `schedule_visit`, and `hospital_command` (`update_attendance` with `assign/assess/refer/admit/discharge`). Verified end to end on a fresh session: assess (hospital_command) → dispense → collect (stock 112 → 84) → clock advance completes the home visit → complete_task closes "Arrange post-discharge monitoring" → discharge home with community follow-up (attendance `discharged`, v4). The ordered U&E stays `open` until a later diagnostics round.

Changing the agent's tools changes its fingerprint, so old sessions return `pipeline structure has changed`; `server.ts` then starts a fresh session for the patient instead of failing.

Time: nothing new happens until the clock moves. `POST /api/clock/advance {minutes}` on the server wraps `/api/clock`; the Ctrl+K palette has "Advance simulation clock 2 hours", which advances, re-renders the pathway and asks the agent to re-check the records.

## Operations console (admin.html)

`admin.html` is the staff-facing, full-page console: left nav (Overview, Capacity, Blocked and waiting, Cohort, Patients, featured patients), centre content, and a chat panel on the right backed by `admin_agent` (`POST /api/admin/chat`). The admin agent has every read and write tool plus `get_overview` (clock, capacity, beds/robots/theatre lists, every waiting or rejected record), `scan_patients`, `list_example_patients` (from `data/examples.json`) and a yielding `advance_clock`. Writes and clock advances show as Approve/Decline chips. `GET /api/admin/overview` and `GET /api/admin/patients` feed the views; patient pages reuse the pathway graph from `sim.html`.

## Performance

Building a pathway is 8 simulator calls at 2–7 s each, so `pathway.ts` caches complete results for 90 s (`PATHWAY_CACHE_MS`), dedupes concurrent builds, and never caches a result that had site errors. The server prefetches the six featured patients at startup and every 80 s, and every write tool or clock advance invalidates the cache. GET timeout is 15 s (`SIM_GET_TIMEOUT_MS`); `?fresh=1` on the pathway endpoint bypasses the cache.

## Example patients

`agent/data/examples.json` (16 patients, mined by a research agent; see `PATHWAY-EXAMPLES.md`) adds pathway types the featured six do not cover: digital access, genomic uncertain result, wearable not syncing, care package funding, unanswered screening, Pharmacy First, unconfirmed post-surgical follow-up, failed contact ladders, discharge letter in draft, accessible-information need, home visiting, referral awaiting triage, prescription awaiting pharmacy review. They appear in the console's Patients view, in the admin agent's `list_example_patients`, and in the patient app's Ctrl+K switcher. Finding from the mining: only 218 of the 50,000 registered patients own any record, and the dramatic record kinds are concentrated on SIM-000001 to SIM-000008.

## Run on another machine (no Codex)

The Codex proxy is only one way to get a model. Choose by environment:

```bash
git clone <repo> && cd anima/agent && npm install
# copy the sim key(s): key-agent.txt (agent world). Never commit them.

# Option A: Gemini (AI Studio key)
MODEL_PROVIDER=gemini GEMINI_API_KEY=... SIM_KEY=$(cat key-agent.txt) npm run server

# Option B: OpenAI platform key
MODEL_PROVIDER=openai OPENAI_API_KEY=sk-... MODEL=gpt-5.6-luna SIM_KEY=$(cat key-agent.txt) npm run server

# Option C (this machine only): ChatGPT OAuth via the proxy
npm run proxy &
OPENAI_BASE_URL=http://127.0.0.1:8788/v1 OPENAI_API_KEY=local SIM_KEY=$(cat key-agent.txt) npm run server
```

Defaults: `MODEL_PROVIDER` is inferred (gemini if only `GEMINI_API_KEY` is set); `MODEL` defaults to `gemini-2.5-flash` or `gpt-5.6-luna`. Then open `http://127.0.0.1:8790/admin.html` (console) or `/` (patient app). `PORT=` changes the port; `ADK_STORE=memory` avoids SQLite. The pages are plain static files served by the same process, so nothing else needs installing. Requires Node 22.

## Cohort dataset

`agent/build-dataset.ts` pulls every patient with one condition (default `Arthritis`, 86 patients) through `buildPathway`, and writes `agent/data/cohort.json`: per patient the stage reached, days between stage transitions, waiting days and blockers; per condition the stage counts, median/min/max transition days, common blockers and needs. The `get_similar_pathways` tool reads it so the agent can answer "how long does this usually take" with figures and the synthetic-data caveat. Rebuild with `SIM_KEY=$(cat key-agent.txt) npx tsx build-dataset.ts` (`COHORT_CONDITION=` to change condition).

## Run

```bash
cd agent && npm install
# terminal 1: model proxy (ChatGPT OAuth token from ~/.codex/auth.json)
npm run proxy                                   # 127.0.0.1:8788
# terminal 2: agent + static site
SIM_KEY=$(cat key-agent.txt) OPENAI_BASE_URL=http://127.0.0.1:8788/v1 OPENAI_API_KEY=local npm run server   # 127.0.0.1:8790
# tests (no model needed)
npm test
```

Open `http://127.0.0.1:8790/`, press Continue, Ctrl+K to switch patient. `MODEL=` overrides the model name; `ADK_STORE=memory` skips SQLite.

References: [@animahealth/adk](https://www.npmjs.com/package/@animahealth/adk), [source and examples](https://github.com/mycontinuum-com/adk) (`examples/yieldResume.ts`, `examples/lambda-rest.ts`, `skills/adk/SKILL.md`), [OpenCode Zen](https://opencode.ai/docs/zen/).
