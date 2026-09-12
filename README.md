1. Install dependencies: `cd agent && npm install`.
2. Grant Terminal Full Disk Access; set approved `IMESSAGE_ALLOW` numbers and optional `IMESSAGE_SELF_ALLOW` in your private environment file.
3. In one terminal, run `npm run proxy` from `agent/`.
4. In another, load your private environment and run `SIM_KEY="$(cat key-agent.txt)" OPENAI_BASE_URL=http://127.0.0.1:8788/v1 OPENAI_API_KEY=local ADK_STORE=memory npm run server` from `agent/`.
5. Open `http://127.0.0.1:8790/console.html`, with `board.html` and `pathway.html` beside it; select a patient and start.
