# Architecture

```text
┌──────────────────────────┐
│ public/index.html        │  NHS App style patient view (also admin.html console)
│ chat + pathway UI        │
└────────────┬─────────────┘
             │ /api/*  (Netlify CDN serves public/, one function serves the API)
             ▼
┌──────────────────────────┐
│ agent/server.ts          │  routes: chat, admin chat, pathway, patients, overview, clock
└────────────┬─────────────┘
             │
   ┌─────────┴──────────┐
   ▼                    ▼
┌──────────────┐  ┌───────────────────────┐
│ ADK agents   │  │ agent/pathway.ts      │  deterministic: stage, blockers,
│ agents.ts    │─▶│ pathway builder       │  medicines, letters, repeats
│ tools/*      │  └──────────┬────────────┘
└──────┬───────┘             │
       │ sessions            │ 8 reads per patient, cached 90s
       ▼                     ▼
┌──────────────┐  ┌───────────────────────┐
│ Supabase     │  │ sim.animahacks.com    │  gp · hospital · pharmacy · community
│ Postgres     │  │ synthetic NHS world   │  diagnostics · wearables · referrals
└──────────────┘  └───────────────────────┘
```

The pathway builder decides stages and blockers with fixed rules in `agent/pathway.ts`. The agent interprets those results and talks to the user. Every write action yields for explicit approval before the simulator is touched.

## Request flow for a chat turn

1. Browser posts `{ patientId, sessionId?, input }` to `/api/chat`.
2. On a new session the server builds the pathway and seeds session state (name, stage, blockers, needs, goals).
3. The ADK runs the patient agent. Read tools call the pathway builder or the simulator. Write tools return a yield.
4. Response carries `text` and `yieldedTools`. The browser renders chips (Yes / No, or ask_patient options).
5. The chosen answer is posted back as `{ tools: [{ callId, input }] }` and the tool's `finalize` runs the action.

## Stage inference

Records map to a backend stage by kind: referral → referred, encounter/appointment/attendance → assessed, surgery/theatre-slot/task → waiting, visit/prescription/test → treated, discharge-summary → discharged. The patient app shows these as Referred, Booked, Preparation, Procedure, Post-op care. Records in waiting or rejected status become blockers. Medicines, hospital letters and repeat prescriptions are derived separately from prescription, discharge-summary/document and GP EHR medication records.
