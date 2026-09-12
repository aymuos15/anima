# Pre-op concierge — demo design (12 Sep 2026)

Status: approved by Aaryan 14:30; cohort and modifiers revision 14:50. Freeze 16:30. Submission 18:30. Stall 18:30–19:30.

This is the spec the development agents build from. It sits on top of what already exists in this repo (`agent/`, `pathway.html`). Nothing here replaces the ADK app, the sim client, the pathway stitcher or the chat handler; it adds a pre-op layer beside them.

## 0. YAGNI. Read this before anything else

This is a four-minute stall demo that runs once, on one MacBook, driven by one presenter, on real patients pulled live from the Anima simulation. It is thrown away on Monday. Every line of code is judged by one question: does the §2 script need it to land? If not, do not write it.

Hard rules for every build agent on every track:

- No auth, no users, no sessions beyond the ADK session id, no roles, no permissions.
- No database beyond the one JSON file in §5 and the ADK's existing SQLite. No migrations, no ORM, no schema versioning.
- No framework, no bundler, no React, no Tailwind, no build step. Static HTML, the existing `pathway.css`, plain fetch and polling. No WebSockets, no SSE.
- No generic anything. One protocol, five items, the outcomes in §6 and nothing more. Hard-code the protocol, the wording and the outcome sets. Never hard-code patients: names, ids, needs, conditions and surgery dates come from the sim at run time (§5a). Do not write a "protocol engine" that could support other procedures.
- No retries, no queues, no rate limiting, no caching layers, no feature flags, no config system beyond env vars already in use.
- No input validation beyond what stops the demo crashing. No error pages. Log to console and move on.
- No tests beyond §13. No test infrastructure, no mocks framework, no coverage.
- No abstractions for one caller. No interfaces with one implementation. No utilities "for later". If a function is used once, inline it.
- No refactor of existing files beyond the exact additions the spec names. Do not tidy, rename, reformat or "improve" `pathway.html`, `server.ts`, `write.ts` or anything else on the way through.
- No docs beyond a five-line "how to run" block in the README. No comments explaining obvious code.
- No security work. The API key stays in the gitignored file as it is today. The iMessage whitelist is one env var, nothing more.
- No accessibility, i18n, responsive layout, dark mode, animation or polish that the judge will not see on the stall screen.

If you find yourself writing a class, a plugin system, a registry, a factory, a middleware chain, or a new file over 300 lines, stop and delete it. If a track needs something outside this spec to make the script land, post one line in the team channel and wait. Do not build it speculatively.

Done means: the beat in §2 that your track serves plays end to end on the MacBook. Not "production-ready", not "extensible", not "clean".

YAGNI cuts breadth, not depth. The cohort selection, the three or four featured patients, the eight branches, the agent prompt and skill, the rules wording and the evals are built to full refinement. Cutting those is not YAGNI, it is a broken demo.

## 1. What the demo is

An agent that gets a patient who is already booked for elective surgery ready for theatre: it works through the pre-op checklist with the patient over a real message thread on the patient's own phone, writes every step into the NHS record, reacts correctly to each test result as it arrives, and stops and hands over the moment anything clinical is raised. The patients are real records from the simulation, chosen by the agent at run time, not fixtures. Two screens beside the judge show the same journey from the patient's side and the clinician's side.

Pitch line: elective surgery is the biggest backlog in the NHS. Patients get booked, then nobody makes sure they are ready, and operations get cancelled on the day for a missed blood test. This is the coordinator that gets every booked patient ready.

Judging criteria are NHS relevance and impact, quality of the working product, originality, plus a voice prize. Everything below serves the four-minute stall script in §2 and nothing else.

## 2. Stall script (under four minutes)

