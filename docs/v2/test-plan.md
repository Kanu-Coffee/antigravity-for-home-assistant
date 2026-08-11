# v2 테스트 계획

## 1. 증거 원칙

- 요구 범위와 같은 범위의 증거만 인정한다.
- 기존 v1 또는 Codex reference의 PASS는 설계 근거일 뿐 v2 증거가 아니다.
- build 성공은 runtime, 보안, rendered UI 또는 update 성공을 뜻하지 않는다.
- emulated aarch64 build는 native/HAOS aarch64 실행을 대체하지 않는다.
- AppArmor는 실제 HAOS enforce 상태의 audit와 동작을 함께 확인한다.
- 성공 command, intended value 또는 config check만으로 HA 변경 결과를 확정하지
  않는다. fresh API와 필요한 rendered/browser 검증을 사용한다.
- 테스트 fixture에는 실제 token, entity name, state, memory DB와 대화 원문을
  넣지 않는다.

## 2. 현재 기준선

2026-08-11 준비 감사의 관찰이며 v2 완료 증거가 아니다.

| 항목 | 상태 | 관찰 |
| --- | --- | --- |
| tracked Git state | PASS | `main`과 `origin/main`이 `aba6805`에서 일치 |
| 기존 amd64 image build | PASS | local source image build 성공 |
| Python tests | FAIL | 84 pass, s6 executable-bit 계약 1 fail |
| Docker smoke | FAIL | 제거된 `debug prompt-input` 계약 사용 |
| memory smoke | FAIL | `node:sqlite` warning이 JSON stderr와 혼합 |
| user-file update smoke | FAIL | `/bin/sh` 경로에서 Bash `[[` 사용 |
| ShellCheck | FAIL | 2개 실패 |
| Markdown lint | FAIL | 기존 전체 문서에 다수 실패 |
| latest GitHub CI | FAIL | Python와 Docker smoke 실패 |
| latest Builder | FAIL | `config.yaml`의 `image` 누락 |
| aarch64 | NOT RUN | metadata와 Dockerfile이 amd64 전용 |
| v2 AppArmor | NOT RUN | custom profile 없음 |
| v2 Telegram security | FAIL | 기존 구현에 injection/auth/approval 결함 |
| 1.1.11 shared-HOME global MCP positive control | FAIL as expected | `--agent ha-telegram`에서도 user global stdio MCP가 Google OAuth 인증 완료 전 launch |
| 1.1.11 runtime auto-update opt-out | PARTIAL | clean HOME에서 미설정 spawn=1, `AGY_CLI_DISABLE_AUTO_UPDATE=true` 설정 spawn=0 |
| 실제 HAOS v2 | NOT RUN | v2 image 없음 |

이 표 이후의 local v2 구현 증거는 별도로 관리한다.

### 2.1 2026-08-11 local v2 working-tree 증거

| 항목 | 결과 | 정확한 범위 |
| --- | --- | --- |
| Python suite | PASS | historical local v2 snapshot `119 passed`; current full suite is recorded below |
| linux/amd64 image | PASS | `antigravity-for-home-assistant:v2-final-local`; manifest-list digest `sha256:de1992f8c0df09a0b138a8c22659f68dc1e817079f6828149f68305df79ddb04` |
| amd64 saved image config | PASS | `sha256:89fbca725e87f93af8d93f136b520f9e99738882ba3db2d6dc5e8db0f4d38a2b` |
| amd64 image smoke | PASS | full Docker, browser-approval, feedback, memory, managed-auth, managed-plugin, update, user-files와 Telegram isolation |
| linux/arm64 image | PASS (QEMU) | `antigravity-for-home-assistant:v2-final-local-arm64`; manifest-list digest `sha256:3cac3dcc76ba9d1410d3aac2369431a0568841f340f6b9748824b307cbd087df`; saved image config `sha256:1b63cf5afb9fb104426f94a1bdc9d6c3822c5fcc274a35515ee1d08fca17d82a`; packaging, HOME/rules/MCP Telegram isolation와 container-replacement update preservation PASS |
| Telegram isolation | PASS | amd64와 QEMU arm64 actual 1.1.11 shared-HOME positive control 뒤 HOME별 marker 음성 및 managed MCP/rules tamper fail-closed |
| config + memory fixture | PASS | bounded diff, canonical input boolean reload, memory begin/verify, failure rollback와 installed `ha-memory` subprocess boundary |
| transient device test | PASS | separate typed operation, test/restore preview, high-risk gate, success/test-failure/initial-call-error/rollback-failed/in-doubt와 durable replay fixture |
| read transport ownership | PASS | ordinary read, memory snapshot와 state validation의 shared ha-read broker static/failure injection; privileged mutation/browser-auth는 분리 |
| native arm64/HAOS | NOT RUN | QEMU 결과를 native 또는 HAOS 증거로 확대하지 않음 |
| actual HAOS | NOT RUN | OAuth, AppArmor enforce, 실제 Telegram/config mutation E2E 미실행 |
| candidate/release local contract | PASS | targeted 10, actionlint, ShellCheck, workflow YAML와 modified Markdown lint |
| remote candidate/Builder/public GHCR | NOT RUN | package visibility, native runner, evidence finalization, numeric promotion과 release 미실행 |

