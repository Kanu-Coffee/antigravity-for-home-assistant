# v2 제품 사양

## 1. 제품 정의

Antigravity for Home Assistant는 HAOS Supervisor가 관리하는 Home Assistant
App이다. 컨테이너 안에 고정 버전 Antigravity CLI와 Home Assistant 전용 native
plugin을 제공한다. 사용자는 다음 세 표면에서 같은 `/config` 프로젝트와
영속 Antigravity 계정을 사용한다.

- Home Assistant Ingress의 ttyd/tmux 터미널
- 공개키 인증만 허용하는 App SSH endpoint
- 인증·queue·승인 broker를 거치는 Telegram Bot

세 표면 모두 같은 관리자급 Antigravity 환경과 정책을 사용한다. Telegram은
shell이나 tmux TUI를 중계하지 않는 transport adapter지만 격리된 identity 또는
축소된 agent가 아니다.

## 2. 사용자 시나리오

### US-001 설치와 로그인

사용자는 repository를 HAOS에 추가하고 자신의 아키텍처 이미지를 설치한다.
Ingress 또는 SSH에서 공식 Antigravity OAuth 흐름을 완료한다. 인증은 `/data`에
영속화되고 App 재시작과 정상 업데이트 뒤에도 유지된다.

### US-002 Home Assistant 진단

사용자는 entity, device, area, automation, history, trace, Core/App 로그를 묻는다.
기본값에서 Antigravity는 Recorder DB나 비밀 파일을 읽지 않고 HA plugin의 bounded
API를 통해 관련 정보만 가져온다. 민감정보 option을 켜도 secrets와 `.storage`는
직접 읽지 않으며 Web/SSH/Telegram에 Recorder DB 진단용 read-only profile만 적용한다.

### US-003 설정 변경

사용자는 `/config`의 YAML, dashboard resource 또는 automation을 수정한다.
대화형 표면은 Antigravity native permission과 AppArmor를 적용한다. persistent
변경은 expected digest와 atomic backup/write를 사용하고 `ha-config-check` 실패 시
exact rollback/recheck한다. 일반 `/config` YAML을 지원하되 sensitive deny 경로는
제외하고, 지원 reload 또는 `restart_required`를 정확히 보고한다.

### US-004 Telegram 조회와 변경

허용된 사용자는 Bot에서 CLI와 같은 전역 plugin/agent/rule/MCP와 권한 정책으로
자연어 요청을 보낸다. 첫 요청 전에 user/chat과 conversation ID를 영속 결합하고
이후 대화·응답·승인을 같은 session에서 직렬 처리한다. 명시적인 `/new`만 새
conversation을 만든다. 고위험 작업은 같은 conversation·사용자·채팅의 확인이
필요하다.
관리형 runtime rule은 HA service/config 변경을 `ha_change_propose`, terminal command·
bounded inline script·명령 선택지·유한 질문을 `telegram_action_propose`로 먼저
등록한다. 이 경로로 제출된 모든 App-managed broker `service_call`/
`multi_choice_service_call`/`config_patch`는 고위험 proposal로 durable Telegram
확인을 받은 뒤 실행한다. broker는 모든 live-validated HA service domain/service와
bounded `service_data`, 최대 31개의 상호 배타적인 사전 검증 service-call 선택지,
민감 경로 밖의 일반 YAML patch를 지원한다. action proposal은 exact source digest,
canonical cwd, timeout 또는 1~31개의 완성된 선택지를 등록하고 bridge가 durable commit한
뒤 credential-free executor로 한 번만 보낸다. completion을 확정할 수 없으면
`in_doubt`이며 재실행하지 않는다. pinned CLI가 native permission prompt를 external
approval 뒤 resume할 수 없으므로 임의 future/user plugin MCP는 transparent intercept
대상이 아니고 지원하지 않는 Telegram side effect는 fail closed한다. 이 proposal-first
계약은 기본 `request-review`에 적용된다. 사용자가 App option에서 `always-proceed`를
명시적으로 선택하면 current request 범위의 일반 운영 command/URL,
installed MCP와 Playwright interaction을 자율 관리자 권한으로 실행하지만 mandatory
credential/storage/policy blacklist는 우회하지 않는다.
proposal coordinator 등록 자체는 crash-durable하지 않다. 등록 성공 뒤 bridge가
encrypted approval/card state를 봉인하기 전에 종료되면 사용자가 원 요청을 다시 보내야
하며, durability는 봉인된 decision/result와 이미 접수된 execution부터 적용한다.