| t | Beat | What the judge sees |
|---|---|---|
| 0:00 | Pitch line, one breath. | Console on laptop: three or four featured patient cards pulled from the live world, with the rest of the cohort listed below them. |
| 0:15 | Judge picks any card, types their own mobile number, presenter presses **Start**. | Card flips to "contacting…". The card shows the needs and conditions the agent read from the record, so the judge sees it is real data. |
| 0:30 | Judge's phone buzzes with an iMessage from the pre-op team. First question: have you started the physio exercises? Judge replies as the patient. Agent explains bloods are needed and offers two real slots. Judge picks one. | Patient app: readiness bar moves, checklist items flip. Board: row turns amber. Record pane: appointment and blood order appear. |
| 2:00 | Presenter presses **+7 days**. Results arrive. | Readiness completes, row turns green, "Ready for theatre". Agent texts the judge the plain-English result. |
| 2:30 | Second card, ideally one with a recorded need such as transport or a condition such as diabetes, so the agent visibly adapts. Agent asks the anaesthetic question about chest pain or breathlessness. Judge says yes. | Agent thanks them, asks nothing more, files an urgent task, gives the 999 line, stops. Board row turns red, "Clinical review". Presenter: the agent never diagnoses, it stops and hands over. |
| 3:15 | Close. | Board header: booked patients in this world and how many are not ready. Closing line names OpenAI and the Anima ADK. |

The only network dependencies are the model call, the sim call and iMessage. If iMessage fails at the stall, the console has a text box that plays the same conversation on screen.

## 3. Scope and cuts

In scope: a cohort pulled live from the sim with three or four featured patients, one pre-op protocol for elective surgery with record-driven modifiers, five checklist items, eight outcome branches, iMessage transport, patient app additions, clinician board, demo console, timeline with rewind, evals per branch, voice lane behind a gate.

Cut, do not build: cohort sweep beyond one count on the board, a language switch or any non-English speech, the ten-disease chat, agent-built pitch deck, authentication, a second protocol, any channel other than iMessage and the gated voice lane, SMS via the sim as a user-facing channel.

## 4. Architecture

```text
Judge's phone  ◄── iMessage ──►  Messages.app on the MacBook
                                     │ osascript send / chat.db poll
                                     ▼
agent/imessage.ts  ──────────►  agent/server.ts  ──────────►  ADK app (agent/app.ts)
                                     │  /api/demo/*   /api/board          preop_agent (agent/preop/agent.ts)
                                     │                                     skill: agent/preop/skills/elective-preop.md
                                     ▼                                     rules: agent/preop/rules.ts
                            agent/preop/store.ts  (demo-state.json, snapshots)
                                     │
                                     ▼
                            sim.ts  ──►  https://sim.animahacks.com  (audit trail: orders, appointments, tasks, problems)

Static pages served by server.ts:  pathway.html (patient, existing)  board.html (clinician, new)  console.html (presenter, new)
```

Source of truth rule: the demo state store is the truth for the dashboard, the board and the agent's context. The sim is the audit trail. Writes go to the sim and their resource ids are kept on the checklist item, and the record pane on the patient page reads the sim live so "it landed in the record" is visible. Nothing reads sim results back into checklist state; results come from the timeline engine (§6).

Model route: unchanged for text (existing Codex proxy). The voice lane needs a platform OpenAI API key; see §11.

## 5. Demo state store

File: `agent/preop/store.ts`. Backing file `agent/demo-state.json` (gitignored). One object:

