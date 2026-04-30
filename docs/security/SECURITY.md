# Security

## Defaults

- Do not commit secrets, tokens, private keys, or local credentials.
- Do not log sensitive user data.
- Treat authentication, authorization, payments, and personal data as high-risk
  areas.
- Public dependency additions require justification in the PR summary.

## Security Review Triggers

Request extra review when a change touches:

- authentication or authorization
- data export or deletion
- payment or billing flows
- secret handling
- dependency upgrades with security implications