### US-005 dashboard 검증

Antigravity는 image-managed browser MCP로
`http://127.0.0.1:8099/`의 Home Assistant dashboard를 열어 desktop
1440×900과 mobile 390×844를 검사한다. visible snapshot, screenshot, console과
실패한 network resource를 함께 검토한다.
`request-review`에서는 upstream read-only 네 도구만 자동 허용하고 navigation/
interaction은 typed adapter 전까지 fail closed한다. explicit `always-proceed`는 current
user request 범위의 installed Playwright navigation/interaction을 허용한다.

### US-006 검증형 메모리

App은 첫 시작 이후 entity/device/area/automation의 허용된 구조 metadata를
색인한다. 사용자가 명시한 지속 사실은 검증 절차로 저장한다. 현재 상태,
대화 원문, credential과 automation 원문은 메모리에 저장하지 않는다.

### US-007 안전한 업데이트와 복구

사용자는 보존 정책을 선택해 v1에서 v2로 업데이트한다. 변경 대상은 먼저
root-only backup에 저장되고 migration은 원자적이며 재실행 가능하다. 실패하면
App은 기존 복구 표면을 유지하고 rollback 절차를 안내한다.

## 3. 기능 요구사항

### FR-001 App 패키징

- App slug는 `antigravity_home_assistant`를 유지한다.
- `init: false`와 s6-overlay를 사용한다.
- `arch`는 `amd64`, `aarch64`를 목표로 한다.
- public 설치는
  `ghcr.io/kanu-coffee/antigravity-for-home-assistant:<version>`의 generic
  multi-arch manifest를 사용한다.
- `config.yaml`의 `image`는 tag 없는 generic image 이름이다.
- custom `apparmor.txt`를 포함하고 AppArmor는 항상 켠다.
- `/config`, `/share`, `/media`는 Supervisor-supported map으로 read-write mount한다.
- `homeassistant_api: true`, `hassio_api: true`, `hassio_role: manager`를 사용한다.
- `full_access`, Docker API, host network, privileged capability와 host journal mount는
  기본적으로 사용하지 않는다.

### FR-002 Antigravity

- CLI version은 1.1.13에 고정하고 아키텍처별 artifact digest를 검증한다.
- 사용자 명령은 `agy`와 `antigravity` alias를 제공한다.
- Web/SSH/Telegram의 `HOME`은 `/data/home`, 작업 디렉터리는 `/config`다. 세 표면은
  OAuth와 사용자 전역·workspace customization을 의도적으로 공유한다.
- 설정과 extension은 [antigravity-contract.md](antigravity-contract.md)의 native
  JSON 경로만 사용한다.
- 로그인은 공식 CLI OAuth 흐름만 사용한다. App option으로 임의 API token을
  주입하지 않는다.

### FR-003 Ingress와 SSH

- Ingress는 외부 ttyd port 없이 Supervisor 인증 뒤에 둔다.
- ttyd는 재접속 가능한 tmux session을 열며 Antigravity 자동 시작은 선택 사항이다.
- SSH는 public key만 허용하고 host key를 `/data`에 보존한다.
- password, empty password와 root remote password login은 허용하지 않는다.

### FR-004 Home Assistant plugin

plugin은 다음 capability를 분리해 제공한다.

- `ha_read`: Core/Supervisor 정보, state, registry, history, trace, logs
- `ha_validate`: configuration check와 변경 후 fresh verification
- `ha_memory`: bounded search, explicit memory, candidate와 change verification
- `playwright`: loopback dashboard. `request-review`의 Telegram auto-allow는 upstream
  `readOnly: true`인 console, network, snapshot, screenshot 네 도구만 제공하며
  navigate/back, tabs, hover, wait, resize, close 등 mutation-capable 도구는 typed
  adapter 전까지 fail closed. explicit `always-proceed`는 installed Playwright
  interaction을 autonomous-admin 범위에 포함
- `ha_change_propose`: typed 변경 preview 생성
- `telegram_action_propose`: terminal/script/choice/question의 non-executing typed proposal
- `ha_files`: `ha_files_list`, `ha_files_read_text`, `ha_files_write_text`로 `/config`,
  `/share`, `/media`, ordinary `/data/home`, `/tmp`, `/var/tmp`만 다루는 confined file
  surface. UTF-8 1 MiB·목록 200개 상한, no-symlink/non-regular/multi-hardlink,
  same-directory atomic write와 optional `expected_sha256`를 강제
