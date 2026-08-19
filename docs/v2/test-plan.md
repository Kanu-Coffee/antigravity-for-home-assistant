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
| 1.1.11 shared-HOME global MCP positive control | FAIL as expected | 이전 격리형 Telegram 실행에서도 user global stdio MCP가 Google OAuth 인증 완료 전 launch되어 격리 가정이 성립하지 않음 |
| 1.1.11 runtime auto-update opt-out | PARTIAL | clean HOME에서 미설정 spawn=1, `AGY_CLI_DISABLE_AUTO_UPDATE=true` 설정 spawn=0 |
| 실제 HAOS v2 | NOT RUN | v2 image 없음 |

이 표 이후의 local v2 구현 증거는 별도로 관리한다.

### 2.0.7 Telegram trust-model 전환

2.0.6 이하의 Telegram HOME/customization isolation PASS는 2.0.7 수용 증거가 아니다.
새 기준은 shared `/data/home`·`/config`·OAuth·global/workspace customization과 native
permission의 positive inheritance, `/new`까지 안정된 session, same-session approval,
encrypted reply outbox의 crash/retry/ack다. source/component 검증은 구현 뒤 새로
기록하고 실제 HAOS OAuth/AppArmor/live Bot API E2E는 현재 `NOT RUN`이다.

### 2.0.8 Telegram terminal-result 복구

2.0.7의 shared conversation과 outbox 계약은 유지하되 일반 채팅 성공을 model의
App 전용 JSON schema/`finish` tool 호출에 의존하지 않는다. 2.0.8 수용 증거는 실제
1.1.13 native free-text `result.response`, 정확한 완료 `ha_change_propose` receipt,
durable conversation binding과 requester-bound broker live-metadata 재검증, typed
terminal failure, 그리고 transport 정상과
terminal 실패의 구분을 포함해야 한다. source/component fixture는 실제 Bot API
network, HAOS OAuth/AppArmor 또는 live Telegram 전달 PASS로 확대하지 않는다.

### 2.0.9 Telegram 관리자 권한·변경 승인과 local cache

2.0.9는 새 설치 `always-proceed`, operational default allow, 세 채널의 native sandbox
무사용과 legacy true/false 입력의 false 정규화, bootstrap/runtime/command AppArmor
전환, secrets/storage/token/key exact deny, 모든 live-validated HA service 및 일반 YAML patch,
durable requester/session-bound approval을 검증한다. 관리형 runtime rule은 일반 HA
service/config 변경을 `ha_change_propose`로 라우팅하고, 이 경로의 모든 App-managed
broker `service_call`/`config_patch`에 durable 확인을 강제해야 한다. 신뢰된 사용자 전역
native tool과 direct command/API helper는 broker가 투명하게 intercept하지 않는
관리자 경로임을 문서 계약으로 고정한다. callback ACK/기본 인증은 긴 model
작업과 무관하게 즉시 끝나야 하지만 broker 실행은 requester FIFO에서 직렬화되고 실행
직전 `/new`·`/cancel` 경합과 generation/conversation을 다시 확인해야 한다. restart와
duplicate callback은 동일 idempotency mutation을 한 번만 접수해야 한다. native
headless permission prompt는 Telegram으로 resume할 수 없으므로 broker proposal과
혼동하지 않는다. local build는 per-checkout project builder/cache/image 경계만 지우며
global prune 부재를 계약 테스트한다. 실제 HAOS와 live Bot API는 별도 증거 전까지
`NOT RUN`이다.

release build는 stable GHA cache scope를 검사한다. managed-plugin, native user-files
refresh와 change-broker config backup fixture는 각 범주에서 검증된 완료 transaction의
최신 총 2개, active journal/result 보존, atomic quarantine crash retry와
manifestless/unsafe/symlink 보존을 확인한다.

### 2.0.10 Telegram proposal receipt와 multi-choice

2.0.10은 필수 managed-MCP parameter 세 개에 optional bounded
`toolAction`/`toolSummary`가 추가된 실제 stream shape를 수용하고 unknown/invalid
metadata는 fail closed해야 한다. 정확히 하나의 완료된 유효 proposal receipt 뒤 빈
terminal text만 고정 문구로 대체하며 proposal 없는 빈 응답은 계속
`terminal_response_invalid`여야 한다.

`multi_choice_service_call`은 1~31개 선택지 모두에 ordinary `service_call` validator와
한 live service registry snapshot을 적용하고, cancel을 포함한 최대 32개 button을
4×8 안에 배치한다. `v3c`/`v3d`와 legacy `v2a`/`v2d`, encrypted opaque-token mapping,
선택-before-authorization, requester/session generation/conversation/digest/choice/
capability/idempotency binding, unknown token·double tap·다른 두 번째 choice·restart
경계를 검증한다. bridge-only restart는 broker가 살아 있을 때만 기존 proposal을
계속할 수 있고, full App/broker restart는 미접수 in-memory proposal을 실행하지 않으며
접수된 durable result만 회수해야 한다. 실제 HAOS OAuth/AppArmor와 live Telegram
Bot API/card/service-call E2E는 별도 증거 전까지 `NOT RUN`이다.

### 2.0.11 universal managed Telegram approval

2.0.11은 새 설치와 Telegram의 유일한 effective native 값 `request-review`,
`strict`/legacy autonomous schema 입력의 `request-review` 정규화, safely identified 2.0.9/2.0.10 App-owned broad
permission의 bounded-read/proposal-only migration, exact
`telegram_action_propose` receipt와 private run-bound coordinator를 검증한다.
`terminal_command`, `multi_choice_terminal`, `question` schema의 size/depth/path/timeout/
sensitive-value deny, 1~31 choice+cancel 4×8 `v4a`/`v4d`/`v4c` keyboard, encrypted
approval state, durable commit-before-exec, no-respawn `in_doubt`, credential-free executor,
bounded stdout/stderr와 same-conversation sealed continuation을 component fixture로
검증한다. `/cancel`, cross-user/session/update/run mismatch와 duplicate callback도
실행을 만들지 않아야 한다.
upstream `readOnly: true` Playwright 네 도구만 auto-allow되고 navigate/back, tabs,
hover, wait, resize, close는 fail closed하는지 검증한다. proposal register 성공 뒤
encrypted approval/card sealing 전 bridge crash는 registration 복구를 주장하지 않고
사용자 재시도 상태로 끝나야 한다.

고정 CLI 1.1.13 print mode에서 PreToolUse hook이 실행되지 않고 native permission
prompt를 external approval로 resume할 protocol이 없다는 actual-binary negative proof를
유지한다. 따라서 arbitrary future/user plugin MCP transparent interception은 수용
조건이 아니며 unsupported side effect의 fail-closed가 수용 조건이다. source fixture와
local image 성공은 실제 HAOS AppArmor enforce, initial OAuth, live Telegram Bot API
card/callback 또는 실제 HA/command E2E가 아니다. 이 항목들은 계속 `NOT RUN`이다.

### 2.0.12 Telegram-enabled permission reconciliation과 startup hold

2.0.12는 `telegram_enabled=true`와 `preserve`인 synthetic legacy settings를 사용해
다음을 별도 검증한다.

- root-owned single-link regular·256 KiB 이하의 parse 가능한 existing settings를
  transaction backup한 뒤 다섯 App 관리 보안 key와 permission 세 bucket을 shared
  canonical policy로 교체하고 mode를 0600으로 강화하며 ownership state를 갱신
