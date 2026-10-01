import process from "node:process";
import { inspectPrompt, VERSION } from "../src/index.ts";
import { corpus } from "../tests/corpus.ts";

let missed = 0;
let falsePositives = 0;
for (const entry of corpus) {
  const decision = inspectPrompt(entry.prompt).decision;
  if (entry.expected === "review" && decision !== "review") missed++;
  if (entry.expected === "no_match" && decision !== "no_match") falsePositives++;
}
console.log(JSON.stringify({
  version: VERSION,
  corpus: "Hand-authored regression fixtures, not an independent benchmark",
  cases: corpus.length,
  extractionRequests: corpus.filter((entry) => entry.expected === "review").length,
  benignRequests: corpus.filter((entry) => entry.expected === "no_match").length,
  missed,
  falsePositives,
  limitation: "No generalization or semantic leakage guarantee. No model was called.",
}, null, 2));
process.exitCode = missed + falsePositives > 0 ? 1 : 0;
