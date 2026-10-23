# Contributing

Thanks for helping make AI agents safer to use.

## Ground rules
1. Any change to approval logic needs a test proving that the action does **not** run without approval, plus one for the failure path.
2. Failures must fail closed: an error never leads to execution.
3. Never log raw tool arguments.
4. No network calls, telemetry or extra runtime dependencies.

## Development
```bash
git clone https://github.com/techsaurabh-394/mcp-safe-actions.git
cd mcp-safe-actions
npm install
npm test         # builds, then runs all tests
npm run demo     # prints both approval flows
```

## Publishing to npm (maintainer)
1. Create an npm access token (automation type) and add it as the repository secret `NPM_TOKEN`.
2. Set the repository variable `PUBLISH_NPM` to `true`.
3. Tag a release: `git tag v1.0.0 && git push --tags`.

Maintained by Saurabh Pathak.
