# Code Review: @forge/calliope
**Date:** 2026-07-09  
**Reviewer:** Gemini (Rob's Technical Voice)  
**Target Repository:** `/home/rob/Forge/Outputs/calliope`

---

## Executive Summary

The `@forge/calliope` repository implements the Model Context Protocol (MCP) prose/body service over a structured section body model (`note --hasPart--> section`). The codebase is written in TypeScript, targeted at the Bun runtime, and provides clean seams between direct graph substrate access (Urania) and the PostgreSQL sovereign store. 

### Key Findings
1. **Critical Algorithmic Failures in `order-key.ts`**: The fractional indexing system contains fatal bugs in `keyBelow` and `midpoint`. Specifically, calling `between(null, "1")` yields `"11"` (which is lexicographically greater than `"1"`), and `between("2", "21")` yields `"215"` (which is greater than `"21"`). These fail the strict ordering contracts required for document editor insertions and reorders.
2. **Concurrency/Write-Skew Race Hazard in `PgBodyClient`**: The soft-deleting coarse save in `PgBodyClient.saveBody` is vulnerable to concurrent write races. Two concurrent requests writing to a previously empty node will both execute updates matching zero rows (locking nothing), proceed to insert their respective sections, and commit them all as `active`. This leaves the node body in a corrupted, duplicated state.
3. **High Request Overhead in the HTTP Server**: The HTTP entrypoint (`http.ts`) instantiates a new `McpServer` and a new `StreamableHTTPServerTransport`, and recompiles Zod validation schemas on *every single request*. This is highly inefficient for stateless POST invocations.

---

## Tech Stack & Architecture

### Tech Stack
* **Runtime**: Bun (`bun.lock`, `package.json` package manager: `bun@1.3.14`).
* **Database**: PostgreSQL (via `pg` pool).
* **Broker**: Redpanda/Kafka (via `kafkajs` for Pontus heartbeats).
* **Protocol**: Model Context Protocol (MCP SDK: `@modelcontextprotocol/sdk`).

### Components & Entrypoints
* **`src/mcp/main.ts`**: Serves the four prose-facet tools over standard I/O (Stdio).
* **`src/mcp/http.ts`**: Serves the MCP tools as a stateless HTTP constellation "star" over port `8204`.
* **`src/pg-client.ts`**: Implements [PgBodyClient](file:///home/rob/Forge/Outputs/calliope/src/pg-client.ts) for the PostgreSQL sovereign store (copy-on-write section table).
* **`src/urania-client.ts`**: Implements [UraniaBodyClient](file:///home/rob/Forge/Outputs/calliope/src/urania-client.ts) for mapping the section model to graph triples.
* **`src/order-key.ts`**: Handles fractional key generation for ordering sections.

---

## Critical Findings

### 1. Algorithmic Failures in Fractional Indexing (`order-key.ts`)

The fractional sort key module [src/order-key.ts](file:///home/rob/Forge/Outputs/calliope/src/order-key.ts) implements string-based ordering (COLLATE "C") to support inserting sections between arbitrary items. The logic contains two severe bugs.

#### A. The `keyBelow` Lower-Bound Violation
When generating a key below a lower bound, `keyBelow` fails if the bound starts with the alphabet floor (`FIRST = "1"`).
* **Code in question**:
  ```typescript
  function keyBelow(b: string): string {
    const head = b[0] ?? LAST;
    if (head > FIRST) {
      return String.fromCharCode(head.charCodeAt(0) - 1);
    }
    return b + FIRST > b ? FIRST + FIRST : FIRST;
  }
  ```
* **Failure trace**: If `b = "1"`, then `head = "1"`. Since `head > FIRST` is false, it returns `b + FIRST > b ? FIRST + FIRST : FIRST`. `"11" > "1"` is true, so it returns `"11"`.
* **Impact**: `"11"` sorts lexicographically *after* `"1"`. This means `between(null, "1")` yields a key that is *greater* than `"1"`, violating the lower-bound insertion contract.

#### B. The `midpoint` Upper-Bound Violation
When generating a key between two adjacent keys where the first is a prefix of the second (e.g. `"2"` and `"21"`), the algorithm cascades digits until it appends a value that exceeds the upper bound.
* **Failure trace for `between("2", "21")`**:
  1. `i = 0`: characters match (`"2"`). `prefix = "2"`.
  2. `i = 1`: `a` has no character (`da = NaN`, so `ca = 48` / `"0"`). `b` has `"1"` (`cb = 49`). `cb - ca = 1`. Adjacent condition met. It appends the default digit `"1"` (`FIRST`), setting `prefix = "21"`.
  3. `i = 2`: both are `NaN` (`ca = 48`, `cb = 58`). `cb - ca = 10 > 1`. `mid = 53` (`"5"`). Returns `"215"`.
* **Impact**: `"215"` is lexicographically *greater* than the upper bound `"21"`. The resulting order becomes `"2" < "21" < "215"`, breaking sorting constraints.

---

### 2. Concurrency Race Hazard in `PgBodyClient.saveBody` (`pg-client.ts`)

The PostgreSQL client implementation [src/pg-client.ts](file:///home/rob/Forge/Outputs/calliope/src/pg-client.ts) updates section states using soft-deletes:

```typescript
async saveBody(nodeId: string, sections: SectionInput[]): Promise<void> {
  const keys = sequence(sections.length);
  const client = await this.#pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE sections SET active = false WHERE node_id = $1 AND active`,
      [nodeId],
    );
    // Inserts the new sections ...
    await client.query("COMMIT");
  ...
```

* **Vulnerability**: If two transactions concurrently invoke `saveBody` for the same `nodeId` when the node has no active sections (e.g., initial creation or post-clearance), both transactions' `UPDATE` statements will match `0` rows.
* **Consequence**: Neither transaction acquires a row lock. Both transactions then proceed to insert their sections with `active = true` (default) and commit. Upon completion, the database will store multiple sets of active sections for the same node, resulting in duplicated or interleaved content during subsequent reads.

---

### 3. Performance Bottleneck in Stateless HTTP Star (`http.ts`)

In [src/mcp/http.ts](file:///home/rob/Forge/Outputs/calliope/src/mcp/http.ts), the stateless HTTP POST handler recreates the server and transport stack on every request:

```typescript
async function handleMcp(...): Promise<void> {
  const server = createServer(client, { ... });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  // Connect, handle request, close on response end
  ...
}
```

* **Vulnerability**: Every HTTP request triggers Zod parser/schema compilation for all tools in `server.ts`. This incurs significant CPU and garbage-collection overhead under load.
* **Remediation**: Since Hades invokes MCP stars statelessly, the server should be initialized once at startup. The HTTP request handler should call `server.handleMessage(body)` directly.

---

## Refactoring Recommendations

### Recommendation 1: Fix `order-key.ts`
Replace the algorithm in [src/order-key.ts](file:///home/rob/Forge/Outputs/calliope/src/order-key.ts) with a robust prefix-aware midpoint calculator and a corrected floor generator.

```typescript
export function between(a: string | null, b: string | null): string {
  if (a === null) {
    return b === null ? MID : keyBelow(b);
  }
  if (b === null) return keyAbove(a);
  if (compareKeys(a, b) >= 0) {
    throw new Error(`between(): keys not strictly ordered: ${a} >= ${b}`);
  }

  // Find the first differing character index
  let i = 0;
  while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }

  // Case A: a is a prefix of b
  if (i === a.length) {
    let suffix = "";
    for (let j = i; j < b.length; j++) {
      if (b.charCodeAt(j) > 48) { // '0' is 48
        suffix += "05";
        break;
      } else {
        suffix += "0";
      }
    }
    return a + suffix;
  }

  // Case B: a and b differ at index i. Since a < b, a[i] < b[i].
  const ca = a.charCodeAt(i)!;
  const cb = b.charCodeAt(i)!;

  if (cb - ca > 1) {
    const mid = Math.floor((ca + cb) / 2);
    return a.slice(0, i) + String.fromCharCode(mid);
  }

  // Case C: Adjacent characters. Extend a with a mid-alphabet digit.
  return a + "5";
}

function keyBelow(b: string): string {
  // Find first character > '0' to decrement, and append a pad to leave room
  for (let i = 0; i < b.length; i++) {
    const code = b.charCodeAt(i);
    if (code > 48) {
      const prefix = b.slice(0, i);
      const dec = String.fromCharCode(code - 1);
      return prefix + dec + "5";
    }
  }
  return b + "05"; // fallback
}
```

### Recommendation 2: Serialize Writes in `PgBodyClient`
Inject transaction-scoped advisory locks on the node hash inside [src/pg-client.ts](file:///home/rob/Forge/Outputs/calliope/src/pg-client.ts) to serialize write actions without requiring physical parent records.

```typescript
// Inside saveBody and editSection, immediately after client.query("BEGIN"):
await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [nodeId]);
```

### Recommendation 3: Refactor HTTP Stateless Star (`http.ts`)
Avoid reconstructing the `McpServer` and `StreamableHTTPServerTransport` objects on every request. Initialize the server once in `main()` and pass it to the handler:

```typescript
// In http.ts, instantiate a single long-lived server at boot:
const server = createServer(backend.client, { ... });

// In handleMcp, execute the JSON-RPC call directly:
async function handleMcp(req, res, server) {
  const body = await readBody(req);
  const response = await server.handleMessage(body);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
}
```