local PASS는 실제 HAOS OAuth/AppArmor enforce, native aarch64 또는 실제
Telegram/config mutation E2E를 대체하지 않는다.

### 2.2 2026-08-11 native migration transaction 증거

| 항목 | 결과 | 정확한 범위 |
| --- | --- | --- |
| Python suite | PASS | current working tree `158 passed` |
| linux/amd64 integrated image | PASS | 위 `v2-final-local` image와 동일 |
| managed plugin transaction | PASS | 실제 1.1.11 source/stage/installed validation, backup manifest, atomic activation, discovery와 stage-fail/SIGKILL/postcondition-fail rollback |
| native settings/MCP/state transaction | PASS | preflight-before-target-write, managed permission merge, first-create transaction과 same-state/missing-MCP `prepared` SIGKILL recovery |
| full Docker/update smoke | PASS | Telegram HOME의 허용된 native settings normalization을 의미 비교로 검증하고 unsafe mutation은 fail closed; full Docker와 update persistence PASS |
| actual HAOS/native arm64 | NOT RUN | Supervisor update/rollback, 전원 차단, AppArmor와 preservation E2E 필요 |

이 증거는 local image와 failure-injection fixture 범위만 `PARTIAL`로 인정한다.
HA-005 또는 실제 release rollback PASS로 사용하지 않는다.

### 2.3 2026-08-12 pre-commit 통합 증거

아래 결과는 최종 커밋 전에 현재 working tree를 source-rootfs manifest로 고정해 만든
amd64 통합 이미지의 회귀 증거다. OCI revision은 당시 `HEAD`인
`aba6805e8bf1f32e68976a67a46536c3ca362af8`을 가리키므로 이 이미지를 release 또는
clean-commit 증거로 사용하지 않는다.

| 항목 | 결과 | 정확한 범위 |
| --- | --- | --- |
| source-bound amd64 image | PASS | image ID `sha256:379bc37a8a07151d192b64e3368440862e9155599202c05345adcffa2bca6c72`; embedded rootfs digest `sha256:22b435eb960bf5e47ba0d888b59e6a83087e76afc2b13a557b455fad8b49e8ed`; root-owned regular file 135개 검증 |
| Python contracts | PASS | full suite `165 passed, 1 skipped`; Docker socket이 없는 test container에서 skip된 Buildx ignored-context canary를 host Docker에 연결해 별도로 `1 passed` |
| Node contracts | PASS | Telegram/change 묶음 30개와 read/validate/memory/Supervisor credential·option 묶음 30개 |
| static gates | PASS | ShellCheck, yamllint, markdownlint, actionlint, Hadolint, AppArmor parser/compiled target, App linter v2.21와 `git diff --check` |
| amd64 full runtime | PASS | Antigravity 1.1.11, Docker, feedback, browser approval, memory, managed auth와 Telegram isolation smoke |
| migration/update fixture | PASS | user-files와 managed-plugin의 SIGKILL recovery, container replacement update persistence |
| public v1 rehearsal | NOT RUN | clean committed source를 강제하는 preflight가 dirty working tree를 의도대로 거부; commit-bound image에서 재실행 필요 |
| actual HAOS/native arm64/live services | NOT RUN | AppArmor enforce, OAuth, Telegram Bot API, 실제 Core/Supervisor와 native arm64를 이 결과로 대체하지 않음 |

이 스냅샷은 로컬 패키징 회귀를 찾는 증거다. 최종 source commit, immutable two-arch
candidate와 HAOS evidence가 생기기 전에는 관련 마일스톤을 `VERIFIED`로 올리지 않는다.

## 3. 정적 검사

| ID | 검사 | 수용 기준 |
| --- | --- | --- |
| ST-001 | Git diff | whitespace 오류 없음, 의도한 파일만 변경 |
| ST-002 | YAML/App schema | 모든 YAML parse, config/schema/translation key 일치 |
| ST-003 | ShellCheck | 모든 runtime shell 경고 0 |
| ST-004 | Markdown | repository 규칙으로 lint 성공 |
| ST-005 | Dockerfile | Hadolint 성공, architecture mapping closed |
| ST-006 | Actions | actionlint 성공, permissions 최소화 |
| ST-007 | secret scan | tracked shell/JS/MJS/TS/JSON/YAML/Markdown 전체와 history 후보 검사 |
| ST-008 | executable bits | 모든 s6 run/finish와 `/usr/local/bin` entrypoint executable |
| ST-009 | generated artifacts | node_modules, build output, token fixture가 Git에 없음 |
| ST-010 | docs traceability | FR, SEC, TG, MIG와 test/checklist ID가 orphan 없이 연결 |

## 4. Antigravity 계약 테스트

