# Manifests

Generated manifests are written to `manifests/generated/`.

```bash
./bin/local-tooling manifest --repo /path/to/repo --profile default
./bin/local-tooling manifest --repo /path/to/gravitee-api-management --profile gravitee-apim
```

Each manifest describes which local files are eligible for bootstrap indexing into vectordb.
