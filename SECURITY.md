# Security Policy

This repo is configuration and extension code for a local agent harness. Treat it as executable code.

## Do not commit

- API keys, OAuth tokens, cookies, SSH keys, GitHub tokens
- `~/.omp/agent/*.db`, `*.db-wal`, `*.db-shm`
- `~/.omp/agent/sessions`, `terminal-sessions`, `logs`, `memories`, `blobs`
- private hostnames, LAN IPs, personal usernames, home paths
- real customer, company, fund, patient, or contact names

## MCP caution

MCP servers can execute commands, read files, and bridge external services. Keep the MCP allowlist small and review every server before enabling it.

## Reporting

Open a GitHub issue with reproduction details. Do not include secrets in issues or PRs.
