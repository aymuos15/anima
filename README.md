# Anima

A prototype for exploring synthetic NHS patient pathways with a web UI and an Anima ADK backend.

## Collecting pathways

Pathway collation is custom project logic, not a default ADK feature. We:

1. Find the patient across the simulator.
2. Read their records from GP, hospital, pharmacy, community, diagnostics, referrals, and wearables.
3. Combine and sort the records by date.
4. Infer pathway stages and identify delays or blocked steps.
5. Present the result as one patient timeline.

## Synthetic appointment finding

In the current `13health` simulation world, the GP appointment records contain:

| Measure | Count |
| --- | ---: |
| Appointments | 49,488 |
| Missed/DNA appointments | 2,037 |
| Unique patients with a missed appointment | 2,037 |
| Missed appointment rate | 4.12% |

The API represents a missed appointment as `kind: appointment` and `status: missed`, with `data.sourceStatus: DNA`. The data is synthetic and the figures may change as the simulation changes.

## Project files

- `pathway.html` — static pathway prototype
- `agent/` — ADK backend and simulator tools
- `making-a-pathway.py` — read-only pathway builder
- `ADK-INTEGRATION.md` — integration architecture

Do not commit API keys. They are excluded by `.gitignore`.
