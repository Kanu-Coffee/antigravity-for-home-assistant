<p align="right">
  <strong>한국어</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="antigravity_home_assistant/logo.png" alt="Antigravity for Home Assistant 로고" width="180">
</p>

<h1 align="center">Antigravity for Home Assistant</h1>

<p align="center">
  Home Assistant 안에서 Google Antigravity CLI를 실행하고,<br>
  안전한 API·브라우저·메모리 도구와 Telegram으로 HAOS를 관리하는 실험 단계 App입니다.
</p>

<p align="center">
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Kanu-Coffee/antigravity-for-home-assistant?include_prereleases"></a>
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml"><img alt="CI" src="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml/badge.svg"></a>
  <img alt="Architecture: amd64 and aarch64" src="https://img.shields.io/badge/architecture-amd64%20%7C%20aarch64-blue">
  <img alt="Stage: experimental" src="https://img.shields.io/badge/stage-experimental-orange">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-green"></a>
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fantigravity-for-home-assistant"><img alt="Home Assistant에 App 저장소 추가" src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg"></a>
</p>

> [!WARNING]
> 이 App은 `/config` 쓰기 권한과 Home Assistant Core·Supervisor 관리자급 API
> 권한을 사용합니다. 신뢰하는 관리자만 설치하고, 변경 전 백업과 preview를
> 확인하세요. 현재 `experimental`이며 실제 HAOS 양쪽 아키텍처의 전체 설치·업데이트·
> rollback 검증은 릴리스별 증거를 확인해야 합니다.

**2.0.13 AppArmor 보안 전환:** 실제 HAOS 18.2 amd64에서 2.0.11→2.0.12
`preserve` 업데이트의 Telegram 자동 권한 복구, Bot 재연결·메시지 전달과 App
재시작/재연결은 통과했습니다. 그러나 같은 기기에서 project custom AppArmor가
attach되지 않고 `docker-default (enforce)`가 관찰되어 AppArmor 항목은 실패했습니다.
2.0.13은 Supervisor의 single-primary scanner와 호환되도록 slug primary 선언 하나만
column 0에 두고 나머지 독립 global `Px` target 선언을 들여쓰며, AppArmor parser가
읽는 23개 profile 이름과 전이는 유지합니다. 의도한 least-privilege deny가 처음
활성화될 수 있으므로 breaking update입니다. aarch64 실기기 검증은 장비 부재로
`NOT RUN`이며 experimental 배포에 한해 소유자가 면제했지만, 이는 PASS가 아닙니다.
2.0.13 custom profile의 실제 HAOS 재검증도 아직 `NOT RUN`입니다.

## v2가 제공하는 것

- 고정된 native Google Antigravity CLI와 `agy` 명령
- Home Assistant용 image-managed plugin, rules, skills, bounded read MCP
- `/config` 설정 검사, Core/App 로그, 제한된 Supervisor API helper
- read-only 관리형 사용자로 HA dashboard를 보는 headless Playwright MCP
- 명시적 사실과 검증된 후보만 보존하는 bounded HA memory
- `/config`와 전역 Antigravity 환경을 그대로 사용하는 비대화형 Telegram bridge
- requester·chat·preview digest·TTL에 묶인 승인 broker
- 항상 enforce되는 AppArmor, exact 민감정보 deny와 선택형 Recorder 진단 read-only profile
- `amd64`와 `aarch64`용 GHCR prebuilt release image

## 빠른 설치

요구사항은 Supervisor가 있는 Home Assistant OS 또는 Supervised 환경, `amd64` 또는
`aarch64` 장치, 인터넷 연결, Antigravity를 사용할 Google 계정입니다. HACS로
설치하는 통합이 아닙니다.

1. Home Assistant에서 **설정 → Apps → App store → Repositories**를 엽니다.
2. 다음 저장소 URL을 추가합니다.

   ```text
   https://github.com/Kanu-Coffee/antigravity-for-home-assistant
   ```

3. **Antigravity for Home Assistant**를 설치하고 기본 설정으로 시작합니다.
   릴리스 App은 장치에서 소스를 빌드하지 않고
   `ghcr.io/kanu-coffee/antigravity-for-home-assistant`의 아키텍처별 이미지를
   받습니다.
4. **OPEN WEB UI**에서 최초 한 번 native OAuth를 시작합니다.

   ```bash
   ha-antigravity-login
   ```

