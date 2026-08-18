# v2 구현 체크리스트

## 1. 작업 규칙

상태는 `TODO`, `IN_PROGRESS`, `BLOCKED`, `PARTIAL`, `VERIFIED`만 사용한다.
`PARTIAL`은 좁은 local fixture 등 일부 범위만 통과했고 HAOS·architecture·E2E 같은
필수 범위가 남았음을 뜻한다. `VERIFIED`에는 [test-plan.md](test-plan.md) 양식의
요구 범위 전체 증거가 필요하다. 현재 코드에 파일이나 test가 있다는 사실만으로
완료하지 않는다.

구현 전 매번 확인한다.

- [ ] 루트 `AGENTS.md`와 관련 `docs/v2/` 계약을 읽었는가?
- [ ] 현재 Git 상태와 사용자 변경을 확인했는가?
- [ ] secret, AppArmor, Telegram approval 또는 migration 경계가 바뀌는가?
- [ ] 실제 Antigravity 1.1.13 help/schema로 인터페이스를 확인했는가?
- [ ] rollback과 failure isolation이 정의됐는가?
- [ ] 해당 test ID와 실제 HAOS 필요 여부가 정해졌는가?

## 2. 제약사항과 주의사항

### 반드시 지킬 제약

- AppArmor는 항상 ON이며 끄는 option을 만들지 않는다.
- `antigravity_sensitive_data_access`는 대화형 Antigravity의 top-level named `Px`
  실행 프로필만 선택한다. secrets와 `.storage`는 두 값 모두 직접 접근을 거부하고,
  기본 `false`는 Recorder DB도 거부하며 `true`만 Recorder 진단 read를 허용한다.
- Telegram 기존 bridge의 shell/tmux 실행 경로를 재사용하지 않는다.
- `SUPERVISOR_TOKEN`과 credential을 model process에 전달하지 않는다.
- Antigravity native `settings.json`, MCP와 plugin 경로만 사용한다.
- `-c`를 config override로 사용하지 않는다.
- 사용자 `/config/AGENTS.md`를 생성하거나 덮어쓰지 않는다.
- `.storage`, Recorder DB, secrets와 auth 파일을 직접 수정하지 않는다.
- GHCR tag, image와 release artifact를 덮어쓰지 않는다.
- local build는 per-checkout project-owned Buildx builder만 만들고 종료 시 그 builder
  cache만 제거한다. global Docker prune은 금지하고 checkout-owned unreferenced image는
  최신 두 개를 보존한다. release build는 stable GHA cache scope를 사용한다.
- App backup 상한은 ownership/tree가 검증된 완료 managed-plugin, native user-files
  refresh와 change-broker config transaction에 범주별로 적용해 최신 총 두 개를
  보존한다. active/incomplete 또는 manifestless/unsafe backup은 자동 삭제하지 않는다.
- amd64 성공을 aarch64 또는 실제 HAOS 성공으로 확대하지 않는다.

### 특히 주의할 부분

- shell quote로 prompt를 안전하게 만들려고 하지 말고 shell 자체를 사용하지 않는다.
- settings/plugin JSON merge는 unknown 사용자 top-level key를 보존한다. 단,
  `telegram_enabled=true`의 2.0.12 startup은 다섯 App 관리 보안 key와 permission 세
  bucket을 canonical policy로 reconcile하므로 해당 key의 drift와 bucket 안
  unknown/user-owned rule은 보존 대상으로 주장하지 않는다.
- migration에서 symlink, hardlink, FIFO, device와 unsafe owner/mode를 거부한다.
- browser read-only user도 모든 state를 볼 수 있으므로 결과는 민감하다.
- 2.0.11 native default이자 Telegram의 유일한 effective 값은 `request-review`이며
  `strict`와 legacy autonomous schema 입력도 updater가 이 값으로 정규화한다. 다른
  schema 값은 upgrade input 호환용이다. AppArmor와 App-managed proposal approval은 option으로 완화하지 않는다. native
  nested sandbox는 비특권 HAOS App에서 namespace 생성에 실패하므로 사용하지 않는다.
  command와 stdio tool은 별도 AppArmor command profile로 `Px` 전환하며 host 권한을
  추가하지 않는다.
