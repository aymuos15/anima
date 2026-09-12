# Sample elective pathway — SIM-000007

Traced from live sim data (`13health` world), all timestamps converted from epoch ms.

| Date | Site | Kind | Status | Event |
|---|---|---|---|---|
| 2025-12-25 – 2026-08-30 | gp | encounter/observation | completed | Six recurring primary-care contacts over ~8 months |
| (recurring, each contact) | gp / diagnostics / hospital | report | available | Full blood panel (FBC, CRP, HbA1c, Lipids, LFT, U&E) — pre-op monitoring |
| 2026-09-05 | gp | discharge-summary | sent | "Neurology · Assessment episode summary" — the referral trigger |
| 2026-09-11 21:43 | hospital | hospital-attendance | inpatient | "Chest discomfort" — admitted |
| 2026-09-12 00:00 | hospital | handover | completed | Ambulance handover awaiting staffed space |
| 2026-09-12 00:00 | hospital | surgery | **waiting** | "Elective list: robot and recovery bed required" (routine priority, needs bed + robot) |
| 2026-09-12 00:00 | hospital | theatre-slot | **waiting** | "Robotic theatre list: two cases exceed staffed capacity" — Room OR-3, robot RX-1, 6 planned cases, 4 staffed |

## Pathway shape

GP monitoring → neurology assessment/discharge summary → hospital admission → placed on elective surgery list → blocked at theatre-slot stage.

## Notes

- No RTT-style clock field exists in the sim; "waiting" status + `createdAt`/`dueAt` gap is the only proxy for elapsed wait.
- This patient's pathway is currently stuck: the robotic theatre list is understaffed (4 staffed cases vs. 6 planned), a live capacity constraint rather than a completed elective episode.
- Resource kinds involved: `referral` (referrals site, not present for this patient but is the typical entry point), `surgery`, `theatre-slot`, `discharge-summary`, `hospital-attendance`, `handover`.

## Repro

```bash
KEY=$(cat key.txt)
curl -s -H "Authorization: Bearer $KEY" \
  "https://sim.animahacks.com/api/sites/hospital/view?patient=SIM-000007&limit=500"
```
