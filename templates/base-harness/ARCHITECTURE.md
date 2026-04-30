# ARCHITECTURE.md

## Layers

Code should follow this dependency direction unless this repository documents a
more specific architecture:

```text
types -> config -> data/repo -> services -> runtime -> ui
```

## Rules

- UI may depend on services, but services may not depend on UI.
- Data access belongs in repository or data modules.
- Runtime wiring belongs in bootstrap or composition modules.
- Cross-cutting concerns should enter through explicit providers.

## Validation

Run:

```bash
./scripts/agent-check.sh
```

