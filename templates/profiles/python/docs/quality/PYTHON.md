# Python Quality

Expected checks when tools are installed:

- `ruff check .`
- `mypy .`
- `pytest`

Agents should keep IO, orchestration, and domain logic separated enough for
targeted tests.
