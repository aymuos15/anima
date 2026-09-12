# Pathway examples

16 patients from the synthetic world (sim.animahacks.com), each verified against their actual records
rather than their condition label. These are in addition to the six already used as worked examples
(SIM-000007, SIM-000504, SIM-000023, SIM-000002, SIM-000070, SIM-000001).

Machine-readable version: `agent/data/examples.json`.

| ID | Name | Pathway type | Story | Next action |
| --- | --- | --- | --- | --- |
| SIM-000003 | Aisha Patel | Digital access barrier + provider choice | Night-shift worker; booking links expire before she can use them (r-10) and an open diagnostic provider choice (r-50: 9 vs 15 day waits) is unanswered. | Send a non-expiring afternoon booking link; record the provider choice |
| SIM-000004 | Thomas Reed | Genomic test, uncertain result | Rare-disease panel (r-45) reviewed as "uncertain", consent clinical-only, family contact not allowed; he asked on 2026-09-03 for the specialist letter explained with an interpreter. | Book a double slot with an interpreter |
| SIM-000005 | Grace Okafor | Wearable data not reaching the record | Monitor stopped syncing after a phone change and no readings have arrived, yet the wearables register still shows the glucose monitor "active", 88% battery. | Arrange device reconnection support before the review |
| SIM-000006 | Eleanor Chen | Care package waiting for funding | Frailty, step-free access; community care package (r-44) waiting on a pending funding decision with no key safe, plus an open care plan (r-36) for unarranged home support. | Chase the funding decision; assess home access |
| SIM-000008 | Sofia Williams | Screening invitation unanswered | Invitation (r-38) was delivered by app only to a patient with no smartphone; counted as delivered, never completed. | Reissue the invitation by post with a callback number |
| SIM-000009 | Thomas Chen | Pharmacy First minor illness | Sore throat referral reached the pharmacy at 07:30 on 2026-09-12 and is still at stage "received"; nothing has come back to the GP. | Book the pharmacy consultation slot |
| SIM-000010 | Oliver Khan | Pharmacy First with transport need | Infected insect bite referral received 07:00 on 2026-09-12, unactioned; transport need means the assigned pharmacy may be unreachable. | Offer a pharmacy within walking distance |
| SIM-000011 | Zara Khan | Post-surgical handover, follow-up unconfirmed | General surgery handover sent 2026-08-31; task r-120 open since 2026-09-09 with one contact attempt, due 2026-09-17, alongside a separate pharmacy referral. | Second contact attempt before the due date |
| SIM-000012 | Mei Brown | Rehab discharge, repeat contacts failing | Therapy rehabilitation handover sent 2026-08-30; task r-126 has two failed contact attempts and no clinical contact since 2026-06-25. | Send a letter after two failed calls |
| SIM-000021 | Eleanor Williams | Follow-up task never started | ED discharge notification sent 2026-09-04; the resulting task r-196 still shows zero contact attempts. | Make the first contact attempt |
| SIM-000039 | Oliver Ahmed | Uncontactable after day-case surgery | Orthopaedics day-case handover reviewed 2026-08-31; task r-322 has exhausted three contact attempts; needs step-free access. | Written invitation, then a home review |
| SIM-000058 | Daniel Brown | Discharge letter stuck in draft | Ophthalmology letter still "draft" with no assignee after an appointment-reference mismatch, while three contact attempts failed for a patient needing offline contact and a carer. | Assign and send the draft letter; contact the carer |
| SIM-000506 | Peter Davies | Accessible information need | Hearing loss; missed part of a phone call and came to reception in person; asked for large-print written summaries after each contact. | Issue a large-print written summary each time |
| SIM-000511 | Iris Walker | Home visiting coordination | Will not admit a visiting team unless named in advance; a community visit clashed with a family outing; wants a paper list of teams and a number to rearrange. | Schedule visits with the team named in advance |
| SIM-015005 | Ada N. Richards | New referral awaiting triage | Referral r-3892 created 2026-09-12, still open with no triage, clinic or date; letter-only contact. | Triage the referral; send a posted appointment letter |
| SIM-028263 | Edith U. Edwards | Prescription awaiting pharmacy review | Prescription r-3948 arrived 2026-09-12 and is still "open" — not reviewed, approved or dispensed; no collection confirmation sent. | SMS the patient when it is ready |

## Pathway shapes not found in the data

- **Test ordered with a result delayed.** There are no `test` resources attached to any patient in the
  world; diagnostics carries messages and reports but no outstanding patient-level orders. The nearest
  shape is the unanswered diagnostic provider choice on SIM-000003.
- **Wearable device explicitly disconnected.** All three `device` records are status `active` with good
  battery and quality. The only disconnection evidence is narrative (SIM-000005's consultation notes),
  never reflected in the device record — which is itself the interesting finding.
- **Formal complaint / PALS.** No complaint resource kind exists. Repeat-contact frustration is only
  expressed as `request` records (e.g. SIM-000002's "Fourth contact: what happened to my referral?").
- **Medicine supply shortage.** Only two prescriptions in the world are attached to identified patients
  and both are already `collected` or newly `open`; there is no out-of-stock or failed-supply case
  beyond the already-used SIM-000001 furosemide example.
- **Second rejected/blocked referral.** Both `referral: rejected` records belong to SIM-000002, which is
  already a worked example; all other referrals are simply `open`.
- **Carer-involved multi-morbidity with an active care plan.** Many patients carry a "Carer involvement"
  need, but only SIM-000006 has an actual community care plan; for everyone else the carer never
  appears in the records.