- 2.0.12에서 Telegram이 활성화되면 safe parseable existing settings의 permission
  boundary는 mode와 ownership state에 관계없이 transaction backup 뒤 exact policy로
  reconcile한다. unrelated settings/OAuth/global MCP는 보존하고 mode를 `reset_v2`로
  바꾸지 않는다. bridge 재검증 실패는 Bot API 전 `permission_boundary_blocked` live
  hold이며 fatal/S6 restart loop가 아니다.
- diagnostics, proposed diff와 command success는 mutation 승인/검증이 아니다.
- memory 0건은 준비 완료나 검증된 no-result와 같지 않다.
- 실제 HAOS/AppArmor 결과는 local Docker fixture와 별도 기록한다.
- Telegram Playwright auto-allow는 upstream read-only 네 도구뿐이다. navigate/back,
  tabs, hover, wait, resize, close는 typed adapter 전까지 fail closed한다.
- proposal registration은 approval/card sealing 전에는 crash-durable하지 않다. 이
  구간의 bridge crash는 사용자 재시도를 요구한다.
- GAP-007의 장시간 성능·내구성 진단은 수동 advisory이며 Candidate, finalize,
  tag 또는 release를 차단하지 않는다.
- Web/SSH/Telegram Antigravity는 `/data/home`, `/config`, OAuth, user global/workspace
  plugin·agent·rule·MCP와 native permission을 공유한다. 실제 1.1.11 shared-HOME
  positive control의 global MCP launch는 2.0.7의 필수 inheritance 증거다. 실제 HAOS
  OAuth/AppArmor enforce와 동일-process 비유출 시험은 별도 기록한다.
- raw file tool을 통한 App 관리 `settings.json`과 native MCP config 직접 mutation은
  exact deny다. interactive Web/SSH의 일반 전역 setting은 digest-bound `agy-settings patch`로 매개 수정할 수 있지만
  `permissions`, `enableTerminalSandbox`, `allowNonWorkspaceAccess`, `toolPermission`,
  `artifactReviewPolicy`는 거부한다. global plugin·agent·rule·skill은 계속 공유·직접
  공유한다. Telegram customization mutation은 approved exact terminal/script proposal로만
  실행하고 user-configured MCP executable은 AppArmor command profile에서 실행한다.
- Telegram은 최초 실행 전에 conversation을 결합하고 `/new` 전까지 유지하며,
  same-session approval과 암호화 reply outbox의 retry/ack를 보장한다.
- `multi_choice_service_call` approval은 최대 31개 사전 검증 service call과 cancel을
  4×8 grid에 표시하고 opaque callback token만 사용한다. choice는 authorization 전에
  durable state에 기록하고 requester/session generation/conversation/digest/choice/
  capability/idempotency를 모두 결합한다. bridge restart와 full App/broker restart의
  proposal 생존 범위를 혼동하지 않는다.
- `terminal_command`, `multi_choice_terminal`, `question`은 non-executing
  `telegram_action_propose`로 등록하고 `v4a`/`v4d`/`v4c` opaque callback, encrypted
  durable action, commit-before-exec와 no-respawn `in_doubt`를 지킨다. executor에는 App
  token/OAuth를 전달하지 않는다.
- fixed CLI print mode는 native permission prompt를 external approval로 resume할 수
  없다. arbitrary future/plugin MCP의 transparent interception을 주장하지 않고 두
  proposal로 표현할 수 없는 Telegram side effect는 fail closed한다. initial OAuth와
  live HAOS/Bot API E2E는 `NOT RUN`이다.
- callback ACK와 기본 인증/control은 즉시 처리하되 승인된 broker 실행은 requester
  FIFO에서 session-serialized한다. 실행 직전 current generation/conversation/requester/
  digest를 재검증하고 durable idempotency로 같은 mutation을 한 번만 접수한다.
- `config_patch` public preview는 broker-generated secret-safe bounded structured
  diff, 생략 표시와 normalized mutation digest를 포함한다. local component suite는
  secret canary 제거와 changed-preview 승인 무효화를 통과했다.