- `ha_read`: raw Host/Supervisor log endpoint를 노출하지 않고 exact App token과 알려진
  credential-shaped line/block을 제거한 bounded log projection 제공. arbitrary unkeyed
  application text의 비밀 여부를 완전 판별한다고 주장하지 않음

Telegram Antigravity는 CLI와 같은 `/config` 및 native 사용자 설정 권한을 가지지만
raw Supervisor token을 직접 받지는 않는다. broker 기반 작업은 검증된 proposal과
동일 conversation의 사람 확인을 사용한다.

기존의 “HA용 AGENTS.md preset” 요구는 Antigravity native plugin의 image-managed
`rules/`와 `skills/`로 구현한다. 루트 `AGENTS.md`는 저장소 개발자용이며 runtime
preset으로 복사하지 않는다. 사용자 `/config/AGENTS.md`와 다른 프로젝트 지침은
자동 생성하거나 덮어쓰지 않는다.

### FR-005 메모리

- 저장소는 `/data/antigravity-ha-memory/memory.sqlite3`를 유지한다.
- 구조 catalog와 사용자 semantic memory를 논리적으로 분리한다.
- 첫 bootstrap과 정기 refresh 실패는 memory만 `empty`, `degraded` 또는 `stale`로
  표시하고 Ingress, SSH와 Telegram 조회 서비스의 시작을 막지 않는다.
- 사용자 명시 사실은 `memory_remember_explicit`로 처리한다.
- 다른 학습은 candidate → verified → applied 순서를 지킨다.
- persistent HA 변경은 표현 가능한 경우 `memory_begin_change`와 fresh API 기반
  `memory_verify_change`로 연결한다.

### FR-006 브라우저

- Chromium과 Playwright MCP version을 image lockfile과 build에서 고정한다.
- executable path는 실제 image에서 계약 테스트하고 wrapper와 일치시킨다.
- browser profile과 screenshot은 `/run/antigravity-ha` 아래 임시 저장하고 재시작
  때 제거한다.
- 관리형 browser 사용자는 active, local-only, non-admin이며 sole
  `system-read-only` group이어야 한다.
- Core TLS 오류를 무시하지 않는다.

### FR-007 Telegram

- 기본은 꺼짐이며 기존 bridge 코드를 재사용하지 않는다.
- 허용된 user ID와 chat ID의 교집합만 처리한다.
- Telegram 전용 권한 mode를 두지 않고 global `antigravity_tool_permission`과
  민감정보 option을 Web/SSH와 동일하게 적용한다. 비특권 HAOS와 호환되지 않는 native
  sandbox는 세 채널 모두 사용하지 않고 command/stdio tool executable을 별도 AppArmor
  profile로 전환한다. native sandbox argv override는 거부한다.
- `ha-antigravity-login`의 `/data/home` OAuth, 전역 plugin/agent/rule/MCP와 `/config`
  workspace customization을 공유한다. 최초 OAuth는 Web/SSH controlling TTY가 필요하다.
- 첫 요청 전에 session binding을 영속화하고 `/new` 전까지 유지한다.
- approval callback ACK와 기본 인증은 즉시 처리하되 broker 실행은 requester FIFO에서
  session-serialized한다. 실행 직전 requester/chat/current generation/conversation을
  재검증하고 durable idempotency로 한 번만 접수한다.
- `multi_choice_service_call`은 1~31개의 사전 검증 선택지와 cancel을 4×8 이내의
  inline keyboard로 표시한다. callback에는 opaque token만 넣고 encrypted
  token→choice mapping, proposal digest, requester/session/choice/capability/idempotency를
  재검증해 정확히 하나만 실행한다. 기존 binary callback도 호환한다.
- `terminal_command`, `multi_choice_terminal`, `question`은 exact source/action digest와
  preview를 등록하고 `v4a`/`v4d`/`v4c` opaque callback 뒤 credential-free executor 또는
  same-conversation selection으로 완료한다. commit 이후 불확실성은 `in_doubt`이며
  재실행하지 않는다.
- arbitrary native/plugin MCP permission prompt의 transparent interception/resume은
  지원하지 않는다. proposal로 표현할 수 없는 side effect는 fail closed한다.
- proposal register와 encrypted approval/card sealing 사이의 bridge crash는 registration을
  복구하지 않는다. 사용자가 원래 요청을 다시 보내 새 proposal을 만들며, registration
  자체를 crash-durable로 표현하지 않는다.
