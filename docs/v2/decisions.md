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
- release version/source/rootfs metadata는 대형 dependency install layer 뒤에서만
  선언하고 private Playwright dependency manifest는 App version과 결합하지 않는다.
  dependency가 같으면 numeric release가 달라도 registry와 HAOS layer store가 해당
  payload를 재사용할 수 있어야 한다.
- HAOS update의 old-image cleanup은 Supervisor 소유다. App은 Docker socket,
  `docker_api`, `full_access`, global prune 또는 자동 `/supervisor/repair`를 추가하지
  않는다. repair는 실제 stale overlay/image 증거 뒤 별도 관리자 복구 작업이다.
- local QEMU arm64 PASS는 packaging evidence일 뿐 native HAOS arm64 지원 선언이
  아니다.

## ADR-003 — AppArmor는 항상 ON

- 상태: `Accepted`
- AppArmor를 끄는 option은 제공하지 않는다.
- `antigravity_sensitive_data_access`는 Web/SSH/Telegram Antigravity를 restricted와
  sensitive-read bootstrap/runtime 쌍 중 하나로 전환할 뿐이다.
- 비특권 HAOS App에서 namespace 생성이 실패하는 native `--sandbox`는 사용하지 않는다.
  bootstrap은 shared HOME을 열지 않고 image-owned native binary로 전환하며, runtime이
  시작한 일반 command와 stdio tool은 공통 command profile로 다시 `Px` 전환한다. 이를
  위해 host privilege를 늘리지 않는다.
- secrets, `.storage`, runtime token/options와 SSH/private key는 두 runtime 모두
  read/write를 거부한다. sensitive-read는 Recorder DB 진단 read만 추가하며 broker,
  browser와 memory 권한은 바꾸지 않는다. command profile은 OAuth, App 관리 settings/
  MCP config와 token을 읽거나 쓸 수 없다.

## ADR-004 — Telegram bridge 전면 교체

- 상태: `Accepted`
- v1의 shell/tmux prompt runner, static PIN 노출과 interactive approval 전달 경로는
  migration하거나 fallback으로 남기지 않는다.
- 2.0.7부터 Telegram은 CLI와 동등한 관리자 주 채널이며 `/data/home`, `/config`,
  OAuth, global/workspace plugin·agent·rule·MCP와 native permission을 공유한다.
- Telegram 전용 `telegram_access_mode`, `ha-telegram-login`, HOME/bootstrap과 fixed
  customization copy를 제거한다. legacy mode 값은 migration에서 무시·제거한다.
- user/chat 교집합, 최초 실행 전 stable conversation binding, explicit `/new`,
  per-session model 직렬화, 즉시 control/approval ACK·기본 인증, requester FIFO의
  broker 실행, 실행 직전 session 재검증, durable same-session approval/idempotency와 암호화 reply outbox를
  사용한다. native headless tool prompt는 Telegram으로 resume하지 않는다. 관리형
  runtime rule은 HA service/config 변경을 `ha_change_propose`, terminal/script/choice/
  question을 `telegram_action_propose`로 먼저 등록하며 이 App-managed proposal을
  durable Telegram 승인 경계로 둔다. arbitrary native/plugin MCP permission prompt는
  external resume할 수 없으므로 transparent intercept 대상으로 주장하지 않고
  unsupported Telegram side effect는 fail closed한다.
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
- Antigravity CLI는 `1.1.13` artifact와 architecture별 digest에 고정한다.
- Codex식 `-c` override, TOML config, token option과 추정 subcommand를 사용하지 않는다.
- 모든 native launch는 `AGY_CLI_DISABLE_AUTO_UPDATE=true`를 전달한다.
- native upgrade는 새 numeric App release와 migration/rollback evidence로만 수행한다.

## ADR-006 — proposal-first universal managed Telegram approval

- 상태: `Accepted`
- 2.0.11 새 설치와 Telegram의 유일한 effective native permission은
  `request-review`다. `strict`, `always-proceed`, `proceed-in-sandbox` schema 값은 기존
  Supervisor option의 upgrade input 호환용이며 updater가 모두 `request-review`로
  정규화한다. safely identified
  2.0.9/2.0.10 App-owned `command(*)`/`mcp(*)` broad allow와 legacy autonomous option은
  bounded read와 exact proposal MCP 정책으로 migration한다. user-owned rule과 stronger
  deny는 보존한다.
- HA mutation은 기존 broker, terminal command·bounded script·command choices·finite
  question은 private action coordinator와 credential-free executor가 담당한다. proposal
  MCP는 실행하지 않고 exact digest/public preview만 등록한다.