```ts
interface DemoState {
  runId: string
  world: string                       // sim team name in use
  step: number                        // 0..4  →  T-28, T-21, T-14, T-7, T-0
  patients: Record<string, PatientRun>
  snapshots: DemoSnapshot[]           // one per forward step, popped on rewind
}

interface PatientRun {
  patientId: string
  name: string
  procedureLabel: string              // from the record: surgery resource title, else the condition, else 'elective surgery'
  modifiers: Modifier[]               // §5a, derived from the record at Start
  needs: string[]                     // copied from the sim patient
  conditions: string[]                // copied from the sim patient
  surgeryDate: string                 // ISO date: the sim surgery resource dueAt if present, else sim now at Start + 28 days
  phone?: string                      // E.164, whitelisted
  sessionId?: string                  // ADK session
  status: 'not_contacted' | 'in_progress' | 'ready' | 'clinical_review' | 'done'
  checklist: ChecklistItem[]
  results: ResultRecord[]
  transcript: Array<{ at: number; from: 'agent' | 'patient' | 'system'; text: string }>
  lastContactAt?: number
}

interface ChecklistItem {
  id: 'physio' | 'bloods' | 'ecg' | 'anaesthetic_questions' | 'transport'
  label: string
  state: 'not_started' | 'pending' | 'booked' | 'done' | 'review'
  detail?: string                     // one line shown under the pill
  simRefs: Array<{ site: string; resourceId: string; kind: string }>
  dueStep?: number                    // step at which an outcome is rolled for it
  updatedAtStep: number
}

interface ResultRecord {
  itemId: ChecklistItem['id']
  outcome: OutcomeCode                // see §6
  step: number
  classification: Classification      // from rules.ts, stored so the UI and evals can show it
}

interface DemoSnapshot { step: number; takenAt: number; patients: Record<string, PatientRun> }

type Modifier = 'add_hba1c' | 'renal_caution' | 'transport_flag' | 'carer_flag' | 'interpreter_flag' | 'slots_late' | 'theatre_blocked'   // §5a
```

## 5a. Cohort selection and record-driven modifiers

File: `agent/preop/cohort.ts`. Runs at server start and on console Reset. Nothing here is hard-coded to a patient.

1. Query the live world: `search_patients` with each of `elective`, `surgery`, `arthritis`, `knee`, `hip`, `MSK`, `orthopaedic`. Merge on id. Keep patients whose `conditions` contain `Awaiting elective surgery` or a joint, knee, hip, MSK or arthritis term, up to 40.
2. For each kept patient call `buildPathway` (existing). Keep those with a `surgery`, `theatre-slot` or `referral` event, or the `Awaiting elective surgery` condition. This is the cohort. Its size is the board header number.
3. Feature three or four by a fixed preference, first match wins per slot, no patient twice: (a) one currently blocked at `waiting` on a `theatre-slot` or `surgery` event; (b) one with a need in `Transport`, `Carer involvement`, `Offline contact` or `Interpreter`; (c) one with a condition matching `diabetes` or `CKD`; (d) one plain case with none of the above. If a slot has no match, take the next unfeatured cohort member.
4. Console shows the featured cards first, the rest of the cohort as a list. Any of them can be started.

Modifiers, derived once at Start from `needs` and `conditions`, stored on the run, rendered into agent state, and applied by the rules:

| Trigger on the record | Modifier | Effect |
|---|---|---|
| condition matches `diabetes` | `add_hba1c` | bloods order adds `panelId: 'hba1c'`; skill explains why in one sentence |
| condition matches `CKD` or `kidney` | `renal_caution` | `bloods_high_k` staff action becomes urgent to the anaesthetist as well as the nurse; U&E explanation mentions kidneys |
| need `Transport` | `transport_flag` | transport item starts `pending` with detail "transport need on record"; agent offers the practice task on first contact instead of asking |
| need `Carer involvement` | `carer_flag` | agent asks to include the carer in the plan and puts it in the transport item detail |
| need `Interpreter` | `interpreter_flag` | agent keeps sentences shorter, states an interpreter is booked for the visit, creates a task for it; no language switch |
| need `Offline contact` or `SMS preferred` | none | iMessage is the channel anyway; recorded on the card only |
| need `Shift work` | `slots_late` | slot offers prefer the latest morning and latest afternoon sessions available |
| pathway blocked at theatre | `theatre_blocked` | agent tells the patient their date is being confirmed by the hospital and does not promise a day; board detail shows the block |

A modifier the record does not trigger is never applied. If a patient triggers nothing, the plain protocol runs.

Readiness = count of items in `done` ÷ 5. Status derivation: `clinical_review` if any item is `review`; `ready` if all five `done`; `done` at step 4 with all `done`; `in_progress` if any transcript entry exists; else `not_contacted`.

## 6. Timeline engine and outcomes

File: `agent/preop/timeline.ts`.

