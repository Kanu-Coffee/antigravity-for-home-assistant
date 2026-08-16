# Antigravity 1.1.13 통합 계약

## 1. 고정 기준

현재 v2 App은 Google Antigravity CLI `1.1.13`을 고정한다. 이 문서의 명령은
image 안의 `/usr/local/libexec/antigravity-real --help`로 확인한 계약을 기준으로
한다. 버전을 변경할 때는 이 문서, help snapshot, wrapper
contract test와 두 아키텍처 smoke를 같은 변경에서 갱신한다.

### 1.1 런타임 self-updater 차단

Antigravity 1.1.13에는 background self-updater가 있다. GHCR image에 고정한 binary가
App 실행 중 다른 version을 내려받거나 실행하면 version/digest pin과 rollback 증거가
무효가 되므로, 모든 native CLI launch는 다음 환경을 강제한다.

```text
AGY_CLI_DISABLE_AUTO_UPDATE=true
```

이 값은 interactive wrapper, Telegram shared-runtime invocation, plugin validation/install과
startup/update smoke를 포함해 native binary에 도달하는 모든 `env -i`/child environment
allowlist에 명시한다. 사용자 option, inherited environment 또는 native JSON settings로
끄고 켤 수 없으며, wrapper가 받은 같은 이름의 사용자 값을 그대로 전달하지 않는다.
Antigravity version 변경은 검증된 새 App image 배포로만 수행한다.

2026-08-11 실제 1.1.11 clean-HOME probe에서는 opt-out 미설정 시 background updater
spawn count가 1, `AGY_CLI_DISABLE_AUTO_UPDATE=true` 설정 시 0이었다. 이는 native
opt-out 동작의 좁은 canary일 뿐 현재 App의 모든 launch path가 값을 전달한다는 PASS
증거는 아니다. `AG-014`와 두 architecture image/HAOS 검증 전에는 구현 완료로
표시하지 않는다.

공식 참고 자료:

- [CLI features와 settings](https://antigravity.google/docs/cli-features)
- [CLI reference](https://antigravity.google/docs/cli-reference)
- [Plugins and skills](https://antigravity.google/docs/cli/plugins)
- [MCP configuration](https://antigravity.google/docs/mcp)
- [Permissions](https://antigravity.google/docs/cli-permissions)

## 2. 확인된 CLI 표면

### 2.1 top-level flags

```text
--add-dir
--agent
-c, --continue
--conversation
--dangerously-skip-permissions
--disable-slash-commands
--effort
-i, --prompt-interactive
--json-schema
--log-file
--mode accept-edits|plan
--model
--new-project
--output-format text|json|stream-json
-p, --print
--print-timeout
--project
--prompt
--sandbox
```

### 2.2 subcommands

```text
agent, agents, changelog, help, install, models, plugin, plugins, update
```

`plugin`은 다음 명령을 제공한다.

```text
list
import [source]
install <target>
uninstall <name>
enable <name>
disable <name>
validate [path]
link <marketplace> <target>
help
```

### 2.3 금지된 Codex 호환 추정

- `-c`는 config override가 아니라 `--continue`다.
- `agy -c approval_policy=...`와 `agy -c sandbox_mode=...`를 사용하지 않는다.
- `debug prompt-input`, `login`, `mcp` subcommand는 1.1.13 top-level 계약에 없다.
- `config.toml`, `approval_policy`, `sandbox_mode`, Codex per-tool approval flag를
  생성하거나 주입하지 않는다.
- `ANTIGRAVITY_TOKEN` 또는 `GEMINI_API_KEY`가 공식 App 인증 계약이라고 가정하지
  않는다.
- `--dangerously-skip-permissions`는 App wrapper와 Telegram에서 금지한다.

## 3. native 저장 경로

Web/SSH/Telegram App은 `HOME=/data/home`과 project `/config`를 공유하므로 native
경로는 다음과 같다.

| 역할 | native 경로 |
| --- | --- |
| CLI settings | `/data/home/.gemini/antigravity-cli/settings.json` |
| global MCP | `/data/home/.gemini/config/mcp_config.json` |
| global manually discovered plugin | `/data/home/.gemini/config/plugins/home-assistant/` |
| CLI-installed plugin staging | `/data/home/.gemini/antigravity-cli/plugins/<plugin_name>/` |
| workspace MCP | `/config/.agents/mcp_config.json` |
| workspace plugin | `/config/.agents/plugins/<plugin_name>/` 또는 `/config/_agents/plugins/<plugin_name>/` |

Telegram은 위 global/workspace plugin, agent, rule, MCP와 settings를 상속하고 사용자의
관리 요청에 따라 수정할 수 있다. OAuth는 trusted local controlling TTY의
`ha-antigravity-login`으로 한 번 수행하며 별도 Telegram HOME·login·bootstrap을 두지
않는다.

v2 App 관리형 `home-assistant` plugin은 global manually discovered 경로를
canonical 배치로 사용한다. 같은 이름을 CLI staging 또는 workspace에 동시에
설치한 경우 중복 로드를 허용하지 않고 상태 명령으로 충돌을 보고한다. 사용자
workspace plugin은 자동 삭제하지 않는다.

## 4. settings 계약

`settings.json`은 sparse JSON으로 관리한다. 기존 알 수 없는 key를 보존하며
App이 소유한 key만 merge한다. 최소 관리 key는 다음과 같다.

```json
{
  "toolPermission": "request-review",
  "permissions": {
    "allow": [
      "read_file(/config)",
      "write_file(/config)",
      "read_file(/data/home/.gemini/config)",
      "write_file(/data/home/.gemini/config)",
      "read_file(/data/home/.gemini/antigravity-cli/agents)",
      "write_file(/data/home/.gemini/antigravity-cli/agents)",
      "read_file(/data/home/.gemini/antigravity-cli/plugins)",
      "write_file(/data/home/.gemini/antigravity-cli/plugins)",
      "read_file(/data/home/.gemini/antigravity-cli/skills)",
      "write_file(/data/home/.gemini/antigravity-cli/skills)",
      "read_file(/data/home/.gemini/GEMINI.md)",
      "write_file(/data/home/.gemini/GEMINI.md)",
      "read_file(/data/home/.gemini/antigravity-cli/settings.json)",
      "write_file(/data/home/.gemini/antigravity-cli/settings.json)"
    ],
    "ask": [
      "command(*)",
      "mcp(home-assistant/*)"
    ],
    "deny": [
      "command(sudo)",
      "command(rm -rf)",
      "write_file(.git/)",
      "read_file(/config/secrets.yaml)",
      "read_file(/config/.storage)",
      "write_file(/config/secrets.yaml)",
      "write_file(/config/.storage)"
    ]
  }
}
```

1.1.13의 directory target은 재귀이며 deny가 ask와 allow보다 우선한다. 그래서 위
shared customization/workspace root는 Web/SSH/Telegram에 공통으로 허용하되 OAuth가
있는 `.gemini` 전체를 wildcard로 열지 않고, `/config`의 secret·storage 경로는 native
deny와 AppArmor deny를 함께 유지한다. 2.0.6의 `read_file(/data)`와
`write_file(/data)`는 새 allow보다 우선하므로 managed ownership migration에서
명시적으로 제거한다.

`antigravity_tool_permission`은 `toolPermission`에 다음과 같이 1:1 매핑한다.

| App option | native value | App 의미 |
| --- | --- | --- |
| `request-review` | `request-review` | write, command와 web action을 TUI에서 검토 |
| `proceed-in-sandbox` | `proceed-in-sandbox` | sandbox 안의 허용 동작만 자동 진행 |
| `always-proceed` | `always-proceed` | native prompt를 줄이지만 AppArmor와 broker는 유지 |
| `strict` | `strict` | 모든 non-read 작업을 확인 |

1.1.13 `stream-json`은 native permission request를 외부 channel에 전달하고 승인 뒤
같은 turn을 재개하는 입력 protocol이 없다. Telegram의 사람 확인은 관리형 HA broker
proposal에만 제공하며, 그 밖의 ask rule은 Web/SSH TUI 또는 global permission 변경이
필요하다. Telegram 전용 skip-permission이나 auto-approve 설정은 만들지 않는다.

Antigravity 1.1.13은 system default와 같은 값을 저장하지 않는 sparse persistence를
적용한다. 따라서 `agy agent`가 `request-review`를 읽으면 redundant
`toolPermission` key를 제거할 수 있다. 이 경우에도 App이 생성한
`permissions.allow`, `permissions.ask`, `permissions.deny`가 native authorization
계약이며 세 bucket과 ownership rule 전체를 검증해야 한다. 사용자 설정 보존 테스트는
같은 이유로 default `colorScheme: "terminal"` 대신 CLI가 왕복 보존하는 공식
non-default `colorScheme: "tokyo night"`를 사용한다.

1.1.13은 공유 native CLI HOME의 `antigravity-cli/cli.log`를 같은 directory 아래
`log/cli-YYYYMMDD_HHMMSS.log`를 가리키는 상대 symlink로 만든다. public v1 update
canary는 `/data/home`의 이 exact 경로만 허용하며, link가
root 소유이고 CLI root와 `log` parent가 모두 root 소유 real 0700 directory인지
확인한다. clean v2가 만든 target은 root 소유, single-link regular 0600 file이다.
public v1에서 그대로 보존된 target은 enclosing directory가 위 조건을 만족할 때만
legacy 0644도 허용한다. resolved log target은 두 mode 모두 secret canary scan에서
제외하지 않으며 그 밖의 symlink와 hardlink는 실패한다.

public v1 update evidence는 native sparse 재직렬화를 byte 보존으로 과장하지 않는다.
settings는 file metadata와 공식 key의 semantic 보존을, global MCP는 byte 보존을 서로
다른 machine field로 기록한다.

permission precedence는 native 규칙대로 deny > ask > allow다. AppArmor deny와
broker의 고위험 정책은 `always-proceed`로도 완화되지 않는다.

`antigravity_terminal_sandbox=true`는 Web/SSH/Telegram wrapper에 `--sandbox`를
추가한다. false는 세 표면에서 이 CLI flag만 생략하며 AppArmor를 끄지 않는다.

## 5. plugin 계약

image source는 다음 형태다.

```text
/usr/local/share/antigravity-ha/plugins/home-assistant/
├─ plugin.json
├─ mcp_config.json
├─ rules/
│  └─ home-assistant-safety.md
└─ skills/
   ├─ ha-change-proposal/SKILL.md
   ├─ ha-dashboard/SKILL.md
   ├─ ha-feedback/SKILL.md
   ├─ ha-memory/SKILL.md
   └─ home-assistant-operations/SKILL.md
```

최소 manifest는 공식 schema를 사용한다.

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "home-assistant",
  "description": "Safe Home Assistant API, memory, browser, and change workflows"
}
```

init은 image source와 설치된 copy 모두에
`agy plugin validate <path>`를 실행한다. 설치는 temporary directory에서
완성한 뒤 rename하며, manifest name이 `home-assistant`가 아니거나 unknown
schema가 있으면 기존 verified copy를 유지하고 새 plugin을 활성화하지 않는다.

plugin rules에는 일반 안전 지침만 둔다. entity alias, 사용자 선호, 실제 집의
관계와 현재 상태를 rules 또는 `AGENTS.md`에 기록하지 않는다.

Home Assistant preset의 canonical 구현은 이 plugin의 `rules/`와 `skills/`다.
루트 `AGENTS.md`는 개발 session용이고 image에 runtime preset으로 복사하지 않는다.
기존 사용자 `/config/AGENTS.md`는 별도의 workspace guidance일 수 있으므로 App이
생성·merge·갱신하지 않는다.

## 6. MCP 계약

MCP 설정은 `mcpServers` object를 사용하는 JSON이다. App 관리 server는 plugin의
`mcp_config.json`에 두어 plugin과 함께 versioning한다. global
`~/.gemini/config/mcp_config.json`에 있는 사용자 server는 보존한다.

```json
{
  "mcpServers": {
    "ha_read": {
      "command": "/usr/local/bin/ha-read-mcp",
      "args": [],
      "cwd": "/config"
    },
    "ha_validate": {
      "command": "/usr/local/bin/ha-validate-mcp",
      "args": [],
      "cwd": "/config"
    },
    "ha_memory": {
      "command": "/usr/local/bin/ha-memory-mcp",
      "args": [],
      "cwd": "/config"
    },
    "playwright": {
      "command": "/usr/local/bin/ha-playwright-mcp",
      "args": [],
      "cwd": "/config",
      "disabledTools": [
        "browser_evaluate",
        "browser_file_upload",
        "browser_handle_dialog",
        "browser_install",
        "browser_run_code"
      ]
    },
    "ha_change": {
      "command": "/usr/local/bin/ha-change-proposal-mcp",
      "args": [],
      "cwd": "/config"
    }
  }
}
```

- server command는 절대 경로다.
- `env`에는 Supervisor, Telegram, OAuth 또는 browser token을 넣지 않는다.
- server wrapper는 inherited environment를 지우고 고정 allowlist만 전달한다.
- write capability는 MCP server의 일반 process environment가 아니라 broker의
  peer credential과 1회용 Unix socket capability로 검증한다.
- remote MCP를 image 기본값으로 등록하지 않는다.
- legacy `url`이나 `httpUrl`을 생성하지 않으며 remote server가 필요해질 때는
  현재 공식 `serverUrl` schema를 사용한다.

## 7. 실행 명령

### 7.1 대화형

일반 시작은 `/config`를 current working directory로 하고 다음과 같다.

```text
agy
agy --sandbox
```

wrapper는 HOME, PATH, locale과 non-secret endpoint만 정규화한 뒤 실제 binary를
`exec`한다. 사용자의 나머지 argv는 순서를 보존해 그대로 전달한다.

로그인 helper는 존재하지 않는 `login` subcommand를 호출하지 않는다. 공식
first-run OAuth가 가능한 controlling TTY에서 `agy`를 실행하고 안내만 제공한다.

### 7.2 Telegram non-interactive

새 bridge는 shell 없이 CLI와 같은 wrapper 정책의 argv array를 만든다.

```text
/usr/local/bin/antigravity --output-format stream-json --print-timeout 5m [--conversation <bound-id>]
```

- `cwd`는 `/config`, `HOME`은 `/data/home`이며 native OAuth, global/workspace
  plugin/agent/rule/MCP와 settings를 Web/SSH와 동일하게 사용한다.
- 공유 launcher는 customization을 제거하거나 image-only inventory로 축소하지 않는다.
- prompt는 UTF-8 stdin으로 전달하고 argv, environment, log file에 넣지 않는다.
- 일반 답변은 terminal `result.response`의 native free-text 계약을 사용한다.
  관리형 변경 proposal ID는 정확히 완료된
  `call_mcp_tool(ha_change/ha_change_propose)` stream receipt에서만 후보를
  추출하고 requester-bound broker inspection으로 다시 검증한다. Telegram
  일반 채팅에는 `--json-schema`/`finish`를 강제하지 않는다.
- 1.1.13은 pipe된 non-TTY stdin에서 print mode를 자동 선택한다. 값 없는
  `--print`/`-p`는 다음 argv를 prompt로 소비하므로 bridge argv에 넣지 않는다.
- stdout은 NDJSON 전용, stderr는 비밀 정화된 진단 전용이다.
- exit code 0과 terminal `result` event가 모두 있어야 성공이다.
- `--continue`는 다른 대화를 잘못 선택할 수 있어 bridge에서 사용하지 않는다.
- 최초 prompt 전에 검증된 per-user/per-chat conversation ID를 영속 결합하며 모든
  후속 요청과 승인 callback에 `--conversation <id>`로 전달한다. 실행 실패는 새
  ID를 만들지 않으며 `/new`만 rotation을 허용한다.
- 권한은 별도 Telegram mode가 아니라 native global `toolPermission`, sandbox와
  민감정보 option에서 온다. broker형 변경의 사람 확인은 같은 conversation에 묶는다.

### 7.3 금지 인수

wrapper와 bridge는 다음 인수를 거부한다.

- `--dangerously-skip-permissions`
- Telegram 요청에서 전달된 `--project`, `--add-dir`, `--log-file`, `--agent`
- Telegram 요청에서 전달된 `--conversation` 또는 execution mode override
- App이 검증하지 않은 model name과 JSON schema path

## 8. stream result parser

parser는 한 줄에 JSON object 하나인 NDJSON만 받는다. 알려진 1.1.13 top-level
`event` discriminator와 terminal result만 사용자 응답으로 변환한다. 정상 순서는
`event: "init"`, 0개 이상의 `event: "step_update"`, 단 하나의
`event: "result"`다. terminal object는 init과 같은 conversation ID와
`result.status == "SUCCESS"`를 충족해야 한다. 일반 답변은 native free-text
`result.response`이며 bridge는 이를 App 전용 JSON으로 다시 parse하거나 model에
`--json-schema`/`finish` tool을 강제하지 않는다. NUL을 제거한 뒤 non-empty와 32 KiB
상한만 검증한다. unknown event는 안전하게 무시하고 비밀 정화된 metric을 남기되
전체 raw line은 기록하지 않는다.

proposal ID는 임의 model text나 terminal JSON에서 받지 않는다. 정확한
`call_mcp_tool`의 `ha_change/ha_change_propose` step이 `DONE`으로 끝나고 그 tool
output이 단 하나의 유효한 proposal ID를 반환한 경우만 receipt로 채택한다. 이후
bridge가 durable conversation binding을 별도로 확인하고 trusted change broker에서
동일 requester와 live proposal metadata를 다시 검증해야 approval을 만들 수 있다.
시작됐지만 완료되지 않은 proposal call, 중복
proposal 또는 잘못된 receipt는 `proposal_result_invalid`로 fail closed한다.

다음 조건은 job 실패다.

- 한 줄 또는 전체 stream byte limit 초과
- invalid UTF-8 또는 invalid JSON
- init 없이 tool/result event 수신
- terminal result 중복 또는 누락
- terminal status 실패, 비어 있거나 과대한 free-text response
- init/terminal/bound conversation 불일치
- 완료되지 않았거나 malformed/중복인 HA change proposal receipt
- process timeout, signal 또는 non-zero exit
- schema에 없는 path로 artifact 쓰기 시도

실패는 `stream_contract_failed`, `terminal_missing`, `terminal_status_failed`,
`terminal_response_invalid`, `conversation_mismatch`, `proposal_result_invalid`처럼
bounded reason class로만 상태와 로그에 남긴다. raw NDJSON, prompt, model response,
stderr와 proposal body는 보존하지 않는다. bridge의 `/start`·`/status`·오류 안내가
Telegram에 도착한 상태에서 `session_bound` 뒤 이 reason이 나오면 Bot API network
실패가 아니라 terminal 검증 실패이며, `delivery_queued` 전이 없으므로 `/retry`할
outbox 항목도 아직 없다.

structured event schema는 고정 binary에서 golden fixture로 캡처해 저장하되 prompt,
conversation ID, token, 실제 HA object와 model output은 fixture에서 제거한다.

## 9. upgrade 규칙

Antigravity version 변경 PR은 다음을 함께 제공해야 한다.

1. amd64/aarch64 공식 artifact URL과 공식 manifest의 SHA-512, 그리고 제공되는
   경우 독립 release SHA-256 checksum
2. `--version`, top-level `--help`, `plugin --help` contract diff
3. settings와 plugin schema validation
4. interactive OAuth persistence smoke
5. print `text`, `json`, `stream-json` parser smoke
6. headless permission과 sandbox negative test
7. 두 아키텍처 image 및 실제 HAOS 최소 1개 아키텍처 재검증

CLI 자체의 `update` subcommand로 실행 중 image를 변경하지 않는다. version 변경은
App image release로만 배포한다.