- 그 다섯 보안 key 밖의 unrelated top-level settings의 semantic 보존, global MCP의 byte 보존과
  OAuth/plugin/`/config` 비대상, update mode가 `reset_v2`로 바뀌지 않음
- 기존 ownership state의 유무와 관계없는 결과, 두 번째 restart의 no-write/no-backup
  idempotency, prepared/commit crash recovery
- image default generator, user-files updater와 bridge가 같은 policy validator를 쓰며
  canonical output은 bridge gate를 통과
- 2.0.16은 안전한 기존 settings의 allow/ask/deny 각 bucket이 non-array이거나 array 안
  항목이 non-string인 fixture에서도 managed 세 bucket을 typed merge 검증 전에 exact
  canonical policy로 교체한다. unrelated settings 보존, backup/ownership state와 두 번째
  실행 no-write/no-backup idempotency를 각 malformed bucket마다 검사한다.
- invalid effective settings는 Bot API 호출 전 `permission_boundary_blocked` 한 건을
  만들고 bridge process를 exit시키거나 S6 restart loop를 만들지 않는 live hold

현장 수동 settings 복구는 이 repaired image의 증거가 아니다. 2026-08-18 실제 HAOS
18.2 amd64에서 public 2.0.11→2.0.12 `preserve` update, automatic reconciliation,
`permission_boundary_ready` 29/0/33, live Bot API reconnect·delivery와 App
restart/reconnect는 `PASS`했다. 이 좁은 결과는 unrelated settings/global MCP/OAuth
보존, unsafe boundary hold, 전체 HA-004 또는 다른 architecture를 PASS로 만들지 않는다.
같은 보고의 AppArmor는 project custom profile이 아니라 `docker-default (enforce)`여서
`FAIL`이고, aarch64 실기기 결과는 장비 부재로 `NOT RUN`이다. 소유자가 experimental
배포에서 aarch64 결과를 면제했지만 이 면제를 PASS 증거로 기록하지 않는다.

### 2.0.13~2.0.18 Supervisor AppArmor와 startup 회귀

2.0.12 `apparmor.txt`의 들여쓰기 없는 최상위 `profile` 선언 23개는 Supervisor
2026.07.5의 App policy primary scanner가 요구하는 정확히 한 개의 `^profile[ ]` 선언과
맞지 않았다. 2.0.13은 slug primary 선언 하나만 column 0에 유지하고 나머지 22개
독립 global profile 선언을 들여쓴다. AppArmor parser 관점의 23개 profile 이름,
`Px transition`과 path deny는 동일해야 하며 nested subprofile로 바꾸지 않는다.

정적 수용은 Supervisor primary 선언 1개, AppArmor parser의 기존 23개 global profile,
기존 transition target과 deny 집합 보존을 각각 검사한다. 공개 2.0.13의 실제 HAOS
18.2 amd64 업데이트에서는 이전 컨테이너의 정상 Telegram metrics와 순차 종료 뒤 새
컨테이너의 `/run/s6`·`/run/service` 생성이 `Permission denied`로 실패하고
`s6-overlay-suexec`가 exit 111로 종료됐다. 따라서 2.0.13 실기기 AppArmor/S6 startup
결과는 `FAIL`이며 Telegram 연결 실패로 분류하지 않는다.

2.0.14는 S6 runtime directory entry와 container exit result, nginx PID에 필요한
접근만 추가했지만 실제 HAOS amd64에서 S6 service graph가 init까지 진행한 뒤
`/usr/bin/bashio`의 resolved `/usr/lib/bashio/bashio` 실행이 거부되어 exit 126으로
다시 `FAIL`했다. init의 `/command/with-contenv`도 실제
`/package/admin/s6-overlay-3.2.2.0/command/with-contenv` target에 exact execute가
필요하다.

2.0.15 정적 수용은 관찰된 Bashio denial만 검사하지 않고 cold-start trace-derived closure 전체를
다음처럼 고정한다.

- primary/init의 `/usr/lib/bashio/bashio`, init의 pinned
  `execline`·`s6-envdir`·`with-contenv`, narrow profile의 resolved `/usr/bin/bash`,
  Telegram의 resolved `s6-pause`, shell의 architecture-bound `utempter`, Playwright
  bootstrap/browser의 interpreted wrapper/runtime read, `/usr/lib/chromium/chromium`·
  `chrome_crashpad_handler` exact execute, traced font/config metadata read와 profile 집합
- init passwd/shadow lock·교체 파일과 nginx PID/temp state, sshd의
  `owner @{PROC}@{pid}/oom_score_adj`, shell의 `/run/utmp`·`/var/log/wtmp`, HA helper의
  `/config/antigravity-workspace/feedback/**` 및 browser의
  `/var/cache/fontconfig/*` narrow mutation과 profile 집합
- 새로 추가된 `/usr/lib/**`·`/package/admin/**` broad execute와 `/etc/**` broad write 부재, 기존
  credential·민감정보 deny 보존

`Kernel-enforced AppArmor startup smoke`는 unique profile을 실제 kernel에 load하고
exact built/Candidate image를 그 profile로 실행하여 PID 1 enforce, runtime ready와 full
S6 service, cold start, 동일 data를 쓴 fresh-container restart, S6 mkdir/exec fatal 부재,
안전한 canary 내용으로 준비한 `/config/secrets.yaml` read denial과 예상 밖 kernel
denial 부재를 검사한 뒤 profile을 unload한다. 실제 `/data/options.json`을 denial
canary로 사용하지 않는다. 일반 CI amd64와 Candidate native amd64/aarch64에서
필수지만 HAOS 증거로 승격하지 않는다.

공개 2.0.15의 실제 HAOS amd64에서는 service graph, Ingress HTTP 200과 WebSocket 101
뒤 ttyd `pty_spawn`이 EACCES를 반환하고 S6가 ttyd를 반복 재시작했다. 따라서 2.0.15
Web terminal/AppArmor 수용은 `FAIL`이다.

2.0.16 정적·kernel-enforced 수용은 primary profile에 exact `/dev/ptmx rw`가 있고 broad
`/dev/**` grant는 없는지 확인한다. 실제 profile 아래에서 PTY를 allocate하여 양방향
입출력을 검증하고, ttyd WebSocket→PTY→tmux 연결과 fresh connection을 연속 수행한 뒤
예상 밖 AppArmor denial과 ttyd 재시작이 없어야 한다. updater 수용은 위의 malformed
allow/ask/deny fixture와 unsafe-file fail-closed matrix를 함께 통과해야 한다.

실제 HAOS 2.0.16은 App service graph, Ingress/Web terminal, Telegram
`permission_boundary_ready`와 `connected`까지 도달했지만 `agy` 및
`antigravity --version`이 SIGSEGV/status 139로 즉시 종료되고 모든 Telegram worker가
`session_ready` 뒤 실패했다. 따라서 2.0.16 native/Telegram 수용은 `FAIL`이다.

2.0.17 회귀는 먼저 exact public 2.0.16 image와 project custom profile에서 status 139와
kernel audit의 `/usr/local/libexec/antigravity-real` `file_mmap` permission `m` denial을
재현해야 한다. corrected image에서는 restricted/sensitive-read 두 runtime profile의
exact native-binary rule은 `r`에서 `rm`으로 바뀌며 full blank-auth trace의 bootstrap
nsswitch/passwd identity와 runtime `/usr/share/ca-certificates/**` TLS trust-store exact
read가 두 transition chain에만 존재하는지 검증한다. 새로운 broad `/etc/**`·
`/usr/share/**` rule이 없고 runtime의 기존 `/etc/** r`, 필수 system-library mapping 및
proc/settings/credential deny가 그대로인지 정적으로 검증한다.
kernel-enforced 양성 검사는 실제 `antigravity --version` status 0, blank-auth worker의
TLS trust-store 도달, PTY와 fresh-container restart를 실행하고,
음성 검사는 proc/settings/sensitive canary와 unexpected denial 부재를 유지한다. Telegram
fixture는 child SIGSEGV를 generic `worker_failed`로만 숨기지 않고 bounded signal class로
기록하되 stderr, prompt, OAuth, token과 사용자 content가 없는지 검증한다.

