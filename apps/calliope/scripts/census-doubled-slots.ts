// Read-only census of slots holding more than one tree_content — see
// census-doubled-slots-lib.ts. One statement; the decisions live in the lib.
// `--help` is answered before any dial is built.
import { LiveChaosDial } from "../src/chaos-client.js";
import { runCensus } from "./census-doubled-slots-lib.js";

process.exitCode = await runCensus(
  process.argv,
  new LiveChaosDial(),
  process.stdout,
  process.stderr,
);
