# Python Quality

Expected checks when tools are installed:

- `ruff check .`
- `mypy .`
- `pytest`

Agents should keep IO, orchestration, and domain logic separated enough for
targeted tests.

App legibility guidance:

- document the module, script, or server command that starts the app
- prefer `pytest` smoke coverage for runtime behavior
- include log paths and any metrics/trace commands exposed by the Python stack