실제 HAOS 2.0.17 amd64에서는 최초 기동, Ingress/Web terminal,
`antigravity --version`과 기본 대화, Telegram `permission_boundary_ready`/`connected`,
도구 없는 답변이 `PASS`했다. 단일 managed MCP와 `telegram_action_propose`는 `FAIL`,
승인된 쓰기는 카드 생성 전에 막혀 `NOT RUN`이므로 2.0.17 전체 수용은 `FAIL`이다.
kernel audit는 `change-proposal-client`가 exact image-owned
`/usr/local/share/antigravity-ha/supervisor-credential-fd.mjs` 전이 module을 읽지 못한
denial을 기록했다. 별도로 restricted/sensitive-read launcher는 승인 제안에 필요한
requester/run binding 다섯 값을 버렸다.

2.0.18 정적·component 수용은 다음을 모두 검사한다.

- `change-proposal-client`에는 exact `supervisor-credential-fd.mjs r`만 있고 상위
  `/usr/local/share/antigravity-ha/** r` 같은 broad 대체 rule은 없다.
- restricted와 sensitive-read launcher는 다섯 binding 모두가 있을 때만 함께 전달하고,
  일부 binding은 native child 시작 전에 실패하며 환경 전체를 상속하지 않는다.
- managed read MCP와 `telegram_action_propose` coordinator fixture가 성공하고 direct
  unapproved write/command와 기존 민감정보 deny negative canary는 그대로다.
- memory DB 본체와 실제 hardlink는 계속 fail closed하고, SQLite가 `-wal`/`-shm`/
  `-journal`을 정상 unlink하는 경합에서만 관찰 가능한 `nlink == 0`은 `ENOENT`와 같은
  ephemeral disappearance로 처리한다. deterministic zero-link fixture와 two-link
  negative fixture를 모두 실행한다.

실제 HAOS 2.0.18 amd64에서는 최초 기동·stop/start·restart 뒤 단일 read MCP,
Telegram 승인카드, requester-bound callback과 승인된 bounded `/config` 쓰기를 순서대로
검증하고 예상 밖 `DENIED`가 없어야 한다. 2.0.18 amd64와 aarch64 실기기 결과는 릴리스
전 `NOT RUN`이다. aarch64 owner waiver는 PASS가 아니며 전체 v2 수용은 `PARTIAL`이다.
automated Linux-container result는 HAOS 증거로 승격하지 않는다.

2.0.12 rollback rehearsal은 Supervisor direct downgrade가 지원된다고 가정하지 않는다.
exact 2.0.12 App backup이 있는 경우에만 backup restore가 App image와 `/data`를 함께
되돌리는지, post-backup OAuth·memory·approval/outbox·identity 손실을 사용자가 수용했는지
확인한다. backup 없는 uninstall/Docker 조작은 시험하지 않는다. current `/data`를
보존하는 higher-version security-degraded compatibility fallback도 실제 Candidate와
HAOS 수용 전에는 `NOT RUN` contingency다.

### 2.1 2026-08-11 local v2 working-tree 증거

| 항목 | 결과 | 정확한 범위 |
| --- | --- | --- |
| Python suite | PASS | historical local v2 snapshot `119 passed`; current full suite is recorded below |
| linux/amd64 image | PASS | `antigravity-for-home-assistant:v2-final-local`; manifest-list digest `sha256:de1992f8c0df09a0b138a8c22659f68dc1e817079f6828149f68305df79ddb04` |
| amd64 saved image config | PASS | `sha256:89fbca725e87f93af8d93f136b520f9e99738882ba3db2d6dc5e8db0f4d38a2b` |
| amd64 image smoke | PASS | full Docker, browser-approval, feedback, memory, managed-auth, managed-plugin, update, user-files와 당시의 폐기된 Telegram isolation; 2.0.7 shared-context 증거가 아님 |
| linux/arm64 image | PASS (QEMU) | `antigravity-for-home-assistant:v2-final-local-arm64`; manifest-list digest `sha256:3cac3dcc76ba9d1410d3aac2369431a0568841f340f6b9748824b307cbd087df`; saved image config `sha256:1b63cf5afb9fb104426f94a1bdc9d6c3822c5fcc274a35515ee1d08fca17d82a`; packaging, 당시의 폐기된 HOME/rules/MCP isolation과 container-replacement update preservation PASS |
| Retired Telegram isolation | PASS (historical) | amd64와 QEMU arm64 actual 1.1.11에서 당시 HOME별 marker 음성 및 managed MCP/rules tamper fail-closed; 2.0.7은 shared-context positive canary로 재검증 필요 |
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
| amd64 full runtime | PASS | Antigravity 1.1.11, Docker, feedback, browser approval, memory, managed auth와 당시의 폐기된 Telegram isolation smoke; 2.0.7 수용 증거가 아님 |
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
| AG-001 | `--version` | 정확히 `1.1.13` |
| AG-002 | help snapshot | 필수 flags/subcommands 일치, 금지 Codex 호출 없음 |
| AG-003 | wrapper argv | 사용자 argv 보존, native sandbox flag 미주입, enable/disable/assignment 형태 거부 |
| AG-004 | settings merge | managed key 갱신, unknown/user key byte-semantic 보존 |
| AG-005 | plugin validation | source와 installed plugin이 공식 schema 통과 |
| AG-006 | duplicate plugin | global/staged/workspace 이름 충돌 시 fail closed |
| AG-007 | MCP discovery | `ha_change`, `telegram_action`, `ha_memory`, `ha_read`, `ha_validate`, `playwright` 여섯 managed server가 secret env 없이 발견 |
| AG-008 | OAuth persistence | login 후 restart/update에서 native session 보존 |
| AG-009 | print stdin | 값 없는 `--print` 없이 pipe된 prompt가 argv/log에 없고 stdin으로 처리 |
| AG-010 | stream parser | top-level `event`, init/progress/SUCCESS native free-text result, exact completed HA/action proposal receipt, optional bounded `toolAction`/`toolSummary`, kind-specific single-proposal empty-text fallback, conversation binding, typed terminal/headless-permission failures, invalid JSON, unknown event, size limit |
| AG-011 | headless permissions | effective `request-review` 하나, bounded-read/proposal-only settings와 AppArmor command 경계가 print mode에도 적용되고 `strict`/legacy autonomous option과 sandbox true/false가 보수적으로 정규화 |
| AG-012 | forbidden flags | skip-permissions와 Telegram override 거부 |
| AG-013 | Telegram customization inheritance | user global/workspace plugin·agent·rule·MCP를 Web/SSH와 동일하게 실행·노출; Telegram mutation은 exact action proposal, shared settings policy 상속, raw/protected settings/MCP-config write deny |
| AG-014 | runtime auto-update disabled | 모든 native launch가 opt-out을 강제하고 updater spawn·binary version/digest 변동이 없음 |

AG-009와 AG-010은 실제 고정 binary의 authenticated test account 또는 비밀 없는
recorded protocol fixture가 필요하다. fake binary만으로 최종 PASS하지 않는다.