- callback action은 encrypted durable record에 먼저 결정·commit하고 executor 결과를
  같은 conversation의 새 turn으로 전달한다. committed completion uncertainty는
  `in_doubt`이고 executor를 다시 시작하지 않는다.
- Playwright auto-allow는 upstream `readOnly: true`인 console messages, network
  requests, snapshot, screenshot 네 도구뿐이다. navigate/back, tabs, hover, wait,
  resize, close 등은 typed adapter 전까지 fail closed한다.
- proposal coordinator registration은 approval state/card sealing 전에는
  crash-durable하지 않다. 이 사이 bridge crash는 사용자에게 원 요청 재시도를 요구한다.
- 명시적 `reset_v2`는 safe parseable settings를 backup하고 ownership state와 무관하게
  managed key와 permission 세 bucket을 exact default로 복구한다. permissions 밖의
  사용자 top-level/MCP/plugin/OAuth는 보존하고 `preserve`로 되돌릴 때까지 매 시작
  drift를 복구한다.
- fixed CLI 1.1.13 print mode의 native permission request는 external callback으로
  resume할 수 없다. 따라서 이 설계는 arbitrary future/user plugin MCP의 universal
  interceptor가 아니다. 표현하지 못하는 Telegram side effect는 fail closed한다.
- 공유 OAuth가 이미 있으면 지원되는 일반 작업은 Telegram만으로 처리한다. initial OAuth
  controlling TTY, live HAOS AppArmor, Bot API card/callback과 real action E2E는 별도 증거
  전까지 `NOT RUN`이다.

## ADR-007 — Telegram-enabled permission reconciliation과 live fail-closed hold

- 상태: `Accepted`
- 2.0.12부터 `telegram_enabled=true`는 Bot API를 시작하라는 option인 동시에 exact
  managed Telegram permission boundary를 적용하라는 관리자 선택이다. 일반
  `preserve` semantics만으로 stale user-owned permission을 유지한 뒤 bridge startup
  gate에서 반복 종료하는 상태를 허용하지 않는다.
- root-owned single-link regular·256 KiB 이하이고 parse 가능한 existing settings는 현재
  migration mode나 ownership state와 관계없이 transaction backup한다. 그 뒤
  `allowNonWorkspaceAccess`, `artifactReviewPolicy`, `toolPermission`,
  `enableTerminalSandbox`와 `permissions.allow`/`ask`/`deny` 전체를 image canonical
  Telegram policy로 교체하고 mode를 0600으로 강화하며 ownership state를 같은 policy로
  기록한다. 같은 canonical input의 재실행은 write와 새 backup이 없어야 한다.
- 이 reconciliation은 다섯 App 관리 보안 key와 permission boundary에 한정한다. 그 밖의
  사용자 top-level settings, global MCP 파일, 사용자 plugin, native OAuth와 `/config`는
  보존하고 `antigravity_user_files_update_mode`를 `reset_v2`로 자동 변경하지 않는다.
  따라서 Telegram-enabled 상태에서는 bucket 안의 user-owned rule과 stronger deny가
  보존되지 않는다는 breaking boundary를 문서와 release note에 명시한다.
- updater와 bridge는 같은 canonical policy definition과 validator를 사용한다. file
  preflight, parse, image default validation 또는 transaction이 실패하면 partial write나
  permissive fallback을 만들지 않는다. invalid effective settings가 bridge까지
  도달하면 `permission_boundary_blocked`를 한 번 기록하고 Bot API 요청 없이 process를
  살아 있는 fail-closed hold에 둔다. 같은 설정의 fatal/S6 restart loop는 금지하며
  안전한 복구 뒤 App restart가 필요하다.
- 명시적 `reset_v2`는 Telegram 활성화 여부와 무관한 broader drift recovery로 유지한다.
  2026-08-18 실제 HAOS amd64에서 2.0.12 public update, live Bot API 재연결·전달과
  App restart/reconnect는 `PASS`했다. unsafe-boundary hold, unrelated state/OAuth 보존과
  전체 HA-004는 `NOT RUN`이며 좁은 성공을 확대하지 않는다. 같은 기기의 custom
  AppArmor attach는 `FAIL`, aarch64는 owner-waived `NOT RUN`이다.

## ADR-008 — Supervisor primary scanner와 독립 AppArmor profile 표현

- 상태: `Accepted`
- Supervisor 2026.07.5는 App의 `apparmor.txt`에서 column 0의 `^profile[ ]` primary
  선언을 정확히 하나만 허용한다. 2.0.12의 23개 column-0 선언은 이 presentation
  계약을 위반했고 custom policy가 설치되지 않아 실제 amd64에서
  `docker-default (enforce)`가 관찰됐다.