| ID | 시나리오 | 수용 기준 |
| --- | --- | --- |
| AG-001 | `--version` | 정확히 `1.1.11` |
| AG-002 | help snapshot | 필수 flags/subcommands 일치, 금지 Codex 호출 없음 |
| AG-003 | wrapper argv | 사용자 argv 보존, 허용된 `--sandbox`만 주입 |
| AG-004 | settings merge | managed key 갱신, unknown/user key byte-semantic 보존 |
| AG-005 | plugin validation | source와 installed plugin이 공식 schema 통과 |
| AG-006 | duplicate plugin | global/staged/workspace 이름 충돌 시 fail closed |
| AG-007 | MCP discovery | `ha_change`, `ha_memory`, `ha_read`, `ha_validate`, `playwright` 다섯 managed server가 secret env 없이 발견 |
| AG-008 | OAuth persistence | login 후 restart/update에서 native session 보존 |
| AG-009 | print stdin | prompt가 argv/log에 없고 stdin으로 처리 |
| AG-010 | stream parser | init/progress/result, invalid JSON, unknown event, size limit |
| AG-011 | headless permissions | settings policy와 sandbox가 print mode에서도 적용 |
| AG-012 | forbidden flags | skip-permissions와 Telegram override 거부 |
| AG-013 | Telegram customization isolation | user global/workspace plugin·agent·rule·MCP가 인증 전후 worker에서 실행·노출되지 않음 |
| AG-014 | runtime auto-update disabled | 모든 native launch가 opt-out을 강제하고 updater spawn·binary version/digest 변동이 없음 |

AG-009와 AG-010은 실제 고정 binary의 authenticated test account 또는 비밀 없는
recorded protocol fixture가 필요하다. fake binary만으로 최종 PASS하지 않는다.

AG-013의 2026-08-11 actual 1.1.11 control은 shared `/data/home`에서 user global stdio
MCP가 Google OAuth 인증 완료 전 launch됨을 먼저 재현했다. 전용
`/data/antigravity-ha/telegram-home`과 image-managed safe cwd를 사용한 worker에서는
같은 global MCP marker와 `/config/.agents` marker가 모두 실행되지 않았고, managed
MCP 변조는 exit 70, rules 변조는 fail closed로 거부됐다. 이는 local container 격리
PASS이며 primary OAuth
backend/path, 실제 로그인 성공 뒤 동일-process credential 비유출과 HAOS AppArmor
enforce는 아직 `NOT RUN`이다.

AG-014 control canary는 실제 1.1.11과 clean temporary HOME에서 opt-out 미설정 시
updater spawn count 1, `AGY_CLI_DISABLE_AUTO_UPDATE=true` 설정 시 0을 먼저 재현한다.
그 뒤 interactive, Telegram, plugin validate/install과 startup/update 경로의 sanitized
child environment에 정확히 이 값이 있는지 검사하고, restart 전후 native binary
version과 image-layer digest가 같으며 updater child/download가 없는지 확인한다.
current amd64 image와 current-source QEMU aarch64 packaging canary는 이 경계를
통과했다. 실제 HAOS 두 architecture canary 전에는 최종 PASS를 주지 않는다.

## 5. unit와 component 테스트

### 5.1 API와 broker

- Core/Supervisor config, state, service, registry, history, trace, Core/App
  log의 고정 read allowlist, 입력·시간·개수·응답 크기 상한
- trace detail에서 raw config/action/result/trigger/context 제거, history/state attribute
  projection, bounded sensitive-state signal과 모든 로그 credential canary redaction
- `ha_validate_config`가 reload/restart 없이 고정 config check만 실행하고
  `ha_verify_state`가 exact entity fresh timestamp/state를 비교
- endpoint/method/tool allowlist와 unknown operation 거부
- broker bootstrap의 file/fd 검증, runtime의 즉시 read/close/env 제거와 raw token이
  장기 process environment, response와 log에 없는 canary test
- canonical path, traversal, symlink, hardlink, FIFO와 device 거부
- risk 재분류와 high-risk downgrade 거부
- capability entropy, binding, expiry, replay와 one-time consumption
- broker-generated secret-safe bounded structured diff가 normalized mutation과
  일치하고 target/digest/bytes+model summary만인 preview를 거부
- structured preview의 secret canary 제거, truncation 표시, digest binding과
  changed-preview confirmation 무효화
- config backup, temporary patch, failed config check와 atomic rollback
- canonical root-level input_boolean include만 restricted schema로 파싱하고 broker가
  expectation을 생성; memory begin → atomic replace/check → `input_boolean.reload` →
  fresh API memory verify → 실패 시 backup reload 순서를 검증
- automation/script/theme/임의 YAML은 preview-only이며 supported activation과 fresh API
  postcondition이 없으면 파일을 쓰거나 end-to-end 성공으로 표시하지 않음
- persistent `service_call`의 prior-state precondition과 fresh result verify
- 별도 typed `device_test`의 light/switch/input_boolean on/off allowlist, no-op/safety
  domain 거부, broker-generated test+restore preview, fresh prior/test/restore 순서와
  test-call error/verification failure에도 always restore
- restore mismatch `rollback_failed`, restore 관찰 불능 `in_doubt`, durable replay가
  service를 다시 호출하지 않는지 검증
