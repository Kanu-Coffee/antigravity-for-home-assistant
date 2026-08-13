# Contributing to Antigravity for Home Assistant

Contributions are welcome. This App handles Home Assistant administrator access,
so changes must preserve the documented security boundaries and include evidence
proportional to their risk.

## Read the current contract first

1. Read [AGENTS.md](AGENTS.md).
2. Follow the canonical [v2 documentation order](docs/v2/README.md).
3. Find the affected FR/SEC/TG/MIG requirement and its test IDs in
   [the checklist](docs/v2/checklist.md).
4. Inspect the current Git state and preserve unrelated changes.

The files under [`docs/development/`](docs/development/README.md) are superseded
v1 evidence, not current implementation instructions.

## Development workflow

For a host Codex checkout, first follow the
[local source-development setup](docs/local-development.md). The root
`AGENTS.md` is the source-development contract; the App receives its separate
runtime guidance from the image rootfs.

1. Fork and clone the repository, then create a focused branch.
2. Make the smallest change that satisfies the canonical contract.
3. Add positive, negative, failure, and recovery tests where the boundary needs
   them.
4. Update Korean canonical documentation, English user documentation, the
   checklist, and changelog when behavior changes.
5. Record what ran, on which architecture/image, and what remains unverified.
6. Open a pull request without credentials, private HA data, or raw logs.

Install local Python tooling with:

```bash
python3 -m pip install -r requirements-dev.txt
```

## Checks that match CI

Run the relevant checks locally. The complete source checks are:

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

CI also runs actionlint, Hadolint, the Home Assistant App linter, secret scanning,
and executable-bit contracts. Consult [the current CI workflow](.github/workflows/ci.yaml)
instead of copying commands from historical documents.

For an amd64 image and its main smoke suite:

```bash
docker build \
  --platform linux/amd64 \
  --tag antigravity-for-home-assistant:test \
  antigravity_home_assistant
bash tests/docker-smoke.sh antigravity-for-home-assistant:test
```

Smoke scripts are invoked with `bash` and an explicit image argument; do not rely
on their executable bit or run `./tests/docker-smoke.sh` without an image. The CI
workflow also runs feedback, browser, memory, managed-auth, migration/update, and
emulated arm64 smoke suites.

## Evidence and pull requests

A build or emulated arm64 smoke is not proof of runtime support on real HAOS.
AppArmor enforcement, native OAuth, dashboard rendering, Telegram approval,
migration, and rollback claims require the HAOS evidence named in
[the v2 test plan](docs/v2/test-plan.md). Do not mark a checklist item
`VERIFIED` when any required result is `PARTIAL`, `NOT RUN`, or narrower than the
requirement.

In the pull request, include:

- affected requirement and test IDs;
- exact sanitized commands and results;
- architecture, image reference/digest, and HAOS versions when applicable;
- changed user behavior and rollback plan;
- remaining gaps and known residual risks.