Steps are days to surgery: 0 = T-28 (Start), 1 = T-21, 2 = T-14, 3 = T-7, 4 = T-0 (surgery day).

Console actions:

- `+7`: push a snapshot, `step += 1`, advance the sim clock by 10080 minutes (the API maximum, one call), roll outcomes for every item whose `dueStep === step`, apply them, then wake the agent for each patient with a `results` event (§7). At step 4 with every item `done`, set status `done` and post the closing message.
- `-7`: pop the last snapshot and restore it. Do not touch the sim clock. The sim now drifts ahead of the demo timeline after a rewind; only record timestamps show it. Accepted.
- Outcome picker: per pending item, `random` (default, weighted) or a fixed outcome. The picker is read at `+7` time, so `+7, -7, +7` with a different pick produces a different branch.

Outcome sets, with default weights:

| Item | Outcome code | Weight | Note |
|---|---|---|---|
| bloods | `bloods_normal` | 0.5 | Hb and K+ in range |
| bloods | `bloods_low_hb` | 0.3 | Hb 108 g/L |
| bloods | `bloods_high_k` | 0.2 | K+ 5.9 mmol/L |
| ecg | `ecg_normal` | 0.7 | sinus rhythm |
| ecg | `ecg_new_af` | 0.3 | irregularly irregular, no prior AF on record |
| physio | `physio_done` | 0.6 | patient reports doing exercises |
| physio | `physio_not_started` | 0.4 | patient has not started |
| anaesthetic_questions | `anaesthetic_clear` | n/a | decided by conversation, not rolled |
| anaesthetic_questions | `red_flag_raised` | n/a | decided by conversation, not rolled |

Due steps: `bloods` and `ecg` become due one step after they are booked. `physio` is answered by conversation at step 0 (started or not); at every later step it is rolled from the table to show whether they kept it up, unless already `done`. `transport` is answered in conversation. `anaesthetic_questions` is answered in conversation.

Bloods are ordered in the sim as `order_test` actions (`panelId: 'fbc'` and `panelId: 'ue'`, plus `hba1c` under the `add_hba1c` modifier) at the moment the patient picks a slot. The sim generates its own values; they are not read. The rolled outcome carries the displayed values.

## 7. Rules table

File: `agent/preop/rules.ts`. Pure function `classify(outcome: OutcomeCode, patient: PatientRun): Classification`. It reads `patient.modifiers` (§5a) and nothing else about the patient. The model never decides whether a result is abnormal; this table does.

```ts
interface Classification {
  code: OutcomeCode
  severity: 'normal' | 'action' | 'urgent'
  itemState: ChecklistItem['state']            // what the item becomes
  allowedActions: ActionName[]                 // the only write tools the model may call for this event
  patientExplanation: string                   // plain English, ≤ 40 words, used verbatim or lightly rephrased
  staffAction?: { title: string; priority: 'routine' | 'urgent'; owner: 'gp' | 'preop_nurse' | 'anaesthetist' }
}
```

| Outcome | Severity | Item state | Allowed actions | Patient explanation (verbatim) | Staff action |
|---|---|---|---|---|---|
| `bloods_normal` | normal | done | none | Your blood tests are back and everything is in the normal range. Nothing more to do on this one. | none |
| `bloods_low_hb` | action | review | `order_test`, `create_task` | Your blood count is a little lower than we would like before an operation. This is common and usually treatable. We will repeat the test with an iron check and your GP will look at the result. Your operation date has not changed. | Repeat FBC with ferritin and iron studies; GP to review and consider iron. Routine, owner gp. |
| `bloods_high_k` | urgent | review | `create_task` | One of your blood salts, potassium, is higher than expected. A pre-op nurse will call you today to talk it through. Please do not change any medicines until then. | Potassium 5.9 mmol/L on pre-op bloods; nurse to call patient today and arrange repeat. Urgent, owner preop_nurse. |
| `ecg_normal` | normal | done | none | Your heart tracing is normal. Nothing more to do on this one. | none |
| `ecg_new_af` | action | review | `create_task` | Your heart tracing shows an irregular rhythm that was not on your record before. This is common and the anaesthetist needs to look at it before your operation. They will contact you. | New AF on pre-op ECG; anaesthetic pre-assessment review before listing. Routine, owner anaesthetist. |
| `physio_done` | normal | done | none | Good, keep going with the exercises until your operation. | none |
| `physio_not_started` | action | pending | `create_task` | The exercises make a real difference to how quickly you recover. What is getting in the way? | Only if the patient names a barrier the practice can fix, e.g. transport: task to gp, routine. |
| `red_flag_raised` | urgent | review | `create_task` | Thank you for telling me. I am not going to ask you anything else. A pre-op nurse will call you today. If it gets worse, or you have chest pain now, call 999. | Patient reports [symptom] during pre-op contact; clinical review today. Urgent, owner preop_nurse. |

