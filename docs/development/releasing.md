# 3.0 release process

## Version contract

Every deployable App change uses a previously unpublished version greater than
the latest published release. The minimum bump is patch +1. Version 3.0.0 is a
breaking release because it performs the documented no-backup reset.

Update every release-version binding together: App metadata, Docker build
argument/labels, repository metadata, changelog, tests, and immutable image
references. Never hand off a deployable change under an already published
version.

## Candidate gates

1. Start from a clean understanding of Git state and stage only release files.
2. Run source contracts, focused regression, full pytest, YAML/Markdown/shell
   lint, AppArmor parsing, source-rootfs manifest verification, and secret scan.
3. Build the pinned `amd64` and `aarch64` images with the repository helper and
   record exact digests.
4. Run container and emulated-architecture smoke as labelled non-HAOS evidence.
5. Execute the real-HAOS acceptance matrix in the test plan. Keep missing
   results `NOT RUN` and partial results `PARTIAL`.
6. Confirm that user-facing release notes lead with the no-backup 3.0 reset,
   exact deleted/preserved data, and required reauthentication.

## Publication

Publication requires explicit user authorization. Publish one immutable image
per supported architecture, the matching multi-architecture numeric tag, and
the matching GitHub release. Do not move or reuse a numeric tag.

After publication, verify the public repository metadata, manifests, digests,
release assets, install path, and a fresh pull without rebuilding on the device.
If post-publication evidence fails, record the failure accurately and prepare a
higher-version fix; do not rewrite the released artifact.

Rollback is restoration of a Home Assistant App backup created for the target
version. It is not a promise that 3.0 runtime data can be consumed by an older
image or that deleted 2.x App data can be reconstructed.
