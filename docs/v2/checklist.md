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
- 2.1.0 native 기본값은 `request-review`이며 mutation을 ask/proposal-first로 보낸다.
  explicit `always-proceed`는 mandatory blacklist 밖의 ordinary operational
  command/URL, installed MCP와 Playwright interaction을 autonomous-admin으로
  허용한다. `strict`와 `proceed-in-sandbox`만 legacy upgrade 입력으로
  `request-review`에 정규화한다. AppArmor mandatory deny와 App-managed broker의
  high-risk 판정은 option으로 완화하지 않는다. native
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
- `request-review` Telegram Playwright auto-allow는 upstream read-only 네 도구뿐이다. navigate/back,
  tabs, hover, wait, resize, close는 typed adapter 전까지 fail closed한다.
  explicit `always-proceed`는 current request의 installed Playwright interaction을 허용한다.
- proposal registration은 approval/card sealing 전에는 crash-durable하지 않다. 이
  구간의 bridge crash는 사용자 재시도를 요구한다.
- GAP-007의 장시간 성능·내구성 진단은 수동 advisory이며 Candidate, finalize,
  tag 또는 release를 차단하지 않는다.
- Web/SSH/Telegram Antigravity는 `/data/home`, `/config`, OAuth, user global/workspace
  plugin·agent·rule·MCP와 native permission을 공유한다. 실제 1.1.11 shared-HOME
  positive control의 global MCP launch는 2.0.7의 필수 inheritance 증거다. 실제 HAOS
  OAuth/AppArmor enforce와 동일-process 비유출 시험은 별도 기록한다.
- raw native file read/write는 symlink alias 우회를 막기 위해 두 mode 모두 전역
  deny한다. ordinary file 작업은 confined `ha_files` MCP의 `ha_files_list`,
  `ha_files_read_text`, `ha_files_write_text`만 사용하고 `/config`, `/share`, `/media`,
  ordinary `/data/home`, `/tmp`, `/var/tmp` root와 UTF-8 1 MiB·listing 200개 상한을
  적용한다. secrets/.storage/.gemini/credential/policy/Recorder-write,
  symlink/hardlink/TOCTOU를 fail closed한다.
  App 관리 `settings.json`과 native MCP config는 직접 read/mutation exact deny다.
  interactive Web/SSH의 일반 전역 setting은 digest-bound `agy-settings patch`로 매개 수정할 수 있지만
  `permissions`, `enableTerminalSandbox`, `allowNonWorkspaceAccess`, `toolPermission`,
  `artifactReviewPolicy`는 거부한다. global plugin·agent·rule·skill은 계속 공유·직접
  공유한다. Telegram customization mutation은 approved exact terminal/script proposal로만
  실행하고 user-configured MCP executable은 AppArmor command profile에서 실행한다.
- Telegram은 최초 실행 전에 conversation을 결합하고 healthy session은 `/new` 전까지
  유지한다. native worker terminal failure는 failed conversation을 quarantine하고
  update를 durable ACK한 뒤 다음 user request에 새 generation을 결합하며 failed
  mutation을 replay하지 않는다. same-session approval과 암호화 reply outbox의
  retry/ack를 보장한다.
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
- 2026-08-18 실제 HAOS 18.2 amd64에서 public 2.0.11→2.0.12 `preserve` update,
  automatic reconciliation, live Bot API reconnect·delivery와 App restart/reconnect는
  `PASS`했다. unrelated settings/global MCP/OAuth 보존과 unsafe-boundary no-restart
  hold는 `NOT RUN`이므로 M5/M6 또는 release gate를 `VERIFIED`로 올리지 않는다.
- 같은 현장 보고의 custom AppArmor attach는 `docker-default (enforce)`가 관찰되어
  `FAIL`했다. aarch64 실기기는 장비 부재로 `NOT RUN`이며 소유자가 experimental
  배포에서만 면제했다. 이 면제는 architecture 또는 AA-001 PASS가 아니다.

### 2026-08-18 2.0.13 AppArmor loader 호환성 경계

- 2.0.12의 column-0 `profile` 선언 23개는 Supervisor 2026.07.5가 요구하는 single
  primary 선언 계약을 위반해 custom policy 설치가 거부됐다.