AG-013의 2026-08-11 actual 1.1.11 control은 shared `/data/home`에서 user global stdio
MCP가 Google OAuth 인증 완료 전 launch됨을 재현했다. 2.0.7은 이 positive control을
의도된 관리자 채널 inheritance로 채택한다. global/workspace plugin·agent·rule·MCP
수정 canary, shared settings policy read canary와 `agy-settings patch` 일반 설정 수정
canary가 Web/SSH/Telegram에서 같은 결과를 내야 한다. raw `settings.json` write와
`permissions`, `enableTerminalSandbox`, `allowNonWorkspaceAccess`, `toolPermission`,
`artifactReviewPolicy` patch는 모두 거부되어야 한다. primary OAuth backend/path, 실제
로그인 뒤 credential 비유출과 HAOS AppArmor enforce는 아직 `NOT RUN`이다.

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
- 민감 exact deny 밖의 일반 `/config` YAML에 expected SHA, bounded preview, atomic
  backup/write, config check와 실패 시 exact restore/recheck를 검증
- activation 생략 시 `restart_required`; input_boolean/automation/script/scene reload API와
  input_boolean semantic memory verification을 각각 정확한 completion 범위로 검증
- live `/api/services` 기반 모든 domain/service, optional 단일/100개 entity,
  bounded/prototype-safe/redacted-but-digest-bound `service_data`, 단일 entity의 optional
  prior-state/fresh-result verify와 그 밖의 API-completion-only 보고
- `multi_choice_service_call`의 1/31개 boundary와 0/32개 거부, unique bounded
  `choice_id`/label/prompt/cancel, 모든 choice의 ordinary service-call validation, 한 live
  service registry snapshot, 전체 payload/digest binding과 선택한 하나의 execution
- choice가 authorize capability/execute/idempotency/status/result에 끝까지 결합되고
  missing/unknown/different choice, binary operation의 choice 주입과 같은 key의 다른
  선택 replay를 fail closed하는지 검증
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
- shell false, `--print` 없는 exact argv와 stdin prompt
- actual 1.1.13에서 user global/workspace plugin·agent·rule·MCP의 Web/SSH 동등 상속,
  shared native settings read, approved exact customization action positive canary.
  raw protected settings/MCP-config write는 negative canary
- per-chat FIFO, global concurrency, queue overflow, cancel와 timeout
- callback query ACK/기본 인증의 즉시 처리, approved broker/executor execution의 requester FIFO
  직렬화, execution-boundary generation/conversation/requester/digest 재검증
- validated update의 HKDF/AES-256-GCM sealed spool, plaintext/token canary 부재,
  fsync-before-transport-offset, ack ciphertext 삭제와 비순차 contiguous commit
- Bot API transport ack 뒤 process crash/restart replay, wrong-token/tamper fail-closed와
  sealed spool 128 records/2 MiB 경계
- NDJSON invalid/oversized/missing result/non-zero exit
- proposal receipt의 optional bounded `toolAction`/`toolSummary` 허용, unknown key/
  non-string/control/oversize 거부, 단일 유효 proposal+empty terminal text의 고정 fallback,
  proposal 없는 empty terminal text 거부
- exact `telegram_action_propose` receipt/coordinator revalidation, first-turn conversation
  rebind, terminal/script/question schema bounds와 sensitive-path/value/daemon deny,
  register 뒤 approval/card seal 전 crash의 사용자 재시도와 registration 비영속 경계
- `v4a`/`v4d`/`v4c`, 31 action choices+cancel 4×8 layout, encrypted action/opaque token,
  commit-before-executor, bounded output, sealed same-conversation continuation,
  committed replay no-respawn `in_doubt`, `/cancel` state boundary
- first-run pre-binding, worker/restart/idle 뒤 같은 conversation과 explicit `/new` rotation
- 유일한 effective `request-review`/bounded-read/proposal-only managed permission과 sensitive option 적용,
  `strict`/legacy autonomous option normalization, native sandbox flag 부재/override 거부,
  sandbox true/false 입력의 false 정규화, legacy Telegram mode 무시
- Telegram-enabled preserve가 safe legacy settings의 boundary key와 permission 세
  bucket만 transaction backup 뒤 canonicalize하고 unrelated settings/global MCP/OAuth를
  보존하며, ownership 유무와 두 번째 실행에서 같은 idempotent 결과를 내는지 검증
- unsafe effective permission은 shared validator에서 거부되고
  `permission_boundary_blocked` 한 건 뒤 Bot API call과 process exit 없이 live hold하는지
  검증
- Playwright upstream read-only 네 도구의 auto-allow와 navigate/back/tabs/hover/wait/
  resize/close fail-closed
- actual CLI print mode의 native permission/external resume 부재와 unsupported arbitrary
  plugin MCP side effect fail-closed
- bootstrap → runtime → command AppArmor policy, PATH shell/stdio MCP의 command 전환,
  command OAuth/settings/MCP-config/token deny와 일반 `/config`/network/helper positive path
- encrypted reply outbox의 pre-send fsync, chunk ack, 429 bounded retry,
  crash/network/timeout/5xx ambiguity 격리와 명시적 `/retry`, 최종 제거
- App-managed broker high-risk always-confirm matrix와 모든 broker
  `service_call`/`multi_choice_service_call`/`config_patch`의 durable human confirmation 강제
- 31 choice+cancel의 4×8 inline keyboard, `v3c`/`v3d` choice/dismiss와 legacy
  `v2a`/`v2d`, callback 64-byte 상한, encrypted opaque-token mapping, 선택의
  authorization-before persistence와 restart recovery/fail-closed 경계
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
| IM-010 | Telegram full component smoke with fake Bot API, shared permission validator와 `permission_boundary_blocked` no-API/no-exit hold |
| IM-011 | AppArmor policy compile/static profile coverage |
| IM-012 | preserve/refresh/reset/update/rollback 및 Telegram-enabled boundary reconciliation/idempotency fixture |

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

Candidate attempt는 하나의 atomic artifact set이다. Candidate job이 하나라도 실패하면
GitHub UI에서 **Re-run all jobs**만 사용한다. **Re-run failed jobs**는 지원하지 않으며,
consumer가 현재 run ID/attempt의 artifact만 받도록 해 이전 attempt의 성공 artifact와
새 attempt의 artifact를 섞는 경로를 의도적으로 fail closed한다.

실제 HAOS gate는 [release-evidence-template.json](release-evidence-template.json)의
`NOT_RUN`을 `PASS`로 글자만 바꿔서는 안 된다. exact candidate/source와 연결된
repository-scoped evidence URI와 content SHA-256이 여덟 gate 모두에 있어야 finalize가
통과한다. pre-finalize gate는 AppArmor enforce, amd64 same-local-identity
migration, aarch64 첫-release install/persistence, migration mode, shared runtime
persistence, updater canary, local migration rollback, Telegram session/outbox다. amd64
rehearsal은 공식 local testing `/addons/antigravity_home_assistant`에 exact public-v1
source를 build한 뒤 같은 directory/slug를 candidate App directory로 교체하는
`HA-007`이다. original custom repository의 public update/rollback `HA-005`가 아니다.
공유 identity/customization의 읽기·수정·재시작 계약은
`shared_runtime_persistence`, 명시적 `/new`·same-session approval·암호화 전달
ledger 계약은 `telegram_session_delivery` gate가 담당한다. 폐기된 별도 OAuth
격리와 Telegram 전용 mode는 release PASS 조건이 아니다.

