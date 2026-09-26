# fixture-math-repo
Deliberately broken fixture for the ludi-agent-kit pipeline E2E. `average()` divides by `length + 1`.
Do not fix in place; the E2E copies this directory to a temp location before running.