Thresholds behind the codes, kept in the file as constants: Hb < 130 g/L men or < 120 g/L women is low; K+ ≥ 5.5 mmol/L is high. The clinician on the team checks every row of this table before 16:00 and initials the file header.

Red-flag detector: `detectRedFlag(text: string): string | null` in `rules.ts`, deterministic keyword and phrase match over the patient's message, applied before the model sees the message. Phrases: chest pain, chest tightness, short of breath, breathless, can't breathe, fever, temperature, bleeding, black stools, confused, confusion, collapsed, fainted, swollen leg, calf pain. A hit sets the outcome `red_flag_raised` for `anaesthetic_questions`, forces the model turn into escalation mode (§8), and blocks every write tool except `create_task` for the rest of the session.

## 8. Agent

File: `agent/preop/agent.ts`, registered on the existing `app` beside `pathway_agent`. Name `preop_agent`.

State (typed via the ADK schema): `patientId`, `patientName`, `procedureLabel`, `modifiers[]`, `surgeryDate`, `daysToSurgery`, `checklist` (id, label, state, detail), `pendingEvent?` (a classification from §7), `escalated: boolean`, `needs[]`, `goals[]`.

Context, in order:

1. System prompt (below).
2. Skill file `agent/preop/skills/elective-preop.md`, injected whole.
3. State renderer: one paragraph with the patient, procedure label, days to surgery, needs, conditions, active modifiers, each checklist item and state, and the pending event if any.
4. History.

System prompt:

```text
You are the pre-operative coordinator for Northbank General, messaging one patient who is booked for elective surgery. The procedure, surgery date, needs, conditions and modifiers in your state come from their real record; use them. You write in NHS plain English: short sentences, sentence case, no jargon, no exclamation marks, no emojis, warm but not chatty. Under 80 words per message. One question per message. Address the patient by first name once at the start of the conversation.

Your job is to get the checklist in your state to done before the surgery date, by asking the patient what you need to know, booking what needs booking, and explaining results in the words the protocol gives you.

Rules you never break:
- You never interpret a test result yourself. When a pending event is in your state, use its patientExplanation and only the actions it allows.
- You never diagnose, reassure about symptoms, or ask follow-up clinical questions. If the patient mentions any symptom, or your state says escalated, send the safety-net message from the protocol, call create_task with the staff action, and end the conversation. Do not ask anything else, in this message or later.
- You never invent dates, slots, results, clinicians or phone numbers. Slots come from get_appointment_sessions only.
- Before any write (order_test, book_appointment, create_task, save_problem) say in one sentence what you are about to do. The patient's next reply is their answer. "yes", "ok", "sure", a chosen slot or a chosen option means approved.
- Respect recorded needs and goals: transport, carer involvement, early appointments, keeping working, avoiding travel.
- Work one checklist item per message, in the order the protocol gives. When every item is done, say so plainly, tell them what happens on the day, and stop.
```

Skill file `elective-preop.md`, sections in this order, plain Markdown, no front matter:

1. **Checklist order and what done means.** physio → bloods → ecg → anaesthetic_questions → transport.
2. **Prehab and physio.** What the preparation exercises are for, in two sentences, worded for any elective operation with a joint-specific line when the procedure label mentions knee, hip or joint. The one question to ask. The one follow-up if not started.
3. **Bloods.** Why FBC and U&E are needed before an anaesthetic. How to offer slots: two options, morning and afternoon, from real sessions. What to say when they pick.
4. **ECG.** Why it is needed. Booked in the same visit as bloods where possible; state that.
5. **Anaesthetic questions.** Exactly three, asked one per message: current medicines and any blood thinners; allergies or problems with a previous anaesthetic; any chest pain, breathlessness or fever since they were booked. The third is the red-flag question. Any yes to the third is a red flag.
6. **Transport and support.** One question: is there someone to take them home and stay the first night. If the patient has the need "Transport" or "Carer involvement" on record, say the practice can help and offer a task.
7. **Result explanations and responses.** Verbatim copy of the patient explanation column from §7, one heading per outcome code.
8. **Safety net.** The verbatim escalation message from §7 and the rule that nothing else is asked afterwards.
9. **What happens on the day.** Three sentences for the closing message when everything is done.
10. **Modifiers.** One short paragraph per modifier in §5a saying exactly what changes in the conversation.

Tools available to `preop_agent`:

- Existing reads: `get_patient_pathway`, `get_appointment_sessions`, `get_capacity`, `get_resource`.
- Existing writes, reused as they are: `book_appointment`, `create_task`, `order_test` (add to `write.ts` if not yet wired; it is documented but not in the file), `ask_patient`.
- New in `agent/preop/tools.ts`:
  - `save_problem({ patientId, title, problemStatus })` → sim `save_problem` on gp. Used once per run to code "Pre-operative assessment in progress" and, on escalation, the flagged symptom.
  - `update_checklist({ itemId, state, detail })` → store only. The agent calls it after each item is settled by conversation (physio started, questions answered, transport confirmed). Bookings and orders update the checklist through their finalize, not through this tool.
  - `escalate({ patientId, symptom })` → creates the urgent task via sim, sets `escalated`, sets `anaesthetic_questions` to `review`, sets status `clinical_review`. Allowed even after escalation.

Approval over iMessage: the existing yield mechanism stays. The bridge answers a pending yield with the patient's reply text. Server logic: if a yield is pending, the reply is passed as the yield input with `approved` inferred (yes/ok/sure/a slot label/an option label → true; no/not now/later → false; anything else → true with `note` = text). This matches the existing gotcha handling in `ADK-INTEGRATION.md`.

Events from the timeline: `+7` posts a `system` message to the session: `event: results` with the JSON classification. The agent's turn then has `pendingEvent` set in state and must use only its allowed actions and its explanation. After the turn, `pendingEvent` is cleared by the server.

Turn budget: eight agent messages per run before the closing message. Enforced in the server, not the prompt: on the ninth, the server sends the protocol's "we will pick this up next week" line and stops the session until the next `+7`.

## 9. iMessage bridge

File: `agent/imessage.ts`.

- Send: `osascript -e 'tell application "Messages" to send "<text>" to participant "<phone>" of (1st account whose service type = iMessage)'`. Fall back to the SMS account if iMessage send throws. Text is shell-escaped; no newlines beyond one blank line.
- Receive: poll `~/Library/Messages/chat.db` (read-only SQLite via `better-sqlite3`, already a dependency) every two seconds: `message` joined to `handle`, `handle.id = phone`, `is_from_me = 0`, `date > startDateNs`, ordered by `ROWID`. `date` is nanoseconds since 2001-01-01; convert. Track the last seen `ROWID` per handle.
- Routing: handle → `patientId` from the store. A message from a handle with no active run is ignored and logged.
- Whitelist: env `IMESSAGE_ALLOW` is a comma-separated list of E.164 numbers. The console refuses any other number. Nothing is ever sent to a number outside the list.
- Mirror: every send and receive appends to the patient's transcript in the store; the patient app Messages tab and the console read from there.
- Gate: Full Disk Access granted to the terminal or Node binary that runs the server, and one round trip to Aaryan's own phone by 14:45. Until it passes, the console text box is the transport.