- ordinary read, memory snapshot와 state validation이 production `ha-read-broker`를
  공유하고 하나의 injected broker failure에서 함께 fail closed하는지 검증. mutation과
  browser-auth transport는 privilege 차이 때문에 별도 owner로 유지
- Core/Supervisor timeout, 401/403/429/5xx 정제

### 5.2 memory

- empty DB init, FTS5, schema/version/permission 검사
- bounded search/show와 output ceiling
- explicit remember의 applied/already-known/conflict
- candidate → verified → applied state machine
- begin/verify change와 stale/partial/failure precondition
- transient state, timestamp, raw template, credential와 raw conversation 거부
- DB busy/corrupt/unknown schema에서 memory-only degraded
- restart/update persistence와 compensating rollback audit

### 5.3 browser

- Chromium executable path와 Playwright package version
- tool allowlist와 forbidden code/upload/download/path argument
- loopback-only gateway와 direct external access 거부
- managed user exact policy, reuse, rotation, OFF/ON과 removal
- token canary redaction in snapshot, console, network와 error
- desktop/mobile screenshot dimensions와 visible snapshot
- 4xx/5xx/transport failure, page error와 WebSocket inspection
- Core TLS verification 실패 시 우회 없이 fail closed

### 5.4 Telegram

- static allowlist 교집합과 ID canonicalization
- local pairing entropy/TTL/single-use/revoke와 unauthorized response
- `$()`, backtick, quotes, newline, leading dash, Unicode와 oversized input
- shell false, exact argv와 stdin prompt
- actual 1.1.11에서 user global stdio MCP pre/post-auth launch 거부와
  user/workspace plugin·agent·rule·MCP discovery 격리
- per-chat FIFO, global concurrency, queue overflow, cancel와 timeout
- validated update의 HKDF/AES-256-GCM sealed spool, plaintext/token canary 부재,
  fsync-before-transport-offset, ack ciphertext 삭제와 비순차 contiguous commit
- Bot API transport ack 뒤 process crash/restart replay, wrong-token/tamper fail-closed와
  sealed spool 128 records/2 MiB 경계
- NDJSON invalid/oversized/missing result/non-zero exit
- session key isolation, 24-hour expiry와 `/new`
- read-only/confirm/autonomous mode matrix
- high-risk always-confirm matrix와 모든 `service_call`의 human confirmation 강제
- cross-user/chat callback, replay, expiry와 preview digest change
- config replacement 원문을 Bot에 보내지 않고 broker structured preview만
  confirmation에 사용하며 model summary-only preview를 거부
- Bot 401/403/429/5xx/network failure와 result idempotency
- socket timeout보다 긴 mutation의 durable accept, status/result 조회와 restart `in_doubt`
- token/prompt/raw response log and metric non-disclosure

## 6. image 테스트

다음 suite를 `linux/amd64`와 `linux/arm64` 각각 실행한다.

`AG-014`의 updater opt-out canary도 각 architecture image 안에서 실행하며 한
entrypoint라도 값을 누락하거나 updater spawn/version·digest 변동이 있으면 해당 image를
publish하지 않는다.

| ID | 시나리오 |
| --- | --- |
| IM-001 | correct base, OCI label, user, HOME와 `/config` cwd |
| IM-002 | Antigravity/ttyd/Node/Chromium version과 architecture |
| IM-003 | s6 init dependency, service readiness와 clean shutdown |
| IM-004 | Ingress ttyd WebSocket, resize와 tmux reconnect |
| IM-005 | SSH public-key success, password/empty key failure, host-key persistence |
| IM-006 | fake Core/Supervisor read API와 log media type |
| IM-007 | broker mutation/rollback fixture와 token canary |
| IM-008 | memory bootstrap/restart/degraded isolation |
| IM-009 | Playwright desktop/mobile, console/network/WebSocket |
| IM-010 | Telegram full component smoke with fake Bot API |
| IM-011 | AppArmor policy compile/static profile coverage |
| IM-012 | preserve/refresh/reset/update/rollback fixture |

QEMU에서 IM suite를 통과하면 image compatibility 증거로 기록하되 native runtime
증거와 구분한다.

### 6.1 candidate와 release supply-chain gate

`Candidate / build`는 source SHA, run ID와 attempt가 포함된 staging tag만 게시한다.
per-arch action digest artifact에서 만든 generic candidate의 raw digest와 exact platform
descriptor를 검사하고, 다음 automated evidence가 모두 성공해야 candidate artifact를
만든다.

- generic `@exact-digest`의 amd64 full suite
- native `ubuntu-24.04-arm`의 arm64 full feasible suite
- 같은 source SHA의 complete reusable CI
- exact amd64/arm64 leaf SPDX와 파일별 16 MiB 미만 budget
- run ID와 attempt가 포함된 모든 intermediate/final artifact

