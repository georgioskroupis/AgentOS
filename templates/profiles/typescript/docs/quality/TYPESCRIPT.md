# TypeScript Quality

Expected checks:

- `npm run typecheck`
- `npm test`
- `npm run lint` when configured

Agents should prefer typed interfaces at boundaries and avoid `any` unless the
unknown shape is explicitly normalized.

App legibility guidance:

- document the `npm` script or CLI command that starts the app
- keep smoke tests runnable with the package manager already in use
- include Node/server logs, CI logs, and any configured metrics/trace commands
