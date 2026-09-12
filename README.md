# Anima

NHS App style patient pathway view with an AI care team agent, over a synthetic NHS simulator.

Local development only. Chat uses gpt-5.6-luna with low reasoning through Codex OAuth.

```bash
npm install
npm run dev   # simulator key in agent/key-agent.txt; signed-in Codex CLI required
```

The dev command starts or reuses the local OAuth proxy automatically. Open http://127.0.0.1:8790/.

Setup and conventions: [AGENTS.md](AGENTS.md).