실제 HAOS gate는 [release-evidence-template.json](release-evidence-template.json)의
`NOT_RUN`을 `PASS`로 글자만 바꿔서는 안 된다. exact candidate/source와 연결된
repository-scoped evidence URI와 content SHA-256이 여덟 gate 모두에 있어야 finalize가
통과한다. finalize는 각 URI를 다운로드해 실제 byte SHA-256도 비교한다. template
원본은 release contract 검사에서 실패해야 한다. 이 검사는 evidence integrity와
candidate binding을 보장하지만 보고서 속 HAOS 관찰의 진실성은 maintainer review라는
trusted-attestor 경계다.

Builder 정적/remote 시험은 다음 failure injection을 포함한다.

- package versions API success + tag absent와 authenticated registry manifest missing
  → carbon-copy create
- API success + tag same digest → no-op resume
- API success + conflicting digest → fail without overwrite
- API가 tag absent를 반환해도 registry inspect가 same/conflict면 resume/fail without
  overwrite
- API가 tag absent를 반환하고 registry inspect가 authorization/transport error면 fail;
  manifest missing만 create 허용
- API 403/404/network/malformed response → fail; absent로 분류하지 않음
- anonymous candidate preflight failure → numeric tag create 전 fail
- lightweight tag, source mismatch, run/workflow mismatch, expired/mismatched artifact → fail
- extra runnable platform, duplicate platform, detached attestation subject → fail
- Cosign identity/ref/SHA/repository/trigger mismatch → fail
- provenance 또는 leaf SPDX predicate retrieval failure → fail
- existing GitHub Release의 body/asset mismatch → fail without clobber
- missing GitHub Release + source가 current default branch에 미포함 또는 두
  `.github/workflows` tree digest가 다름 → fail; exact image와 supply-chain 게시 뒤
  reviewed merge 및 workflow drift 전 Release job resume만 허용

이 local contract와 workflow 정의는 실제 public package, native runner 실행, HAOS
rehearsal과 numeric tag publish 증거가 아니다. 외부 결과가 없으므로 현재 상태는
`PARTIAL`이다.

현재 `tests/managed-plugin-update-smoke.sh`는 기존 App 관리 plugin의 verified backup,
sibling stage, 실제 1.1.11 validation, activation 직후 SIGKILL restart recovery와
postcondition failure rollback을 검사한다. `tests/user-files-update-smoke.sh`는 managed
permission의 unknown user rule 보존, ownership conflict의 preflight-before-write,
settings/MCP/state transaction과 같은 state digest를 가진 missing-MCP transaction의
`prepared` SIGKILL recovery를 검사한다. 두 suite는 local amd64에서 PASS했지만 실제
HAOS update와 이전 image rollback은 실행하지 않았으므로 IM-012는 `PARTIAL`이다.

## 7. 실제 HAOS E2E

### HA-001 — 설치와 기본 표면

- clean install, App start/stop/restart와 Supervisor health
- Ingress 1440×900과 390×844 terminal usability
- public-key SSH와 host fingerprint persistence
- 공식 OAuth login과 App restart persistence
- AppArmor가 custom enforce profile인지 확인

### HA-002 — Home Assistant 기능

- Core/Supervisor readonly 정보와 로그
- entity/device/area/automation catalog bootstrap
- 한 개의 안전한 test config change, `ha-config-check`, reload와 fresh verify
- 안전한 test entity의 typed `device_test`: fresh prior, distinct test state, test verify,
  unconditional restore와 fresh restore verify
- memory explicit fact, conflict와 restart persistence
- memory/Core 장애에서 recovery surface 유지

실제 대상 이름, state와 secret은 테스트 보고서에서 익명화한다.

### HA-003 — dashboard

- canonical `http://127.0.0.1:8099/` URL
- desktop 1440×900, mobile 390×844 visible snapshot와 screenshot
- console warning/error와 network 4xx/5xx/blocked/failed resource
- authenticated REST와 WebSocket
- browser identity가 sole read-only policy인지 fresh API로 확인
- browser token이 screenshot, output와 App log에 없는 canary 확인

### HA-004 — Telegram

- static allowlist와 local pairing 각각 1회
- unauthorized user/chat와 pairing probe 거부
- readonly query와 per-chat session continuation
- `confirm_changes`의 safe config change와 cancel/expiry
- `autonomous` 저위험 실행과 high-risk confirmation 강제
- safe fixture entity `device_test`의 test+restore preview, human confirmation과 최종
  prior-state 복원. 실제 safety-critical entity는 사용하지 않음
- callback replay/cross-user negative test
- App restart 때 queue/capability 취소와 authorization 보존
- Bot API network interruption 뒤 duplicate mutation 없음
- sanitized Telegram Home/safe cwd에서 user global/workspace customization이
  실행되지 않고 실제 OAuth canary가 reply/log/network로 유출되지 않음

실제 high-risk device를 작동하지 않는다. broker dry-run과 synthetic policy operation으로
confirmation 강제를 검증한다.

### HA-005 — update와 rollback

amd64와 aarch64에서 각각 다음을 실행한다.

