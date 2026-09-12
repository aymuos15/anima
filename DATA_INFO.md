# Data

- 50,000 synthetic patients exposed as JSON through the NHS-SIM REST API; this is not a SQL or CSV dataset.
- Patient fields: `id`, `name`, `birthDate`, `localIds`, `conditions`, `needs`, `goals`, `synthetic`.
- Most other data is a versioned resource with `id`, `patientId`, `kind`, `title`, `status`, `owner`, `visibleTo`, `priority`, `createdAt`, `dueAt`, `data`, `version`, and `provenance`.
- Resource kinds include consultations, problems, allergies, appointments, tasks, documents, messages, referrals, prescriptions, tests, reports, hospital notes, community visits, care plans, observations, beds, and capacity.
- Service views: `gp`, `hospital`, `pharmacy`, `community`, `diagnostics`, `wearables`, and `referrals`. A record appears only where it is visible.
- Views may also include simulation time, staffing, waiting counts, capacity, faults, and events.
- Read records with `GET /api/sites/{site}/view?patient=SIM-000001`.
- All data is fictional. Read the bearer key from `key.txt`; never commit or publicly share it.
