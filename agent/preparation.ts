// Curated demo data, shared by the patient UI and agent. Not simulator orders/results.
export function preparationFor(patientId: string) {
  if (patientId !== 'SIM-000007') return null
  return {
    source: 'curated-demo' as const,
    items: [
      { label: 'Blood test', mandatory: true, done: false },
      { label: 'ECG', mandatory: true, done: true },
      { label: 'Physiotherapy', mandatory: true, done: false },
    ],
  }
}