1. 최신 public v1 설치와 representative 사용자 상태 준비
2. v2 `preserve` update
3. OAuth, SSH, browser identity, memory, `/config`와 사용자 settings 확인
4. 모든 native launch의 updater 미실행과 restart 전후 binary version/digest 불변 확인
5. `refresh_managed` 1회성과 restart idempotency
6. 별도 fixture에서 `reset_v2`와 conflict failure
7. migration 중 강제 종료와 recovery
8. 이전 immutable image rollback과 필요한 managed state 복원

## AA-001 — AppArmor 검증

실제 HAOS에서 각 top-level named `Px` 실행 프로필로 positive와 negative test를
수행한다.

Positive:

- interactive worker의 일반 `/config` YAML read/write
- option `true` interactive sensitive-read `Px` 프로필의 `secrets.yaml`, `.storage`와
  Recorder DB read-only
- broker의 scoped atomic config transaction
- memory profile의 DB access
- browser의 `/run` profile과 loopback gateway
- SSH/ttyd와 native OAuth 자료의 필요한 접근
- Telegram Antigravity worker의 native OAuth login/session 접근

Negative:

- option `false` interactive restricted `Px` 프로필의 `secrets.yaml`, `.storage`,
  Recorder DB read/write
- option `true` interactive sensitive-read `Px` 프로필의 위 세 종류
  write/rename/truncate/delete
- Telegram/browser/memory/broker의 위 세 종류 read/write를 두 option 값에서 모두 거부
- 모든 profile의 SSH key, App token, backup, SSL과 cloud auth 접근을 두 option 값에서 모두 거부
- Telegram의 `/config` write와 raw mutation endpoint
- browser의 `/config`, `/data`, Supervisor endpoint
- memory의 OAuth/Telegram/SSH/browser credential
- 모든 unprivileged child의 capability directory와 host paths
- ordinary SSH/SFTP/ttyd shell의 `/data/home/.gemini/**` 접근과 main/shell/interactive/
  helper/broker profile의 다른 PID `environ`, `cmdline`, `mem`, `fd`, `root`, `map_files` 우회

interactive Antigravity process는 native Home/session 동작을 위해 `/data/home/**`에,
Telegram Antigravity process는 별도 전용 Home에 접근한다. primary OAuth credential
backend와 exact path가 아직
검증되지 않았으므로 특정 `.gemini` 경로를 OAuth 필수 경로로 가정해 AppArmor deny
시험을 설계하지 않는다. 대신 credential canary를 두고 native
permission/sandbox/command 경계가 임의 file-read 유도를 차단하는지, 원문이 model
output, Telegram reply, log와 artifact에 없는지를 별도 negative test한다. AppArmor가
같은 process 안의 정상 인증 read와 유도된 read를 구분하지 못하는 잔여 위험을
release evidence에 기록하지 않으면 PASS가 아니다.

Telegram worker에서 임의 user global stdio MCP를 canary로 구성하고 인증 전과 인증
후 모두 process launch가 없어야 한다. custom MCP를 의도적으로 launch하는 negative
fixture에서는 child가 Telegram worker profile을 상속하고 coordinator socket이
deny되는지도 별도로 확인한다. socket deny만으로 공유 Home credential 격리 PASS를
주지 않는다.

예상 deny는 test case와 일치해야 한다. 예상하지 않은 `DENIED`와 release run의
`ALLOWED` complain event가 있으면 PASS가 아니다.

두 option 값 모두 `aa-status`와 Supervisor 상태에서 custom profile이 enforce여야
한다. option 전환은 interactive top-level named `Px` 실행 프로필 이름만 바꾸며
AppArmor detach, complain 전환 또는 root/다른 실행 프로필 권한 변경을 일으키면
실패다.

## 9. 성능과 내구성

- idle container memory/CPU와 image size budget을 release별 추적한다.
- 2 global workers, chat별 queue 4에서 30분 soak를 수행한다.
- Core, Bot API, browser와 memory 장애를 동시에 15분 주입해 backoff와 복구를 본다.
- 1,000 entity 규모 catalog와 긴 로그에서 bounded memory/output를 확인한다.
- rapid restart 20회에서 migration, socket, lock과 zombie child 누수가 없어야 한다.

고정 budget은 [performance-budget.json](performance-budget.json)의 기계 판독 가능한
값을 사용한다. 기준은 SHA-256
`b2cb64cac2c5f12c61d4a779c06a4bca1307799e485086d9512974e231d51d09`인 첫 30분
baseline evidence다. 이 측정의 image 558,690,739 bytes, host component peak RSS
104,890,368 bytes, candidate idle 약 47,815,066 bytes와 idle CPU 0.00%를 근거로
image 600,000,000 bytes, candidate cgroup peak RSS 201,326,592 bytes, 평균 CPU 5.0%를
상한으로 고정했다. image에는 약 7.4% 증가 여유를, RSS에는 baseline component peak의
약 1.9배를 부여하며, CPU 상한은 baseline의 낮은 부하보다 충분히 크지만 runaway를
탐지한다. budget 파일의 limit 또는 baseline digest가 빠지거나 달라지거나 측정값이
상한을 넘으면 release harness는 nonzero로 끝나며 `closure_eligible: false`인 실패
증거만 남긴다.