Candidate artifact의 `haos-report-templates/`에는 exact candidate binding과 여덟 gate의
key/check set을 자동으로 채운 fail-closed authoring template이 들어 있다. 동일 결과는
다음 명령으로 재생성할 수 있다.

```bash
python3 .github/scripts/release_contract.py haos-report-templates \
  --candidate candidate.json \
  --output-dir haos-report-templates
```

생성물은 `status`와 모든 check가 `NOT_RUN`, 관찰 환경과 timestamp가 empty,
sanitization flag가 `true`, attestation이 `false`이므로 그대로 제출하면 반드시
실패한다. 각 장비의 실제 관찰을 working copy에 채운 뒤 `haos-report`로 로컬 검증하고
`HAOS evidence` workflow에 제출한다. `release-evidence-template.json`은 검증된 여덟
artifact의 URI/digest를 합치는 finalize 입력일 뿐 개별 report authoring template이
아니며 post-publish HA-005/HA-008 template과 혼용하지 않는다.

`HAOS evidence` workflow는 candidate run ID/attempt, gate와 sanitized report를 gate별로
별도 dispatch한다. exact candidate artifact/source와 report schema를 검증한 뒤
`format: "github_actions_zip"`인 고유 Actions artifact record를 낸다. finalize는 각
URI를 다운로드해 실제 archive byte SHA-256과 내부
source/digest/architecture/check set을 비교한다. 검증된 report는 canonical
`haos-gates/<gate>.json`으로 보존하고 각 JSON byte digest를
`release-evidence.json` 안의 `haos_gate_evidence`에 결합한다. template 원본은
release contract 검사에서 실패해야 한다. 이 검사는 evidence integrity와
candidate binding을 보장하지만 보고서 속 HAOS 관찰의 진실성은 maintainer
review라는 trusted-attestor 경계다.

artifact의 `retention-days`는 availability 상한일 뿐이며 GitHub REST API의 실제
`expires_at`이 authoritative deadline이다. Candidate finalize는 다음 중 가장 이른
시각 전에 끝나야 한다.

```text
min(candidate artifact expires_at,
    earliest gate artifact expires_at,
    oldest HAOS observed_at_utc + 30 days)
```

numeric tag 생성과 Builder 완료 deadline은 다음과 같다.

```text
min(candidate artifact expires_at,
    finalizer artifact expires_at,
    oldest embedded HAOS observed_at_utc + 30 days)
```

만료된 artifact를 재업로드하거나 서로 다른 run attempt를 섞거나 annotated tag를
이동하지 않는다. numeric tag를 만들기 전이면 **Re-run all jobs**로 새 Candidate를
만들어 여덟 gate와 finalize를 같은 atomic chain에서 다시 수행한다. numeric tag를
이미 만들었는데 chain을 복구할 수 없으면 그 tag를 재사용하지 않고 새 version에서
다시 시작한다.

numeric release 발행 후 original public repository의 metadata와 numeric prebuilt
image fresh install을 두 architecture에서 확인하는 `HA-008`을 수행한다. amd64에서는
같은 original repository/add-on identity의 public v1.0.4를 numeric v2로 update하고
rollback하는 `HA-005`를 별도로 수행한다. 두 post-publish acceptance를 finalize
입력으로 순환시키지 않는다. 별도 `Post-publish HA-005 acceptance`
(`.github/workflows/postpublish-ha005.yaml`)는 exact numeric v2 tag ref에서
`version`과 `report_json`만 받는다. tag-bound finalizer artifact와 GitHub Release의
byte-identical `release-evidence.json`, non-draft prerelease, anonymous public GHCR digest를
다시 검증한다. maintainer가 제출한 sanitized
`antigravity-ha-ha005-acceptance/v1` report가 계약을 통과하면 canonical
`ha005-acceptance.json`을
`ha005-acceptance-<version>-<source_sha>-<run_id>-<run_attempt>` Actions artifact와
fixed-name GitHub Release asset으로 보존한다. 기존 asset이 같은 byte면
resume하고 다르면 덮어쓰거나 Release body/state를 바꾸지 않고 실패한다.
이 workflow는 tag trailer가 결합한 finalizer Actions artifact를 다시
download하고 그 `release-evidence.json`을 durable GitHub Release asset과 byte별로
비교한다. finalizer artifact의 retention은 30일이므로 `HA-005`는 그 exact
artifact가 만료하기 전, 보통 publish 직후 dispatch한다. 이미 만료한
artifact를 새 report로 우회하지 않고 fail closed한다. 이 artifact
availability 창은 report 관찰 시각의 30일 freshness 계약과 별개다.
따라서 HA-005 dispatch의 effective deadline은
`min(finalizer artifact expiry, oldest embedded HAOS observed_at_utc + 30 days)`다.
post-publish `release_contract.py release` replay에서도 embedded pre-finalize HAOS
report의 freshness를 다시 검사하며, 어느 쪽이든 만료되면 freshness를 완화하거나
새 evidence로 우회하지 않고 의도적으로 fail closed한다.
운영자는 [HA-005 acceptance template](ha005-acceptance-template.json)를
`report_json`의 출발점으로 사용한다. 이 template은 exact top-level/nested key,
check, sanitization과 attestation 이름을 모두 포함하지만 fail-closed로
`status`/transition/check를 `NOT_RUN`, attestation을 `false`, sensitive-content
sanitization flag를 `true`, 관찰값을 empty string으로 둔다. 실제 관찰과
sanitization review 후 모든 placeholder를 교체한다. 변경하지 않은
template은 `release_contract.py ha005-report`가 거부한다.
실제 공개 release와 `HA-005` report는 없으므로 상태는 계속 `NOT RUN`이다.

`Post-publish public install acceptance` workflow는 exact numeric tag에서 sanitized
`antigravity-ha-public-install-acceptance/v1` report를 받는다. report 하나가 amd64와
aarch64의 original public repository fresh install, exact generic/leaf digest,
start/stop/restart와 data identity persistence를 모두 포함해야 하며 한 architecture라도
빠지면 실패한다. canonical `public-install-acceptance.json`은 고유 90일 Actions
artifact와 fixed-name GitHub Release asset에 create-once로 보존한다. 운영자는
[public install acceptance template](public-install-acceptance-template.json)의
`NOT_RUN`, empty observation, unsafe sanitization과 false attestation을 실제 관찰로
교체한다. 변경하지 않은 template은 `public-install-report`가 거부한다.

HA-008 dispatch deadline은 다음 중 가장 이른 시각이다.

```text
min(finalizer artifact expires_at,
    oldest embedded HAOS observed_at_utc + 30 days,
    oldest HA-008 installation observed_at_utc + 30 days)
```

전체 post-publish 수용에는 durable GitHub Release의 `ha005-acceptance.json`과
`public-install-acceptance.json`이 모두 필요하다. 실제 numeric release와 HA-008
report가 없으므로 상태는 계속 `NOT RUN`이다.

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
sibling stage, 실제 1.1.13 validation, activation 직후 SIGKILL restart recovery와
postcondition failure rollback을 검사한다. `tests/user-files-update-smoke.sh`는 managed
permission의 unknown user rule 보존을 Telegram 비활성 일반 merge에서 검사하고,
Telegram-enabled preserve에서는 permission boundary exact reconciliation, unrelated
top-level settings/global MCP 보존, backup·ownership·restart idempotency를 별도로
검사한다. ownership conflict의 preflight-before-write, settings/MCP/state transaction과
같은 state digest를 가진 missing-MCP transaction의 `prepared` SIGKILL recovery도
검사한다. 기존 local amd64 PASS는 새 2.0.12 fixture의 실행 결과가 아니므로 새 command
결과를 별도로 기록해야 한다. 실제 repaired-image HAOS update와 이전 image rollback은
`NOT RUN`이며 IM-012는 `PARTIAL`이다.

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
- 조회와 per-chat session continuation, explicit `/new` rotation
- global native permission 동등 적용과 same-session change confirmation/cancel/expiry
- 2.0.11 representative legacy permission drift를 가진 safe settings에서 Telegram을 켠
  `preserve` update가 boundary key만 canonicalize하고 unrelated settings/global MCP와
  OAuth를 보존한 뒤 `permission_boundary_ready`와 Bot API reconnect에 도달
