# v2 결정 기록

이 문서는 구현 중 다시 열면 보안·마이그레이션 결과가 달라지는 제품 결정을
고정한다. `Accepted`는 설계 결정을 뜻하며 실제 HAOS 또는 공개 릴리스 검증 완료를
뜻하지 않는다. 검증 상태는 [checklist.md](checklist.md)와
[gap-register.md](gap-register.md)를 따른다.

## ADR-001 — v2 target과 직접 migration 창

- 상태: `Accepted`
- target App version: `2.0.0`
- source contract: 최신 공개 v1 tag `1.0.4`
- 직접 update 후보: `1.0.4 → 2.0.0`
- `1.0.4`보다 오래된 설치는 먼저 공개 `1.0.4`로 업데이트한 뒤 v2로 이동한다.
- 직접 update를 지원한다고 공개하려면 실제 HAOS amd64와 aarch64에서 `HA-005`를
  모두 통과해야 한다. 그 전에는 이 범위를 release candidate의 목표 창으로만
  표현한다.
- v2.0.x는 [MIG-004](migration-release.md#mig-004--v1-옵션-변환)의 deprecated
  option을 migration-only로 읽는다. 제거는 실제 update evidence와 별도 breaking
  release 없이 수행하지 않는다.

이 창은 검증 조합을 유한하게 유지하면서 최신 public v1 사용자가 복구 가능한
경로를 갖게 한다. 여러 과거 version을 한 번에 직접 지원한다고 추정하지 않는다.

## ADR-002 — prebuilt multi-arch 배포

- 상태: `Accepted`
- public install은 source build가 아니라 tag 없는 generic GHCR image 이름과 numeric
  App version을 사용한다.
- 같은 numeric tag의 linux/amd64와 linux/arm64 image가 모두 성공한 뒤에만 generic
  manifest를 게시한다.
- `latest`는 만들지 않으며 기존 numeric tag나 package version을 덮어쓰지 않는다.
- local QEMU arm64 PASS는 packaging evidence일 뿐 native HAOS arm64 지원 선언이
  아니다.

## ADR-003 — AppArmor는 항상 ON

- 상태: `Accepted`
- AppArmor를 끄는 option은 제공하지 않는다.
- `antigravity_sensitive_data_access`는 interactive Antigravity child를 restricted와
  sensitive-read profile 중 하나로 전환할 뿐이다.
- sensitive-read도 지정된 세 진단 경로의 read-only만 허용하며 Telegram, broker,
  browser와 memory 권한은 바꾸지 않는다.

## ADR-004 — Telegram bridge 전면 교체

- 상태: `Accepted`
- v1의 shell/tmux prompt runner, static PIN 노출과 interactive approval 전달 경로는
  migration하거나 fallback으로 남기지 않는다.
- v2는 전용 native HOME과 safe cwd, user/chat 교집합, durable update ledger, typed
  proposal과 분리된 coordinator broker만 사용한다.
- 실제 HAOS OAuth·AppArmor·Bot API 수용 시험 전에는 `telegram_enabled=false`를
  기본값으로 유지한다.

## ADR-005 — Antigravity native pin

- 상태: `Accepted`
- Antigravity CLI는 `1.1.11` artifact와 architecture별 digest에 고정한다.
- Codex식 `-c` override, TOML config, token option과 추정 subcommand를 사용하지 않는다.
- 모든 native launch는 `AGY_CLI_DISABLE_AUTO_UPDATE=true`를 전달한다.
- native upgrade는 새 numeric App release와 migration/rollback evidence로만 수행한다.
