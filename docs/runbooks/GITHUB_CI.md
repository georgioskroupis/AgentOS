# GitHub CI Runbook

The recommended GitHub Actions workflow is:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run agent-check
```

Add this as `.github/workflows/ci.yml` after GitHub auth has the `workflow`
scope. The current `gh` token can create and push the repository, but GitHub
rejects workflow-file updates without that scope.