## 10. Surfaces

All three are static files served by the existing server. No framework. Poll `GET /api/demo/state` every three seconds.

**Patient app, `pathway.html` (existing).** Add:

- Home: a "Getting ready for your operation" card above "Needs your attention": surgery date, days to go, readiness bar, five pills.
- Pathway page: the same card expanded, each item with its detail line; the record pane below it stays live from the sim.
- Messages tab: renders the transcript from the store instead of the ADK chat when a pre-op run exists for the patient.
- Ctrl+K palette lists the cohort from `/api/demo/state`, featured first.

**Clinician board, `board.html` (new).** One table: patient, procedure, surgery date, days to go, five checklist pills, readiness, status pill (Not contacted grey, In progress amber, Ready green, Clinical review red, Done blue), last contact. Row click opens the patient page. Rows are the whole cohort from §5a, featured first; patients without a run show `Not contacted` with their record-derived detail. Header: "Booked for surgery in this world: N · not ready: M", where N is the cohort size and M is N minus the ready count in the store. Keep the NHS look of `pathway.css`.

**Demo console, `console.html` (new).** Featured patient cards with initials, procedure label, surgery date, needs, conditions and active modifiers, the rest of the cohort as a list, a phone number field, Start, Reset. Timeline strip T-28 … T-0 with the current step highlighted, `-7` and `+7` buttons, the outcome picker per pending item, and a transcript pane per patient with a text box that sends a reply exactly as the bridge would. Voice toggle appears only if the voice lane passes its gate.

