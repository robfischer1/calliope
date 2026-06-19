# @forge/calliope

Calliope — the node-body **prose** editor. "clotho for prose": a ProseMirror
editor over the urania substrate, the Obsidian replacement.

One urania substrate, two peer facets:

- **Clotho** — the work/graph facet (board-mcp replacement). Never touches bodies.
- **Calliope** (this repo) — the body/prose facet. Talks to the substrate
  directly (urania capture via the Hades gate); **not** through clotho.
- **Tantalus** — the render surface for Clotho's graph; imports Calliope's editor
  for body text.

## Body model

A node's body is stored as substrate triples — no blocks, no arrangements:

```
note    --hasPart-->   section          # node edge
section : hasType "section"             # a placement id (not content-addressed)
section --text-->      "<prose>"        # literal; interned content-addressed
section --order_key--> "<key>"          # fractional key, sorted COLLATE "C"
```

Reading a body resolves the note's `hasPart` section targets, resolves each to
`{ text, order_key }`, and sorts by `order_key`. Edits are **copy-on-write**:
changed prose mints a new version node that supersedes the old; `hasPart` is
rewired.

## Public API

```ts
type Section = { id: string; text: string; orderKey: string };
type SectionInput = { text: string }; // position = array order

interface BodyClient {
  readBody(nodeId: string): Promise<Section[]>;
  saveBody(nodeId: string, sections: SectionInput[]): Promise<void>;
}

function NodeBodyEditor(props: {
  nodeId: string;
  client: BodyClient;
  readOnly?: boolean;
  onSaved?: () => void;
}): JSX.Element;

class FixtureBodyClient implements BodyClient; // in-memory; ships now
class UraniaBodyClient implements BodyClient; // substrate-direct; live wire deferred
```

## Clients

- **`FixtureBodyClient`** — in-memory, fully working. Default for standalone dev
  and for Tantalus today.
- **`UraniaBodyClient`** — substrate-direct (urania capture via Hades). The
  body-model mapping (copy-on-write `hasPart`/`text`/`order_key`) is real; the
  **live transport is deferred**, guarded behind `CALLIOPE_URANIA_WIRED` and an
  injected `UraniaCapture`, exactly like Tantalus's current clotho swap-seam.

## MCP server

The prose facet is also an MCP server exposing four tools (`read_body`,
`write_body`, `append_section`, `edit_section`) over the same backend selection
(`UraniaBodyClient` live by default — `URANIA_URL`, internal-net
`http://urania:8202`; `CALLIOPE_MCP_BACKEND=fixture` for a standalone server).
Two transports, one shared tool set:

- **stdio** — `calliope-mcp` bin (`dist/mcp/main.js`); for Tantalus + local use.
- **streamable-HTTP** — `calliope-mcp-http` bin (`dist/mcp/http.js`,
  `pnpm start:http`); serves `POST /mcp` on `$PORT` (else `$CALLIOPE_MCP_PORT`,
  else 8204). This is the **constellation star** form: the Hades MCP gateway
  fronts it east-west at `http://calliope-mcp:8204/mcp`. Stateless — a fresh
  server+transport per request over a long-lived backend.

## Deploy (nas01 star)

`compose.yaml` + `Dockerfile` + `.forgejo/workflows/deploy.yml` ship the HTTP
star to nas01: container/hostname `calliope-mcp` on the external `mnemosyne-net`,
internal-only (no host port), reaching urania at `URANIA_URL=http://urania:8202`.
Push to `main` runs the gate (format/lint/typecheck/test/build) then builds,
pushes to the Forgejo registry, and recreates the container. Joining the
constellation is one line in the gateway's `hades.toml` `[stars]` table
(`calliope = "http://calliope-mcp:8204/mcp"`) + a Hades restart.

## Develop

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The package builds to `dist/` (ESM + `.d.ts`). A consumer links it with
`file:../calliope`.