- 2.0.13 source는 slug primary만 column 0에 두고 나머지 22개 독립 global profile
  선언을 들여쓴다. AppArmor parser의 23개 이름, `Px transition`과 deny 의미는
  유지하며 nested subprofile로 바꾸지 않는다.
- 공개 2.0.13의 실제 HAOS amd64 업데이트에서는 새 컨테이너가 `/run/s6`와
  `/run/service`를 만들지 못하고 `s6-overlay-suexec` exit 111로 종료되어
  AppArmor/S6 startup이 `FAIL`했다. 앞선 Telegram metrics는 이전 컨테이너의 정상
  기록이며 이 startup 결함을 Telegram 실패로 분류하지 않는다.
- 2.0.14는 S6 runtime entry·container exit result와 nginx PID의 exact access를
  복구했지만 실제 HAOS 최초 기동은 아래의 resolved Bashio denial로 `FAIL`했다.
  공개 2.0.15도 아래의 PTY 접근 누락으로 `FAIL`했고 2.0.16은 native `file_mmap`
  거부와 SIGSEGV/status 139, 2.0.17은 managed MCP module read 거부로 `FAIL`했다.
  2.0.18 최초 기동·stop/start·restart와 AA-001 positive/negative matrix를 완료하기 전
  AppArmor milestone을 `VERIFIED`로 올리지 않는다.

### 2026-08-19 2.0.14 Bashio execute 회귀와 2.0.15 init trace 경계

- 공개 2.0.14의 실제 HAOS 18.2 amd64 startup은 S6 service graph까지 진행했지만
  `/usr/bin/bashio`의 resolved target `/usr/lib/bashio/bashio` 실행이 거부되어
  `antigravity-ha-init`이 exit 126으로 `FAIL`했다. init의 `/command/with-contenv`도
  실제 `/package/admin/s6-overlay-3.2.2.0/command/with-contenv` target에 exact execute가
  필요하다.
- 2.0.15는 관찰된 Bashio denial만 완화하지 않고 전체 cold-start trace-derived closure를
  profile별로 적용한다. resolved Bashio/S6/execline/Bash, Telegram pause, shell
  `utempter`, Chromium child의 exact execute, interpreted Playwright wrapper/runtime 및 traced
  font/config metadata read와 init 계정/nginx, SSH OOM/accounting, feedback report subtree,
  fontconfig cache의 narrow mutation만 허용한다. 새로운 `/usr/lib/**`와
  `/package/admin/**` 전체 execute, `/etc/**` 전체 write는 추가하지 않고 기존
  credential·민감정보 deny를 유지한다.
- `Kernel-enforced AppArmor startup smoke`는 실제 custom profile을 exact image에
  attach하여 PID 1 enforce, full S6 init, cold start, 동일 data의 fresh-container
  restart, S6 mkdir/exec fatal 부재와 안전하게 준비한 `/config/secrets.yaml`
  read-denial canary를 검사한다. 일반 CI amd64와 Candidate exact-digest native
  amd64/aarch64에서 필수지만 HAOS 증거는 아니다.
- 2.0.15 실제 HAOS에서는 service graph와 Ingress HTTP/WebSocket은 시작됐지만 ttyd
  PTY 생성이 EACCES로 실패했다. 따라서 2.0.15 AppArmor/Web terminal 수용은 `FAIL`이다.

### 2026-08-19 2.0.15 PTY·Telegram 회귀와 2.0.16 교정

- 공개 2.0.15의 실제 HAOS 18.2 amd64에서 Ingress `/`와 `/token`은 HTTP 200,
  `/ws`는 101이었지만 `pty_spawn: 13 (Permission denied)` 뒤 ttyd가 반복 재시작됐다.
  이는 client reconnect나 Ingress transport 장애가 아니라 primary AppArmor profile의
  `/dev/ptmx` 접근 누락이다.
- 같은 시작에서 safe parseable settings의 `permissions.ask`가 문자열 배열이 아니자
  `refresh_managed`가 Telegram-safe canonical replacement 전에 merge validation을
  중단했다. bridge는 Bot API 접촉 없이 `permission_boundary_blocked` hold를 유지했으므로
  transport 장애가 아니며 fail-closed 자체는 정상이다.
