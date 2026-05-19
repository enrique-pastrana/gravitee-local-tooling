# Troubleshooting

## Docker is not available

Run:

```bash
docker version
docker compose version
```

Start Docker Desktop or your Docker daemon, then retry `./bin/local-tooling doctor`.

## Port conflict

Change `VDB_API_PORT` or `POSTGRES_PORT` in `.env`.

## Empty search results

Run:

```bash
./bin/local-tooling index --repo /path/to/repo --profile default
./bin/local-tooling doctor
```

Check that the health output reports a non-zero document count.

## GitHub auth fails

Set `GITHUB_PERSONAL_ACCESS_TOKEN` in `.env`. The default GitHub MCP command uses read-only mode.

## Atlassian auth fails

Check `ATLASSIAN_SITE_URL` and retry the agent. `mcp-remote` may require browser/OAuth authorization in the host environment.

## Kapa auth fails

Set either:

- `KAPA_REMOTE_MCP_AUTH_HEADER`
- `KAPA_API_TOKEN`

If both are set, `KAPA_REMOTE_MCP_AUTH_HEADER` wins.