- 2.0.13은 `antigravity_home_assistant` slug primary 선언 하나만 column 0에 두고
  다른 22개 선언을 들여쓴다. AppArmor parser는 들여쓰기와 무관하게 동일한 23개
  독립 global named profile과 기존 `Px transition` target을 load한다. profile을
  nesting하거나 root profile 권한으로 합치지 않는다.
- 이 변경으로 project least-privilege deny가 처음 실제 적용될 수 있으므로 2.0.13은
  breaking version이다. parser와 source contract PASS만으로 HAOS attach를 주장하지
  않으며 2.0.13 설치 뒤 AA-001을 새로 수행한다.
- 2.0.12 amd64 Telegram reconciliation/reconnect/restart PASS와 AppArmor attach FAIL은
  서로 독립된 현장 결과다. aarch64 `NOT RUN` owner waiver는 experimental 배포의
  위험 수용일 뿐 AppArmor 또는 architecture PASS가 아니다.
- 공개 2.0.13의 실제 HAOS amd64 startup은 `/run/s6`·`/run/service` directory entry
  생성 거부와 `s6-overlay-suexec` exit 111로 `FAIL`했다. 2.0.14는 exact S6 runtime·
  container exit result와 nginx PID access만 추가하고 기존 credential·민감정보 deny를
  유지한다. 이 수정은 2.0.13 보안 경계를 바꾸는 새 migration이 아니므로 2.0.14를
  `breaking_versions`에 추가하지 않으며, 실제 HAOS 기동·재시작 수용은 `NOT RUN`으로
  유지한다.
- 공개 2.0.14의 실제 HAOS amd64 startup은 S6가 init service까지 진행한 뒤 resolved
  `/usr/lib/bashio/bashio` execute denial과 exit 126으로 다시 `FAIL`했다. init의
  `/command/with-contenv` 역시 image-owned S6 package target으로 resolve된다.
- 2.0.15는 관찰된 Bashio denial만 완화하지 않고 전체 cold-start trace의 exact runtime
  closure를 적용한다. resolved Bashio/S6/execline/Bash, Telegram pause, shell
  `utempter`, Chromium child는 사용하는 profile에만 execute를 주며 interpreted
  Playwright wrapper/runtime과 traced font/config metadata만 browser에서 읽는다. init 계정/nginx,
  SSH OOM/accounting, feedback report subtree와 fontconfig cache는 필요한 mutation 경로만 연다. broad
  `/usr/lib/**`·`/package/admin/**` execute 또는 `/etc/**` write는 새로 추가하지 않고 기존
  credential·민감정보 deny를 유지한다.
- 2.0.15는 실제 custom profile을 exact image에 attach하는 kernel-enforced cold-start·
  fresh-container restart와 안전한 `/config/secrets.yaml` read-denial canary smoke를
  CI/Candidate 필수 gate로 추가했다. 그러나 실제 HAOS에서 primary profile의
  `/dev/ptmx` 접근 누락으로 ttyd PTY 생성이 EACCES를 반환해 2.0.15 Web terminal
  수용은 `FAIL`이다. 자동 Linux-container 증거는 이 실기기 결과를 대체하지 않는다.

## ADR-009 — PTY 최소권한과 Telegram managed bucket 정규화 순서

- 상태: `Accepted`
- 공개 2.0.15의 실제 HAOS 18.2 amd64에서 Ingress HTTP와 WebSocket upgrade는
  성공했지만 ttyd `pty_spawn`이 EACCES로 실패했다. primary AppArmor profile에 ttyd가
  여는 exact `/dev/ptmx rw`를 추가하며 `/dev/**` broad grant나 다른 profile의 권한
  복사는 허용하지 않는다.
- 같은 시작에서 `refresh_managed`는 safe parseable settings의 malformed
  `permissions.ask`를 Telegram-safe replacement보다 먼저 typed array로 검증했다.
  2.0.16은 Telegram이 관리하는 allow/ask/deny 세 bucket을 exact 29/0/33 policy로
  canonicalize한 뒤 merge validation을 수행한다. 이 순서는 unrelated top-level settings,
  global MCP, plugin, OAuth와 `/config` 보존을 바꾸지 않는다.
- symlink, hardlink, non-root owner, 크기 초과와 invalid JSON은 계속 자동 복구 대상이
  아니며 bridge는 effective boundary가 안전하지 않으면 Bot API 접촉 없이
  `permission_boundary_blocked` hold를 유지한다.
