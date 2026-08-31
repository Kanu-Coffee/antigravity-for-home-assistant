# Contributing to Antigravity for Home Assistant

Contributions are welcome. This App has administrator-level access to Home
Assistant, so changes need evidence proportional to their risk and must preserve
the documented trust boundaries.

## Start with the current contract

1. Read [AGENTS.md](AGENTS.md).
2. Read the [3.0 development overview](docs/development/README.md), then the
   relevant product, architecture, security, test, or release document.
3. Follow the [local source-development setup](docs/local-development.md).
4. Inspect Git state and preserve unrelated work.

The App ships separate runtime guidance inside its image. A host-development
checkout has no access to live `/config`, `/data`, Supervisor credentials, or
real HAOS state.

## Development workflow

1. Make the smallest cohesive change that satisfies the 3.0 contract.
2. Add positive, negative, failure, and recovery tests for changed boundaries.
3. Update the Korean and English user guides plus the changelog when user
   behavior changes.
4. Regenerate and verify the source-rootfs manifest after rootfs changes.
5. Record exact sanitized commands, results, architecture/image, and remaining
   verification gaps.

Install local Python tooling with:

```bash
python3 -m pip install -r requirements-dev.txt
```

Run the smallest relevant checks first. The broad source checks include:

```bash
python3 -m pytest -ra
yamllint -c .yamllint .
git grep -Il '^#!' -- antigravity_home_assistant/rootfs tests \
  | xargs --no-run-if-empty shellcheck
npx --yes markdownlint-cli2@0.23.0 \
  "**/*.md" \
  "#**/.pytest_cache/**" \
  "#**/node_modules/**"
sudo apparmor_parser --skip-kernel-load --skip-cache \
  antigravity_home_assistant/apparmor.txt
```

Consult [CI](.github/workflows/ci.yaml) for the current complete job set. Do not
copy stale commands from archived documents.

For an amd64 image and smoke test:

```bash
tools/development/build-app build antigravity-for-home-assistant:test linux/amd64
bash tests/docker-smoke.sh antigravity-for-home-assistant:test
```

The build helper owns an ephemeral per-checkout builder and its cache. Never
prune Docker's shared default resources from this repository.

## Evidence and pull requests

Source, container, and emulated-architecture success does not prove behavior on
real HAOS. Authentication, enforced AppArmor, update reset, Remote reconnect,
dashboard interaction, restart, and rollback claims require the real-device
evidence defined in the [test plan](docs/development/test_plan.md).

In a pull request, include:

- user-visible behavior and compatibility impact;
- exact sanitized commands and results;
- architecture, immutable image digest, and HAOS versions when applicable;
- rollback or recovery behavior; and
- every `PARTIAL` or `NOT RUN` gap.

Never include credentials, private Home Assistant data, raw authorization
headers, or unredacted logs. External publication, releases, and destructive
actions require explicit authorization.