- config transaction은 민감 exact deny 밖의 일반 `/config` YAML에 expected SHA,
  atomic backup/write/config check와 실패 시 exact restore/recheck를 적용한다.
  activation 생략은 `restart_required`, 명시 reload는 input_boolean/automation/script/
  scene이며 의미 검증이 있는 범위만 fresh API 성공을 주장한다. `ha_change_propose`로
  제출된 모든 App-managed broker config patch와 live-validated service
  domain/service_data는 durable high-risk approval 대상이다. 신뢰된 사용자 전역 native
  tool과 direct command/API helper는 broker가 투명하게 intercept하지 않는다. 실제 HAOS
  safe change는 아직 `NOT RUN`이므로 전체 config change를 end-to-end 완료로 표현하지
  않는다.
- pinned Antigravity binary의 background self-updater는 모든 native launch에서
  `AGY_CLI_DISABLE_AUTO_UPDATE=true`로 차단한다. clean-HOME opt-out canary만으로 App
  전체 wrapper/env 경계를 완료로 표시하지 않는다.

### 2026-08-17 2.0.11 universal approval 검증 경계

- source/component targets: action proposal schema, private coordinator, encrypted state,
  v4 callback grid, commit/replay executor, policy migration과 bridge continuation.
- local contract PASS는 부모 작업의 최종 test report에만 기록한다. 이 문서는 미실행
  command를 PASS로 선기입하지 않는다.
- 실제 HAOS AppArmor enforce, initial OAuth, live Telegram Bot API card/callback,
  real HA/config/terminal action은 현재 `NOT RUN`이며 관련 milestone은 `VERIFIED`로
  올리지 않는다.

### 2026-08-18 2.0.12 Telegram permission reconciliation 검증 경계

- source/component targets: shared canonical policy, Telegram-enabled preserve
  reconciliation, boundary-only transaction backup, ownership/idempotency와
  `permission_boundary_blocked` live hold.
- local contract 결과는 실제 실행한 command와 결과만 부모 작업의 최종 test report에
  기록한다. 이전 2.0.11 policy PASS나 현장 수동 settings 복구를 repaired 2.0.12 image의
  성공으로 승격하지 않는다.
- 2.0.12 repaired image의 실제 HAOS update, OAuth/AppArmor, live Bot API reconnect와
  no-restart hold는 현재 `NOT RUN`이다. M5/M6 또는 release gate를 `VERIFIED`로 올리지
  않는다.

### 2026-08-11 local v2 증거 스냅샷

- 전체 Python suite: `134 passed`.
- linux/amd64 `antigravity-for-home-assistant:v2-final-local`: manifest-list digest
  `sha256:de1992f8c0df09a0b138a8c22659f68dc1e817079f6828149f68305df79ddb04`,
  saved image config digest
  `sha256:89fbca725e87f93af8d93f136b520f9e99738882ba3db2d6dc5e8db0f4d38a2b`.
- linux/arm64 `antigravity-for-home-assistant:v2-final-local-arm64`:
  manifest-list digest
  `sha256:3cac3dcc76ba9d1410d3aac2369431a0568841f340f6b9748824b307cbd087df`,
  saved image config digest
  `sha256:1b63cf5afb9fb104426f94a1bdc9d6c3822c5fcc274a35515ee1d08fca17d82a`;
  QEMU packaging, 당시의 폐기된 Telegram HOME 격리 canary와 container-replacement
  update preservation PASS. 이 격리 결과는 2.0.7 수용 증거가 아니다. 임시 binfmt
  등록은 시험 후 제거했다.
- 해당 amd64 image의 full Docker, memory, browser-approval, feedback,
  managed-auth, user-files, managed-plugin과 update smoke: PASS.
- amd64와 QEMU arm64 actual Antigravity 1.1.11에서 당시 Telegram 전용 HOME/cwd
  격리 canary와 managed MCP/rules tamper fail-closed: PASS. 이 구조는 2.0.7에서
  shared-context 관리자 채널로 교체됐다.
- canonical input boolean config transaction, memory begin/verify와 failure rollback local
  fixture: PASS.
- 실제 HAOS OAuth/AppArmor enforce, native arm64와 실제 Telegram/config mutation
  E2E: `NOT RUN`. 이 스냅샷만으로 관련 마일스톤을 `VERIFIED`로 올리지 않는다.
