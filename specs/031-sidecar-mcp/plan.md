---
title: "The Sidecar's Local MCP Endpoint"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# The Sidecar's Local MCP Endpoint — Design Plan

> **Binding contract.** (Constitution I/II)

## Summary
One route on the existing sidecar server: `POST /mcp` builds a per-request
`createServer(client, { focus })` over the SAME FsBodyClient and a
process-lifetime FocusRegister, wired through `StreamableHTTPServerTransport`
(stateless, `sessionIdGenerator: undefined`) — the exact `mcp/http.ts`
`handleMcp` pattern, transplanted. The ferry route, health route, CORS, bind
and boot contract are untouched.

## Contracts & Seams
| Surface | Shape | State |
| :--- | :--- | :--- |
| `POST /mcp` on the sidecar port | MCP streamable-http, stateless; tools = the fs-supported body surface + `look` | decided |
| bind | 127.0.0.1 only (unchanged — the off-host refusal is connection-level) | decided |

Consumes: `mcp/server.ts` `createServer` (focus default param, 028) ·
`@modelcontextprotocol/sdk` StreamableHTTPServerTransport (already a
dependency via the MCP server) · `FsBodyClient` (shared instance).

RR verified: `apps/calliope/src/mcp/sidecar.ts` (route) ·
`apps/calliope/__tests__/sidecar.test.ts` (conformance). **RR delta vs
master-plan:** `repo:grace apps/desktop/src/` (lifecycle) needs NO change —
the endpoint rides the listener grace already boots and ports it already
parses; surfaced here.

## Decision Log
| Decision | Resolution | Rationale | Provenance |
| :--- | :--- | :--- | :--- |
| Transport | stateless streamable-http per request | the proven http.ts pattern; no session state to leak | Claude (http.ts law) |
| Auth | none beyond loopback (v1) | the machine is the trust boundary the sidecar already declares | Default (binding; hardening surfaced) |
| Verb subset | fs-supported + structured refusals | the de-inference law already IS the subset policy | Default (binding) |
| Register | one per process, unfed | look answers honestly empty; a local feed is future wiring | Default (binding) |

## Open & risk
- Token auth for multi-user machines — surfaced hardening.
- A local pointer feed (grace's editor → the sidecar register) — future wiring, out of scope.

---
Definition of Ready: all checked.