- scoped synthetic unsafe boundary에서 `permission_boundary_blocked`가 한 번만 기록되고
  Bot API 요청과 Telegram service restart가 없으며, verified backup 복구와 App restart
  뒤 정상 연결
- `multi_choice_service_call`의 synthetic safe choices, 31-choice layout 경계,
  한 선택 실행과 다른 choice/double-tap/unknown-token 거부, legacy binary card 호환
- safe fixture entity `device_test`의 test+restore preview, human confirmation과 최종
  prior-state 복원. 실제 safety-critical entity는 사용하지 않음
- callback replay/cross-user negative test
- bridge restart 때 broker가 살아 있는 pending choice mapping 복구, App/broker restart
  때 미접수 proposal fail closed, 이미 접수된 execution의 durable status/result 회수,
  queue/capability 취소와 authorization 보존
- Bot API network interruption 뒤 duplicate mutation 없음
- `terminal_command`, `multi_choice_terminal`, `question` 실제 card/selection/result와
  command/script exact source, credential-free executor, commit-crash `in_doubt` no-respawn
- shared `/data/home`·`/config`에서 user global/workspace customization이 CLI와
  동일하게 로드되고 승인된 exact action으로만 수정되며 실제 OAuth canary가
  reply/log/network로 유출되지 않음

실제 high-risk device를 작동하지 않는다. broker dry-run과 synthetic policy operation으로
confirmation 강제를 검증한다.

### HA-005 — 지원되던 public v1 update와 rollback

numeric v2와 original custom repository metadata가 공개된 뒤, public v1.0.4가
지원한 amd64에서만 다음을 수행한다. v1.0.4는 aarch64 artifact를
제공하지 않았으므로 존재하지 않는 이전 aarch64 image의 update/rollback을 PASS로
기록하지 않는다.

1. original custom repository에서 public v1.0.4를 설치하고 repository ID/URL,
   add-on slug, source SHA, source-build image ID와 representative 사용자 상태를 기록
2. 같은 repository/add-on identity가 제공하는 numeric v2로 `preserve` update하고
   published generic/amd64 runtime digest와 `/data` identity 유지 확인
3. OAuth, SSH, browser identity, memory, `/config`와 사용자 settings 확인
4. 모든 native launch의 updater 미실행과 restart 전후 binary version/digest 불변 확인
5. Telegram-enabled safe legacy settings에서 mode를 `preserve`로 유지한 채 다섯 App
   관리 보안 key와 permission boundary를 exact reconcile하고 그 밖의 top-level
   settings/global MCP/OAuth를 보존하며
   재시작이 새 backup/write 없이 idempotent인지 확인
6. 복원된 별도 public-v1 fixture에서 `refresh_managed`의 1회성, `reset_v2`가 settings
   ownership state와 무관하게 safe parseable file을 backup한 뒤 managed key/permission
   bucket을 exact default로 복구하는지, `preserve`로 되돌리기 전 restart drift 복구와
   unsafe-file conflict를 확인
7. 기록한 public v1 source/image와 matching managed backup으로 rollback한 뒤
   repository/add-on/data identity와 recovery surface 확인

업데이트 직전 Supervisor가 source-build한 v1 image ID, source
`aba6805e8bf1f32e68976a67a46536c3ca362af8`와 설치 repository/ref를 기록한다. branch
suffix를 붙인 URL이나 temporary repository는 다른 Home Assistant repository
identity이므로 이 시험을 대체하지 못한다. v1 registry digest가 존재한다고
가정하지 않는다. `HA-005`는 post-publish acceptance이며 pre-finalize
evidence에 포함하지 않는다.

sanitized report의 `previous_release` record는 original repository URL,
`addon_slug: "antigravity_home_assistant"`,
`installation_source: "original_custom_repository_source_build"`, repository ID hash,
data identity hash와 local image ID를 강제한다. repository/add-on/data identity는
previous/update/rollback에서 같아야 한다. update는 exact published generic·amd64
digest와 numeric v2를, rollback은 public v1 source SHA, source-build image ID,
matching managed backup과 최종 App `1.0.4`를 강제한다.
architecture는 `amd64`만 허용하고 observation은 Release publish 시각 후여야
하며, report 제출 시점에 관찰 시각이 30일보다 오래되지 않아야 한다.
branch/temporary repository identity와 aarch64 `HA-005`는 validation을 통과할
수 없다.

`repository_id_sha256`는 update 전 기록한 stable Supervisor repository ID의 exact
byte를, `data_identity_sha256`는 `/data`에 미리 둔 dedicated identity sentinel을
SHA-256한 값이며 report에는 hash만 남긴다. `local_image_id`는 v1 registry
digest가 아니라 Supervisor/Docker가 생성한 exact source-build image ID다. 세
값은 모두 `sha256:<64 lowercase hex>` 형식이고 서로 달라야 하며, update와
rollback은 기록한 repository/data digest를 동일하게 제출한다.

### HA-006 — 첫 aarch64 release install과 persistence

public v1이 없었던 aarch64에서는 candidate bundle의 App directory를
공식 local testing `/addons/antigravity_home_assistant`에 배치해 다음을 실행한다.

1. bundle manifest/archive hash, prerelease version과 exact candidate digest 확인
2. clean install과 App start/stop/restart
3. Ingress/SSH, native plugin, HA read/memory/browser와 AppArmor enforce 확인
4. OAuth, SSH host key, browser identity, memory, `/config`와 user settings의 restart 보존

첫 release에서는 이전 numeric aarch64 image rollback을 완료로 주장하지 않는다. 실제
numeric rollback gate는 다음 aarch64 release부터 추가한다.

### HA-007 — amd64 same-local-identity migration rehearsal

numeric publish 전에 공식 Home Assistant local testing 경로로 candidate migration을
연습한다.

1. exact public v1.0.4 tag source를 `/addons/antigravity_home_assistant`에 배치해
   source-build install하고 source SHA, image ID, local repository ID와 add-on slug 기록
2. 같은 directory/slug의 content만 candidate bundle App directory로 교체하고
   local repository를 refresh해 exact prerelease version으로 update
3. update 전후 local repository/add-on/data identity와 observed candidate digest 확인
4. Telegram-enabled `preserve`의 boundary-only reconciliation, unrelated settings/global
   MCP/OAuth 보존과 restart idempotency를 확인하고, 별도 fixture에서
   `refresh_managed`, ownership state 없는 safe settings의 `reset_v2` exact recovery,
   같은-version restart drift 복구와 unsafe-file conflict 확인
5. migration 중 강제 종료/recovery와 기록한 v1 source-build image/managed backup으로
   local migration rollback을 수행한다. rollback report의 installed App postcondition은
   `1.0.4`다.
