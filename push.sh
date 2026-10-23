#!/usr/bin/env bash
# Creates the GitHub repo and pushes it. Requires git and GitHub CLI (gh auth login).
set -euo pipefail
git init -q -b main
git config user.name  "Saurabh Pathak"
git config user.email "saurabhpathak394@gmail.com"   # change to your GitHub no-reply address if you prefer
git add .
git commit -q -m "Initial commit: mcp-safe-actions 1.0.0"
gh repo create techsaurabh-394/mcp-safe-actions --public --source=. --remote=origin --push \
  --description "Human approval for destructive MCP tools: MCP elicitation first, one-time token fallback, audit log. TypeScript."
echo "Pushed. Next: add topics, upload assets/social-preview.png, check the Actions tab."
