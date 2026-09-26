# mcp/

Backend-neutral catalog of MCP servers (`servers.json`). Adapters translate entries into
their runtime's format (pi: `pi-mcp-adapter` `mcp.json`; Codex: `config.toml` `[mcp_servers]`).

Rules:
- No tokens or secrets. Use `authEnv` naming an environment variable, or rely on the
  runtime's own OAuth/auth store.
- `enabled: false` entries are documentation only and are never rendered.
- The user's live `~/.pi/agent/mcp.json` is never overwritten by this kit; `sync-pi.ps1`
  renders a proposal file inside the repo (`adapters/pi/out/`) for review.