- 2.0.16은 primary profile에 exact `/dev/ptmx rw`만 추가하고, 지원되는 안전한
  settings에서는 allow/ask/deny 세 managed bucket을 typed merge 검증 전에 exact
  29/0/33 policy로 교체한다. symlink·hardlink·non-root owner·크기 초과·invalid JSON
  negative boundary와 unrelated settings/global MCP/plugin/OAuth/`/config` 보존은 유지한다.
- 정적·container 수용은 enforced primary profile에서 실제 PTY 생성·입출력·재접속과
  malformed allow/ask/deny 각각의 reconciliation/idempotency를 검사해야 한다.
  2.0.16 실제 HAOS 최초 기동·stop/start·restart, terminal reconnect와 Telegram
  worker는 native SIGSEGV/status 139 때문에 `FAIL`이다. aarch64 owner waiver는 PASS가
  아니며 전체 v2 수용은 `PARTIAL`로 유지한다.

### 2026-08-19 2.0.16 native mmap 회귀와 2.0.17 교정

- 공개 2.0.16 실제 HAOS 18.2 amd64에서는 App service graph, Ingress/Web terminal,
  Telegram `permission_boundary_ready`와 Bot API 연결까지 성공했다. 그러나 `agy`와
  `antigravity --version`은 `Segmentation fault`/status 139로 즉시 종료됐고, 모든
  Telegram 요청은 `session_ready` 뒤 같은 native worker crash로 실패했다. `/new`와
  reconnect는 원인 경계를 바꾸지 않는다.
- exact public 2.0.16 image를 project custom AppArmor profile 아래에서 재현한 kernel
  audit는 `interactive-runtime-restricted`의 exact `/usr/local/libexec/antigravity-real`
  rule에서 `file_mmap` permission `m` 거부를 확인했고 sensitive-read에는 동일한
  `r`-only rule이 있었다. 두 rule의 `r`을 `rm`으로 바꾸고 full blank-auth trace-derived bootstrap
  nsswitch/passwd identity read와 runtime `/usr/share/ca-certificates/**` TLS trust-store
  read를 두 transition chain에만 추가하면 local kernel-enforced
  `antigravity --version`이 status 0이고 blank-auth worker가 trust store에 도달한다.
  새로운 broad `/etc/**`·`/usr/share/**` rule은 추가하지 않고, runtime의 기존
  `/etc/** r`와 필수 system-library mapping 및 proc/settings/credential deny는 바꾸지 않는다.
- 2.0.17 수용은 두 runtime profile 모두의 exact `rm` rule, exact bootstrap identity/TLS
  trust-store closure, 새 broad rule 부재,
  proc/settings deny canary 보존, actual native `--version` status 0과 Telegram의 bounded
  SIGSEGV signal 진단을 검사한다. automated Linux-container result는 HAOS 증거가 아니다.
  실제 HAOS 18.2 amd64에서는 최초 기동, Web terminal, native 기본 대화, Telegram
  transport와 도구 없는 답변이 `PASS`했지만 아래 managed MCP·승인 경로가 `FAIL`했다.
- 2.0.12는 자동·무손실 rollback이 아니다. custom profile attach `FAIL`, amd64
  `docker-default`의 좁은 현장 PASS, aarch64 `NOT RUN`만 존재한다. Supervisor direct
  downgrade는 지원되지 않고 exact 2.0.12 App backup 복원은 backup 이후 `/data` 상태를
  잃는다. backup이 없으면 uninstall/Docker 조작을 하지 않으며, current `/data`를
  보존하는 higher-version security-degraded compatibility patch도 `NOT RUN` contingency다.

### 2026-08-19 2.0.17 managed MCP·Telegram 승인 회귀와 2.0.18 교정

- 공개 2.0.17 실제 HAOS 18.2 amd64에서 App startup, Ingress/Web terminal, native CLI와
  기본 대화, Telegram transport, 도구 없는 한 줄 응답은 `PASS`했다. 단일 managed MCP
  요청과 `telegram_action_propose` 승인카드 요청은 모두 `FAIL`했고, 승인된 쓰기는
  카드 생성 전 중단되어 `NOT RUN`이다. 따라서 2.0.17 전체 수용은 `FAIL`이다.
