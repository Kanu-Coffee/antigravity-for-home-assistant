# v2 결정 기록

이 문서는 구현 중 다시 열면 보안·마이그레이션 결과가 달라지는 제품 결정을
고정한다. `Accepted`는 설계 결정을 뜻하며 실제 HAOS 또는 공개 릴리스 검증 완료를
뜻하지 않는다. 검증 상태는 [checklist.md](checklist.md)와
[gap-register.md](gap-register.md)를 따른다.

## ADR-001 — v2 target과 직접 migration 창

- 상태: `Accepted`
- target App version: `2.0.0`
- source contract: 최신 공개 v1 tag `1.0.4` (amd64 only)
- 직접 update 후보: amd64 `1.0.4 → 2.0.0`
- amd64의 `1.0.4`보다 오래된 설치는 먼저 공개 `1.0.4`로 업데이트한 뒤
  v2로 이동한다. public v1이 없었던 aarch64는 v2를 fresh install한다.
- 직접 update와 첫 aarch64 release를 지원한다고 공개하려면 실제 HAOS
  amd64의 post-publish `HA-005`, pre-publish aarch64 `HA-006`과 numeric public
  release를 양 architecture에서 fresh install하는 post-publish `HA-008`을 모두
  통과해야 한다. 그 전에는 이 범위를 release candidate의 목표 창으로만 표현한다.
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
- `antigravity_sensitive_data_access`는 Web/SSH/Telegram Antigravity child를 restricted와
  sensitive-read profile 중 하나로 전환할 뿐이다.
- sensitive-read도 지정된 세 진단 경로의 read-only만 허용하며 broker,
  browser와 memory 권한은 바꾸지 않는다.

## ADR-004 — Telegram bridge 전면 교체

- 상태: `Accepted`
- v1의 shell/tmux prompt runner, static PIN 노출과 interactive approval 전달 경로는
  migration하거나 fallback으로 남기지 않는다.
- 2.0.7부터 Telegram은 CLI와 동등한 관리자 주 채널이며 `/data/home`, `/config`,
  OAuth, global/workspace plugin·agent·rule·MCP와 native permission을 공유한다.
- Telegram 전용 `telegram_access_mode`, `ha-telegram-login`, HOME/bootstrap과 fixed
  customization copy를 제거한다. legacy mode 값은 migration에서 무시·제거한다.
- user/chat 교집합, 최초 실행 전 stable conversation binding, explicit `/new`,
  per-session 직렬화, same-session approval과 암호화 reply outbox를 사용한다.
- 설계 비교 기준은 Hermes의
  [결정적 session key와 single-flight](https://github.com/NousResearch/hermes-agent/blob/7095e23eb2066fe9a2f93b99cdbfe0e2b5ece397/gateway/session.py#L1090-L1211),
  [session-bound Telegram approval](https://github.com/NousResearch/hermes-agent/blob/7095e23eb2066fe9a2f93b99cdbfe0e2b5ece397/plugins/platforms/telegram/adapter.py#L6140-L6214),
  grammY의 [session-key 기반 직렬화](https://github.com/grammyjs/runner/blob/fbe8cee2d41efb91c39ac104692f1ecdac4e014d/src/sequentialize.ts#L6-L89),
  CCGram의 [Antigravity conversation 재개](https://github.com/alexei-led/ccgram/blob/b7088fd187c6984ee89843d0c5f19db59e123600/src/ccgram/providers/antigravity.py#L451-L465)다.
  외부 코드를 이식하거나 dependency로 추가하지 않고 이 불변조건만 독립 구현한다.
- 실제 HAOS OAuth·AppArmor·Bot API 수용 시험 전에는 `telegram_enabled=false`를
  기본값으로 유지한다.

## ADR-005 — Antigravity native pin

- 상태: `Accepted`
- Antigravity CLI는 `1.1.11` artifact와 architecture별 digest에 고정한다.
- Codex식 `-c` override, TOML config, token option과 추정 subcommand를 사용하지 않는다.
- 모든 native launch는 `AGY_CLI_DISABLE_AUTO_UPDATE=true`를 전달한다.
- native upgrade는 새 numeric App release와 migration/rollback evidence로만 수행한다.
