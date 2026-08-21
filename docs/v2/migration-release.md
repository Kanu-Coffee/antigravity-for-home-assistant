# v2 마이그레이션과 릴리스

`MIG-*`는 이 계약의 안정 식별자다. 문구나 순서가 바뀌어도 기존 번호를 다른
요구사항에 재사용하지 않는다.

## MIG-001 — 배포 모델

public App은 사용자의 HAOS에서 source build하지 않고 GHCR prebuilt image를
받는다.

```yaml
version: "2.1.3"
arch:
  - amd64
  - aarch64
image: ghcr.io/kanu-coffee/antigravity-for-home-assistant
breaking_versions:
  - "2.0.0"
  - "2.0.7"
  - "2.0.9"
  - "2.0.11"
  - "2.0.12"
  - "2.0.13"
  - "2.1.0"
```

`apparmor`의 Supervisor 기본값은 `true`다. pinned App linter가 중복 기본값을
거부하므로 metadata key는 생략하지만 같은 디렉터리의 custom `apparmor.txt`가
기본 profile을 대체하며 `apparmor: false`는 허용하지 않는다.

Supervisor는 `version`을 image tag로 사용한다. 같은 numeric tag에 amd64와
aarch64 manifest가 모두 있을 때만 `config.yaml`에 두 아키텍처를 선언한다.
첫 v2, 2.0.7의 Telegram 관리자 trust-model 전환, 2.0.9의 default-allow managed
permission 및 persistent mutation 범위 전환, 2.0.11의 proposal-first
`request-review`/universal managed approval 전환, 2.0.12의 Telegram-enabled
permission reconciliation 전환, 2.0.13의 Supervisor-compatible custom AppArmor
profile 활성화와 2.1.0의 dual-mode operational-blacklist 전환은 breaking version으로 표시하고
사용자가 release note를 읽고 선택하게 한다.

2.0.12의 `apparmor.txt`에는 들여쓰기 없는 최상위 `profile` 선언이 23개 있었다.
Supervisor 2026.07.5는 App의 custom policy에서 `^profile[ ]` 선언을 정확히 하나만
허용하므로 이 파일의 설치를 거부했고, 관찰된 amd64 container는 프로젝트의 세분화된
policy 대신 `docker-default (enforce)`로 실행됐다. 2.0.13은 slug primary 선언만
column 0에 두고 나머지 22개 독립 global profile 선언을 들여써 Supervisor의 primary
scanner에는 정확히 하나만 보이게 한다. AppArmor parser는 동일한 23개 profile 이름과
기존 `Px` 전이·제약을 계속 load한다. 이전에 generic profile에서 허용되던 접근이 이제
거부될 수 있는 보안 경계 변화이므로 2.0.13을 breaking version으로 표시한다.

공개 2.0.13의 실제 HAOS 18.2 amd64 업데이트에서는 이전 컨테이너의 정상 Telegram
처리와 순차 종료 뒤 새 컨테이너가 `/run/s6`와 `/run/service`를 만들지 못했고,
`s6-overlay-suexec`가 exit 111로 종료됐다. descendant rule만으로 S6 runtime
directory entry 자체의 create/traverse를 허용하지 않은 custom AppArmor 결함이다.
2.0.14는 S6 runtime tree·container exit result와 nginx PID에 필요한 exact access만
추가하고 기존 credential·민감정보 deny를 유지한다. 이는 2.0.13에서 의도한 보안
경계를 바꾸는 새 migration이 아니라 startup 회귀를 고치는 patch이므로
`breaking_versions`에 2.0.14를 추가하지 않는다. 2.0.14의 실제 HAOS 기동·재시작
수용은 이후 amd64에서 `FAIL`로 확인됐다. S6 service graph가 init까지 진행했지만
AppArmor가 `/usr/bin/bashio`의 resolved `/usr/lib/bashio/bashio` target 실행을
거부하여 `antigravity-ha-init`이 exit 126으로 종료됐고, init의
`/command/with-contenv`도 image-owned S6 package target에 exact execute가 필요했다.

2.0.15는 관찰된 Bashio denial만 완화하지 않고 전체 cold-start trace에서 확인한 exact runtime
closure를 적용한다. resolved Bashio/S6/execline/Bash와 Telegram pause, shell
`utempter`, Chromium child 실행은 사용하는 profile에만 열고, interpreted Playwright
wrapper/runtime과 traced font/config metadata만 browser에서 읽는다. init의 계정/nginx 상태,
SSH OOM/accounting, HA feedback report subtree와 fontconfig cache는 필요한 mutation 경로만 허용한다.
새로운 `/usr/lib/**`·`/package/admin/**` 전체 execute, `/etc/**` 전체 write 또는 기존
credential·민감정보 경계를 넓히지 않는다. 실제 custom profile을 exact image에
attach하는 kernel-enforced cold start·fresh-container restart와 안전하게 준비한
`/config/secrets.yaml` read-denial canary 자동 smoke를 일반 CI amd64와 Candidate native
amd64/aarch64에 필수화한다. 이 자동 Linux-container 증거는 HAOS 증거가 아니다.
공개 2.0.15의 실제 HAOS amd64에서는 service graph와 Ingress HTTP/WebSocket은
시작됐지만 primary profile의 PTY multiplexor 접근 누락으로 ttyd `pty_spawn`이
EACCES를 반환했다. 또한 `refresh_managed`가 malformed `permissions.ask`를
Telegram-safe canonical replacement 전에 검증해 update를 적용하지 못했고 bridge는
`permission_boundary_blocked`에 머물렀다. 따라서 2.0.15 실기기 수용은 `FAIL`이다.

2.0.16은 primary profile에 exact `/dev/ptmx rw`만 추가하고, 지원되는 안전한
settings의 allow/ask/deny managed bucket을 typed merge validation 전에 exact 29/0/33
policy로 정규화한다. unrelated top-level settings, global MCP, plugin, OAuth와
`/config`를 보존하고 symlink·hardlink·non-root owner·크기 초과·invalid JSON은 계속
fail closed한다. 2.0.16 공개 시점 실제 HAOS 수용은 `NOT RUN`, aarch64 장비 부재 owner waiver는
not a PASS이며 전체 v2 수용은 `PARTIAL`이다. 이후 실제 2.0.16은 terminal과 Telegram
transport까지 시작했지만 native CLI가 SIGSEGV/status 139로 종료되어 수용 `FAIL`로
갱신됐다. exact public image/custom profile 재현의 kernel audit는
`interactive-runtime-restricted`에서 `/usr/local/libexec/antigravity-real` `file_mmap`
permission `m` 거부를 확인했고 sensitive-read에는 동일한 `r`-only rule이 있었다.

2.0.17은 두 exact native-binary rule을 `r`에서 `rm`으로 바꾸고 full blank-auth trace의
exact bootstrap nsswitch/passwd identity read와 runtime
`/usr/share/ca-certificates/**` TLS trust-store read만 두 transition chain에 추가한다.
새로운 broad `/etc/**`·`/usr/share/**` rule은 추가하지 않고, runtime의 기존 `/etc/** r`,
필수 system-library mapping 및 proc/settings/credential deny는 그대로이고, local kernel-enforced
`antigravity --version` status 0은 HAOS 증거가 아니다. 2.0.17 actual HAOS와 aarch64는
`NOT RUN`, 전체 v2 수용은 `PARTIAL`이었다. 이후 실제 2.0.17 amd64에서 App startup,
Web terminal, native 기본 대화, Telegram transport와 도구 없는 답변은 통과했지만
managed MCP와 `telegram_action_propose`는 실패했다. kernel audit는
`change-proposal-client`의 exact image-owned `supervisor-credential-fd.mjs` module read
거부를 확인했고, 두 confined launcher는 승인 제안에 필요한 requester/run binding
다섯 값을 버렸다. 승인된 쓰기는 `NOT RUN`이고 2.0.17 전체 수용은 `FAIL`이다.

