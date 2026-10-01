#!/usr/bin/env node
import process, { stdin, stdout, stderr, argv } from "node:process";
import { Buffer } from "node:buffer";
import { inspectPrompt, projectResponse, type Provider } from "./index.js";

const providers = new Set<Provider>(["openai-chat", "openai-responses", "anthropic"]);
const mode = argv[2];
const provider = argv[3] as Provider;

async function main(): Promise<void> {
  if (mode === "--help" || mode === undefined) {
    stdout.write("Krextract: Kreflux Reasoning Extraction defense\n\nkrextract prompt < prompt.txt\nkrextract project <openai-chat|openai-responses|anthropic> < response.json\n\nNo model calls or telemetry. Exit 2 means review/withheld; exit 1 means invalid input.\n");
    return;
  }
  if (mode !== "prompt" && (mode !== "project" || !providers.has(provider))) throw new Error("Invalid command.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 1_048_576) throw new Error("Input exceeds one MiB.");
    chunks.push(bytes);
  }
  const input = Buffer.concat(chunks).toString("utf8");
  if (mode === "prompt") {
    const assessment = inspectPrompt(input);
    stdout.write(`${JSON.stringify(assessment)}\n`);
    process.exitCode = assessment.decision === "review" ? 2 : 0;
  } else {
    const result = projectResponse(provider, JSON.parse(input) as unknown);
    stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "withheld" ? 2 : 0;
  }
}

void main().catch(() => {
  // Parser errors can include private input excerpts. Do not echo them.
  stderr.write("Krextract rejected the command or input. Use --help and check the JSON schema and size.\n");
  process.exitCode = 1;
});
