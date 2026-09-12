# Setup (5 minutes)

What you get: an NHS-style patient app, a staff operations console, and an AI care-team agent that reads a simulated NHS neighbourhood and acts on it after you approve.

## 1. Install

You need Node 22 or newer (`node --version`).

```bash
cd agent
npm install
```

## 2. Keys

Two small files, never committed:

- `agent/key-agent.txt` — simulator key. Get one with:
  ```bash
  curl -s https://sim.animahacks.com/api/keys -H 'Content-Type: application/json' -d '{"teamName":"my-team"}'
  ```
  copy the `apiKey` value into `agent/key-agent.txt` (same name = same world; use a new name for a clean world).
- A model key, one of:
  - Gemini (free tier works): `GEMINI_API_KEY=...` from Google AI Studio
  - OpenAI: `OPENAI_API_KEY=sk-...`

## 3. Run

```bash
cd agent
# Gemini
MODEL_PROVIDER=gemini GEMINI_API_KEY=... SIM_KEY=$(cat key-agent.txt) npm run server
# or OpenAI
MODEL_PROVIDER=openai OPENAI_API_KEY=sk-... SIM_KEY=$(cat key-agent.txt) npm run server
```

Then open:

| URL | What |
|---|---|
| http://127.0.0.1:8790/admin.html | Operations console (staff): overview, capacity, blocked patients, cohort, per-patient pathway, chat with the agent on the right |
| http://127.0.0.1:8790/ | Patient app (NHS App style): press Continue, Ctrl+K to switch patient |
| http://127.0.0.1:8790/sim.html | Pathway graph only |

Everything is served by that one process; no build step.

## 4. Try it

In the console chat: "Who is blocked right now and why?", "What is the next action for SIM-000002?", "Advance the clock by 2 hours and tell me what changed." Anything that changes a record shows Approve / Decline first.

## Options

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_PROVIDER` | inferred | `gemini` or `openai` |
| `MODEL` | `gemini-3.6-flash` / `gpt-5.6-luna` | model name |
| `PORT` | 8790 | web port |
| `ADK_STORE` | sqlite | `memory` to skip the sessions database |
| `SIM_KEY` | contents of `../key.txt` | simulator key |

## Problems

- Page says "some services did not respond": the simulator (sim.animahacks.com) returns 502 for a minute or two at times. Press Retry.
- First load of a patient takes a few seconds (8 simulator calls); after that it is cached.
- Rebuild the cohort statistics: `SIM_KEY=$(cat key-agent.txt) npx tsx build-dataset.ts`.