6. OAuth, SSH, browser identity, memory, `/config`와 사용자 settings 보존,
   모든 native launch의 updater 미실행 확인

이 시험은 exact public-v1 source와 candidate code의 migration 호환성을 실제 HAOS에서
검증하지만 repository identity는 `local`이다. original custom repository의 public
update/rollback 수용인 `HA-005`로 기록하지 않는다.
세 local migration gate의 `previous_release` record는 exact v1 source/image ID와
`installation_source: "local_addons_source_build"`,
`repository_identity: "same_local_repository_identity"`를 강제한다.
HA-007의 OAuth/native-updater 보존은 `haos_amd64_local_migration` report 내
dedicated check로 입증한다. 양 arch cross-cutting OAuth/updater report에는
`previous_release`가 없으므로 그 report 자체가 HA-007을 claim하지 않는다.

### HA-008 — post-publish public repository fresh install

numeric prerelease 발행 후 original custom repository를 실제 HAOS amd64와 aarch64에
각각 등록하거나 refresh하고 다음을 수행한다.

1. 설치 전에 App과 local Candidate repository가 없음을 확인
2. repository metadata에서 exact numeric version 확인
3. source build가 아닌 published prebuilt image로 fresh install
4. observed generic/architecture runtime digest가 Release evidence와 일치함을 확인
5. App start/stop/restart와 Supervisor health 확인
6. restart 뒤 dedicated data identity가 보존되고 AppArmor가 enforce임을 확인

두 architecture record를 하나의 sanitized report에 결합한다. HA-008은 pre-publish
HA-006/HA-007 또는 amd64 update/rollback HA-005를 대체하지 않으며 Candidate의 여덟
manual gate에도 들어가지 않는다. 각 record의
`data_identity_before_restart_sha256`와
`data_identity_after_restart_sha256`는 동일해야 하며, repository identity hash와는
달라야 한다. 각 장비에는 hardware/host identifier가 아닌 별도의 random identity
sentinel을 사용하며 두 architecture의 data identity hash도 서로 달라야 한다. 따라서
persistence나 독립 설치 check의 `PASS` 선언만으로는 validation을 통과할 수 없다.

## AA-001 — AppArmor 검증

실제 HAOS에서 각 top-level named `Px` 실행 프로필로 positive와 negative test를
수행한다.

Positive:

- interactive worker의 일반 `/config` YAML read/write
- option `true` interactive sensitive-read `Px` 프로필의 Recorder DB read-only
- broker의 scoped atomic config transaction
- memory profile의 DB access
- browser의 `/run` profile과 loopback gateway
- SSH/ttyd와 native OAuth 자료의 필요한 접근
- Telegram Antigravity worker의 native OAuth login/session 접근

Negative:

- option `false` interactive-runtime-restricted `Px` 프로필의 `secrets.yaml`, `.storage`,
  Recorder DB read/write
- 두 interactive runtime profile 모두에서 `secrets.yaml`, `.storage` read/write 거부
- option `true` interactive-runtime-sensitive-read `Px` 프로필의 Recorder DB
  write/rename/truncate/delete 거부
- browser/memory/broker의 secrets/storage/Recorder read/write를 두 option 값에서 모두 거부하고
  Web/SSH/Telegram Antigravity에는 같은 option profile 적용
- 모든 profile의 SSH key, App token, backup, SSL과 App이 관리하는 표준 cloud-auth
  경로 접근을 두 option 값에서 모두 거부
- browser의 `/config`, `/data`, Supervisor endpoint
- memory의 OAuth/Telegram/SSH/browser credential
- 모든 unprivileged child의 capability directory와 host paths
- ordinary SSH/SFTP/ttyd shell의 `/data/home/.gemini/**` 접근과 main/shell/interactive/
  helper/broker profile의 다른 PID `environ`, `cmdline`, `mem`, `fd`, `root`, `map_files` 우회

Web/SSH/Telegram Antigravity process는 native Home/session과 사용자 customization을
위해 `/data/home/**`와 `/config`에 접근한다. primary OAuth credential backend와 exact path가 아직
검증되지 않았으므로 특정 `.gemini` 경로를 OAuth 필수 경로로 가정해 AppArmor deny
시험을 설계하지 않는다. 대신 credential canary를 두고 native permission과
bootstrap/runtime/command 경계가 spawned command/stdio MCP의 임의 file-read 유도를
차단하는지, 원문이 model output, Telegram reply, log와 artifact에 없는지를 별도
negative test한다. native sandbox는 비특권 container에서 namespace EPERM을 재현하고
App runtime argv에는 없어야 한다. AppArmor가 같은 process 안의 정상 인증 read와
유도된 built-in read를 구분하지 못하는 잔여 위험을
release evidence에 기록하지 않으면 PASS가 아니다.

Telegram에서 실행한 Antigravity에 임의 user global stdio MCP와 workspace agent/rule canary를
구성하고 인증 전후 discovery 및 수정 결과가 Web/SSH와 같아야 한다. custom MCP child도
command profile로 전환되어 OAuth, settings, MCP config, Supervisor credential과
coordinator capability가 계속 deny되어야 한다. shared Home은 credential isolation
PASS로 표현하지 않는다. 사용자가 global plugin/MCP config에 inline한 credential은
신뢰된 확장 컨텍스트이므로 자동 redaction 보장으로 주장하지 않고, fixture에는 실제
secret 대신 sentinel만 사용한다.

예상 deny는 test case와 일치해야 한다. 예상하지 않은 `DENIED`와 release run의
`ALLOWED` complain event가 있으면 PASS가 아니다.

두 option 값 모두 `aa-status`와 Supervisor 상태에서 custom profile이 enforce여야
한다. option 전환은 interactive top-level named `Px` 실행 프로필 이름만 바꾸며
AppArmor detach, complain 전환 또는 root/다른 실행 프로필 권한 변경을 일으키면
실패다.

## 9. 성능과 내구성

- 일반 CI는 2 global workers, chat별 queue 4, bounded queue/cancel, backoff recovery,
  1,000 entity와 긴 로그의 bounded output을 짧고 결정론적인 fixture로 검사한다.
- 30분 soak, 15분 동시 장애, broker/candidate restart 20회와 장시간 resource 측정은
  누수나 복구 회귀가 의심될 때만 수동으로 수행한다.
- 장시간 결과는 진단 및 budget 기준 수립 자료이며 Candidate, finalize, Builder,
  numeric tag 또는 post-publish release의 필수 gate가 아니다.
- 실제 HAOS에서의 장시간 운용, live Bot API network interruption, Supervisor/Core
  reconnect와 App 재시작 내구성은 별도 실기기 검증으로 남긴다.

고정 budget은 [performance-budget.json](performance-budget.json)의 기계 판독 가능한
값을 사용한다. 기준은 SHA-256
`b2cb64cac2c5f12c61d4a779c06a4bca1307799e485086d9512974e231d51d09`인 첫 30분
baseline evidence다. 이 측정의 image 558,690,739 bytes, host component peak RSS
104,890,368 bytes, candidate idle 약 47,815,066 bytes와 idle CPU 0.00%를 근거로
image 600,000,000 bytes, candidate cgroup peak RSS 201,326,592 bytes, 평균 CPU 5.0%를
수동 진단 상한으로 고정했다. image에는 약 7.4% 증가 여유를, RSS에는 baseline component peak의
약 1.9배를 부여하며, CPU 상한은 baseline의 낮은 부하보다 충분히 크지만 runaway를
탐지한다. budget 파일의 limit 또는 baseline digest가 빠지거나 달라지거나 측정값이
상한을 넘으면 수동 harness는 nonzero로 끝나며 `closure_eligible: false`인 실패
증거만 남긴다. 이 실패 자체는 자동 release blocker가 아니다.

