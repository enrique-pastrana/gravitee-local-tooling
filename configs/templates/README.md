# Config templates

The setup command patches real agent config files directly:

```bash
./bin/local-tooling setup --agents all --repo /path/to/repo
```

To preview what would be added, run:

```bash
./bin/local-tooling print-config --agent codex
./bin/local-tooling print-config --agent cursor
./bin/local-tooling print-config --agent claude
```

Generated configs call `bin/local-tooling mcp <server>` so secrets stay in `.env`.

For target repositories, install lightweight workflow rules with:

```bash
./bin/local-tooling install-agent-rules --repo /path/to/the/code-repo-you-work-on --agents cursor
```