`tests/performance-durability-soak.sh`는 두 모드를 명시적으로 분리한다. 기본
`--mode contract`는 CI에서 2초 soak, 1초 동시 장애와 broker 3회 restart로 fixture와
증거 schema만 검사하며 JSON의 `closure_eligible`은 항상 `false`다. 이 결과로
GAP-007을 닫지 않는다. 외부 HA나 Bot API는 호출하지 않으며 browser 장애도
loopback fixture로 제한한다.

GAP-007 local 해제에는 새 candidate를 대상으로 다음 opt-in 명령을 실제 wall-clock으로
완료해야 한다.

```bash
tests/performance-durability-soak.sh \
  --mode release \
  --image '<amd64-image@exact-stage-digest>' \
  --candidate-stage-digest 'sha256:<exact-amd64-stage>' \
  --candidate-leaf-digest 'sha256:<exact-amd64-runtime-leaf>' \
  --evidence '/absolute/path/gap-007-release.json'
```

release mode의 1,800초 soak, 900초 동시 장애, broker 20회 restart와 candidate container
20회 restart는 environment로 줄일 수 없다. candidate container는 외부 network 없이
실행한다. release harness는 image 내부 source-rootfs manifest의 Git allowlist 기반
path/content/실행 비트 digest 및 non-null OCI source revision label을 현재 source와
대조한다. image 내부에서는 manifest에 등록된 file content와 size도 다시 확인한다. workload는
candidate 안에서 실행하며 `/usr/local/share/antigravity-ha/telegram-bridge.mjs`의 실제
global queue/worker slot과 `TelegramPollBackoff`를 import한다. host-only loop나 module
origin 문자열만으로는 PASS할 수 없다. PASS JSON에는 immutable image ID, source commit과
실행 전후 동일한 source-rootfs SHA-256, UTC 시작·종료, 실제 경과 시간, architecture,
migration state digest, socket/journal/lock/zombie 검사와 고정 resource budget 측정이
있어야 한다.
긴 로그·prompt·credential·실제 entity/chat ID는 evidence에 넣지 않는다. 장시간
component PASS와 candidate restart PASS가 모두 있어야 `closure_eligible: true`이며,
이는 실제 HAOS와 live Bot gate를 대신하지 않는다.

위 baseline run은 candidate revision label이 없고 host source workload를 사용했으므로
budget 수립 입력일 뿐 GAP-007 해제 증거가 아니다. 별도의 source-bound candidate
release run은 source `ae8b0bc4fdd042bdb84c55a1767d619d9adc734f`, source-rootfs
`sha256:22b435eb960bf5e47ba0d888b59e6a83087e76afc2b13a557b455fad8b49e8ed`에서
1,800초 soak, 900초 장애 주입, broker/candidate restart 20회와 고정 budget을 PASS했다.
sanitized evidence SHA-256은
`2c2b3fe0cb0aa2522722e192323bdb0e0a291f5d99193df603eace003dc7f8f9`이며 local
GAP-007 해제 증거다. 실제 HAOS와 live Bot API는 여전히 별도 gate다.

공식 Candidate build는 위 release mode를 exact amd64 staging digest에서 자동 실행하고
runtime leaf digest, source revision, source-rootfs digest와 evidence file SHA-256을
`candidate.json` 및 immutable candidate artifact에 함께 기록한다. finalize artifact도
원본 `gap007-release.json`을 보존한다. numeric tag Builder는 promotion 전에
`release_contract.py`로 원본 hash, exact stage/leaf/source, schema, duration, packaged
module origin, restart와 resource budget을 다시 검증한다. candidate image는 stopped
container의 `docker export`를 host Python으로 읽어 embedded manifest aggregate와 각
regular root-owned entry의 normalized mode/size/SHA-256를 image binary와 독립적으로
검증한다. build context는 manifest entry와 manifest 자체 외 rootfs file을 거부하므로
Git-ignored canary도 COPY될 수 없다. `source-rootfs-manifest.py create`는 같은 manifest에서
부모 디렉터리 traversal과 각 file만 열어 주는 `.dockerignore`를 함께 생성하고, `verify`는
allowlist drift와 wildcard 추가를 fail closed한다. 따라서 ignored/unmanifested rootfs
비밀은 Docker daemon으로 context가 전송되기 전에 client allowlist에서 제외되며,
Dockerfile의 manifest/count/digest 검사는 그 다음 독립 방어선이다. 이 검증 또는 evidence가
없거나 candidate와 다르면 numeric image tag를 만들 수 없다.

release harness는 시작과 종료 모두 repository 전체가 clean인지 확인하고 HEAD가 image
revision label과 같은 경우에만 host의 harness를 candidate container로 복사한다. dirty
또는 untracked harness로 생성한 결과는 `closure_eligible` evidence가 될 수 없다.
packaged component는 GNU `timeout`의 40분 wall-clock, TERM과 30초 kill-after 경계 안에서
완료해야 하며 hang/timeout도 sanitized FAIL evidence와 container cleanup으로 끝난다.

