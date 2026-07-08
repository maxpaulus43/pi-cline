// Installs the pre-commit hook that drives changelog generation.
// Run automatically via `npm install` (the "prepare" script). No-ops when
// not in a git repo so it is safe to run during publish/consumer installs.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

if (!existsSync(".git")) process.exit(0);

const hook = `#!/bin/sh
node scripts/gen-changelog.mjs
`;

mkdirSync(".git/hooks", { recursive: true });
writeFileSync(".git/hooks/pre-commit", hook);
chmodSync(".git/hooks/pre-commit", 0o755);
