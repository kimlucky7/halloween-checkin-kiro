#!/usr/bin/env node
// PreToolUse guard: ask the user before any command that could change a remote
// Cloudflare account. Reads the hook's JSON from stdin and inspects the command
// text. Local-only wrangler usage (--local, dry-run) is allowed without a prompt.
// Exit 0 always; the decision is printed as hook JSON.
import process from "node:process";

export function classify(text) {
  const t = String(text);
  if (!/wrangler/.test(t)) return null;
  if (/--local\b|--dry-run\b|\bwhoami\b|--version\b|\bwrangler\.local\b/.test(t) && !/--remote\b|\bdeploy\b(?!.*--dry-run)/.test(t)) return null;
  const risky = [
    /\bwrangler\s+(?:\S+\s+)*(?:deploy|publish|delete|rollback)\b/,
    /\bwrangler\s+(?:\S+\s+)*secret\b/,
    /\bwrangler\s+(?:\S+\s+)*(?:d1|r2|kv|queues)\s+(?:\S+\s+)*(?:create|delete|execute|migrations)\b/,
    /--remote\b/,
  ];
  return risky.some((re) => re.test(t))
    ? "This command may create, change or delete resources in a Cloudflare account. The account that wrangler is logged into may be a production account. Confirm the target account and that this is intended."
    : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    const reason = classify(input);
    if (reason) {
      console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: reason } }));
    }
    process.exit(0);
  });
}
