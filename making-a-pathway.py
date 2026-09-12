#!/usr/bin/env python3
import sys
import json
import urllib.request

BASE = "https://sim.animahacks.com"
SITES = ["gp", "hospital", "referrals", "diagnostics", "pharmacy", "community", "wearables"]

STAGE_BY_KIND = {
    "referral": "referred",
    "encounter": "assessed",
    "hospital-attendance": "assessed",
    "surgery": "waiting",
    "theatre-slot": "waiting",
    "discharge-summary": "discharged",
}


def fetch(site, patient, key):
    url = f"{BASE}/api/sites/{site}/view?patient={patient}&limit=500"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def build_pathway(patient, key):
    events = []
    for site in SITES:
        data = fetch(site, patient, key)
        for r in data.get("resources", []):
            if r.get("patientId") == patient:
                events.append({
                    "site": site,
                    "createdAt": r.get("createdAt"),
                    "kind": r.get("kind"),
                    "status": r.get("status"),
                    "title": r.get("title"),
                    "stage": STAGE_BY_KIND.get(r.get("kind"), "other"),
                })
    events.sort(key=lambda e: e["createdAt"] or 0)
    return events


def flag_risk(events):
    risks = []
    for e in events:
        if e["status"] == "waiting":
            risks.append(f"stuck waiting: {e['title']} ({e['site']})")
        if e["status"] == "rejected":
            risks.append(f"blocked: {e['title']} ({e['site']})")
    return risks


def main():
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <patient-id> <key-file>")
        sys.exit(1)

    patient, key_file = sys.argv[1], sys.argv[2]
    key = open(key_file).read().strip()

    events = build_pathway(patient, key)
    for e in events:
        print(f"[{e['site']}] {e['createdAt']} {e['kind']} | {e['status']} | stage={e['stage']} | {e['title']}")

    risks = flag_risk(events)
    if risks:
        print("\nRisks:")
        for r in risks:
            print(f"- {r}")


if __name__ == "__main__":
    main()