Endpoints added to `server.ts`:

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/demo/state` | | full `DemoState` |
| POST | `/api/demo/start` | `{ patientId, phone? }` | creates the run for that patient, opens the ADK session, sends the first message |
| POST | `/api/demo/reply` | `{ patientId, text }` | same path as an inbound iMessage |
| POST | `/api/demo/step` | `{ direction: 1 \| -1, outcomes?: Record<itemId, OutcomeCode \| 'random'> }` | §6 |
| POST | `/api/demo/reset` | | new run, new world name suffix, clears store |
| GET | `/api/board` | | rows derived from the store plus the cached cohort count |

## 11. Voice lane (parallel, gated)

Blocked until a platform OpenAI API key with Realtime access arrives from the organisers. The request goes to an organiser at 14:30, owner: Aaryan.

Same agent, same skill, same rules, different transport. Build order:

1. Handset page `handset.html`: shows an incoming-call screen, rings, Answer connects the browser to OpenAI Realtime over WebRTC with the same system prompt and skill text and a tool bridge back to `/api/demo/reply` and the write tools. Transcript mirrors into the store.
2. Continuity relay: Messages/FaceTime dials the judge's number from the MacBook; BlackHole virtual device carries Realtime audio into the call and the call audio back. Aggregate device for input, multi-output for output, FaceTime pointed at both.

Gate at 15:30: one clean two-way test call on either path. Pass: card one goes by voice and card two by iMessage at the stall, which also shows "channel follows the patient's needs". Fail: iMessage only, no voice debugging after 15:30.

## 12. World and sim writes

Stall world: `POST /api/keys {"teamName":"13health-stall"}`; key in `agent/key-stall.txt`, gitignored, `SIM_KEY` at run time. `Reset` on the console creates `13health-stall-<n>` so a polluted rehearsal never reaches the judges. Clock paused at Start.

Sim actions per checklist item:

| Item | Sim action | Site |
|---|---|---|
| run start | `save_problem` "Pre-operative assessment in progress", active | gp |
| bloods slot picked | `book_appointment` in a real session; `order_test` fbc; `order_test` ue; `order_test` hba1c under `add_hba1c` | gp |
| ecg | `create_task` "Book pre-op ECG at the phlebotomy visit" | gp |
| result with staff action | `create_task` from §7, priority as given | gp |
| escalation | `create_task` urgent, `save_problem` for the symptom | gp |
| transport need | `create_task` "Arrange transport home after surgery" | gp |
| interpreter need | `create_task` "Book interpreter for pre-op visit" | gp |

Every write keeps the returned resource id on the item's `simRefs`. 409 handling is unchanged: never retried, the model offers an alternative.

## 13. Tests and evals

`node:test` under `agent/test/`, no model needed:

- `rules.test.ts`: every outcome code maps to the expected severity, item state and allowed actions; the red-flag detector hits each phrase and misses "no chest pain".
- `timeline.test.ts`: `+7` pushes a snapshot and rolls only due items; `-7` restores the previous state exactly; `+7, -7, +7` with a fixed pick yields the picked outcome; the sim advance is called once per forward step and never on rewind (sim mocked).
- `store.test.ts`: readiness and status derivation for each combination in §5.
- `skill.test.ts`: the skill file contains a heading for every outcome code in the rules table, every modifier in §5a, and the verbatim safety-net line.
- `cohort.test.ts`: against a fixture of sim patients and pathways, the cohort filter keeps the right ids, the featured slots fill by the stated preference with no duplicates, and each modifier fires only on its trigger.

ADK evals with the model, one scenario each, run before freeze:

1. Happy path on a plain patient: start → physio yes → picks a slot → book and two orders happen only after the reply → everything done by step 3 → closing message.
2. Low haemoglobin at step 2: explanation matches the table, `order_test` and `create_task` called, no other write, surgery date unchanged in the message.
3. High potassium: `create_task` urgent, patient told a nurse calls today, readiness holds.
4. New AF: anaesthetist task, explanation matches.
5. Physio not started: one "what is getting in the way" question, then a task only if a fixable barrier is named.
6. Red flag in a reply: safety-net message verbatim, `create_task` urgent, no further question in that or any later turn, no other write after.
7. Declined slot: agent offers an alternative and does not retry the same slot.
8. Turn budget: ninth message is the pick-up-next-week line.
9. Modifiers: a diabetic patient gets the HbA1c added to the order and one sentence why; a patient with a transport need is offered the task on first contact and not asked; a theatre-blocked patient is never given a surgery day.

Each eval asserts: message under 80 words, at most one question mark, write calls only from the allowed list for the event.

## 14. Build tracks and clock

| Track | Owner | Deliverable | Done by |
|---|---|---|---|
| Gates | Aaryan | iMessage round trip to own phone; API key request sent; `13health-stall` world created | 14:45 |
| T1 cohort + store + timeline + rules + board | dev agent 1 | `cohort.ts`, `store.ts`, `timeline.ts`, `rules.ts`, `board.html`, `/api/demo/*`, `/api/board`, unit tests | 15:45 |
| T2 agent + skill + bridge | dev agent 2 | `preop/agent.ts`, `preop/tools.ts`, `skills/elective-preop.md`, `imessage.ts`, evals 1–9 | 15:45 |
| T3 patient app + console | dev agent 3 | `pathway.html` additions, `console.html` | 15:45 |
| T4 voice | dev agent 4 | `handset.html`, Continuity relay; stops at the 15:30 gate | 15:30 |
| Clinical check | clinician on the team | rules table and skill file rows initialled | 16:00 |
| Integration run | Aaryan + presenter | full §2 script end to end, iMessage to a real phone | 16:00 |
| Freeze | named human with veto | video and repo frozen; backup recording of the script | 16:30 |

Interface contracts between tracks, fixed now so they can run in parallel: the `DemoState` shape in §5, the `Modifier` set in §5a, the endpoint table in §10, the `Classification` shape in §7, and the skill file section order in §8. A track that needs to change one of these posts the change in the team channel before making it.

## 15. Open items

- API key for Realtime: requested at 14:30, unresolved until an organiser replies.
- `order_test` is documented in `ADK-INTEGRATION.md` but not present in `agent/tools/write.ts` (checked 14:35). T2 adds it, same yield-and-finalize shape as `book_appointment`.
- Clinician sign-off on thresholds and wording in §7: due 16:00.