- kernel audit는 `change-proposal-client`가 exact image-owned
  `/usr/local/share/antigravity-ha/supervisor-credential-fd.mjs` 전이 module을 읽지 못한
  AppArmor denial을 반복 기록했다. 2.0.18은 이 client에 해당 exact module read만
  허용하고 directory-wide application-library read를 열지 않는다.
- restricted와 sensitive-read 두 confined launcher는 proposal에 필요한 requester/run
  binding 다섯 값을 모두 정리해 버렸다. 2.0.18은 다섯 값이 전부 있거나 전부 없는
  상태만 허용하고, 일부 binding은 시작 전에 거부하며 완전한 binding만 함께 전달한다.
  direct unapproved write/command 차단과 기존 민감정보 deny는 바꾸지 않는다.
- source/container 회귀는 exact module rule, broad 대체 rule 부재, 두 launcher의 complete
  binding 전달·partial binding 거부와 proposal coordinator를 검사하지만 HAOS 증거가
  아니다. 2.0.18 amd64 최초 기동·read MCP·승인카드·승인된 bounded write와 aarch64
  실기기 수용은 릴리스 전 `NOT RUN`이며 전체 v2 수용은 `PARTIAL`이다.
- main push memory smoke에서 daemon bootstrap과 `ha-memory status`가 겹친 직후
  transient SQLite `-shm`을 `multiple hard links`로 보고한 1건이 있었다. CI 원문은
  실제 link count를 남기지 않았지만, 별도 Linux stress에서 같은 unlink 경합의
  `nlink == 0`을 재현했다. 2.0.18은 auxiliary file의 zero-link snapshot만 정상 소멸로
  취급하고 DB 본체, symlink, owner/mode 위반과 `nlink > 1`은 계속 거부한다.
  zero-link와 two-link 양방향 회귀를 모두 통과해야 Candidate로 진행한다.

### 2026-08-19 공개 2.0.18 실기기 결과와 2.1.0 breaking 교정

- 실제 공개 2.0.18 HAOS amd64는 App startup, native `antigravity --version` status 0,
  Telegram transport와 no-tool chat을 `PASS`했다. Web `agy`/`antigravity` interactive
  I/O와 첫 managed Telegram tool은 `FAIL`했고 current audit는 `/dev/pts/0`
  inherited/open `rw` denial을 기록한다. 후속 3~7은 failed conversation reuse라 각
  tool의 독립 결과가 아니며 approved write는 `NOT RUN`이다. 2.0.18 수용은 `FAIL`이다.
- 2.1.0은 `/config`, `/share`, `/media`, ordinary HOME/temp, system command, installed
  MCP, supported Core/Supervisor manager API와 sanitized bounded logs에 operational
  default-allow를 적용한다. raw Host logs는 제공하지 않고 exact token/known
  credential-shaped line/block을 제거하지만 arbitrary unkeyed text의 완전한 secret
  판별을 주장하지 않는다.
- native raw file read/write는 전역 deny하고 ordinary file은 confined `ha_files` MCP로
  `ha_files_list`/`ha_files_read_text`/`ha_files_write_text`만 사용한다. ordinary root,
  UTF-8 1 MiB·listing 200개, atomic write/optional digest를 강제하고
  secrets/storage/.gemini/credential/policy/Recorder-write,
  symlink/hardlink/path swap/TOCTOU negative와 ordinary-root positive matrix를 모두
  통과해야 한다.
- `request-review`/explicit `always-proceed` dual mode와 mandatory blacklist를 mode별로
  검증한다. `always-proceed`의 `mcp(*)`/Playwright interaction은 의도된
  autonomous-admin이고, `strict`/`proceed-in-sandbox`는 request-review로 정규화한다.
- failed native conversation quarantine, durable ACK, next-generation recovery와 failed
  mutation no-replay를 검증한다. Web PTY inherit/open/read/write는 actual Antigravity
  interactive probe로 검사한다.
- `breaking_versions`에 2.1.0을 추가한다. `full_access`, `docker_api`, Docker socket,
  host-root/PID/journal mount, privileged capability와 protection disablement는 계속
  없어야 한다.