2.0.18은 proposal client에 그 exact module read를 추가하고 restricted/sensitive-read
launcher가 완전한 다섯 값 binding만 검증·보존하며 일부 binding은 거부하게 한다. broad
AppArmor/native-tool 권한, 환경 전체 상속이나 승인 없는 direct write/command는 추가하지
않았다. 이후 실제 공개 2.0.18 amd64는 startup, `antigravity --version` status 0,
Telegram transport/no-tool chat을 `PASS`했지만 Web `agy`/`antigravity` interactive I/O와
첫 managed Telegram tool이 `FAIL`했다. current kernel audit는 `/dev/pts/0`
inherited/open `rw` denial을 기록한다. 후속 3~7은 failed conversation을 재사용했으므로
독립 tool 결과가 아니고 approved write는 `NOT RUN`이다. 공개 2.0.18 수용은 `FAIL`이다.

2.1.0은 narrow operational allowlist를 supported mount/API의 broad operational grant와
explicit blacklist로 교체한다. ordinary `/config`, `/share`, `/media`, non-credential
persistent HOME/temp, system command, installed MCP, supported Core/Supervisor manager API와
known credential-shaped/exact-token redaction을 거친 bounded Host/Supervisor log를
지원한다. raw logs는 노출하지 않으며 arbitrary unkeyed application text의 secret 여부를
완전 판별한다고 주장하지 않는다. mandatory deny는 secrets/storage/OAuth/token/key,
App-owned permission/MCP policy, credential-bearing `/proc`, Recorder write와 raw
backup/SSL/other-App config에 적용된다. raw host root/PID/journal, Docker socket,
`full_access`, `docker_api`와 보호 mode 해제는 추가하지 않는다.

기본 `request-review`는 URL read, confined `ha_files` list/read와 managed
read/validate/memory/proposal을 허용하고 `ha_files` write/command/URL execute를
ask/proposal-first로 보낸다. explicit `always-proceed`는 mandatory blacklist 밖의 command/URL,
`mcp(*)`와 installed Playwright interaction을 autonomous-admin으로 허용한다. `strict`와
`proceed-in-sandbox`는 `request-review`로 정규화한다. failed native worker conversation은
quarantine하고 failed update를 durable ACK한 뒤 다음 user request에 새 generation을
결합하며 mutation을 replay하지 않는다. 이 trust/permission 변화 때문에 2.1.0을
`breaking_versions`에 추가한다. 2.1.0 automated regression은 HAOS 증거가 아니며
amd64/aarch64 실기기 수용은 배포 시점 `NOT RUN`, 전체 v2 수용은 `PARTIAL`이다.

2.1.1은 public 2.1.0의 첫 Web `agy`가 `request-review` settings를 native
Antigravity 1.1.13 shape로 다시 쓰려다 final `settings.json`의 의도된 AppArmor
write/link/lock deny에 막힌 호환성 회귀를 고친다. 임시 파일과 대상은 같은
디렉터리이므로 `EXDEV`가 아니다. `request-review`는 top-level `toolPermission`을
생략하고 `always-proceed`는 exact `"toolPermission":"always-proceed"`를 유지하며,
두 mode 모두 `enableTerminalSandbox`를 생략한다. known permission bucket은 native
canonical order로 기록한다. `request-review`는 `allow`/`deny`/`ask`,
`always-proceed`는 `allow`/`deny`를 기록하고 empty `ask`를 생략한다. exact App-owned
2.1.0 layout은 transaction backup 뒤 mode-specific canonical form으로 바꾸고 두 번째
실행부터 byte-idempotent해야 한다. final-settings deny는 유지하며 copy/unlink fallback이나
settings-write grant는 추가하지 않는다. 2.1.1의 real-HAOS Web TUI, enforced AppArmor,
authenticated Telegram delivery, browser와 memory 수용은 amd64/aarch64 모두
`NOT RUN`이고 전체 v2 수용은 `PARTIAL`이다.

공개 뒤 2.1.1 실제 HAOS amd64의 Telegram 시험은 transport, exact no-tool response,
단일 `ha_read_state`와 confined `ha_files_list`를 `PASS`했다. 그러나 explicit
`always-proceed`의 read-only native `run_command` turn은 Bridge에서
`headless_permission_denied`로 분류됐고, 반복 요청은 mode를 구분하지 않는 proposal
fallback 뒤 `proposal_result_invalid`로 끝났다. 2.1.1 classifier는 generic
permission 문구를 어느 tool error에서든 일치시켰고 tool/denial layer를 기록하지
않았으므로 AppArmor command profile이나 `/config` directory read 도달 여부는 판정할
수 없다. 두 항목은 `FAIL`이 아니라 `NOT RUN`이다. 공개 2.1.1 이미지의 격리
재현에서는 canonical `always-proceed`와 straight ASCII quote를 사용한 같은 명령이
성공했고 curly Unicode quote도 권한 거부 없이 실행됐지만 출력만
`‘TERMINAL-DIR-OKn’`로 훼손됐다. 이 자동 재현은 HAOS 증거가 아니다.

2.1.2는 exact native 1.1.13 headless denial만 bounded하게 분류하고 선택된 mode와
함께 처리한다. proposal이 없는 `request-review`의 `run_command` denial만 최대 한 번
`telegram_action` proposal로 재계획하고 exact single same-run proposal은 기존 receipt
검증을 계속한다. `always-proceed`에서 같은 denial이 나오면 정상 승인 요청으로
위장하지 않고 approval card 없이 `unexpected_permission_denied` policy mismatch로
fail closed한 뒤 conversation을 격리한다. Native `read_file`/`view_file`/`write_file`/`write_to_file` denial은 두
mode 모두 `headless_read_denied`이며 forbidden native-file proposal로 보내지 않고
confined `ha_files` 사용을 안내한다. 일반 command/AppArmor 오류 문구는 native approval
denial로 오인하지 않는다. 이 진단·복구 보강은 2.1.0의 trust boundary를 바꾸지 않는
patch이므로 `breaking_versions`에는 2.1.2를 추가하지 않는다. 2.1.2의 real-HAOS
install/update, direct command, request-review proposal/approval, restart, rollback과
aarch64 수용은 배포 전 모두 `NOT RUN`이며 전체 v2 수용은 `PARTIAL`이다.

공개 2.1.2 실제 HAOS amd64의 authenticated Web TUI에서는 Terms/data-use 화면의
Done·Enter와 Ctrl+C가 작동했지만 native가
`settings.json.<uuid>.tmp`를 final `settings.json`으로 atomic rename하지 못했다.
`agy-settings` hash는 전후 `SAME`이었다. 이는 terminal input 부재가 아니라 local
final-settings replacement 실패를 증명하지만, 별도 remote Terms 요청의 성공 여부는
증명하지 않는다.

2.1.3은 authenticated controlling TTY에서 명시적으로 실행하는
`ha-antigravity-login`을 consumer Google OAuth/Terms 전용 controller로 바꾼다. native
first-run은 persistent HOME 대신 root-owned `/run` staging HOME과 빈 fixed workspace를
사용한다. onboarding runtime에는 real HOME, `/config`, command exec, MCP/plugin,
proposal/managed-HA socket과 automatic browser helper를 열지 않는다. 사용자는 표시된
HTTPS URL을 열고 authorization code를 붙여 넣으며 Google Cloud/enterprise flow를
선택하지 않는다.

controller는 native status `0` 또는 의도한 Ctrl+C `130`, completed consumer marker와
OAuth present를 모두 요구한다. 기존 settings에서 native telemetry 선택만 달라진
settings, root-owned single-link 0600의 bounded opaque OAuth credential file, exact
`consumerOnboardingComplete`/`enterpriseOnboardingComplete` boolean만 검증하고 no-secret
journal에 바인딩된 settings→OAuth→marker 순서로 crash-consistent commit한다. 각
destination의 fixed same-directory temporary 교체만 개별적으로 atomic하며, 중단된
prefix는 격리 후 재시도한다. timeout, unexpected exit와
incomplete flow는 staging을 폐기하고 normal session 시작을 안내하지 않는다. normal
Web/Telegram final-settings write/link/lock deny와 command/MCP/HA 민감 경계는 유지한다.
local file/marker로 remote Terms 수락을 단정하지 않는다. 이 patch는 2.1.0 trust
boundary를 넓히지 않으므로 `breaking_versions`에는 2.1.3을 추가하지 않는다. 2.1.3
real-HAOS install/update, enforced onboarding AppArmor, consumer OAuth/Terms persistence,
normal Web/Telegram regression, restart/rollback과 aarch64 수용은 배포 전 `NOT RUN`이며
전체 v2 수용은 `PARTIAL`이다.