5. CLI가 보여 주는 Google 인증 절차를 완료한 뒤 새 세션을 시작합니다.

   ```bash
   agy
   ```

`ha-antigravity-login`은 별도 로그인 subcommand를 흉내 내지 않고 controlling TTY에서
공식 Antigravity first-run OAuth를 실행합니다. OAuth 자료를 출력하거나 이슈에
첨부하지 마세요.

## Telegram 설정

> [!CAUTION]
> Telegram은 CLI와 동등한 **관리자 주 채널**입니다. 허용된 Telegram 사용자는
> 공유 OAuth identity와 `/config`, 전역 customization을 사용하며, 승인 카드를 통해
> 기기·설정·terminal/script 작업을 실행할 수 있습니다. OAuth 자료, App 소유 권한
> 설정과 민감 경로는 직접 수정할 수 없습니다. bot token, 허용된 chat과 Telegram
> 계정을 HA 관리자 credential처럼 보호하세요. amd64의 기본 Bot API 재연결·전달과
> App 재시작은 2.0.12에서 확인됐지만, OAuth, 전체 승인/mutation 행렬, 2.0.13 custom
> AppArmor와 aarch64 실기기 E2E는 아직 완료되지 않았습니다.

Web UI 또는 SSH에서 `ha-antigravity-login`으로 공식 native first-run OAuth를 한 번
완료한 뒤 bot을 활성화합니다. 별도 Telegram identity, `ha-telegram-login`, 전용 HOME
bootstrap은 사용하지 않습니다.

