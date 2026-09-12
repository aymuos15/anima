# Idea

# What API Allows

- Search patients per site
- Read all resources for a site/patient
- Submit actions
- Read/advance clock
- No pathway concept — must be derived from raw resources

# Making a pathway

- Pick a patient ID
- Query `/view?patient=...` on each site (gp, hospital, referrals, diagnostics, ...)
- Collect all resources with that `patientId`
- Sort by `createdAt`
- Group/label by kind + status into stages (referred → assessed → waiting → admitted → discharged)
- Flag risk from status/timing (e.g. stuck "waiting", capacity blocked)