- candidate/release targeted contract 10개, actionlint, release/smoke ShellCheck,
  workflow YAML과 수정 Markdown lint: PASS. 실제 candidate/Builder run, GHCR public
  visibility, HAOS evidence와 numeric tag는 `NOT RUN`이다.
- 위 최종 amd64 image에서 App 관리 plugin의
  stage-fail/SIGKILL/postcondition-fail rollback과 native settings/MCP/state의
  same-state/missing-MCP `prepared` SIGKILL recovery가 PASS했다. 실제 HAOS
  update/rollback과 전원 차단 내구성은 `NOT RUN`이다.

### 2026-08-12 pre-commit 통합 증거 스냅샷

- current working tree를 embedded source manifest로 고정한 amd64 image
  `sha256:379bc37a8a07151d192b64e3368440862e9155599202c05345adcffa2bca6c72`에서
  rootfs digest
  `sha256:22b435eb960bf5e47ba0d888b59e6a83087e76afc2b13a557b455fad8b49e8ed`와
  135개 root-owned regular file을 검증했다.
- full Python은 `165 passed, 1 skipped`; test container에서 Docker socket 부재로
  skip된 Buildx context canary는 host Docker를 연결해 별도로 `1 passed`였다. Node
  component는 두 묶음 60개, 전체 static/lint/AppArmor parser/App linter gate는 PASS했다.
- 같은 이미지의 full Docker, feedback, browser approval, memory, managed auth,
  당시의 폐기된 Telegram isolation, user-files, managed-plugin과 update persistence
  smoke는 PASS했다. Telegram 항목은 2.0.7 shared-context 증거가 아니다.
- 이 image의 OCI revision은 아직 변경 전 `HEAD`를 가리키므로 release 증거가 아니다.
  public `1.0.4 → v2` rehearsal도 clean committed source preflight에서 의도대로 멈췄다.
  commit-bound rebuild와 rehearsal 전에는 M6-01, M6-08 또는 M7-05를 승격하지 않는다.
- 실제 HAOS, AppArmor enforce, OAuth, live Telegram/Core/Supervisor, native arm64와 remote
  candidate/Builder/public GHCR은 계속 `NOT RUN`이다.

## 3. 마일스톤