[@BotFather](https://t.me/botfather)에서 bot token을 만든 뒤 다음 두 인증 방법 중
하나를 선택합니다.

### 정적 허용 목록

App 설정에 사용자 ID와 채팅 ID를 모두 넣습니다. 요청은 두 목록의 교집합에
포함될 때만 허용됩니다. 어느 한 목록만 채우면 인증되지 않습니다.

```yaml
telegram_enabled: true
telegram_bot_token: "REDACTED"
telegram_allowed_user_ids:
  - "123456789"
telegram_allowed_chat_ids:
  - "123456789"
```

### 로컬 일회용 pairing

Web UI 또는 SSH의 로컬 셸에서 token을 만들고 만료 전에 같은 bot에 전송합니다.

```bash
ha-telegram-pair create --ttl 5m
```

Telegram에서 `/start TOKEN`을 보냅니다. token은 한 번만 표시되고 한 번만 사용할
수 있으므로 비밀로 취급합니다. 승인 목록은 `ha-telegram-pair list`, 철회는
`ha-telegram-pair revoke AUTHORIZATION_ID`로 관리합니다. PIN, 자동 deep link,
`/unpair`는 v2 계약이 아닙니다.

Bot pairing은 관리자급 Antigravity 환경에 접근할 Telegram user/chat을 승인합니다.
`/start`, `/help`, `/status`, `/new`, `/cancel`은 AI prompt가 아니라 bridge가 직접
처리하는 로컬 제어 명령입니다. 최초 자연어 요청은 user/chat에 대화 session을 먼저
영속 결합하고 이후 요청과 승인·응답은 같은 session에서 직렬 처리합니다. 오직
명시적인 `/new`만 새 session으로 회전합니다. 로그인 필요 안내가 나오면 credential
파일을 찾거나 복사하지 말고 신뢰하는 App 터미널에서 `ha-antigravity-login`을
실행하세요.

Telegram을 먼저 활성화했더라도 bridge는 Bot API에 연결하지 않고
`waiting_for_authorization` 상태로 조용히 대기합니다. 같은 App 터미널에서 pairing을
생성하면 App을 재시작하지 않아도 이를 감지해 연결을 계속합니다.

### 공유 권한 정책

Telegram 전용 mode는 없습니다. Telegram은 Web/SSH와 같은
`antigravity_tool_permission`과 `antigravity_sensitive_data_access` 설정을 따릅니다.
Antigravity 1.1.13의 native `--sandbox`는 비특권 HAOS App에서 필요한 namespace를
만들 수 없어 `operation not permitted`로 실패합니다. 2.0.9는 세 채널 모두 이 nested
sandbox를 사용하지 않고, model이 시작한 command와 stdio tool을 별도
`antigravity_home_assistant-command` AppArmor 프로필로 `Px` 전환합니다. 이 경계는
공유 OAuth와 App 관리 settings를 command/tool descendant에서 차단하면서 일반
`/config`, network와 제한 helper 작업은 유지합니다. 이를 위해 `full_access`,
`SYS_ADMIN`, 보호 모드 해제 같은 HAOS 권한을 추가하지 않습니다.
`antigravity_terminal_sandbox`는 deprecated/no-op compatibility 입력이며 `true`와
`false` 모두 `false`로 정규화됩니다. wrapper는 사용자가 native sandbox flag를
덮어쓰는 것도 거부합니다. 2.0.6 이하의
`telegram_access_mode` 값은 권한으로 사용하지 않는 migration-only 입력입니다.
2.0.11 새 설치와 Telegram의 유일한 effective native 값은 `request-review`입니다.
고정 CLI의 headless 가용성 때문에 `strict`, `always-proceed`,
`proceed-in-sandbox` option은 user-files updater에서 모두 `request-review`로
정규화됩니다. schema가 세 legacy 값을 계속 받는 것은 기존 Supervisor option으로
업그레이드를 시작하기 위한 입력 호환성일 뿐입니다. 2.0.9/2.0.10의 App 소유
`always-proceed`·`mcp(*)`·`command(*)` broad-allow 설정은 안전하게 식별되는 경우
bounded native read와 정확한 managed proposal MCP만 허용하는 정책으로
migration됩니다. Telegram이 꺼져 있으면 기존 `preserve` 소유권 규칙대로 사용자
permission을 보존합니다. 2.0.12부터 Telegram이 켜져 있으면 시작 전에 root 소유
single-link regular이고 256 KiB 이하이며 parse 가능한 settings를 transaction backup하고,
`allowNonWorkspaceAccess=false`, `artifactReviewPolicy=agent-decides`,
`enableTerminalSandbox=false`, `toolPermission=request-review`와 permission 세 bucket
(29 allow/0 ask/33 deny)을 exact safe policy로 정규화합니다. unknown custom
allow/ask/deny는 제거하지만 이 다섯 App 관리 보안 key 밖의 top-level 설정, global MCP,
plugin, OAuth와 `/config`는 보존합니다. 기존 mode가 0600이 아니면 transaction에서
0600으로 강화합니다. symlink/hardlink/non-root owner, 크기 초과 또는 parse 불가능한
JSON은 수정하지 않으며, bridge는 sanitized
`permission_boundary_blocked`를 한 번 기록하고 Bot API에 접속하거나 재시작 loop를
만들지 않은 채 대기합니다. 관리자가 `reset_v2` 또는 안전한 파일 복구를 적용한 뒤
App을 재시작해야 합니다.
일반 command, native write, URL 실행, interactive browser, 임의 mutation MCP는
unattended allow 목록에 없습니다. `secrets.yaml`, `.storage`, App runtime/browser/bot
token, SSH/private key, native MCP 설정과 표준 cloud-auth 경로의 직접 읽기·쓰기는
계속 exact deny입니다.

Telegram에서 자동 허용되는 Playwright 도구는 upstream이 `readOnly: true`로 선언한
`browser_console_messages`, `browser_network_requests`, `browser_snapshot`,
`browser_take_screenshot` 네 개뿐입니다. `browser_navigate`, `browser_navigate_back`,
`browser_tabs`, `browser_hover`, `browser_wait_for`, `browser_resize`, `browser_close`를
포함한 mutation-capable 브라우저 도구는 typed approval adapter가 생기기 전까지
fail closed합니다.

bridge는 pipe된 stdin으로 질문을 받고 같은 `/data/home`과 `/config`에서 공유
`antigravity --output-format stream-json` launcher를 실행합니다. 별도 shell이나 공유
tmux에 입력을 주입하지 않지만 CLI와 같은 전역
설정·plugin·agent·rule·권한 정책을 상속합니다. 생성된 답변은 암호화된 영속 outbox에
기록한 뒤 Telegram 전송 확인 시 제거합니다. 429처럼 미전송이 명확한 오류만 bounded
backoff로 재시도하고 전달 여부가 모호하면 `/retry` 전까지 격리합니다.

2.0.11의 Telegram 경로는 **제안 먼저(proposal-first)** 동작합니다. 안전한 상태·로그·
설정 조회는 bounded read MCP로 바로 수행합니다. HA service/config 변경은
`ha_change_propose`, terminal command·inline script·명령 선택지·유한 질문은
`telegram_action_propose`로 먼저 등록합니다. proposal MCP는 실행 권한이나
credential을 갖지 않으며 exact action digest와 public preview만 등록합니다. bridge가
requester·chat·session generation·update·conversation·TTL에 결합한 Telegram 카드를
보내고, 사용자가 opaque 버튼을 누른 뒤에만 credential-free executor 또는 HA broker가
미리 검증된 동작 하나를 실행합니다. commit 후 결과를 확정할 수 없으면 재실행하지
않고 `in_doubt`로 보고합니다. 승인 결과는 같은 Antigravity conversation의 새 turn으로
전달됩니다.

HA broker는 모든 live HA domain/service의 bounded `service_data`와 일반 YAML patch를
지원합니다. 승인된 service call은 live `/api/services` 검증 뒤 실행하고, YAML은
expected digest, atomic backup/write, `ha-config-check`, 실패 시 exact rollback을
적용합니다. terminal/script executor는 승인된 exact source, canonical cwd, timeout만
받고 별도 AppArmor command profile에서 실행하며 App token이나 native OAuth를 받지
않습니다. shell-visible background/daemon pattern은 실행 직전에 거부하지만 opaque
interpreter의 double-fork를 cgroup처럼 완전히 격리하지는 못하므로 daemon 작업은 지원하지
않고, 완료 여부가 불명확하면 `in_doubt`로 끝냅니다. `question`은 부작용 없이 선택
label을 conversation에 돌려줍니다.

2.0.10부터 HA broker는 하나의 질문에 상호 배타적인 1~31개 service call을 담는
`multi_choice_service_call`도 지원합니다. Telegram은 취소를 포함해 최대 32개 버튼을
행당 최대 4개, 최대 8행으로 표시합니다. 선택 callback은 실행 파라미터가 아닌 짧은
opaque token만 전달하며, bridge가 암호화해 저장한 token→choice binding과 broker의
requester·session generation·conversation·proposal digest·choice·idempotency
binding을 모두 재검증한 뒤 사전 검증된 선택지 하나만 실행합니다. 새 `v3c`/`v3d`
choice/cancel callback과 기존 `v2a`/`v2d` 실행/취소 카드는 함께 지원됩니다.

2.0.11의 `multi_choice_terminal`과 `question`도 1~31개 선택지와 취소를 같은 4×8
grid에 표시합니다. action callback은 `v4a`/`v4d`/`v4c`이며 command, script 또는
선택 payload 대신 짧은 encrypted-state token만 운반합니다. `/cancel`은 아직 pending
또는 approved인 action을 취소하지만 이미 committed된 실행을 rollback하지 않습니다.
TTL cleanup은 untouched pending card만 만료하며 durable decision/result는 callback ACK
전까지 보존합니다.

choice mapping과 선택 결과는 bridge 재시작에 대비해 영속화되지만, 아직 실행을
접수하지 않은 proposal 자체는 change broker의 메모리에만 있습니다. 따라서 bridge만
재시작되고 broker가 계속 살아 있으면 카드를 재검증할 수 있지만, App 전체 또는
broker가 재시작되어 proposal이 사라졌다면 오래된 카드를 실행하지 않고 새 요청을
요구합니다. broker가 이미 접수한 실행의 완료 결과는 durable idempotency/status로
회수하며 같은 변경을 다시 실행하지 않습니다.

proposal MCP가 coordinator에 등록한 사실 자체는 crash-durable하지 않습니다. 특히
등록 성공 뒤 bridge가 encrypted approval state와 card/outbox를 봉인하기 전에
종료되면 복구할 승인 카드가 없으므로 사용자가 원래 요청을 다시 보내 새 proposal을
만들어야 합니다. 문서의 durable 보장은 이 봉인 이후의 approval decision/result와
broker가 접수한 실행에만 적용됩니다.

2.0.11 stream parser는 필수 `Arguments`/`ServerName`/`ToolName`에 더해 bounded 문자열
`toolAction`/`toolSummary` metadata를 허용합니다. 정확히 하나의 완료된 유효 proposal
receipt가 있는데 terminal text만 비어 있으면 고정된 안전 문구를 넣어 승인 카드를
계속 전달합니다. proposal이 없는 빈 응답, 알 수 없는 parameter key, non-string 또는
과대 응답은 계속 fail closed합니다.

중요한 한계가 있습니다. 고정 CLI 1.1.13의 `--print --output-format stream-json`은
native permission request를 외부로 내보내 승인 뒤 중단 지점에서 재개하는 protocol을
제공하지 않습니다. 따라서 App은 임의의 미래/user plugin MCP를 투명하게 가로채는
것처럼 주장하지 않습니다. 현재 관리형 HA·terminal·script·question 동작은 위 두
proposal MCP로 지원하고, bridge가 표현할 수 없는 Telegram side effect는 direct tool로
우회하지 않고 fail closed합니다. native permission denial이 발생하면 bridge는 한 번
같은 conversation에 proposal 사용을 요청해 재계획하지만 거부된 tool 자체를 재개하거나
승인으로 간주하지 않습니다. 인증된 Web/SSH의 대화형 작업은 native review 아래 direct
tool을 쓸 수 있으며 Telegram 카드로 자동 변환되지 않습니다.

이미 공유 OAuth가 인증되어 있다면 일상적인 지원 작업은 Telegram만으로 처리할 수
있습니다. 그러나 native 최초 OAuth는 여전히 controlling TTY가 필요하므로 미인증 설치는
Web terminal 또는 SSH에서 `ha-antigravity-login`을 한 번 실행해야 합니다. 실제 HAOS
AppArmor, native OAuth, live Bot API 카드/callback과 실제 기기 변경 E2E는 릴리스 증거가
생기기 전까지 `NOT RUN`입니다.

## 안전 기본값

- AppArmor는 항상 켜져 있으며 App 옵션으로 끌 수 없습니다.
- `secrets.yaml`, `.storage`, App 소유 runtime token/options, SSH/private key와 표준
  cloud-auth 경로는 `antigravity_sensitive_data_access` 값과 관계없이 직접
  읽기·쓰기가 거부됩니다. spawned command/stdio tool은 native OAuth backend도 읽을
  수 없습니다.
- `antigravity_sensitive_data_access: false`가 기본값이며 Recorder DB도 읽거나 쓸 수
  없습니다. 값을 `true`로 바꾸면 Web/SSH/Telegram Antigravity runtime에 Recorder DB와
  sidecar의 진단용 읽기만 허용하고 쓰기·이름 변경·삭제는 계속 거부합니다.
- browser, memory, broker와 일반 shell에는 이 권한이 전달되지 않습니다.
- SSH private key, App token, backup, SSL private material과 표준 cloud-auth 경로는
  두 설정 모두 차단됩니다. 전역 plugin/MCP 설정에는 inline secret을 넣지 말고
  credential-aware wrapper나 보호된 환경 참조를 사용하세요.
- native default이자 Telegram의 유일한 effective 값은 `request-review`입니다.
  `strict`와 legacy autonomous option도 user-files updater가 이 값으로 정규화하며,
  schema의 다른 값은 upgrade 입력 호환용입니다. AppArmor command-profile 전환과
  proposal approval은 App option으로 해제할 수 없고 native terminal sandbox는
  사용하지 않습니다.
- Web/SSH/Telegram Antigravity는 의도적으로 `/data/home`의 OAuth와 사용자 설정,
  `/config` 프로젝트를 공유합니다. 따라서 Telegram prompt가 유도한 credential·설정
  접근과 정상 접근을 AppArmor만으로 구분할 수 없으며, 정확한 user/chat 인증과
  Telegram 계정 보호가 관리자 경계입니다. primary OAuth backend의 실제 경로와
  same-process built-in read 비유출은 실제 HAOS에서 아직 검증되지 않았습니다.

SSH는 공개키만 허용합니다. TCP `2224`를 인터넷에 직접 노출하지 말고 신뢰하는
VPN을 사용하세요.

## 업데이트와 migration

`antigravity_user_files_update_mode`의 기본값은 `preserve`입니다.

| 값 | 동작 |
| --- | --- |
| `preserve` | OAuth와 사용자 소유 settings·MCP·plugin을 보존; Telegram enabled이면 안전한 settings의 다섯 App 관리 보안 key와 permission 세 bucket을 exact policy로 자동 정규화; App 소유 HA plugin은 version당 보안 갱신 |
| `refresh_managed` | 위 보존 원칙과 plugin 갱신에 더해 소유권이 기록된 settings key·permission rule을 backup 후 merge |
| `reset_v2` | 명시적 복구 mode. 안전하게 parse 가능한 settings를 backup하고 ownership state와 무관하게 managed key와 permission 세 bucket을 image exact default로 교체 |

`reset_v2`는 `permissions` 밖의 사용자 top-level settings, 기존 global MCP,
사용자 plugin, `/config`, OAuth, SSH key, browser identity와 memory를 보존합니다.
대신 managed key와 `permissions.allow`/`ask`/`deny` 전체는 현재 image 기본값과 정확히
맞추며, 기존 App ownership state가 없거나 모호해도 명시적으로 선택한 복구 작업을
수행합니다. 안전한 regular file로 읽거나 JSON으로 parse할 수 없으면 fail closed합니다.
option을 `preserve`로 되돌릴 때까지 매 시작 drift를 다시 복구하므로 정상화 뒤에는
`preserve`로 변경하세요. mode와 관계없이 App 소유 `home-assistant` plugin은 안전한
ownership marker가 있을 때 App version당 한 번 canonical image copy로 갱신됩니다.
같은 이름의 marker 없는 plugin은 사용자 소유 충돌로 보고 시작을 중단합니다. 업데이트 전 Home Assistant
전체 backup과 현재 동작 version/image를 기록하고, 실패하면
`preserve`로 되돌린 뒤 이전 immutable version과 검증된 scoped backup으로
복구하세요. 자동 HAOS rollback은 보장하지 않습니다.

Telegram-enabled 자동 정규화는 mode를 `reset_v2`로 바꾸지 않습니다. 같은
journal/backup transaction으로 한 번 적용되며, 다음 재시작에서는 설정과 ownership이
일치하면 추가 backup 없이 끝납니다. Telegram이 꺼져 있으면 기존 `preserve`의 사용자
permission 보존 의미가 유지됩니다.

개발용 source image는 `tools/development/build-app`으로만 빌드합니다. 이 helper는
checkout hash로 분리한 project-owned Buildx builder/cache만 종료 시 제거하고 global
Docker prune을 하지 않으며, 이 checkout label을 가진 미참조 local image도 최신 두 개를
보존합니다. release workflow는 stable `antigravity-home-assistant` GHA cache scope를
사용합니다. App runtime에서는 성공한 복구·갱신·config transaction 뒤 소유
manifest가 검증된 완료 managed-plugin, native user-files refresh, change-broker config
backup을 각 범주별 최신 두 개로 제한합니다. active journal/result, 소유 불명·
malformed·unsafe backup은 자동 삭제하지 않습니다. HA memory는 매 refresh의 미참조
종료 기록을 최신 64개로 제한하되 현재 catalog/revision/change/audit가 참조하는 sync와
의미 있는 history는 보존합니다. refresh 도중 비정상 종료된 `running` 행은 안전한
lease 판별이 없어 자동 삭제하지 않습니다.

HAOS의 App 업데이트는 위 개발 빌드 캐시를 사용하지 않습니다. 이 저장소는 Home
Assistant가 권장하는 generic GHCR prebuilt image를 배포하므로 장치에서는 최종 image를
pull하고, 성공한 교체 뒤 구버전 image 정리는 Supervisor가 담당합니다. 공유 layer나
다른 App이 쓰는 image ID는 유지되는 것이 정상입니다. 이 App은 Docker socket,
`docker_api`, `full_access`를 추가하거나 update 때 global prune 또는
`/supervisor/repair`를 자동 실행하지 않습니다. 용량 증가가 의심되면 Telegram의
`ha_read_storage_usage`와 Supervisor 로그로 system/App data/config/backup을 먼저
구분하세요. `repair`는 stale overlay/image 장애가 실제로 확인된 뒤 관리자가 별도로
승인할 광범위한 복구 작업입니다. 실제 HAOS 업데이트 전후 용량 관찰은 아직
`NOT RUN`입니다.

## 문서와 검증 상태

- [한국어 App 사용 설명서](antigravity_home_assistant/DOCS.md)
- [English App user guide](antigravity_home_assistant/DOCS.en.md)
- [v2 개발 계약과 체크리스트](docs/v2/README.md)
- [릴리스와 변경 이력](antigravity_home_assistant/CHANGELOG.md)

저장소 테스트는 native CLI 계약, Telegram broker, read broker, memory, browser,
migration과 AppArmor 정책을 검사합니다. 그러나 generic Linux의 parse/build 성공은
실제 HAOS AppArmor enforce나 양쪽 아키텍처 runtime 성공의 대체 증거가 아닙니다.
설치 전 해당 릴리스의 CI, GHCR multi-arch manifest와 HAOS 검증 기록을 확인하세요.

## 라이선스

[Apache License 2.0](LICENSE)