- source/container/kernel 회귀는 HAOS 증거가 아니다. 2.1.0 amd64/aarch64 실기기
  수용은 배포 시점 `NOT RUN`이며 전체 v2 수용은 `PARTIAL`이다. 2.0.12는 clean/safe
  rollback이 아니고 exact old backup restore는 newer `/data`를 교체한다.

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
| M3-05 | `PARTIAL` | custom `apparmor.txt` operational-blacklist와 restricted/sensitive-read top-level named `Px` 실행 프로필 | parser/static + kernel-enforced smoke; public 2.0.18 Web PTY FAIL; 2.1.0 HAOS TODO |
| M3-06 | `PARTIAL` | 실기기 audit 기반 PTY/ordinary-operation positive와 explicit sensitive/raw-host blacklist | 2.0.18 `/dev/pts/0` denial RCA; 2.1.0 sanitized audit TODO |
| M3-07 | `PARTIAL` | HAOS enforce positive/negative matrix | historical 2.0.12~2.0.18 failures recorded; 2.1.0 operational/blacklist E2E TODO |
| M3-08 | `PARTIAL` | App-managed broker 고위험 항상 확인 불변조건 검증 | local policy/replay matrix PASS; real Telegram E2E TODO |
| M3-09 | `PARTIAL` | 민감정보 option의 profile 선택과 불변 deny 구현 | local profile matrix PASS; false/true HAOS matrix TODO |
| M3-10 | `PARTIAL` | shared native OAuth 동일-process 잔여 위험과 관리자 trust-model 검증 | local shared-HOME canary; actual HAOS OAuth 비유출/AppArmor TODO |

### M4 — HA API, memory와 browser

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M4-01 | `VERIFIED` | ordinary read/memory/fresh-state validate의 ha-read broker ownership 고정; config-check/mutation/browser-auth는 scoped 분리 | static owner + shared failure injection PASS |
| M4-02 | `PARTIAL` | bounded Core/Supervisor read와 raw-unavailable sanitized Host/Supervisor log tools | API/component contract; 2.0.18 first managed tool FAIL; 2.1.0 HAOS E2E TODO |
| M4-09 | `PARTIAL` | confined `ha_files` ordinary-root list/read/write와 alias/TOCTOU/sensitive deny | component positive/negative pending final report; 2.1.0 HAOS E2E TODO |
| M4-03 | `PARTIAL` | memory 모듈 분리와 bootstrap/degraded isolation | memory suite PASS; HAOS lifecycle TODO |
| M4-04 | `PARTIAL` | explicit/candidate/change memory workflow | state-machine suite PASS; HAOS mutation TODO |
| M4-05 | `PARTIAL` | Chromium executable와 Playwright lock 일치 | amd64 runtime/QEMU arm64 packaging PASS; native arm64 TODO |
| M4-06 | `PARTIAL` | loopback gateway와 managed read-only identity | managed-auth suite PASS; HAOS identity lifecycle TODO |
| M4-07 | `PARTIAL` | desktop/mobile/console/network 검증; request-review는 read-only 네 도구만, always-proceed는 installed interaction 허용 | fixture rendered smoke; 2.1.0 rendered HAOS E2E TODO |
| M4-08 | `PARTIAL` | browser/memory 비밀 및 output redaction | local canary security suite PASS; HAOS E2E TODO |

