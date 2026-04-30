# TypeScript Quality

Expected checks:

- `npm run typecheck`
- `npm test`
- `npm run lint` when configured

Agents should prefer typed interfaces at boundaries and avoid `any` unless the
unknown shape is explicitly normalized.