image size는 Docker daemon의 backend별 `.Size` 값이 아니라 exact runtime leaf OCI
manifest의 config descriptor와 모든 compressed layer descriptor `size` 합으로
측정한다. harness는 raw manifest bytes의 SHA-256이 candidate runtime leaf digest와
같은지 먼저 검증한다. 따라서 containerd/classic image store가 각각 압축·비압축 크기를
보고하는 차이로 budget 결과가 바뀌지 않는다.

`tests/performance-durability-soak.sh`는 두 모드를 명시적으로 분리한다. 기본
`--mode contract`는 CI에서 2초 soak, 1초 동시 장애와 broker 3회 restart로 fixture와
증거 schema만 검사하며 JSON의 `closure_eligible`은 항상 `false`다. 이 결과로
GAP-007을 닫지 않는다. 외부 HA나 Bot API는 호출하지 않으며 browser 장애도
loopback fixture로 제한한다.

장시간 진단이 필요하면 조사할 exact image를 대상으로 다음 opt-in 명령을 운영자가
직접 실행한다. CLI의 `release` mode 이름은 기존 full-duration evidence 형식을 유지하기
위한 것이며 자동 release gate를 뜻하지 않는다.

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
component PASS와 candidate restart PASS가 모두 있어야 기존 evidence schema의
`closure_eligible: true`가 되지만, 이 값은 release 진행 권한이나 자동 gate PASS를
뜻하지 않는다. 또한 실제 HAOS와 live Bot 검증을 대신하지 않는다.

위 baseline run은 candidate revision label이 없고 host source workload를 사용했으므로
budget 수립 입력일 뿐 GAP-007 해제 증거가 아니다. 별도의 source-bound candidate
release run은 source `ae8b0bc4fdd042bdb84c55a1767d619d9adc734f`, source-rootfs
`sha256:22b435eb960bf5e47ba0d888b59e6a83087e76afc2b13a557b455fad8b49e8ed`에서
1,800초 soak, 900초 장애 주입, broker/candidate restart 20회와 고정 budget을 PASS했다.
sanitized evidence SHA-256은
`2c2b3fe0cb0aa2522722e192323bdb0e0a291f5d99193df603eace003dc7f8f9`이며 local
historical result로만 유지한다. 원본 evidence bytes/immutable URI가 보존돼 있지
않고 현재 source/runtime이 다르므로 GAP-007을 닫지 않는다. 같은 장시간 검사를
current Candidate마다 되풀이할 의무는 없다. 실제 HAOS와 live Bot API는 여전히 별도
실기기 검증이다.

공식 Candidate와 release workflow는 이 30분 mode를 자동 실행하지 않으며
`gap007-release.json`, `gap007_release` binding 또는 장시간 PASS를 입력·artifact·tag
계약으로 요구하지 않는다. 수동 진단이 명시적으로 요청된 경우에만 exact image와
source에 묶인 evidence를 별도로 보존한다. 수동 harness에서 candidate image는 stopped
container의 `docker export`를 host Python으로 읽어 embedded manifest aggregate와 각
regular root-owned entry의 normalized mode/size/SHA-256를 image binary와 독립적으로
검증한다. build context는 manifest entry와 manifest 자체 외 rootfs file을 거부하므로
Git-ignored canary도 COPY될 수 없다. `source-rootfs-manifest.py create`는 같은 manifest에서
부모 디렉터리 traversal과 각 file만 열어 주는 `.dockerignore`를 함께 생성하고, `verify`는
allowlist drift와 wildcard 추가를 fail closed한다. 따라서 ignored/unmanifested rootfs
비밀은 Docker daemon으로 context가 전송되기 전에 client allowlist에서 제외되며,
Dockerfile의 manifest/count/digest 검사는 그 다음 독립 방어선이다. 이 검증은 수동
결과의 신뢰 경계이며, 해당 장시간 evidence가 없다는 이유로 numeric image tag 생성을
막지 않는다.

수동 harness는 시작과 종료 모두 repository 전체가 clean인지 확인하고 HEAD가 image
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
| FR-001 | ST-002, ST-005, ST-008, IM-001, IM-002, IM-003, IM-011, HA-001, HA-008, AA-001 |
| FR-002 | AG-001, AG-002, AG-003, AG-004, AG-005, AG-006, AG-007, AG-008, AG-009, AG-010, AG-011, AG-012, AG-013, AG-014, IM-002, HA-001 |
| FR-003 | ST-008, IM-003, IM-004, IM-005, HA-001 |
| FR-004 | AG-005, AG-006, AG-007, IM-006, IM-007, IM-008, IM-009, IM-010, HA-002 |
| FR-005 | IM-008, HA-002 |
| FR-006 | IM-009, HA-003 |
| FR-007 | AG-013, IM-010, HA-004 |
| FR-008 | AG-013, ST-007, IM-007, IM-009, IM-010, IM-011, AA-001 |
| SEC-001 | AG-013, ST-007, IM-007, IM-010, IM-011, AA-001 |
| SEC-002 | AG-013, ST-007, IM-007, IM-008, IM-009, IM-010, IM-011, AA-001 |
| SEC-003 | AG-009, AG-012, AG-013, IM-007, IM-010, IM-011, IM-012, AA-001, HA-004, HA-005, HA-006, HA-007 |
| SEC-004 | ST-002, IM-011, AA-001 |
| SEC-005 | AG-007, AG-013, IM-006, IM-007, IM-009, IM-010, AA-001 |
| SEC-006 | ST-007, IM-011, AA-001 |
| SEC-007 | IM-007, IM-010, HA-002, HA-004 |
| SEC-008 | AG-009, AG-012, AG-013, IM-010, IM-011, HA-004, AA-001 |
| SEC-009 | IM-009, IM-011, HA-003, AA-001 |
| SEC-010 | ST-007, IM-008, HA-002 |
| SEC-011 | ST-007, IM-007, IM-009, IM-010, HA-004 |
| SEC-012 | AG-013, ST-007, IM-007, IM-009, IM-010, IM-011, IM-012, AA-001, HA-004, HA-005, HA-006, HA-007 |
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
| MIG-002 | ST-007, IM-012, HA-005, HA-007 |
| MIG-003 | IM-012, HA-005, HA-007 |
| MIG-004 | IM-012, HA-005, HA-007 |
| MIG-005 | ST-001, ST-009, IM-012, HA-005, HA-007 |
| MIG-006 | IM-008, IM-012, HA-002, HA-005, HA-007 |
| MIG-007 | IM-012, HA-005, HA-007 |
| MIG-008 | AG-014, ST-005, IM-001, IM-002, HA-001, HA-006 |
| MIG-009 | AG-014, ST-001, ST-002, ST-003, ST-004, ST-005, ST-006, ST-007, ST-008, ST-009, ST-010, IM-001, IM-002, IM-003, IM-004, IM-005, IM-006, IM-007, IM-008, IM-009, IM-010, IM-011, IM-012, HA-006, HA-007, AA-001 |
| MIG-010 | AG-014, ST-010, IM-001, IM-002, IM-003, IM-004, IM-005, IM-006, IM-007, IM-008, IM-009, IM-010, IM-011, IM-012, HA-001, HA-002, HA-003, HA-004, HA-005, HA-006, HA-007, HA-008, AA-001 |
| MIG-011 | ST-010 |