- 답변은 전송 전에 암호화된 영속 outbox에 기록하고 Telegram 확인 뒤 제거한다.
- 상세 계약은 [telegram-spec.md](telegram-spec.md)를 따른다.

### FR-008 비밀과 로그

- `SUPERVISOR_TOKEN`, Telegram token, browser token, SSH private key와 민감 파일
  내용은 model, argv, 로그, artifact, screenshot 이름에 넣지 않는다. spawned
  command/stdio tool은 native OAuth backend도 읽을 수 없다. 사용자가 전역 plugin/MCP
  설정에 inline한 secret은 신뢰된 확장 컨텍스트로 이 보장 밖이며 credential-aware
  wrapper나 보호된 환경 참조를 사용한다. OAuth를 사용하는 native parent의
  same-process built-in read 비유출은 실제 HAOS에서 아직 검증되지 않았다.
- 자식 프로세스 환경은 capability별 allowlist로 새로 구성한다.
- 로그는 event type, opaque correlation ID, duration, result code만 기본 기록한다.
- 사용자 prompt와 model raw output은 기본 기록하지 않는다.
- Host/Supervisor log read는 raw endpoint/bytes를 native tool에 주지 않는다. broker가
  line/byte 상한을 적용하고 exact App token과 알려진 credential-shaped line/block을
  제거한다. arbitrary unkeyed application text가 secret인지 완전 판별할 수는 없으므로
  출력은 다시 검토하며 원문 로그를 자동으로 Telegram/artifact에 복사하지 않는다.
- AppArmor는 항상 enforce한다. `antigravity_sensitive_data_access`는 AppArmor를
  끄지 않고 Web/SSH/Telegram Antigravity의 top-level named `Px` 실행 프로필을 선택한다.
- `/config`, `/share`, `/media`, credential이 아닌 persistent HOME, `/tmp`, `/var/tmp`,
  ordinary system binaries, installed MCP와 supported Core/Supervisor manager API는
  operational default-allow다. raw host root/PID/journal mount, Docker socket,
  `full_access`와 다른 App config는 이 범위에 포함되지 않는다.
- `secrets.yaml`, `.storage`, OAuth/cloud credential, runtime token/options,
  App-owned permission/MCP policy, SSH/private key와 credential-bearing cross-process
  `/proc`는 option과 관계없이 read/write를 거부한다. 기본 `false`는 Recorder DB도
  거부하고 `true`만 Recorder DB의 진단용 read를 허용하며 Recorder write는 항상 거부한다.
- browser, memory와 broker에는 이 option을 적용하지 않는다. SSH key, App token,
  backup, SSL private material과 표준 cloud-auth 경로는 두 값 모두 계속 거부한다.

## 4. App 옵션 계약

신규 설치 기본값은 다음과 같다.

```yaml
telegram_enabled: false
telegram_bot_token: ""
telegram_allowed_user_ids: []
telegram_allowed_chat_ids: []
antigravity_tool_permission: request-review
antigravity_terminal_sandbox: false
antigravity_sensitive_data_access: false
antigravity_user_files_update_mode: preserve
home_assistant_browser_auto_auth: true
web_terminal_auto_start_antigravity: false
authorized_keys: []
tmux_session_name: antigravity-ha
log_level: info
```