- 2.0.16은 2.0.13에서 활성화한 security boundary 내부의 corrective patch다.
  `breaking_versions`에는 2.0.13까지만 유지한다. 2.0.16 실제 HAOS는 뒤이은 native
  `file_mmap` denial과 SIGSEGV/status 139 때문에 `FAIL`, aarch64 owner waiver는 not a
  PASS이며 전체 v2 수용은 `PARTIAL`이다.

## ADR-010 — native executable mmap 최소권한과 signal 진단

- 상태: `Accepted`
- 공개 2.0.16 실제 HAOS 18.2 amd64에서 App, Ingress/Web terminal과 Telegram Bot API
  transport는 시작됐지만 `agy`와 `antigravity --version`은 SIGSEGV/status 139로 즉시
  종료되고 Telegram worker도 같은 native crash로 실패했다. session reset이나 transport
  재연결을 복구 경로로 분류하지 않는다.
- exact public 2.0.16 image를 custom AppArmor policy 아래에서 재현한 kernel audit는
  `interactive-runtime-restricted`의 exact `/usr/local/libexec/antigravity-real` rule에서
  `file_mmap` permission `m` 거부를 확인했고 sensitive-read에는 동일한 `r`-only rule이
  있었다. 2.0.17은 두 rule을 `r`에서 `rm`으로 바꾸고 full blank-auth worker trace의
  exact bootstrap nsswitch/passwd identity read와 runtime
  `/usr/share/ca-certificates/**` TLS trust-store read만 두 transition chain에 추가한다.
  새로운 broad `/usr/local/**`, `/etc/**`, `/usr/share/**` 또는 library mapping rule은
  추가하지 않고, runtime의 기존 `/etc/** r`, 필수 system-library mapping 및
  proc/settings/credential deny는 변경하지 않는다.
- Telegram bridge는 native child의 bounded termination signal을 `worker_failed` 진단에
  포함하지만 stderr, prompt, OAuth, token이나 사용자 content는 기록하지 않는다.
- local kernel-enforced `antigravity --version` status 0과 negative canary 보존은
  Candidate evidence일 뿐 HAOS evidence가 아니다. 2.0.17 publication 시점 actual HAOS와
  aarch64는 `NOT RUN`이었고, 이후 결과는 ADR-011에 기록한다.
- 2.0.17도 2.0.13 security boundary 내부 corrective patch이므로
  `breaking_versions`를 확장하지 않는다. 2.0.12 fallback은 direct downgrade가 아니며,
  exact App backup restore의 post-backup `/data` 손실과 custom-attach 보안 저하를
  명시한 `NOT RUN` contingency로만 유지한다.

## ADR-011 — managed MCP exact module read와 complete Telegram run binding

- 상태: `Accepted`
- 공개 2.0.17 실제 HAOS 18.2 amd64에서 App startup, Ingress/Web terminal, native CLI와
  기본 대화, Telegram transport와 도구 없는 답변은 통과했지만 managed MCP 요청과
  `telegram_action_propose`는 실패했다. 이는 prompt 길이, Bot API, pairing 또는
  conversation reset 장애로 분류하지 않는다. 승인카드가 만들어지지 않아 승인된 쓰기는
  `NOT RUN`이고 2.0.17 수용은 전체 `FAIL`이다.
- kernel audit가 확인한 `change-proposal-client`의
  `/usr/local/share/antigravity-ha/supervisor-credential-fd.mjs` read denial은 그
  image-owned transitive module의 exact read 하나로 닫는다. 상위 directory나
  application-library 전체 read, 다른 client profile의 권한 복사는 금지한다.
- Telegram action proposal의 requester/run binding은 다섯 값이 전부 있거나 전부 없는
  closed tuple이다. restricted와 sensitive-read launcher는 일부 binding을 거부하고,
  완전히 검증한 다섯 값을 함께 보존한다. 개별 값의 선택적 전달이나 환경 전체 상속은
  허용하지 않는다.
- 이 교정은 proposal-first 쓰기 요건을 복구하지만 unapproved direct write/command를
  허용하지 않고 AppArmor/native permission 범위를 넓히지 않는다. 2.0.18은 2.0.13
  security boundary 내부 corrective patch이므로 `breaking_versions`는 확장하지 않는다.
- exact module/broad-rule negative와 두 launcher complete/partial binding 자동 회귀는
  HAOS 증거가 아니다. 2.0.18 amd64의 managed read MCP, 승인카드와 승인된 bounded write,
  그리고 aarch64 실기기 수용은 릴리스 전 `NOT RUN`이며 전체 v2 수용은 `PARTIAL`이다.
