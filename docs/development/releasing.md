# 릴리스 운영 가이드

[개발 문서로 돌아가기](README.md)

이 문서는 현재 `.github/workflows/ci.yaml`, `builder.yaml`, `candidate.yaml`,
`main-release.yaml`과 `antigravity_home_assistant/config.yaml`의 계약을
요약합니다. 실제 릴리스 전에는 workflow 원문과 GitHub Actions 결과를 다시
확인하세요.

## 배포 모델

- Home Assistant App repository: `https://github.com/Kanu-Coffee/antigravity-for-home-assistant`
- image: `ghcr.io/kanu-coffee/antigravity-for-home-assistant:<version>`
- architecture: `amd64`, `aarch64`
- version tag: 숫자 SemVer `X.Y.Z`
- mutable `latest` tag는 발행하지 않음
- 기존 version tag는 덮어쓰지 않음

Supervisor는 `config.yaml`의 `image`와 `version`으로 미리 빌드된 public image를 받습니다. 사용자 장치에서 Dockerfile을 소스 빌드하는 배포 방식이 아닙니다.

## 버전 일치 항목

릴리스 후보에서는 최소한 다음 값이 모두 같아야 합니다.

- `antigravity_home_assistant/config.yaml`의 `version`
- `antigravity_home_assistant/Dockerfile`의 `BUILD_VERSION`
- `antigravity_home_assistant/CHANGELOG.md`의 첫 release heading
- Git tag `X.Y.Z`

`playwright/package.json`과 lockfile의 root package version은 App 릴리스 번호가
아니라 private dependency bundle 식별자 `0.0.0`으로 고정합니다. 이 파일들은 큰
의존성 image layer보다 먼저 복사되므로 App 버전만 바뀌는 릴리스에서 수정하면
동일한 의존성 layer를 재사용할 수 없습니다. 계약 테스트가 App 릴리스 값의 일치와
dependency bundle의 독립성을 함께 검사합니다. 사용자 README/DOCS의
current-version 문구와 upgrade note도 함께 검토합니다.

## Pull request 단계

1. 기능 브랜치에서 변경 범위와 사용자 영향을 검토합니다.
2. 로컬에서 관련 unit/contract/lint와 가능한 smoke를 실행합니다.
3. PR에서 `ci.yaml`의 lint, pytest, App linter와 amd64 및 emulated arm64 image
   smoke를 확인합니다.
4. 앱 경로가 바뀐 PR은 `builder.yaml`이 non-publishing image build도 수행합니다.
5. HAOS에서만 확인 가능한 경로는 PASS로 추정하지 않고 `NOT RUN` 또는 `PARTIAL`로 남깁니다.

## Candidate와 image 게시

1. release commit이 `main`에 있고 main CI가 PASS인지 확인합니다.
2. 변경 기록과 사용자 문서가 실제 동작·제약과 일치하는지 검토합니다.
3. `candidate.yaml`을 `mode=build`로 수동 실행하고, 정확한 main SHA에서 amd64와
   aarch64 source gate·immutable image smoke가 모두 PASS인지 확인합니다.
4. Candidate가 만든 정확히 하나의 non-expired
   `release-candidate-<sha>-<run-id>-<attempt>` artifact와 그 provenance/digest를
   검증합니다.
5. 같은 main SHA에서 `main-release.yaml`에 version, Candidate run ID/attempt,
   `confirm=publish-from-main`을 전달합니다.
6. Main release guard가 numeric tag/release/GHCR version 충돌과
   Candidate→main source drift를 fail-closed로 검사한 뒤 annotated numeric tag,
   GitHub prerelease, amd64/aarch64 numeric image와 generic multi-arch manifest를
   게시합니다.

기존 tag나 GHCR version을 수정·덮어쓰지 마세요. 릴리스에 문제가 있으면 tag를 재사용하지 말고 원인을 수정한 새 patch version을 준비합니다.

## 게시 후 확인

- exact main SHA의 CI, Candidate, Main release 결과
- Candidate artifact 이름·run attempt·archive digest와 비만료 상태
- 인증 없는 generic/per-architecture image 조회와 pull
- image의 `io.hass.version`, `io.hass.arch`, source label
- 예상 architecture가 `linux/amd64`, `linux/arm64`인지
- generic tag와 두 runtime/staging manifest digest 기록
- mutable `latest`가 생기지 않았는지
- GitHub release와 사용자용 upgrade note
- Home Assistant App repository 새로고침에서 새 version 노출
- 가능한 경우 실제 HAOS의 일반 update와 `/data` 보존

검증에 실제 token, `/config`, entity, 내부 URL이나 screenshot을 반입하지 마세요. 결과는 [progress.md](progress.md)에 PASS/PARTIAL/NOT RUN 경계를 유지해 기록합니다.

## 롤백 원칙

- 사용자는 앱 완전 삭제·재설치보다 Home Assistant backup과 검증된 version 전환을 우선합니다.
- 유지보수자는 immutable image/tag를 보존하고 새 patch에서 수정합니다.
- downgrade가 `/data` schema나 사용자 config와 호환되는지 검증되지 않았다면 자동 권장하지 않습니다.
- credential 노출이나 image 신뢰 문제가 있으면 배포 편의보다 secret 폐기와 접근 차단을 우선합니다.
