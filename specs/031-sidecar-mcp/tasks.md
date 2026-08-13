# Tasks: The Sidecar's Local MCP Endpoint

### T001 — the /mcp route  ·  M
- **Acceptance:** POST /mcp serves MCP (initialize → tools/list → tools/call)
  over the shared FsBodyClient + a process-lifetime register; the ferry,
  health, CORS, bind and stdout contract are untouched.

### T002 — tests + gate  ·  S
- **Acceptance:** sidecar.test.ts: tools/list carries read_body + look;
  read_body round-trips over MCP against a seeded file; look answers
  {focus:null, pins:[]}; the ferry tests still pass. `bun run gate` green.

---
Done-when: gate green.
