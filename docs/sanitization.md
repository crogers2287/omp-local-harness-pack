# Sanitization Checklist

Run this before publishing any fork or generated package.

## Must not appear

- personal usernames or home paths
- private hostnames or LAN IPs
- API keys, OAuth tokens, cookies, passwords, SSH keys
- real names of private people, companies, funds, customers, or patients
- OMP runtime files: `*.db`, `*.db-wal`, `*.db-shm`, sessions, logs, memories, blobs
- `.env`, `hosts.yml`, credential stores, browser profiles

## Suggested checks

```bash
git grep -nE '(your-username|/home/|ghp_|github_pat_|sk-[A-Za-z0-9]|Bearer |TOKEN|SECRET|PASSWORD|oauth|cookie|private-host|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
```

Also inspect exact staged bytes:

```bash
git diff --cached --stat
git diff --cached
```

If a value is required for users, publish a placeholder and document how to set it locally.
