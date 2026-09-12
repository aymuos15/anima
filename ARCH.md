# Architecture

```text
┌────────────────────┐
│ Website             │
│ Chat + pathway UI   │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Anima ADK agent     │
│ Explains + responds │
└─────────┬──────────┘
          │ calls tools
          ▼
┌────────────────────┐
│ Pathway builder     │
│ Deterministic rules │
│ Collates records    │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Synthetic NHS-SIM   │
│ GP · hospital ·     │
│ pharmacy · others   │
└────────────────────┘
```

The pathway builder determines stages and blockers using fixed rules. The ADK agent interprets those results and communicates with the user. Write actions require explicit confirmation.