## 10. 증거 기록 양식

```text
requirement/test ID:
date/timezone:
source commit:
image reference and digest:
architecture / HAOS / Core / Supervisor versions:
exact command or UI path:
sanitized fixture/target:
expected result:
actual result:
artifact or CI link:
result: PASS | FAIL | PARTIAL | NOT RUN
remaining gap:
```

실제 값이 빠졌거나 범위가 좁으면 `PARTIAL` 또는 `NOT RUN`이다. 체크리스트의
`VERIFIED`는 관련 필수 test ID가 모두 PASS일 때만 사용한다.

## 11. 요구사항-테스트 추적표

각 요구사항은 아래 필수 test ID 전부의 실제 증거가 있어야 한다. 한 test가 여러
요구사항을 검증할 수 있지만, 좁은 fixture의 PASS를 더 넓은 요구사항의 증거로
확대하지 않는다.

| 요구사항 ID | 필수 test ID |
| --- | --- |
| FR-001 | ST-002, ST-005, ST-008, IM-001, IM-002, IM-003, IM-011, HA-001, AA-001 |
| FR-002 | AG-001, AG-002, AG-003, AG-004, AG-005, AG-006, AG-007, AG-008, AG-009, AG-010, AG-011, AG-012, AG-013, AG-014, IM-002, HA-001 |
| FR-003 | ST-008, IM-003, IM-004, IM-005, HA-001 |
| FR-004 | AG-005, AG-006, AG-007, IM-006, IM-007, IM-008, IM-009, IM-010, HA-002 |
| FR-005 | IM-008, HA-002 |
| FR-006 | IM-009, HA-003 |
| FR-007 | AG-013, IM-010, HA-004 |
| FR-008 | AG-013, ST-007, IM-007, IM-009, IM-010, IM-011, AA-001 |
| SEC-001 | AG-013, ST-007, IM-007, IM-010, IM-011, AA-001 |
| SEC-002 | AG-013, ST-007, IM-007, IM-008, IM-009, IM-010, IM-011, AA-001 |
| SEC-003 | AG-009, AG-012, AG-013, IM-007, IM-010, IM-011, IM-012, AA-001, HA-004, HA-005 |
| SEC-004 | ST-002, IM-011, AA-001 |
| SEC-005 | AG-007, AG-013, IM-006, IM-007, IM-009, IM-010, AA-001 |
| SEC-006 | ST-007, IM-011, AA-001 |
| SEC-007 | IM-007, IM-010, HA-002, HA-004 |
| SEC-008 | AG-009, AG-012, AG-013, IM-010, IM-011, HA-004, AA-001 |
| SEC-009 | IM-009, IM-011, HA-003, AA-001 |
| SEC-010 | ST-007, IM-008, HA-002 |
| SEC-011 | ST-007, IM-007, IM-009, IM-010, HA-004 |
| SEC-012 | AG-013, ST-007, IM-007, IM-009, IM-010, IM-011, IM-012, AA-001, HA-004, HA-005 |
| TG-001 | AG-009, AG-012, IM-010, HA-004 |
| TG-002 | ST-002, IM-010, HA-004 |
| TG-003 | IM-010, HA-004 |
| TG-004 | IM-010, HA-004 |
| TG-005 | AG-009, AG-012, IM-010, HA-004 |
| TG-006 | IM-010, HA-004 |
| TG-007 | AG-009, AG-010, AG-011, AG-012, AG-013, IM-010, HA-004 |
| TG-008 | IM-007, IM-010, HA-004 |
| TG-009 | IM-007, IM-010, HA-004 |
| TG-010 | IM-007, IM-010, HA-002, HA-004 |
| TG-011 | IM-010, HA-004 |
| TG-012 | ST-007, IM-010, HA-004 |
| TG-013 | AG-013, IM-010, HA-004 |
| MIG-001 | AG-014, ST-002, ST-005, IM-001, IM-002, HA-001 |
| MIG-002 | ST-007, IM-012, HA-005 |
| MIG-003 | IM-012, HA-005 |
| MIG-004 | IM-012, HA-005 |
| MIG-005 | ST-001, ST-009, IM-012, HA-005 |
| MIG-006 | IM-008, IM-012, HA-002, HA-005 |
| MIG-007 | IM-012, HA-005 |
| MIG-008 | AG-014, ST-005, IM-001, IM-002, HA-001, HA-005 |
| MIG-009 | AG-014, ST-001, ST-002, ST-003, ST-004, ST-005, ST-006, ST-007, ST-008, ST-009, ST-010, IM-001, IM-002, IM-003, IM-004, IM-005, IM-006, IM-007, IM-008, IM-009, IM-010, IM-011, IM-012, AA-001 |
| MIG-010 | AG-014, ST-010, IM-001, IM-002, IM-003, IM-004, IM-005, IM-006, IM-007, IM-008, IM-009, IM-010, IM-011, IM-012, HA-001, HA-002, HA-003, HA-004, HA-005, AA-001 |
| MIG-011 | ST-010 |