Terms 화면에서 선택한 data-use 설정은 이후에도 opt-out할 수 있다. 단,
`settings.json`을 직접 쓰지 않고 fresh digest에 묶인 `agy-settings patch` mediator에서
지원하는 privacy-strengthening `enableTelemetry:false` opt-out만 사용한다. opt-in 또는
re-enable은 제공하지 않고 별도 authenticated consent flow가 필요하다. 이 기능은 normal
native runtime에 broad settings write 권한을 추가하지 않는다.

native `read_file(*)`/`write_file(*)`는 symlink alias 우회를 막기 위해 두 mode에서
mandatory deny한다. ordinary file access는 server `ha_files`의
`ha_files_list`, `ha_files_read_text`, `ha_files_write_text`로 이관한다. 허용 root는
`/config`, `/share`, `/media`, ordinary `/data/home`, `/tmp`, `/var/tmp`이며 UTF-8
1 MiB·listing 200개 상한, no-link regular-file, same-directory atomic write와 optional
`expected_sha256`를 강제한다. legacy permission bucket에서 raw file allow/ask를
보존하지 않으며 `.gemini`, secrets/storage/credential/policy/Recorder-write 및 alias는
fail closed한다.

image에 고정한 Antigravity binary는 App runtime에서 자체 갱신하지 않는다. 모든
native launch와 `env -i` child allowlist는 공식 opt-out
`AGY_CLI_DISABLE_AUTO_UPDATE=true`를 강제하며 사용자 option이나 native settings로
재활성화할 수 없다. Antigravity upgrade는 새 numeric App version, per-arch digest와
검증된 migration/rollback을 통해서만 수행한다.

실제 1.1.11 clean-HOME control에서 opt-out 미설정 updater spawn count 1, 설정 시 0이
확인됐다. 그러나 모든 App entrypoint의 전달, 두 architecture image의 updater
미실행과 restart 전후 binary version/digest 불변이 확인되기 전에는 이 배포 계약을
PASS로 표시하지 않는다.

공식 근거:

- [Home Assistant App configuration](https://developers.home-assistant.io/docs/apps/configuration/)
- [Home Assistant App publishing](https://developers.home-assistant.io/docs/apps/publishing/)
- [Home Assistant AppArmor presentation](https://developers.home-assistant.io/docs/apps/presentation/)

## MIG-002 — 영속 데이터 분류

| 분류 | 예 | 기본 처리 |
| --- | --- | --- |
| 사용자 데이터 | `/config/**`, 사용자 Git repository | 절대 migration하지 않음 |
| native 인증 | `/data/home/.gemini/**`의 CLI 관리 OAuth 자료 | 이름/내용을 추정하지 않고 보존 |
| native 사용자 설정 | `settings.json`, global MCP, 사용자 plugin | global MCP/plugin은 보존, settings의 소유 key만 선택 갱신 |
| App 관리 설정 | `home-assistant` plugin 내부 MCP/rules/skills, version state | mode와 무관한 version transaction으로 갱신 |
| SSH | authorized keys option, `/data/ssh/host-keys` | 보존 |
| browser identity | `/data/antigravity-ha/browser-auth`와 기존 호환 경로 | 보존 후 정책 재검증 |
| memory | `/data/antigravity-ha-memory` | 보존, schema 사전검사 |
| Telegram | bot option, static allowlist, local pairing authorization, durable binding/outbox | 인증 option과 v2 local pairing authorization은 보존, shared `/data/home` 사용, legacy dedicated HOME은 실행 경로에서 제거·root-only 보존, 그 HOME에 속한 conversation binding만 초기화 |
| 임시 상태 | `/run/antigravity-ha/**` | 매 시작 폐기 |

OAuth, token과 private key는 backup 대상이어도 내용을 읽어 변환하거나 log하지
않는다. regular file, owner, link count와 mode를 검증한 뒤 같은 filesystem에서
보호된 archive에 byte-for-byte 보존한다.
Telegram은 Web/SSH의 `/data/home` OAuth와 customization을 그대로 사용한다. 기존
`/data/antigravity-ha/telegram-home`의 내용을 공유 HOME으로 병합·복사하거나 credential
파일명을 추정하지 않는다. legacy directory는 실행 경로에서 분리해 root-only 보존하고
사용자는 필요할 때 별도 승인으로 폐기한다. shared OAuth가 없으면 trusted local
TTY에서 `ha-antigravity-login`을 실행한다. 2.0.6의 v2 local pairing authorization은
그대로 유지하되 전용 HOME에서 생성된 conversation ID는 재사용하지 않고 2.0.7의 첫
요청에서 공유 HOME용 ID를 새로 결합한다. 더 오래된 v1 pairing 자료는 기존 quarantine
정책을 유지하며 자동 승인 자료로 승격하지 않는다.

## MIG-003 — migration mode

mode와 무관하게 App 소유 `home-assistant` plugin은 안전한 ownership marker가
확인되면 App version당 한 번 image의 canonical copy로 갱신한다. 신규 설치는 현재
version을 marker에 기록한다. 같은 이름의 기존 plugin에 marker가 없거나 marker가
안전하지 않으면 사용자 소유 충돌로 보고 덮어쓰지 않은 채 App start를 중단한다.
이 보안 갱신은 `preserve`가 억제할 수 없다.

### `preserve` 기본값

- existing native OAuth, keybindings, conversation, 사용자 MCP/plugin을 변경하지
  않는다. Telegram이 꺼져 있으면 native settings도 기존 ownership 계약대로 보존한다.
- native settings와 global MCP 파일이 없을 때만 기본 파일을 만든다. 기존 파일의
  사용자 key와 server는 그대로 보존한다.
- 위 공통 규칙에 따라 ownership이 확인된 App 관리 plugin은 canonical refresh하고,
  같은 이름의 사용자 소유 plugin은 conflict로 중단한다.
- App ownership이 확인된 2.0.6/2.0.8 permission rule과 exact 2.0.9/2.0.10 App-owned
  broad allow layout은 2.0.11에서 `request-review`, bounded native/HA read와 exact
  `ha_change_propose`/`telegram_action_propose` allow로 version migration한다. 사용자
  소유 rule과 stronger deny, OAuth, global plugin/agent/skill/rule은 보존한다.
- App ownership이 확인된 2.0.11~2.0.18 bounded layout은 2.1.0에서 선택된
  `request-review` 또는 explicit `always-proceed` canonical policy로 version migration한다.
  legacy `strict`/`proceed-in-sandbox`는 `request-review`로 정규화하고 기존 native
  `read_file`/`write_file` allow/ask는 보존하지 않는다. ordinary file은 설치된
  `ha_files` MCP로만 접근한다.
- 2.0.12부터 Telegram이 켜져 있으면 App ownership과 무관하게 root-owned single-link
  regular·256 KiB 이하의 parse 가능한 settings를 먼저 transaction backup한다. 공개
  2.1.0까지는 다섯 App 관리 field와 세 permission bucket을 기록했다. 2.1.1부터는
  `allowNonWorkspaceAccess`, `artifactReviewPolicy`, selected mode의 sparse
  `toolPermission` 표현과 known permission bucket을 exact Telegram policy로 맞추고
  retired native sandbox key를 제거한다. unknown custom allow/ask와 stronger deny는
  permission bucket 안에 보존하지 않지만, App 관리 permission 경계 밖의 top-level
  settings, global MCP/plugin/agent/skill/rule, OAuth와 `/config`는 보존한다. 기존 mode는
  0600으로 강화한다. 이는 headless startup
  gate와 updater가 서로 다른 policy를
  받아들여 bridge가 restart loop에 빠지는 것을 막는 breaking migration이다.
- symlink/hardlink/non-root owner, 256 KiB 초과 또는 parse 불가능한 settings는 자동
  수정하지 않는다. 일반 regular file의 non-0600 mode만 안전한 transaction에서
  0600으로 강화한다. bridge는
  Bot API에 접속하기 전에 sanitized `permission_boundary_blocked`를 한 번 기록하고
  supervised process를 종료하지 않은 채 대기한다. 안전한 복구 후 App을 재시작한다.
- `request-review`의 managed Playwright allow는 upstream `readOnly: true`인
  `browser_console_messages`, `browser_network_requests`, `browser_snapshot`,
  `browser_take_screenshot` 네 개로 축소한다. legacy ownership set의 navigate/back,
  tabs, hover, wait, resize, close rule은 ownership 인식에만 사용하고 새 default에서는
  제거한다. typed adapter 전까지 이 mutation-capable 도구는 Telegram에서 fail closed한다.
  explicit `always-proceed`는 installed Playwright interaction을 autonomous-admin
  `mcp(*)` 범위에 포함한다.
- unsafe legacy Codex식 설정은 실행하지 않으며 경고와 `refresh_managed` 안내를
  제공한다.

### `refresh_managed`

- OAuth, conversation, 사용자 settings key, 사용자 MCP/plugin, SSH, browser
  identity와 memory는 보존한다.
- App ownership state에 등록된 managed settings key를 image 기본본으로 갱신한다.
  plugin 안의 managed MCP/rules/skills는 위 공통 version별 plugin refresh가
  담당하며 사용자 global MCP server는 건드리지 않는다.
- 교체 대상은 먼저 transaction backup에 저장한다.
- 사용자와 App 관리 JSON key를 구조적으로 merge하며 전체 파일을 template로
  덮어쓰지 않는다.

### `reset_v2`

- 사용자가 명시적으로 선택하는 permission drift 복구 control이다. 안전한 root-owned
  regular settings 파일과 parse 가능한 JSON을 먼저 transaction backup에 보존한다.
- 기존 App ownership state의 유무·모호함과 관계없이 App-managed settings field와 선택
  mode에 존재하는 known permission bucket을 image exact default로 교체한다.
  `request-review`는 `allow`/`deny`/`ask`를 기록하고, `always-proceed`는
  `allow`/`deny`만 기록해 empty `ask`를 생략한다. custom permission rule과 permissions의
  알 수 없는 bucket은 보존하지 않는다.
- `permissions` 밖의 사용자 top-level settings와 global MCP/plugin/OAuth는 보존한다.
  symlink/hardlink/non-root owner, 크기 초과 또는 parse 불가능한 JSON은 계속 fail closed한다.
- plugin 내부 MCP/rules/skills 갱신은 mode가 아니라 위 공통 version별 plugin
  transaction이 담당한다. global MCP 파일은 존재하면 byte-preserve한다.
- 공식 CLI OAuth 자료, `/config`, SSH host key, authorized keys, browser identity,
  memory DB와 사용자 소유 plugin/MCP server는 보존한다.
- option은 자동으로 바꾸지 않는다. `reset_v2`가 선택된 동안은 같은 App version에서도
  매 시작 managed/permission drift를 exact default로 다시 복구한다. 정상화 확인 뒤
  사용자가 `preserve`로 돌려놓는다.

## MIG-004 — v1 옵션 변환

v2.0.x는 update input을 읽기 위해 deprecated v1 key와 enum을 migration-only로
수용할 수 있다. 이 값은 native CLI에 전달하지 않고 다음처럼 보수적으로
변환한다.

| v1 입력 | v2 결과 |
| --- | --- |
| `antigravity_approval_policy=untrusted` | warning 후 effective `request-review` |
| `antigravity_approval_policy=on-request` | `antigravity_tool_permission=request-review` |
| `antigravity_approval_policy=never` | `request-review`로 낮추고 명시적 경고. auto-approve를 승계하지 않음 |
| `antigravity_tool_permission=strict\|proceed-in-sandbox` | warning 후 `request-review`로 정규화 |
| `antigravity_tool_permission=always-proceed` | 2.1.0에서 explicit autonomous-admin 선택으로 보존; mandatory blacklist는 계속 적용 |
| `antigravity_sandbox_mode=*` | 폐기. `antigravity_terminal_sandbox=false`로 정규화 |
| `antigravity_terminal_sandbox=true\|false` | 2.0.9부터 deprecated/no-op. warning 후 `false`로 정규화; AppArmor command 경계는 항상 유지 |
| `browser_approval_policy=*` | 제거. v2 browser MCP allowlist 사용 |
| `antigravity_user_files_update_mode=preserve` | `preserve` |
| `...=refresh_agents` | `refresh_managed` |
| `...=refresh_all` | `refresh_managed`; `reset_v2`는 사용자가 새로 선택해야 함 |
| `antigravity_token` | import하지 않음. 공식 OAuth 필요 상태 보고 |
| `telegram_allowed_chat_ids` | 유효 ID만 보존. user allowlist와 교집합을 이루거나 새 private pairing 전까지 모든 메시지를 거부 |
| `telegram_access_mode` | 2.0.7에서는 권한으로 사용하지 않고 제거. global `antigravity_tool_permission`/민감정보 option과 AppArmor command 경계를 적용 |
| legacy Telegram pairing/session | `/data/antigravity-ha/quarantine/v1-telegram/`으로 root-only 원자 격리하고 v2에서 재사용하지 않음 |
| `home_assistant_browser_token` | 새 secret으로 복사하지 않음. 관리 identity 재검증 또는 setup 안내 |

2.1.0의 effective native 값은 기본 `request-review`와 explicit `always-proceed`다.
config schema가 `strict`, `proceed-in-sandbox`를 계속 수용하는 이유는 기존 Supervisor
option으로 update container를 시작하기 위한 입력 호환성뿐이며 user-files updater는
native settings를 쓰기 전에 둘을 `request-review`로 정규화한다.

Supervisor의 manual update는 새 App config를 저장한 뒤 기존 실행 상태를
복원하는 `start()`에서 `write_options()` schema 검증을 먼저 수행하고, 검증이
끝나야 container init에 진입한다. 따라서 v2 schema는 `refresh_agents`와
`refresh_all`을 migration-only enum으로 임시 수용한다. init의 user-file
mapping과 image-managed plugin/bootstrap이 모두 끝난 뒤에만 App이
`http://supervisor/addons/self/options`에 현재 option 전체를 POST하고 이 key만
`refresh_managed`로 정규화한다. credential과 request body는 argv/log에 넣지
않고 private runtime file로만 curl에 전달한다. Supervisor token이나 API가
없거나 응답이 거부되면 `/data/options.json`을 직접 수정하지 않고 경고한 뒤
다음 App 시작에서 재시도한다.

고정한 Supervisor 구현은 schema에서 제거된 unknown key를 container의
`/data/options.json`에서는 버리지만 persisted raw option에서는 즉시 지우지 않는다.
따라서 2.0.7은 local file에서 `telegram_access_mode`가 보일 때만 동작하지 않는다.
Supervisor credential이 있고
`/data/antigravity-ha/migration/supervisor-options-2.0.7.json` 완료 marker가 없으면,
schema 검증을 이미 통과한 현재 option 전체를 새 값 추정 없이 self-options API에 한
번 POST한다. 성공 응답 뒤 비밀값이 없는 root-only marker를 원자 기록하고 이후
restart에서는 건너뛴다. API 실패 또는 marker 기록 실패는 marker를 완료로 간주하지
않아 다음 App 시작에서 재시도하며, Supervisor credential이 없는 generic container는
API 호출 없이 안전하게 건너뛴다.

deprecated key는 v2.1 이후 제거 후보지만 실제 설치 telemetry가 아닌 migration
fixture와 support 기간 결정이 먼저다. deprecation 제거는 별도 breaking release로
처리한다.

local migration fixture는 legacy option 파일을 byte-preserve하면서 provider/browser
token 값을 출력하지 않고 재인증 경고만 생성한다. 기존 chat ID만으로 v2 bridge를
인증하지 않으며, legacy `telegram_enabled=true`가 polling process를 시작하더라도 새
user allowlist와 chat allowlist의 교집합 또는 private pairing 전에는 모든 update를
거부한다. legacy pairing
파일 두 개는 content digest를 보존한 채 0600 quarantine으로 이동하고 원래 경로에서
제거한다. 실제 Supervisor가 보존한 1.0.4 option과 live identity의 HAOS update는
`NOT RUN`이다.

## MIG-005 — transaction protocol

각 migration은 다음 상태 머신을 따른다.

```text
discovered → preflighted → backed_up → staged → validated → committed
                  │             │          │          │
                  └─────────────┴──────────┴──────────┴→ rolled_back | failed
```

transaction ID는 source version, target version과 random nonce로 구성한 opaque
값이다. 상태는 `/data/antigravity-ha/migration/`의 0600 regular file에 fsync와
atomic rename으로 기록한다.

1. Git과 `/config`는 target 목록에 넣지 않는다.
2. 대상 parent부터 root owner, directory/file type, symlink, hardlink, mode와 같은
   filesystem 여부를 검사한다.
3. `/data/antigravity-ha/backups/<transaction-id>/`를 0700으로 만든다.
4. manifest에는 path, mode, size와 content digest만 기록하고 secret 원문은
   출력하지 않는다.
5. 임시 디렉터리에 새 파일을 만들고 schema, JSON parse와 plugin validation을
   수행한다.
6. 같은 filesystem에서 atomic rename하고 parent directory를 fsync한다.
7. 설치 tree digest와 Antigravity plugin validation postcondition을 확인한 뒤 commit한다.
8. crash journal이 있으면 다음 시작에서 commit 여부를 판정해 finish 또는
   rollback한다. 모호하면 자동 삭제하지 않고 recovery mode로 들어간다.

unknown future schema, corrupt DB, unsafe link/type/owner/mode와 backup 공간 부족은
fail closed한다. migration 실패 때문에 기존 recovery용 SSH/Ingress를 지울 수
없으며, credential 경계가 안전하지 않을 때만 전체 App start를 중단한다.

### 현재 local transaction 증거

2026-08-11 linux/amd64 component fixture에서 App 관리 plugin 갱신은
`/data/antigravity-ha/migration/managed-plugin.json` phase journal과
`/data/antigravity-ha/backups/plugin-<source>-to-<target>-<nonce>/` verified
backup을 사용한다. sibling staging tree에서 실제 Antigravity 1.1.11
`plugin validate`를 통과한 뒤 rename/fsync하고, 설치 tree digest와 plugin
validation을 postcondition으로 검사한다. stage validation 실패,
target 활성화 직후 SIGKILL과 postcondition validation 실패 fixture에서 다음 시작 또는
동일 실행의 rollback이 기존 plugin을 복원했다.

native settings, global MCP와 ownership state는 별도
`prepared → targets_installed → state_committed` journal을 사용한다. 대상 파일뿐 아니라
state 자체의 before/candidate도 같은 transaction에 보존한다. 기존 state와 candidate
digest가 같고 MCP만 누락된 상태에서 `prepared` 기록 직후 SIGKILL하는 회귀 fixture는
다음 시작에서 phase로 미완료 transaction을 판별해 rollback한 뒤 MCP를 생성했으며,
기존 state digest를 보존했다. ownership conflict는 target/state write 전에 검사한다.

이는 local amd64 implementation/component 증거다. settings/MCP transaction도
`/data/antigravity-ha/migration/native-files.json` phase journal,
`native-files-state.json` ownership state와
`/data/antigravity-ha/backups/native-files/` verified backup을 사용한다. 이전 build가
남긴 legacy journal은 legacy backup에서 먼저 복구한 뒤 state를 canonical 위치로
원자 이관한다. 신·구 state가 다르거나 두 journal이 공존하면 자동 병합하지 않고
fail closed한다. 공개 v1.0.4의 별도
`/data/antigravity/.user-files-update-journal.json`은 schema 1 state와
`backups/user-files/`의 candidate/before digest를 검증한다. commit 완료면 journal만
정리하고, 미완료면 legacy `config.toml`/`AGENTS.md`를 backup으로 복구한 뒤에만
native v2 transaction을 시작한다. 완료된 v1 state와 backup은 rollback 증거로
그대로 보존한다. 실제 HAOS update, Supervisor image rollback, native aarch64와 전원
차단 내구성은 `NOT RUN`이며 MIG-005 전체는 `PARTIAL`이다.

## MIG-006 — memory migration

public 1.0.4와 v2.0.0은 모두 application schema `1`을 사용하므로 이번 direct
migration에서 DB schema나 content를 바꾸지 않는다. 기존 non-empty DB는 write
connection을 열기 전에 read-only preflight로 file safety, SQLite `quick_check`,
application schema version과 table/index allowlist를 검사한다. local memory smoke는
container replacement 뒤 applied memory를 새 CLI/MCP process에서 다시 찾고,
update smoke는 교체 전후 `quick_check`를 확인한다.

현재 binary는 forward migration을 구현하지 않는다. schema `0`과 unknown older
schema는 `migration_required`, 미래 schema는 `unsupported_schema`, corruption이나
unexpected object는 memory-only degraded로 fail closed하며 preflight 중 DB bytes를
수정하지 않는다. 따라서 이번 release에서 존재하지 않는 schema migration backup을
만들거나 정상 schema `1` DB를 다시 쓰는 것도 금지한다.

향후 `MEMORY_SCHEMA_VERSION`을 올리는 release는 먼저 원본 DB를 root-only backup하고,
transaction 안에서 알려진 schema만 explicit forward migration한 뒤 새 schema와
`quick_check`를 검증해야 한다. rollback 기간 동안 backup을 보존하고 downgrade 시
자동으로 schema를 낮추지 않는다. 실제 public 1.0.4 HAOS volume의 보존 검증은
`NOT RUN`이다.

## MIG-007 — rollback

### App image rollback

1. Telegram bridge와 mutation broker를 중지한다.
2. pending approval/capability를 폐기한다.
3. migration status와 backup manifest를 비밀 없이 확인한다.
4. Supervisor에서 이전 immutable numeric version을 선택한다.
5. 이전 version이 이해하는 option set을 적용한다.
6. schema가 바뀐 App 관리 파일과 memory는 해당 transaction backup으로
   명시적으로 복원한다.
7. Ingress/SSH, OAuth, memory와 HA API read-only smoke 후 Telegram을 다시 켠다.

삭제, DB 복원과 backup restore는 사용자 현재 확인 없이는 수행하지 않는다.

### failed first start

commit 전 실패는 staged 파일을 폐기하고 기존 파일을 유지한다. commit 후
postcondition 실패는 journal의 verified backup으로 App 관리 파일만 복원한다.
`/config`, OAuth, SSH key, browser identity와 memory는 transaction manifest에
명시되지 않은 한 건드리지 않는다.

현재 local failure injection은 App 관리 plugin과 native settings/MCP/state의 verified
backup 복원까지만 확인했다. Supervisor의 이전 immutable image 선택, 실제 HAOS의
OAuth/SSH/browser/memory 보존과 schema downgrade restore는 실행하지 않았으므로
MIG-007은 `PARTIAL`이다.

2.0.12는 2.0.18 permission failure의 clean/safe fix도, 자동 또는 무손실 rollback
target도 아니다. exact public image/tag는 있지만
custom 23-profile policy attach가 거부됐고, 실제 성공은 amd64 `docker-default`에서의
제한된 update/reconnect 범위뿐이며 aarch64는 `NOT RUN`이다. Supervisor direct
downgrade는 지원되지 않는다. 사용자가 보유한 exact 2.0.12 App backup을 복원하는
경우에만 이전 App image와 `/data`를 함께 되돌릴 수 있고, 그 이후의 OAuth·memory·
approval/outbox·identity state는 소실된다. 그러한 backup 없이 uninstall 또는 Docker
상태 수동 조작을 복구 절차로 사용하지 않는다.

backup이 없고 2.1.0도 실기기 수용에 실패한다면 fallback은 현재 `/data`를 보존하는
새로운 더 높은 numeric compatibility patch, 최소 `2.1.1`이어야 한다. custom attachment나
mandatory blacklist를 의도적으로 되돌리는 선택은 명시적 security degradation이며,
별도 candidate/HAOS 검증 전에는 감사된 contingency `NOT RUN`일 뿐 정상 복구나 PASS로
기록하지 않는다. 문제 분석 중
사용한 `reset_v2` mode는 정상화 뒤 반드시 `preserve`로 되돌린다.

## MIG-008 — multi-arch build

| Home Assistant arch | OCI platform | 필수 binary |
| --- | --- | --- |
| `amd64` | `linux/amd64` | Antigravity linux-x64, ttyd x86_64, Chromium |
| `aarch64` | `linux/arm64` | Antigravity linux-arm64, ttyd aarch64, Chromium |

- Dockerfile은 `TARGETARCH`/`BUILD_ARCH`를 closed mapping으로 변환한다.
- 각 download는 version과 SHA-256을 아키텍처별로 고정한다.
- base image는 release/digest를 고정하고 OCI labels의 arch와 실제 platform을
  검사한다.
- npm은 lockfile과 `npm ci --ignore-scripts` 원칙을 유지하며 package version을
  build에서 확인한다.
- qemu build 성공만 아키텍처 runtime 지원 증거로 사용하지 않는다. native 또는
  HAOS aarch64 smoke가 필요하다.

## MIG-009 — CI와 publish gate

이 저장소에는 목적이 다른 두 publish 단계가 있다.

- `Main release`는 단일 `main` 개발선의 긴급 수정과 현장 검증을 위한 **experimental
  numeric prerelease** 경로다. 같은 source의 성공한 automated Candidate artifact를
  재빌드 없이 승격하고 immutable numeric tag/GHCR image/GitHub prerelease를 만들지만,
  HAOS 수동 evidence를 입력으로 받지 않는다. 따라서 이 경로의 발행은 field-testing
  availability일 뿐 `MIG-010` 완료, stable 또는 v2 수용으로 표시할 수 없고 release
  notes와 최종 보고에 실제 HAOS gate를 `NOT RUN`으로 남긴다.
- `Candidate / finalize`와 evidence-aware Builder는 아래 여덟 HAOS gate까지 결합하는
  **evidence-complete acceptance** 경로다. `MIG-010`의 완료·stable 주장은 이 경로와
  post-publish 수용 자료에만 적용한다.

두 경로 모두 기존 numeric tag를 이동하거나 image를 덮어쓰지 않으며 실패한 발행은
더 높은 App version으로 재시작한다.

PR/push CI는 독립 job으로 다음을 수행해 첫 실패가 나머지 증거를 가리지 않게
한다.

1. secret scan, YAML, ShellCheck, Markdown, Hadolint, actionlint
2. Python/Node unit와 contract tests
3. amd64 image build와 smoke
4. aarch64 image build와 smoke
5. App metadata와 AppArmor policy validation
6. migration/update fixtures
7. Telegram injection/approval security suite
8. browser, memory와 broker failure-isolation suite
9. 실제 1.1.13의 `AGY_CLI_DISABLE_AUTO_UPDATE=true` propagation과 updater
   spawn/version/digest canary

evidence-complete Candidate와 Builder workflow 조건:

- numeric tag 전 수동 `Candidate / build`가 고유
  `candidate-<source-sha>-<run-id>-<run-attempt>` staging tag로 두 architecture를
  정확히 한 번 build한다. Home Assistant builder의 `build-image`는 digest-only push가
  아니라 `image-tags`가 필수이므로 이 고유 staging tag를 사용한다.
- staging 전 같은 source의 reusable complete CI가 성공해야 한다. numeric tag
  workflow는 image를 다시 build하지 않고 이 candidate evidence만 소비한다.
- matrix output을 직접 합치지 않는다. 각 arch의 action output digest를
  run ID와 attempt가 포함된 별도 artifact로 올리고, generic candidate는 두
  `arch-package@digest`만 source로 만든다.
- 각 per-arch OCI index와 generic OCI index의 raw byte digest를 metadata digest와
  비교한다. runnable descriptor는 정확히 `linux/amd64`, `linux/arm64` 하나씩이며
  그 leaf를 참조하는 `unknown/unknown` BuildKit attestation descriptor 외의 platform은
  거부한다.
- smoke는 generic candidate의 tag가 아니라 `generic@exact-index-digest`를 pull한다.
  amd64와 native `ubuntu-24.04-arm` runner에서 parameterized `TEST_PLATFORM`과
  `HA_ARCH`로 가능한 full image suite를 실행한다. exact public-v1 source
  rehearsal은 v1.0.4가 지원한 amd64에서만 실행한다. aarch64 release
  범위는 존재하지 않았던 v1 update가 아니라 실제 HAOS fresh
  install/persistence `HA-006`으로 닫는다.
- leaf별 SPDX JSON을 exact leaf digest에서 만들고 각 파일이 16 MiB 미만인지
  검사한다. 모든 artifact name에는 run ID와 run attempt가 포함된다.
- Candidate는 generic exact digest를 다시 build하지 않고 고유
  `2.0.0-candidate.<run>.<attempt>` tag로 carbon-copy하고, 그 version을 가진 source-bound
  temporary HA repository bundle을 candidate artifact에 넣는다. tag와 exact digest는
  credential 없는 pull이 성공해야 하며 bundle manifest/archive hash도 candidate record에
  결합한다.
- pre-finalize HAOS rehearsal은 공식 local testing 경로
  `/addons/antigravity_home_assistant`를 사용한다. amd64 `HA-007`은 같은
  directory/slug에 exact public v1.0.4 source를 source-build install한 뒤 candidate
  bundle의 App directory로 교체해 local repository identity와 `/data`를 유지한
  migration/recovery를 검증한다. 이는 original custom repository의 public
  update나 numeric rollback이 아니며 post-publish `HA-005`를 대체하지 않는다.
  public v1이 없었던 aarch64는 candidate App directory를 fresh install해
  `HA-006`을 수행한다.
- 이 rehearsal의 정확한 candidate runtime digest를 확인한 뒤 AppArmor enforce,
  amd64 local migration, aarch64 fresh install/persistence, migration mode, local migration
  rollback, Telegram shared-policy/session/outbox, native updater와 OAuth persistence를 각각 `PASS`로
  기록한다. `HAOS evidence` workflow는 gate별 sanitized report의 exact schema와
  candidate source/digest를 검증하고 고유 Actions artifact URI/SHA-256을 낸다.
  finalize는 각 URI를 다운로드해 byte SHA-256과 내부 source/digest/arch/check
  set을 확인하고 canonical JSON을 final artifact에 보존한다. finalize dispatch
  SHA와 verifier source도 exact candidate source여야 한다.
- tag는 `^[0-9]+\.[0-9]+\.[0-9]+$`인 annotated tag다. tag commit, App version,
  candidate run/attempt와 final evidence run/attempt/name/archive digest를 고정 trailer로
  결합한다. Builder는 두 Actions run의 workflow path, source SHA, conclusion과 artifact
  API digest를 다시 검사한다.
- numeric tag 전에 세 GHCR package API가 모두 성공하고 `public`인지 확인한 뒤
  credential이 없는 Docker config로 candidate index와 두 platform을 pull한다. API
  403, 404, network failure 또는 malformed response를 tag `absent`로 취급하지 않는다.
- numeric per-arch와 generic tag는 rebuild하지 않고 exact staged digest의 single-source
  `imagetools create` carbon copy로 만든다. package API 성공 뒤 tag가 없다고 보여도
  create 직전 authenticated registry inspect를 다시 수행한다. inspect도 manifest
  missing이면 create, 같은 digest면 resume, 다른 digest면 conflict로 중단하고
  authorization/transport/그 밖의 오류는 absent로 취급하지 않는다. generic tag는
  마지막이다. registry가 compare-and-swap을 제공하지 않아 inspect와 create 사이의
  이론적 race는 남지만, API eventual consistency 때문에 이미 보이는 conflict를
  덮는 경로는 차단한다.
- generic provenance와 두 leaf SPDX attestation을 게시하고, exact
  `builder.yaml@refs/tags/<version>` Cosign identity, issuer, workflow SHA/ref/repository와
  `push` trigger를 모두 검사한다. provenance와 SPDX predicate가 registry/API에서
  다시 조회·검증되지 않으면 실패한다.
- GitHub prerelease는 같은 tag, deterministic body와 byte-identical evidence/SBOM
  asset이면 resume하고, 없으면 한 번 생성하며, conflict면 덮어쓰지 않는다. 새 Release
  생성 전 source commit이 현재 default branch에 포함됐음을 compare API로 증명하고
  두 commit의 `.github/workflows` tree digest가 정확히 같은지도 검사한다. GitHub
  workflow 변경 source 때문에 `GITHUB_TOKEN` Create Release가 403/404가 되는 경우
  token 권한을 넓히지 않는다. exact image와 supply-chain 게시 뒤 source를 review/merge한
  직후 workflow drift 전에 실패한 GitHub Release job만 resume한다.
- mutable `latest`를 생성하지 않는다.

구현 근거는 pinned [Home Assistant builder build-image action](https://github.com/home-assistant/builder/blob/4de35182ce1e329181bffcbcc84d33db5e2c7e10/actions/build-image/action.yml),
[Docker imagetools create](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/),
[GitHub package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)와
[GitHub attestation verification](https://cli.github.com/manual/gh_attestation_verify),
[GitHub Create a release](https://docs.github.com/en/rest/releases/releases#create-a-release)
계약이다.

## MIG-010 — 릴리스 단계

이 절은 evidence-complete acceptance 경로를 정의한다.

1. 모든 자동 검사가 green인 release commit에서 `Candidate / build`를 수동 실행한다.
   Candidate attempt는 atomic artifact set이므로 실패 시 **Re-run all jobs**만 사용한다.
   **Re-run failed jobs**는 지원하지 않으며 이전 attempt의 성공 artifact를 새 attempt와
   섞어 우회하지 않는다.
2. candidate artifact의 `haos-candidate-repository.zip`과 manifest/archive digest를
   검증한다. 포함된 App directory를 공식 local testing `/addons` 경로에
   사용하고, 실행 중 observed image digest가 candidate record와 같지 않으면
   중단한다. 같은 artifact의 `haos-report-templates/`는 exact candidate binding과
   여덟 gate의 key set을 가진 fail-closed authoring skeleton이다. 필요하면 다음
   명령으로 exact set을 다시 만들며 unchanged template은 증거가 아니다.

   ```bash
   python3 .github/scripts/release_contract.py haos-report-templates \
     --candidate candidate.json \
     --output-dir haos-report-templates
   ```
3. amd64에서 exact public v1.0.4 source를
   `/addons/antigravity_home_assistant`에 source-build install하고 image ID, source SHA와
   local repository identity를 기록한다. 같은 directory/slug를 candidate App directory로
   교체해 `preserve`/`refresh_managed`/`reset_v2`, crash recovery와 local migration
   rollback `HA-007`을 수행한다. aarch64에서는 candidate를 fresh install해
   [HA-006](test-plan.md#ha-006--첫-aarch64-release-install과-persistence)을 수행한다.
   두 arch에서 AppArmor, browser, memory, updater를 확인하고 OAuth와 Telegram
   gate도 별도로 기록한다.
4. 각 sanitized gate report를 같은 source ref의 `HAOS evidence` workflow에
   gate별로 별도 dispatch한다. workflow summary가 준 `status`, `evidence_uri`,
   `sha256`, `format: "github_actions_zip"`을 변경하지 않고 합친 여덟 record로
   [release-evidence-template.json](release-evidence-template.json)을 채우고
   `Candidate / finalize`에 전달한다. aggregate template은 개별 gate authoring이나
   post-publish acceptance report에 사용하지 않는다.
5. finalize summary의 여섯 trailer를 그대로 사용해 candidate source commit에
   annotated numeric tag를 만든다.
6. Builder가 artifact/source/public preflight를 통과한 뒤 exact digest를 numeric tag로
   carbon-copy하고 supply-chain 자료를 게시한다.
7. tag source가 아직 default branch에 포함되지 않았거나 workflow tree가 다르면 exact
   image와 supply-chain postcondition을 확인한 뒤 reviewed source를 default branch에
   병합한다. 두 `.github/workflows` tree가 같은 즉시 실패한 GitHub Release job만
   rerun한다. workflow-write PAT/App token으로 우회하지 않는다.
8. GitHub prerelease를 deterministic notes/assets 계약으로 idempotently 생성 또는
   resume한다.
9. numeric tag의 anonymous generic/per-arch 접근, exact platform, signature,
   provenance와 leaf SPDX retrievability를 확인한다.
10. post-publish public repository metadata와 numeric prebuilt App fresh install을
    amd64/aarch64에서 확인하고 `HA-008` report를 만든다. 별도 amd64 HAOS에서
    original custom repository identity로
    설치한 public v1.0.4를 같은 repository/slug의 numeric v2로 update하고 실제
    public update/rollback `HA-005`를 수행한다. exact published digest와
    original repository/add-on/data identity, public-v1 source-build image와 matching
    backup을 결합한 sanitized `antigravity-ha-ha005-acceptance/v1` report를
    [fail-closed template](ha005-acceptance-template.json)에서 작성해 exact
    numeric tag의 `Post-publish HA-005 acceptance` workflow에 제출한다. workflow가
    canonical `ha005-acceptance.json`을 Actions artifact와 GitHub Release asset으로
    보존한 후에만 수용을 완료한다. 이 record는 pre-finalize gate나
    Candidate evidence로 순환시키지 않는다. HA-008은
    [fail-closed public install template](public-install-acceptance-template.json)에서
    작성해 별도 `Post-publish public install acceptance` workflow에 제출한다.
    workflow는 두 architecture가 모두 든 canonical
    `public-install-acceptance.json`을 고유 Actions artifact와 fixed Release asset으로
    보존한다. 각 architecture의 restart 전후 data identity hash가 일치하고 두 장비의
    random identity sentinel hash는 서로 달라야 하며, 전체 post-publish 수용에는 두
    acceptance asset이 모두 필요하다.

1~4의 외부 evidence가 하나라도 없거나 `NOT_RUN`이면 evidence-complete finalize와
Builder는 fail closed한다. automated Candidate만 소비하는 `Main release` experimental
prerelease는 이 finalizer를 가장하거나 대체하지 않는다. 현재 이 repository에는 실제
HAOS final evidence가 없으므로 v2 acceptance gate는 `PARTIAL`이다.
발행 전 bundle rehearsal은 local repository identity만 검증하므로 10의 `HA-005`나
public numeric two-arch fresh install `HA-008`을 대체할 수 없다. 10이 통과하기 전에는
post-publish 수용과 v2 완료를 표시하지 않는다. post-publish
upload/validation/artifact contract는 구현됐지만 실제 공개 release와 HA-005/HA-008
report는 없어 `NOT RUN`이다.
10의 workflow는 tag-bound finalizer Actions artifact와 GitHub Release의
`release-evidence.json` byte 동일성을 다시 검증한다. 해당 Actions artifact는
30일 보존되므로 만료 전에, 보통 publish 직후 `HA-005`를 제출해야
한다. artifact가 만료하면 예전 release의 새 report도 provenance 검증을
우회하지 못하고 fail closed한다. 이 제출 창은 observation이 release
publish 후이고 report 제출 시 30일보다 오래되지 않아야 한다는
timestamp 계약과 별개다.

각 artifact의 `retention-days`는 상한이며 GitHub REST API가 반환한 `expires_at`을
authoritative availability로 사용한다. finalize deadline은 다음과 같다.

```text
min(candidate artifact expires_at,
    earliest gate artifact expires_at,
    oldest HAOS observed_at_utc + 30 days)
```

numeric tag 생성과 Builder deadline은 다음과 같다.

```text
min(candidate artifact expires_at,
    finalizer artifact expires_at,
    oldest embedded HAOS observed_at_utc + 30 days)
```

HA-008 workflow deadline은 다음과 같다.

```text
min(finalizer artifact expires_at,
    oldest embedded HAOS observed_at_utc + 30 days,
    oldest HA-008 installation observed_at_utc + 30 days)
```

만료된 artifact를 재업로드하거나 attempt를 섞거나 annotated tag를 이동하지 않는다.
tag 생성 전이면 **Re-run all jobs**로 Candidate와 여덟 gate/finalize를 새 atomic
chain으로 반복한다. numeric tag 이후 복구할 수 없으면 새 version에서 다시 시작한다.

`stage: experimental`은 최소 두 아키텍처의 실제 HAOS 릴리스 회귀와 한 번의
성공적인 이전 public version update가 쌓일 때까지 유지한다.

## MIG-011 — 릴리스 증거 양식

machine record는 source SHA, candidate run/attempt, generic/staging/leaf digest,
rehearsal repository manifest/archive digest와 자동 gate를 가진다. manual record는
template의 정확한 여덟 gate와 candidate digest, download format, 원본 artifact
byte SHA-256을 가진다. finalize는 원본을 검증한 뒤 각 report를 canonical
`haos-gates/<gate>.json`으로 저장하고, 그 JSON byte digest의 exact map을
`release-evidence.json` 안의 `haos_gate_evidence`에 기록한다. 이 JSON 파일과 digest
map은 final artifact와 GitHub Release에 모두 보존한다. finalize artifact archive
자체의 SHA-256까지 annotated tag에 다음처럼 묶는다.

2.0.11의 Telegram 관련 manual gate는 계속 `shared_runtime_persistence`와
`telegram_session_delivery`다. 전자는 Web/SSH/Telegram의 동일 OAuth·HOME·전역
customization 상속과 approved exact action mutation, 후자는 `/new` 전까지의 session
유지, HA/action approval, `v4` 선택, commit/no-respawn `in_doubt`, sealed continuation과
응답 전달 내구성을 검증한다. initial OAuth, live Bot API와 실제 action을 실행하지 않은
local fixture를 manual gate PASS로 올리지 않는다. 이전 별도 Telegram identity/isolation
또는 channel mode를 PASS 조건으로 다시 도입하지 않는다.

```text
Candidate-Run-ID: <positive integer>
Candidate-Run-Attempt: <positive integer>
Release-Evidence-Run-ID: <positive integer>
Release-Evidence-Run-Attempt: <positive integer>
Release-Evidence-Artifact: release-evidence-<version>-<source>-<candidate-run>-<candidate-attempt>-<evidence-run>-<evidence-attempt>
Release-Evidence-SHA256: sha256:<64 lowercase hex>
```

post-publish `HA-005`는 이 여덟 manual gate의 부분이 아니다. 별도
`ha005-acceptance.json`은 final `release-evidence.json`의 numeric version/source,
generic digest와 amd64 runtime digest를 다시 결합하고 original repository ID/URL,
add-on/data identity의 update/rollback 동일성을 강제한다. 고유 Actions artifact와
덮어쓰기 없는 fixed-name GitHub Release asset이 같은 canonical JSON을
보존하며, Candidate finalize가 이 post-publish record를 입력으로 요구하지 않는다.

post-publish `HA-008`도 여덟 manual gate의 부분이 아니다. 별도
`public-install-acceptance.json`은 같은 numeric version/source와 generic/두 leaf
digest에 양 architecture의 original public repository fresh install/start/restart
관찰을 결합한다. 고유 Actions artifact와 fixed-name Release asset은 create-once이며
HA-005와 어느 순서로 붙어도 동일 byte resume만 허용한다.

template의 `NOT_RUN`은 evidence-complete 경로의 의도적인 fail-closed 초기값이다.
필수 완료 조건의 실제 sanitized evidence가 없으면 final artifact와 stable/v2 완료
표시를 만들지 않는다. 별도 `Main release`가 experimental numeric prerelease를
발행했더라도 이 조건은 충족되지 않는다. 자동화가 검증하는 것은 allowlisted
repository에서 다운로드한 evidence byte와 digest, candidate/source 결합이다. 보고서
안의 실제 HAOS 행위가 정직하게 수행됐다는 의미까지 암호학적으로 증명하지는 않으므로,
finalizer를 실행한 repository maintainer가 sanitized report를 검토한
trusted-attestor 경계로 남는다.

## Local build cache와 App backup 소유권·상한

개발용 `tools/development/build-app build`만 checkout path hash로 분리한 App-owned
Buildx namespace `antigravity-ha-local-<checkout-hash>`를 관리한다. helper는 Git common
directory의 checkout별 flock으로 직렬화하고, 시작 시 이 exact 이름의 crash 잔존
builder를 제거한 뒤 `docker-container` builder를 만들며 EXIT에서 같은 builder를
`buildx rm --force`해 자기 BuildKit state/cache만 제거한다.
global/default builder, system, container, volume 또는 image prune은 실행하지 않는다.

local image 정리는 `io.antigravity-ha.local-build=true`,
`io.antigravity-ha.local-build.owner=antigravity-for-home-assistant`와
`io.antigravity-ha.local-build.checkout=<checkout-hash>` label, exact repository tag와 모든
container에서 미참조라는 조건을 다시 검증한 image에만 적용한다. checkout별 최신 두
개는 보존하고 그보다 오래된 project-owned local image만 제거한다. 이 계약은 개발 host
cache에 한정하며 HAOS App runtime data나 Supervisor image lifecycle을 건드리지 않는다.

reusable release build action에는 stable
`cache-gha-scope: antigravity-home-assistant`를 전달해 run마다 새 scope가 누적되지 않게 한다.

HAOS release install/update는 별도 계약이다. App manifest의 generic `image:` 때문에
Supervisor는 이 repository를 장치에서 source-build하지 않고 registry의 최종 prebuilt
container를 pull한다. 성공한 교체 뒤 old App image 정리는 Supervisor가 수행하며,
다른 설치 App이 공유하는 image/layer ID는 마지막 consumer가 교체될 때까지 보존한다.
따라서 App에 Docker socket, `docker_api`, `full_access` 또는 host prune 권한을 주지
않는다. 공식 `POST /supervisor/repair`는 container, non-dangling image, BuildKit build,
volume와 network까지 다루는 broad recovery이므로 update hook이나 startup cleanup으로
호출하지 않고, failed/aborted pull·cleanup error·overlay 장애의 실제 증거와 별도 관리자
승인이 있을 때만 운영자가 수행한다.

대형 dependency install layer는 App version, source revision과 rootfs digest 같은
release-variant metadata 및 private Playwright bundle의 App version 표기로 cache key가
깨지지 않아야 한다. 이 metadata는 dependency layer 뒤에서만 선언하고 internal package
version은 release와 독립적으로 유지한다. 이렇게 하면 Supervisor cleanup 전 신·구 image가
일시 공존하거나 공유 image를 정상 보존할 때에도 변경되지 않은 약 560 MB image payload를
registry/host layer store에서 재사용할 수 있다. 이 최적화는 Supervisor cleanup을 대체하지
않으며 실제 HAOS 전후 사용량은 별도 `NOT RUN` evidence다.

운영 진단은 Docker API 대신 fixed read-only `ha_read_storage_usage`를 사용해 공식
`GET /host/disks/default/usage`의 allowlisted category 수치와 Supervisor/App log를 함께
본다. 이 endpoint는 image별 breakdown을 제공하지 않으므로 system, App data/config,
backup 증가를 분리하는 1차 진단으로만 사용한다.

App runtime backup 상한은 `/data/antigravity-ha/backups/plugin-*`의 managed-plugin transaction,
`backups/native-files/refresh-*`의 native user-files refresh와
`change-broker/backups/*`의 config patch에 독립적으로 적용한다. 각 범주의 ownership
manifest owner/transaction/target과 root-owned/no-symlink 완료 tree를 재검증해 최신 총
두 개를 보존한다. 복구·update·transaction이 success/unchanged로 끝난 뒤 오래된
eligible 항목을 atomic quarantine하고 삭제하며 crash 잔존 quarantine은 다음 실행에서
같은 검증 뒤 재시도한다. active/incomplete, manifestless, unsafe, symlinked 또는 App
ownership을 증명할 수 없는 backup은 보존한다.

HA memory SQLite의 `sync_runs`는 각 refresh마다 추가되므로 `success`/`failed` terminal
row 중 최신 64개와 catalog object/relation/revision, change before/after, last-success
metadata, audit correlation이 참조하는 ID만 보존한다. 이 pruning은 refresh를 종료하는
같은 `BEGIN IMMEDIATE` transaction 안에서 실행하고 FK check/history 결과를 바꾸지 않는다.
비정상 종료 `running` row는 lease 정보가 없어 live refresh와 안전하게 구분할 수 없으므로
자동 삭제하지 않는다. catalog revision과 semantic audit 자체는 cache가 아니라 제품
history이므로 별도 명시 retention 계약 없이 지우지 않는다.