### M5 — 새 Telegram 브리지

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M5-01 | `PARTIAL` | 기존 bridge 격리/제거와 기본 OFF 유지 | static/image entrypoint PASS; HAOS install TODO |
| M5-02 | `PARTIAL` | long polling, static user/chat allowlist와 bounded metrics | Bot API/metric component tests PASS; live Bot API TODO |
| M5-03 | `PARTIAL` | local-only pairing create/list/revoke | pairing security suite PASS; HAOS operator flow TODO |
| M5-04 | `PARTIAL` | input normalization과 shell-free shared-runtime invocation | injection/argv/stdin suite PASS; live conversation TODO |
| M5-05 | `PARTIAL` | pre-bound healthy session, explicit `/new`, failed-conversation quarantine/no-replay, per-chat queue/cancel/timeout | component recovery suite; live 2.1.0 HAOS Telegram TODO |
| M5-06 | `PARTIAL` | stream-json parser, bounded metadata/single-proposal empty-text fallback와 Telegram chunking | parser/output component PASS; live Telegram formatting TODO |
| M5-07 | `PARTIAL` | typed binary/multi-choice proposal, 31+cancel grid와 broker-generated human-reviewable confirmation preview | local secret-safe diff + choice binding/replay/cross-chat PASS; 2.0.17 proposal card FAIL; 2.0.18 HAOS E2E TODO |
| M5-08 | `PARTIAL` | request-review/always-proceed dual policy, raw native file deny, mandatory blacklist, native-prompt/broker high-risk matrix | 2.1.0 local policy suite pending final report; HAOS E2E TODO |
| M5-09 | `PARTIAL` | encrypted reply outbox, rate limit/backoff/idempotent result와 registration→approval sealing 전 crash 재시도 경계 | pre-send persist/retry/ack component와 live Bot API TODO |
| M5-10 | `TODO` | 실제 HAOS Telegram E2E | 2.0.18 no-tool PASS, first managed tool FAIL, later reused-session inconclusive, approved write NOT RUN; 2.1.0 E2E TODO |
| M5-11 | `PARTIAL` | shared Home/cwd와 user customization 상속·수정 | actual 1.1.13 positive canary 재검증; HAOS OAuth/AppArmor TODO |
| M5-12 | `IN_PROGRESS` | dual-mode permission validator와 `permission_boundary_blocked` Bot-API-before hold/no-S6-loop | historical evidence recorded; 2.1.0 HAOS dual-mode/unsafe-hold TODO |

### M6 — migration과 multi-arch release

| ID | 상태 | 과제 | 완료 증거 |
| --- | --- | --- | --- |
| M6-01 | `PARTIAL` | v1 option conservative mapping | exact public-v1 source container rehearsal PASS; HA-007 local HAOS/HA-005 public update TODO |
| M6-02 | `PARTIAL` | preserve mode와 ownership conflict | local preflight/preserve/full update PASS; HAOS TODO |
| M6-03 | `PARTIAL` | refresh_managed owned settings merge, 2.0.x→2.1 dual-mode migration와 plugin refresh idempotency | local transaction pending final report; 2.1.0 HAOS restart/update TODO |
| M6-04 | `PARTIAL` | reset_v2가 ownership state와 무관하게 safe settings를 backup하고 managed key/permission을 exact 복구, preserve 전 매-start drift 복구 | local state/target journal + SIGKILL rollback PASS; HAOS rollback TODO |
| M6-05 | `PARTIAL` | memory/browser/SSH/OAuth preservation | amd64 public-v1 fixture와 QEMU arm64 restart persistence PASS; HA-005/HA-006/HA-007 TODO |
| M6-06 | `PARTIAL` | amd64/aarch64 build/runtime와 per-checkout bounded local cache | 2.0.9 build helper contract 및 shared Telegram/permission/broker 재검증; native HAOS both arch TODO |
| M6-07 | `PARTIAL` | `image`, operational AppArmor와 breaking metadata | 2.0.13/2.1.0 breaking binding; 2.1.0 Candidate/HAOS install TODO |
| M6-08 | `PARTIAL` | staged candidate exact-digest smoke, HAOS rehearsal bundle와 rebuild 없는 idempotent promotion | remote PR Builder PASS; Candidate workflow/actual bundle run TODO |
| M6-09 | `PARTIAL` | leaf SBOM, provenance, exact Cosign identity와 anonymous preflight | local workflow contract; public registry retrieval TODO |
| M6-10 | `PARTIAL` | candidate-bound local HAOS rehearsal과 post-publish public acceptance | pre-finalize finalizer와 post-publish HA-005/HA-008 validator/uploader implemented; HA-005/006/007/008 NOT RUN |
| M6-11 | `IN_PROGRESS` | Telegram-enabled preserve의 selected dual-mode boundary reconciliation, unrelated-state 보존과 restart idempotency | 2.0.12 historical PASS; 2.1.0 migration/unsafe hold HAOS NOT RUN |

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