### M0 — 문서와 기준선

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M0-01 | `VERIFIED` | `docs/v2/` 제품·아키텍처·보안 계약 작성 | 12개 문서, markdownlint 0, internal-link/contract check PASS |
| M0-02 | `VERIFIED` | FR/SEC/TG/MIG/test traceability 검사 추가 | ST-010; `python3 tests/test_v2_docs_contract.py` 14/14 PASS |
| M0-03 | `VERIFIED` | 현재 결함과 제거 대상을 issue 단위로 고정 | [gap register](gap-register.md) GAP/LEGACY IDs |
| M0-04 | `VERIFIED` | v2 target version과 migration support window 확정 | [ADR-001](decisions.md#adr-001--v2-target과-직접-migration-창) |

### M1 — 기존 CI 기준선 복구

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M1-01 | `VERIFIED` | s6 run executable bit 실패 해결 | pytest 119 PASS, ST-008 |
| M1-02 | `VERIFIED` | ShellCheck와 `/bin/sh`/Bash 불일치 해결 | ST-003와 image smoke PASS |
| M1-03 | `VERIFIED` | memory JSON/stdout/stderr 분리 | memory smoke PASS |
| M1-04 | `VERIFIED` | stale `debug prompt-input` smoke 제거 | actual 1.1.11 image smoke PASS |
| M1-05 | `VERIFIED` | Markdown와 secret scan 범위 정리 | ST-004, ST-007 PASS |
| M1-06 | `VERIFIED` | CI job을 독립시켜 실패 증거 보존 | source `38c58f1`; remote CI run 31530524036의 23 jobs PASS |

### M2 — Antigravity native 기반

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M2-01 | `PARTIAL` | 1.1.13 amd64/aarch64 artifact와 digest 고정 | both local image builds PASS; native HAOS aarch64 TODO |
| M2-02 | `VERIFIED` | wrapper에서 Codex flags/token 주입 제거 | AG-002~003, AG-012와 image smoke PASS |
| M2-03 | `PARTIAL` | native OAuth와 `/data/home` persistence | local persistence contract PASS; actual HAOS OAuth TODO |
| M2-04 | `PARTIAL` | sparse `settings.json` merge 구현 | merge/unknown-key/failure recovery PASS; HAOS update TODO |
| M2-05 | `PARTIAL` | `home-assistant` plugin 구조와 validation | actual 1.1.11 validation/rollback PASS; HAOS install TODO |
| M2-06 | `PARTIAL` | plugin MCP와 최소환경 wrapper | local token/env canary PASS; HAOS AppArmor TODO |
| M2-07 | `PARTIAL` | print/stream-json 실제 binary parser | parser/component PASS; real Telegram conversation TODO |
| M2-08 | `PARTIAL` | image-managed rules와 사용자 guidance 분리 | static/native tamper contract PASS; HAOS user migration TODO |
| M2-09 | `PARTIAL` | 모든 native launch에서 runtime self-updater opt-out 강제 | current amd64/QEMU arm64 PASS; native HAOS canary TODO |

### M3 — credential/change broker와 AppArmor

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M3-01 | `PARTIAL` | 원본 credential 격리 broker 구현 | child-env/token canary PASS; HAOS enforce TODO |
| M3-02 | `PARTIAL` | typed proposal, risk classifier, capability 구현 | broker unit/security suite PASS; HAOS mutation TODO |
| M3-03 | `PARTIAL` | secret-safe structured preview와 일반 YAML transaction/check/reload-or-restart-required/exact rollback | local broker suite PASS; HAOS safe change TODO |
| M3-04 | `PARTIAL` | service_call과 분리된 typed transient device prior/test/always-restore workflow | local success/failure/in-doubt/replay PASS; HAOS safe test TODO |
| M3-05 | `PARTIAL` | custom `apparmor.txt` root와 restricted/sensitive-read top-level named `Px` 실행 프로필 작성 | parser/static transition tests PASS; HAOS enforce TODO |
| M3-06 | `TODO` | HAOS complain audit로 최소 allowlist 조정 | sanitized audit report |
| M3-07 | `TODO` | HAOS enforce positive/negative matrix | AppArmor E2E PASS |
| M3-08 | `PARTIAL` | App-managed broker 고위험 항상 확인 불변조건 검증 | local policy/replay matrix PASS; real Telegram E2E TODO |
| M3-09 | `PARTIAL` | 민감정보 option의 profile 선택과 불변 deny 구현 | local profile matrix PASS; false/true HAOS matrix TODO |
| M3-10 | `PARTIAL` | shared native OAuth 동일-process 잔여 위험과 관리자 trust-model 검증 | local shared-HOME canary; actual HAOS OAuth 비유출/AppArmor TODO |

### M4 — HA API, memory와 browser

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M4-01 | `VERIFIED` | ordinary read/memory/fresh-state validate의 ha-read broker ownership 고정; config-check/mutation/browser-auth는 scoped 분리 | static owner + shared failure injection PASS |
| M4-02 | `PARTIAL` | bounded Core/Supervisor read/log tools | API/component contract PASS; HAOS E2E TODO |
| M4-03 | `PARTIAL` | memory 모듈 분리와 bootstrap/degraded isolation | memory suite PASS; HAOS lifecycle TODO |
| M4-04 | `PARTIAL` | explicit/candidate/change memory workflow | state-machine suite PASS; HAOS mutation TODO |
| M4-05 | `PARTIAL` | Chromium executable와 Playwright lock 일치 | amd64 runtime/QEMU arm64 packaging PASS; native arm64 TODO |
| M4-06 | `PARTIAL` | loopback gateway와 managed read-only identity | managed-auth suite PASS; HAOS identity lifecycle TODO |
| M4-07 | `PARTIAL` | desktop/mobile/console/network 검증; Telegram auto-allow는 upstream read-only console/network/snapshot/screenshot만, mutation-capable browser는 fail closed | fixture rendered smoke PASS; rendered HAOS E2E TODO |
| M4-08 | `PARTIAL` | browser/memory 비밀 및 output redaction | local canary security suite PASS; HAOS E2E TODO |

### M5 — 새 Telegram 브리지

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M5-01 | `PARTIAL` | 기존 bridge 격리/제거와 기본 OFF 유지 | static/image entrypoint PASS; HAOS install TODO |
| M5-02 | `PARTIAL` | long polling, static user/chat allowlist와 bounded metrics | Bot API/metric component tests PASS; live Bot API TODO |
| M5-03 | `PARTIAL` | local-only pairing create/list/revoke | pairing security suite PASS; HAOS operator flow TODO |
| M5-04 | `PARTIAL` | input normalization과 shell-free shared-runtime invocation | injection/argv/stdin suite PASS; live conversation TODO |
| M5-05 | `PARTIAL` | pre-bound stable session, explicit `/new`, per-chat queue, cancel와 timeout | 2.0.9 component 재검증 및 live HAOS Telegram TODO |
| M5-06 | `PARTIAL` | stream-json parser, bounded metadata/single-proposal empty-text fallback와 Telegram chunking | parser/output component PASS; live Telegram formatting TODO |
| M5-07 | `PARTIAL` | typed binary/multi-choice proposal, 31+cancel grid와 broker-generated human-reviewable confirmation preview | local secret-safe diff + choice binding/replay/cross-chat PASS; HAOS Telegram E2E TODO |
| M5-08 | `PARTIAL` | effective `request-review` 단일값, bounded read/proposal allow, sensitive exact deny, native-prompt/broker 경계와 high-risk matrix | 2.0.11 local policy suite 및 HAOS E2E TODO |
| M5-09 | `PARTIAL` | encrypted reply outbox, rate limit/backoff/idempotent result와 registration→approval sealing 전 crash 재시도 경계 | pre-send persist/retry/ack component와 live Bot API TODO |
| M5-10 | `TODO` | 실제 HAOS Telegram E2E | sanitized E2E report |
| M5-11 | `PARTIAL` | shared Home/cwd와 user customization 상속·수정 | actual 1.1.13 positive canary 재검증; HAOS OAuth/AppArmor TODO |
| M5-12 | `IN_PROGRESS` | shared Telegram permission validator와 `permission_boundary_blocked` Bot-API-before hold/no-S6-loop | local component contract 및 repaired-image HAOS E2E NOT RUN |

### M6 — migration과 multi-arch release

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M6-01 | `PARTIAL` | v1 option conservative mapping | exact public-v1 source container rehearsal PASS; HA-007 local HAOS/HA-005 public update TODO |
| M6-02 | `PARTIAL` | preserve mode와 ownership conflict | local preflight/preserve/full update PASS; HAOS TODO |
| M6-03 | `PARTIAL` | refresh_managed owned settings merge와 plugin mode-independent refresh의 one-shot/idempotency | local native merge/plugin transaction/full update PASS; HAOS restart/update TODO |
| M6-04 | `PARTIAL` | reset_v2가 ownership state와 무관하게 safe settings를 backup하고 managed key/permission을 exact 복구, preserve 전 매-start drift 복구 | local state/target journal + SIGKILL rollback PASS; HAOS rollback TODO |
| M6-05 | `PARTIAL` | memory/browser/SSH/OAuth preservation | amd64 public-v1 fixture와 QEMU arm64 restart persistence PASS; HA-005/HA-006/HA-007 TODO |
| M6-06 | `PARTIAL` | amd64/aarch64 build/runtime와 per-checkout bounded local cache | 2.0.9 build helper contract 및 shared Telegram/permission/broker 재검증; native HAOS both arch TODO |
| M6-07 | `PARTIAL` | `image`, AppArmor와 breaking metadata | local schema/parser/App linter PASS; HAOS install TODO |
| M6-08 | `PARTIAL` | staged candidate exact-digest smoke, HAOS rehearsal bundle와 rebuild 없는 idempotent promotion | remote PR Builder PASS; Candidate workflow/actual bundle run TODO |
| M6-09 | `PARTIAL` | leaf SBOM, provenance, exact Cosign identity와 anonymous preflight | local workflow contract; public registry retrieval TODO |
| M6-10 | `PARTIAL` | candidate-bound local HAOS rehearsal과 post-publish public acceptance | pre-finalize finalizer와 post-publish HA-005/HA-008 validator/uploader implemented; HA-005/006/007/008 NOT RUN |
| M6-11 | `IN_PROGRESS` | Telegram-enabled preserve의 boundary-only transaction reconciliation, unrelated-state 보존과 restart idempotency | local migration contract 및 repaired-image HAOS update NOT RUN |

### M7 — 사용자 문서와 최종 감사

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M7-01 | `PARTIAL` | 한국어/영어 설치·OAuth·SSH·Telegram 안내 | docs lint/parity PASS; fresh-user/HAOS review TODO |
| M7-02 | `PARTIAL` | App options, migration와 security warning 번역 | schema/translation parity PASS; HAOS UI review TODO |
| M7-03 | `PARTIAL` | troubleshooting과 recovery runbook | local failure rehearsal PASS; HAOS rehearsal TODO |
| M7-04 | `IN_PROGRESS` | requirement-by-requirement completion audit | local audit/static evidence PASS; HAOS/release evidence pending |
| M7-05 | `PARTIAL` | v2 release와 post-publish install/update 검증 | idempotent release와 독립 HA-005/HA-008 acceptance gate implemented; public HA-005/HA-008 NOT RUN |

## 4. 요구사항 추적표

이 표의 필수 test ID는 [test-plan.md](test-plan.md)의 동일 요구사항 행과 정확히
일치해야 한다. 상태를 `VERIFIED`로 바꾸려면 해당 행의 모든 test에 실제 범위와
같은 PASS 증거가 필요하다.

| 요구사항 ID | 구현 마일스톤 | 필수 test ID |
| --- | --- | --- |
| FR-001 | M2, M3, M6, M7 | ST-002, ST-005, ST-008, IM-001, IM-002, IM-003, IM-011, HA-001, HA-008, AA-001 |
| FR-002 | M2 | AG-001, AG-002, AG-003, AG-004, AG-005, AG-006, AG-007, AG-008, AG-009, AG-010, AG-011, AG-012, AG-013, AG-014, IM-002, HA-001 |
| FR-003 | M2, M6 | ST-008, IM-003, IM-004, IM-005, HA-001 |
| FR-004 | M3, M4 | AG-005, AG-006, AG-007, IM-006, IM-007, IM-008, IM-009, IM-010, HA-002 |
| FR-005 | M4 | IM-008, HA-002 |
| FR-006 | M4 | IM-009, HA-003 |
| FR-007 | M3, M5 | AG-013, IM-010, HA-004 |
| FR-008 | M3, M4, M5, M6 | AG-013, ST-007, IM-007, IM-009, IM-010, IM-011, AA-001 |
| SEC-001 | M3 | AG-013, ST-007, IM-007, IM-010, IM-011, AA-001 |
| SEC-002 | M3, M4, M5, M6 | AG-013, ST-007, IM-007, IM-008, IM-009, IM-010, IM-011, AA-001 |
| SEC-003 | M2, M3, M4, M5, M6 | AG-009, AG-012, AG-013, IM-007, IM-010, IM-011, IM-012, AA-001, HA-004, HA-005, HA-006, HA-007 |
| SEC-004 | M3, M6 | ST-002, IM-011, AA-001 |
| SEC-005 | M3, M4, M5 | AG-007, AG-013, IM-006, IM-007, IM-009, IM-010, AA-001 |
| SEC-006 | M3, M4 | ST-007, IM-011, AA-001 |
| SEC-007 | M3, M5 | IM-007, IM-010, HA-002, HA-004 |
| SEC-008 | M3, M5 | AG-009, AG-012, AG-013, IM-010, IM-011, HA-004, AA-001 |
| SEC-009 | M4 | IM-009, IM-011, HA-003, AA-001 |
| SEC-010 | M4 | ST-007, IM-008, HA-002 |
| SEC-011 | M3, M4, M5 | ST-007, IM-007, IM-009, IM-010, HA-004 |
| SEC-012 | M3, M4, M5, M6 | AG-013, ST-007, IM-007, IM-009, IM-010, IM-011, IM-012, AA-001, HA-004, HA-005, HA-006, HA-007 |
| TG-001 | M5 | AG-009, AG-012, IM-010, HA-004 |
| TG-002 | M5 | ST-002, IM-010, HA-004 |
| TG-003 | M5 | IM-010, HA-004 |
| TG-004 | M5 | IM-010, HA-004 |
| TG-005 | M5 | AG-009, AG-012, IM-010, HA-004 |
| TG-006 | M5 | IM-010, HA-004 |
| TG-007 | M2, M5 | AG-009, AG-010, AG-011, AG-012, AG-013, IM-010, HA-004 |
| TG-008 | M3, M5 | IM-007, IM-010, HA-004 |
| TG-009 | M3, M5 | IM-007, IM-010, HA-004 |
| TG-010 | M3, M5 | IM-007, IM-010, HA-002, HA-004 |
| TG-011 | M5 | IM-010, HA-004 |
| TG-012 | M5 | ST-007, IM-010, HA-004 |
| TG-013 | M5 | AG-013, IM-010, HA-004 |
| MIG-001 | M2, M6 | AG-014, ST-002, ST-005, IM-001, IM-002, HA-001 |
| MIG-002 | M6 | ST-007, IM-012, HA-005, HA-007 |
| MIG-003 | M6 | IM-012, HA-005, HA-007 |
| MIG-004 | M6 | IM-012, HA-005, HA-007 |
| MIG-005 | M6 | ST-001, ST-009, IM-012, HA-005, HA-007 |
| MIG-006 | M4, M6 | IM-008, IM-012, HA-002, HA-005, HA-007 |
| MIG-007 | M6 | IM-012, HA-005, HA-007 |
| MIG-008 | M2, M6 | AG-014, ST-005, IM-001, IM-002, HA-001, HA-006 |
| MIG-009 | M1, M2, M6 | AG-014, ST-001, ST-002, ST-003, ST-004, ST-005, ST-006, ST-007, ST-008, ST-009, ST-010, IM-001, IM-002, IM-003, IM-004, IM-005, IM-006, IM-007, IM-008, IM-009, IM-010, IM-011, IM-012, HA-006, HA-007, AA-001 |
| MIG-010 | M2, M6, M7 | AG-014, ST-010, IM-001, IM-002, IM-003, IM-004, IM-005, IM-006, IM-007, IM-008, IM-009, IM-010, IM-011, IM-012, HA-001, HA-002, HA-003, HA-004, HA-005, HA-006, HA-007, HA-008, AA-001 |
| MIG-011 | M0, M6, M7 | ST-010 |

## 5. 현재 제거 또는 교체 대상

다음 항목은 “쓸 수 있는 부분”이 아니라 v2 경계와 충돌하므로 교체한다.

- Codex식 `config.toml` 생성과 `-c approval_policy/sandbox_mode` wrapper
- `ANTIGRAVITY_TOKEN`/`GEMINI_API_KEY` option 주입
- `debug prompt-input` 기반 smoke
- shell script로 prompt를 삽입하고 tmux pane을 수집하는 Telegram 실행
- unauthenticated requester에게 pairing link/PIN을 보여 주는 흐름
- Telegram의 hard-coded no-approval/danger-full-access
- raw prompt와 pane/model output logging
- AppArmor 없는 App metadata

다음 개념은 보안·native 계약에 맞춰 분해 후 재사용할 수 있다.

- s6 서비스와 failure isolation
- Ingress ttyd/tmux, 공개키 SSH와 `/data` host key
- HA API/log helper의 endpoint allowlist
- loopback browser gateway와 managed read-only identity
- validated memory의 상태 머신과 privacy rule
- feedback report의 privacy validation
- atomic user-file update와 backup 아이디어

## 6. 완료 감사 질문

최종 완료 전에 각 명시 요구사항에 대해 다음 질문에 모두 답한다.

1. 어떤 현재 파일/API/image가 구현을 증명하는가?
2. 어떤 test가 정확히 이 범위를 실행했는가?
3. test가 실행된 source SHA, image digest와 architecture는 무엇인가?
4. 실제 HAOS/AppArmor가 필요한데 local fixture로만 대체하지 않았는가?
5. negative, failure, migration과 rollback 경로도 검증했는가?
6. secret 또는 실제 사용자 data가 증거에 포함되지 않았는가?
7. 남은 `TODO`, `IN_PROGRESS`, `BLOCKED`, `PARTIAL`, `FAIL`, `NOT RUN`이 없는가?

하나라도 증거가 없으면 Goal은 완료되지 않았다.