| 옵션 | 허용값과 의미 |
| --- | --- |
| `telegram_enabled` | bridge 시작 여부. 기본 `false`; `true`는 startup 전 exact managed Telegram permission reconciliation을 함께 활성화 |
| `telegram_bot_token` | secret App option. 로그나 진단 payload에서 제외 |
| `telegram_allowed_user_ids` | Telegram numeric user ID allowlist |
| `telegram_allowed_chat_ids` | Telegram numeric chat ID allowlist |
| `antigravity_tool_permission` | 기본 `request-review`는 URL·managed read와 `ha_files` list/read 허용, `ha_files` write·mutation 검토/proposal-first. explicit `always-proceed`는 mandatory blacklist 밖 command/URL/installed MCP/Playwright interaction의 autonomous-admin mode. native raw file은 두 mode 모두 deny. `strict`/`proceed-in-sandbox`는 legacy upgrade 입력이며 `request-review`로 정규화 |
| `antigravity_terminal_sandbox` | deprecated/no-op compatibility 입력. 어느 값도 native sandbox를 켜지 않으며 모두 `false`로 정규화 |
| `antigravity_sensitive_data_access` | 기본 `false`. AppArmor는 유지한 채 Web/SSH/Telegram child의 Recorder DB 진단용 read-only 여부 선택 |
| `antigravity_user_files_update_mode` | `preserve`, `refresh_managed`, `reset_v2` |
| `home_assistant_browser_auto_auth` | 관리형 read-only browser identity 사용 여부 |
| `web_terminal_auto_start_antigravity` | Ingress tmux 접속 시 CLI 자동 시작 여부 |
| `authorized_keys` | SSH public key 목록 |
| `tmux_session_name` | `[A-Za-z0-9._-]{1,64}` |
| `log_level` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal` |

`antigravity_token`, Codex식 `antigravity_approval_policy`,
`antigravity_sandbox_mode`와 `browser_approval_policy`는 v2 public option이 아니다.
1.1.13 native terminal sandbox는 비특권 HAOS App에서 namespace 생성이 실패하므로
2.0.9에서 사용하지 않는다. 기존 `antigravity_terminal_sandbox`는 schema 호환을 위해
받아들이되 어느 값이든 warning과 함께 `false`로 정규화한다. command와 stdio tool은
AppArmor command profile로 전환하며 이를 위해 host privilege를 늘리지 않는다.
이전 옵션은 migration에서 의미를 보수적으로 변환하거나 사용자 조치가 필요한
항목으로 보고하며 런타임 CLI 인수로 전달하지 않는다.

Supervisor pre-container update 검증과의 호환을 위해 schema만 v1의
`refresh_agents`, `refresh_all`을 migration-only 값으로 임시 수용한다. 이 둘은
v2 user-facing mode가 아니며 첫 안전한 bootstrap 뒤 Supervisor self-options API를
통해 `refresh_managed`로 정규화한다.

`reset_v2`는 사용자가 명시적으로 선택하는 drift 복구 mode다. 안전하게 parse 가능한
settings를 backup하고 기존 ownership state와 무관하게 managed key와
`permissions.allow`/`ask`/`deny` 전체를 exact image default로 교체한다.
`permissions` 밖의 사용자 top-level settings, global MCP/plugin/OAuth와 `/config`는
보존한다. option을 `preserve`로 되돌릴 때까지 매 시작 drift를 다시 복구한다.

2.0.12부터 `telegram_enabled=true`이면 이 option이 `preserve` 또는
`refresh_managed`여도 root-owned single-link regular·256 KiB 이하의 parse 가능한 existing
settings에서 `allowNonWorkspaceAccess`, `artifactReviewPolicy`, `toolPermission`,
`enableTerminalSandbox`와 permission 세 bucket을 transaction backup 뒤 exact Telegram
policy로 reconcile한다. 이 다섯 보안 key 밖의 unrelated top-level settings, global MCP,
plugin, OAuth와 `/config`는 보존하고 mode를 0600으로 강화하되 update mode 자체를
`reset_v2`로 바꾸지 않는다.
같은 canonical input의 재시작은 write와 새 backup이 없는 idempotent 결과여야 한다.
unsafe file, invalid JSON, invalid image default 또는 transaction failure는 partial
recovery 없이 fail closed한다.

2.0.6 이하의 `telegram_access_mode`는 Supervisor update migration이 발견할 수 있는
legacy 입력이지만 2.0.7 runtime 권한 결정에는 사용하지 않는다. 안전한 bootstrap은
이를 제거하고 Telegram도 global Antigravity 권한 option만 사용한다. Supervisor가
schema-filtered `/data/options.json`과 persisted raw option을 분리하므로, 2.0.7은
완료 marker가 없을 때 현재 검증된 전체 option을 self-options API에 한 번 다시 저장해
local file에서 이미 보이지 않는 retired key도 persisted state에서 제거한다.

`antigravity_sensitive_data_access=true`는 Web/SSH/Telegram Antigravity에 동일하게
적용되지만 일반 shell, browser, memory 또는 broker의 권한을 늘리지 않는다.
AppArmor attach/enforce 상태, secrets/storage/token/key의 read/write deny와 Recorder
write deny는 option 값과 무관한 불변조건이다.

## 5. Telegram session·권한 계약

- 권한은 global `antigravity_tool_permission`과 민감정보 option에서 온다. native
  sandbox는 Web/SSH/Telegram 모두 사용하지 않으며 AppArmor command 경계는 option으로
  완화할 수 없다.
- 2.1.0 기본 `request-review`는 URL read, confined `ha_files` list/read와 exact managed
  `ha_change_propose`/`telegram_action_propose`를 사용한다. native headless permission
  prompt는 Telegram에서 resume하지 않는다. 관리형 HA·terminal·script·question
  proposal이 mutation approval 경계이고 표현할 수 없는 side effect는 direct fallback
  없이 fail closed한다. `ha_files_write_text`는 ask다. explicit `always-proceed`는
  mandatory blacklist 밖의 command/URL과 `mcp(*)`를 autonomous-admin으로 허용한다.
  native `read_file(*)`/`write_file(*)`는 두 mode 모두 mandatory deny이고 ordinary file은
  `ha_files`만 사용한다.
- 2.0.12에서 Telegram이 활성화되면 위 effective policy는 일반 preserve merge보다
  우선하는 startup 경계다. 다섯 App 관리 보안 key drift와 permission 세 bucket의
  user-owned rule/stronger deny도 canonical policy로 교체하되 그 밖의 customization과
  별도 global MCP/OAuth는 보존한다. bridge가 init 뒤 이 경계를 재검증하지 못하면
  `permission_boundary_blocked`를 한 번 기록하고 Bot API 요청과 S6 restart 없이 살아
  있는 fail-closed hold에 머문다. 복구한 설정은 App restart 뒤 다시 검증한다.
- `request-review`의 Telegram auto-allow Playwright는 upstream `readOnly: true`인
  `browser_console_messages`, `browser_network_requests`, `browser_snapshot`,
  `browser_take_screenshot`만 포함한다. navigate/back, tabs, hover, wait, resize, close는
  typed approval adapter 전까지 fail closed한다. explicit `always-proceed`에서는 current
  request의 installed Playwright navigation/interaction도 허용한다.
- App 관리 `settings.json`과 native MCP config의 직접 mutation은 self-bypass를 막는
  exact deny다. Telegram customization 변경은 지원되는 root에서 exact
  terminal/script proposal로 승인한 경우에만 실행하며 protected security key/path는
  계속 거부한다.
- session key는 인증된 `(user_id, chat_id)`이며 최초 실행 전에 conversation ID를
  영속 결합한다. approval callback ACK와 control 처리는 즉시 수행하고 broker 실행은
  동일 requester FIFO에서 직렬화하며, 실행 직전 durable session binding을 다시 검증한다.
- choice mapping과 선택은 bridge restart에 대비해 암호화해 보존한다. broker가 계속
  살아 있는 bridge-only restart는 proposal을 재검증해 이어갈 수 있지만 full
  App/broker restart로 미접수 in-memory proposal이 사라지면 오래된 card를 실행하지
  않고 새 요청을 요구한다. 이미 접수된 execution은 durable status/result만 회수한다.
- 정상 conversation은 `/new`가 아니면 교체하지 않는다. native worker가 terminal
  failure로 끝나면 해당 conversation을 quarantine하고 failed update를 durable ACK한 뒤
  다음 사용자 요청에 새 generation/conversation을 결합한다. 실패한 mutation prompt를
  자동 replay하지 않는다.
- model 결과는 암호화된 영속 reply outbox에 먼저 기록하고 Telegram API가 전달을
  확인한 뒤 제거한다. 429처럼 미전송이 명확한 오류만 bounded backoff로 재시도하고,
  crash·network·timeout·5xx처럼 전달 여부가 모호하면 `/retry`까지 격리한다.
- App-managed broker의 고위험 분류는 global policy나 사용자 prompt가 낮출 수 없다.
  자세한 목록과 확인 state machine은 [security.md](security.md)와
  [telegram-spec.md](telegram-spec.md)에 고정한다.

## 6. 비기능 요구사항

- 같은 입력과 App options는 같은 permission 결과를 낸다.
- bridge queue와 API 요청에는 상한, timeout, 취소와 backpressure가 있다.
- 서비스 하나의 실패가 복구용 Ingress와 SSH를 불필요하게 중단하지 않는다.
- update와 migration은 crash-safe, idempotent, recoverable해야 한다.
- Telegram permission mismatch는 Bot API 전에 차단하고 반복 fatal restart로 서비스
  supervisor를 소모하지 않아야 한다.
- image build는 network artifact와 dependency를 version과 digest로 고정한다.
- 한국어 문서를 canonical로 하고 사용자 문서는 한국어·영어를 함께 제공한다.
- 지원을 주장하는 각 아키텍처에서 같은 acceptance suite를 통과한다.
