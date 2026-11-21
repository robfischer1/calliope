import { LiveChaosDial } from "../src/chaos-client.js";
import { runCensus } from "./census-doubled-slots-lib.js";

process.exitCode = await runCensus(
  process.argv,
  new LiveChaosDial(),
  process.stdout,
  process.stderr,
);
