# v2 Telegram 브리지 사양

`TG-*`는 이 계약의 안정 식별자다. 문구나 순서가 바뀌어도 기존 번호를 다른
요구사항에 재사용하지 않는다.

## TG-001 — 범위

2.0.11 Telegram 브리지는 Antigravity와 별개인 축소 agent가 아니라 같은 관리자
환경을 노출하는 transport adapter다. Bot API long polling, 인증, stable session,
per-session queue, print transport, 암호화 reply outbox와 confirmation routing을
담당한다. shell, interactive TUI와 tmux pane scraping은 범위 밖이다.

첫 v2 릴리스는 UTF-8 text message만 처리한다. voice, photo, document, location,
inline mode, group mention 자동 응답과 webhook server는 지원하지 않는다.

## TG-002 — 활성화와 인증

bridge 시작 조건은 다음을 모두 만족해야 한다.

1. `telegram_enabled=true`
2. `telegram_bot_token`이 schema와 secret-file preflight를 통과
3. effective native permission boundary가 shared canonical policy 검증을 통과
4. static allowlist 또는 유효한 local pairing identity가 하나 이상 존재
5. App init과 readonly/proposal broker가 ready

1~3이 충족됐지만 4가 아직 충족되지 않으면 bridge는 Bot API에 접속하거나 종료하지
않고 bounded local authorization state만 주기적으로 다시 확인한다. 이 대기 상태는
한 번만 정제해 기록하며 S6 restart loop를 만들지 않는다. local pairing 생성은 같은
프로세스에서 감지하고, static option 변경은 App 재시작 뒤 반영한다. authorization
state의 type/mode/schema가 안전하지 않으면 대기하지 않고 fail closed 한다.

2.0.12 init은 Telegram이 활성화됐고 기존 settings가 root-owned single-link regular,
256 KiB 이하이며 parse 가능하면 3의 경계를 확인하기 전에 transaction backup한다.
현재 2.1.2는 `allowNonWorkspaceAccess`, `artifactReviewPolicy`, selected mode의 sparse
`toolPermission` 표현과 known permission bucket을 canonical policy로 reconcile하고
retired `enableTerminalSandbox`를 제거한다. 이 App 관리 permission 경계 밖의 unrelated
top-level settings, global MCP, plugin, OAuth와 `/config`는 보존하고 mode를 0600으로
강화하되 migration mode option을 바꾸지 않는다. bridge 재검증에서 3이
실패하면 `permission_boundary_blocked`를 한 번 기록하고 Bot API 요청 없이 process를
살아 있는 fail-closed hold에 둔다. 같은 설정으로 exit/S6 restart를 반복하지 않으며
복구 뒤 App restart가 필요하다.

인증 key는 Telegram numeric ID를 decimal string으로 정규화한
`(user_id, chat_id)` 쌍이다. username, phone, display name, message text와 forwarded
sender는 인증에 사용하지 않는다.

static authorization은 `telegram_allowed_user_ids`와
`telegram_allowed_chat_ids`의 교집합이다. 둘 중 하나라도 비어 있으면 static
authorization은 성립하지 않는다.

## TG-003 — 선택적 pairing

pairing은 Ingress 또는 SSH의 local helper에서만 시작한다.

```text
ha-telegram-pair create --ttl 5m
ha-telegram-pair list
ha-telegram-pair revoke <authorization-id>
```

- create는 CSPRNG 128-bit 이상의 1회용 token을 생성한다.
- 원문 token은 local terminal에 한 번만 표시하고 저장소에는 SHA-256 digest만
  저장한다.
- TTL 기본 5분, 최대 10분이다.
- Telegram private chat에서 `/start <token>`을 직접 보낸 user/chat 쌍만 하나의
  authorization으로 묶고 token을 즉시 폐기한다. group/supergroup 또는 forwarded
  message의 token은 소비하지 않는다.
- 미인증 사용자에게 token, PIN, deep link, 기존 authorization과 허용 ID를
  회신하지 않는다.
- authorization은 `/data/antigravity-ha/telegram/authorizations.json`의 root-only
  regular single-link file에 원자적으로 저장한다.
- 기존 v1 pairing/session 파일은 신뢰하거나 자동 import하지 않는다.

pairing은 Telegram user/chat에 Web/SSH와 동등한 관리자급 Antigravity 접근을
승인한다. native OAuth는 공유 `/data/home`의 `ha-antigravity-login`으로 한 번
완료하며 pairing 성공만으로 OAuth 준비 완료라고 표현하지 않는다.

## TG-004 — 명령 표면

| 명령 | 동작 |
| --- | --- |
| `/start` | 인증된 사용자에게 관리자 권한 경계와 사용법 표시 |
| `/new` | 현재 user/chat conversation을 명시적으로 새 ID로 회전 |
| `/cancel` | queued/planning/approval 취소 요청; durable 실행은 상태 추적 지속 |
| `/status` | transport, conversation, 최근 worker/outbox, active/queued 상태 표시 |
| `/help` | 지원 명령과 보안 경계 표시 |

일반 text는 Antigravity prompt로 처리한다. `/mode`는 제공하지 않으며 권한은 global
Antigravity option에서 온다. `/shell`, `/exec` 같은 bridge 전용 우회 명령도 없다.
이 표의 명령은 bridge가 직접 처리하며 Antigravity worker를 실행하지 않는다.

## TG-005 — 입력 정규화

Update는 JSON body 최대 256 KiB로 제한하고 필요한 필드만 새 object로 복사한다.
다음은 Bot API wire schema가 아니라 현재 bridge의 내부 JavaScript record다.

```ts
type NormalizedUpdate =
  | {
      updateId: number;
      kind: "message";
      value: {
        updateId: number;
        message_id: number;
        from: {id: string};
        chat: {id: string; type: string};
        text: string;
      };
    }
  | {
      updateId: number;
      kind: "callback_query";
      value: {
        updateId: number;
        id: string;
        from: {id: string};
        message: {chat: {id: string; type: string}};
        data: string;
      };
    };
```

- user/chat/update/message ID는 decimal string만 허용한다.
- prompt는 valid UTF-8, 1~16 KiB이며 NUL과 unsupported control character를
  거부한다.
- group과 supergroup은 static allowlist에 chat ID가 있을 때만 처리한다.
- edited message, channel post, forwarded authorization, file과 callback 이외의
  update type은 무시한다.
- HTML/Markdown은 prompt 해석 전에 plain text로 취급한다.

`$()`, backtick, quote, newline, escape sequence와 leading dash는 shell 또는 argv
구조로 해석되지 않아야 한다.

## TG-006 — queue와 session

- global worker concurrency는 2다.
- `(user_id, chat_id)`별 active job은 1개다.
- 같은 key의 대기 queue는 최대 4개이며 초과 요청은 명확히 거부한다.
- active job 기본 timeout은 5분, hard kill grace는 10초다.
- `/cancel`은 queued job과 planning/authorization 단계의 child process group을
  SIGTERM 후 10초 grace 뒤 SIGKILL로 정리하고 pending proposal을 폐기한다.
  broker `execute`에 이미 접수된 durable mutation은 취소되었다고 응답하지 않는다.
  bridge는 `execute_status` 조회를 계속해 terminal result를 사용자에게 전달한다.
- 실행 중 model queue는 `/run`에만 저장한다. approval은 durable state에
  conversation/user/chat/session generation/proposal digest/expiry를 결합한다. bridge만
  재시작되고 proposal을 가진 broker가 계속 살아 있을 때는 모두 재검증한 뒤 계속할
  수 있다. App 전체 또는 broker 재시작으로 아직 접수하지 않은 in-memory proposal이
  사라지면 기존 approval은 실행하지 않고 새 요청을 요구한다.
- conversation binding은 opaque Antigravity conversation ID만 `/data`에 저장하고
  idle timeout으로 만료하지 않는다. healthy conversation은 `/new`만 교체한다. native
  worker terminal failure는 binding을 quarantine하고 failed update를 durable ACK한다.
  다음 사용자 요청은 새 generation/binding을 생성하며 failed prompt를 replay하지 않는다.
  response는 delivery가 끝날 때까지만 sealed reply outbox에 저장하고 처리 완료 prompt는
  저장하지 않는다. Antigravity 내부 history 파일을 임의 삭제하지 않는다.
- approval callback ACK와 기본 인증/control 처리는 즉시 수행한다. 승인된 broker 실행은
  같은 requester FIFO에서 session-serialized되고 실행 직전 현재 generation/conversation을
  durable binding과 다시 비교하므로 `/new`,
  `/cancel`, expiry, restart 또는 duplicate callback 경합이 stale mutation을 만들지 않는다.

Bot API batch를 dispatch하거나 transport offset을 전진하기 전에 validated normalized
update를 `/data`의 acknowledgement ledger와 sealed spool에 한 번의 atomic write와
file/directory `fsync`로 등록한다. spool key는 현재 Bot token에서 HKDF-SHA256으로
파생하며 record마다 random nonce를 사용하는 AES-256-GCM ciphertext만 저장한다.
plaintext prompt, Bot token과 raw Bot API envelope는 저장하지 않는다. spool은 최대
128 records/2 MiB이며 한 batch가 한계를 넘으면 transport offset을 전진하지 않고
fail closed 한다. token 변경, authentication tag 불일치 또는 malformed plaintext도
polling 전에 fail closed 하며 해당 ciphertext를 자동 삭제하지 않는다. 정상 token
rotation은 pending spool을 모두 ack한 뒤 수행한다. accidental rotation은 기존 token을
복원해야 하며 tamper가 의심되면 service를 중지하고 state를 보존·격리한 뒤 operator가
복구 또는 pending update 폐기를 명시적으로 결정한다.

`transport_offset`은 sealed registration이 내구적으로 완료된 prefix 뒤로 전진하고,
처리 완료 offset인 `update_offset`과 분리한다. 성공적으로 처리하거나 영구 거부한
update만 ack하며 뒤 update가 먼저 끝난 사실은 ledger에 보존한다. ack 시 해당
ciphertext를 같은 atomic state update로 삭제하고 관측 순서의 ack된 prefix만
`update_offset`에 commit한다. crash 후에는 Bot API가 이미 transport-ack한 update도
sealed spool에서 decrypt/validate해 다시 dispatch하고, update ID와 proposal
idempotency key로 중복 mutation을 막는다.

Antigravity terminal result는 Telegram 전송 전에 같은 AES-256-GCM state의 bounded
reply outbox에 원자적으로 기록한다. record는 conversation/user/chat, opaque reply
fingerprint, chunk 진행도와 retry metadata를 인증된 data에 묶고 raw credential을
포함하지 않는다. Telegram API가 각 chunk 전달을 확인한 뒤 진행도를 commit하고 전체
전달이 끝나야 record를 제거한다. 429처럼 API가 미전송을 명확히 확인한 실패만 같은
reply를 bounded backoff로 재개한다. send 도중 crash, network, timeout 또는 5xx처럼
전달 여부가 모호하면 `ambiguous`로 격리하고 사용자의 `/retry` 전에는 자동 재송신하지
않는다. 어느 경우에도 terminal journal을 사용해 Antigravity를 다시 호출하거나 새
conversation을 만들지 않는다.

## TG-007 — Antigravity worker

bridge는 Node `spawn`과 `shell: false`를 사용한다.

```text
argv = [
  "--output-format", "stream-json",
  "--print-timeout", "5m",
  "--disable-slash-commands",
  "--conversation", "<bound-id>"
]
cwd = "/config"
HOME = "/data/home"
stdin = normalized prompt
```

Antigravity 1.1.13은 non-TTY stdin이 pipe되면 print mode를 자동 선택한다. 값 없는
`--print`/`-p`는 boolean switch가 아니라 다음 argv를 prompt 값으로 소비하므로 넣지
않는다. Telegram local control과 model slash command의 충돌을 막기 위해 정확히 하나의
`--disable-slash-commands`를 넣는다. 이 규칙으로 prompt는 argv나 environment에
노출되지 않고 stdin에만 남는다.

첫 실행 전에 App이 생성·보관한 conversation ID를 결합하고 항상
`--conversation <opaque-id>`로 전달한다. prompt에서 CLI flag, environment, model,
conversation 또는 path를 추출하지 않는다. timeout이나 App 재시작만으로 healthy
binding을 바꾸지는 않는다. terminal worker failure는 위 quarantine state transition을
거쳐 다음 user request에 새 ID를 만들며 `/new`는 사용자가 즉시 회전하는 유일한 command다.

worker environment는 Web/SSH wrapper와 같은 HOME, PATH, locale, native permission,
AppArmor runtime/command profile 선택과 requester binding을 사용한다. Supervisor,
Telegram, browser raw credential과 shell startup 변수는 environment value로 전달하지
않는다. HOME은 `/data/home`, cwd는 `/config`이며 OAuth와 user global/workspace
plugin·agent·rule·MCP를 의도적으로 상속한다. `request-review` mutation은 approved
proposal을 통해 수행하고 explicit `always-proceed`는 current user request 범위의
ordinary mutation을 자율 실행한다. 별도 Telegram settings,
plugin copy, safe cwd, HOME bootstrap 또는 login helper는 없다.

actual Antigravity 1.1.11 shared-HOME canary는 user global stdio MCP가 OAuth 인증 완료
전에도 실행될 수 있음을 재현했다. 2.0.7은 이를 관리자 주 채널의 명시적 동작으로
채택한다. local container 증거를 실제 HAOS OAuth 성공, credential 비유출 또는
AppArmor enforce 증거로 확대하지 않는다.

stdout NDJSON 총량은 4 MiB, 단일 line은 256 KiB로 제한한다. 최종 사용자 text는
32 KiB까지 허용해 Telegram 4096-character 경계에 맞춰 최대 8개 message로
Unicode-safe 분할한다. 초과 결과는 local raw output을 보존하지 않고 요약 실패를
보고한다.

pinned 1.1.13 stream의 top-level discriminator는 `type`이 아니라 `event`다. init과
terminal result는 같은 conversation ID여야 하며 terminal은
`result.status == "SUCCESS"`와 bounded string `result.response`를 충족해야 한다. 일반
채팅에는 `--json-schema`나 generated `finish` tool을 강제하지 않으며 terminal
response를 App 전용 JSON으로 다시 parse하지 않는다. proposal 없는 빈 response,
legacy `type`, 실패 status, 다른 conversation ID와 recursive fallback payload는
거부한다. 정확히 하나의 완료된 유효 HA/action proposal receipt가 존재하고 terminal text만
비어 있으면 2.0.11은 kind별 고정된 `Home Assistant 변경 제안을 준비했습니다.` 또는
`Telegram에서 확인할 작업 제안을 준비했습니다.` 문구를 사용해 approval card delivery를 계속한다. non-string, 32 KiB 초과, proposal receipt가
없거나 중복된 빈 response는 계속 fail closed한다.

proposal ID는 정확한 `call_mcp_tool`의 `ha_change/ha_change_propose` 또는
`telegram_action/telegram_action_propose` step이 `DONE`으로 완료한 tool output에서만 추출한다.
시작됐지만 완료되지 않은 call, malformed/중복 receipt와 임의 model text의 ID는
거부한다. receipt를 얻은 뒤에도 bridge가 durable conversation binding을 별도로
확인하고 trusted broker/coordinator에서 동일 requester와 live proposal metadata를 검증해야
approval을 만든다.

receipt의 `parameters`는 `Arguments`, `ServerName`, `ToolName`을 필수로 하고
`toolAction`, `toolSummary`만 optional compatibility metadata로 허용한다. optional
값은 각각 NUL·비공백 control character가 없는 최대 1,024 UTF-8 byte 문자열이어야
한다. unknown key, non-string, 금지 control character 또는 byte 상한 초과는
`proposal_result_invalid`다.
진단에는 raw key/value 대신 고정 reason class와 key/metadata 개수만 기록한다.

pinned 1.1.13 native child의 stderr는 원문을 저장·로그·회신하지 않는다. bridge는
`Error: authentication required. Run 'antigravity-real' to log in, then retry.`라는
고정 byte marker만 marker 길이 미만의 tail을 유지하는 bounded streaming matcher로
판정한다. exit 1과 이 marker가 모두 있으면 `authentication_required`로 분류한다.
그 밖의 nonzero는 `worker_failed`다. 인증 필요 응답은 trusted local TTY의
`ha-antigravity-login`을 안내한다.
exit 0, stdout 0 byte와 pinned stderr-only headless auto-denial marker가 정확히 함께
있을 때는 legacy `headless_read_denied`로 분류한다. stderr marker만 있고 정상 terminal
result가 있으면 이 분류를 적용하지 않는다. 별도로 valid stream에서 exact native
`run_command`, `read_file`, `view_file`, `write_file` 또는 `write_to_file` tool name과
bounded `tool_info.output`/`error.message`가 pinned native 1.1.13 headless-denial
pattern에 모두 일치할 때만 native permission denial 후보다. `run_command`는 동일
conversation·step·CommandLine의 exact `ACTIVE`→`ERROR` pair이고 다른
`run_command DONE`이 없어야 한다. orphan/duplicate/mixed lifecycle, generic
"permission denied", AppArmor/shell error 또는 unknown tool diagnostic은 approval
분류를 활성화하지 않는다. 유효 proposal receipt가 없으면 즉시 typed denial로
중단하고, 정확한 단일 same-run receipt가 함께 있으면 denial metadata를 downstream
mode 검증까지 보존한다.

proposal이 없는 `run_command` denial은 `request-review`에서만 같은 conversation의
proposal-first replan을 최대 한 번 시작한다. 정확한 단일 same-run proposal은 새
replan 없이 기존 receipt 검증으로 진행한다. explicit `always-proceed`의 같은 denial은
설정된 policy와 native 적용 불일치이므로 `unexpected_permission_denied`로 fail
closed하고 conversation을 격리하며 approval card로 전환하지 않는다.
`read_file`/`view_file`/`write_file`/`write_to_file` denial은 두 mode 모두
`headless_read_denied`이고 forbidden native-file proposal 없이 confined `ha_files`
사용을 안내한다. 어느 경로도 denied tool을 resume하거나 승인하지 않는다. malformed
stream은 기존 stream failure로 남는다. stderr 마지막 줄, command, file target과 raw
diagnostic은 저장·로그·회신하지 않는다.

bridge는 최초 native worker와 bounded correction worker를 각각 시작하기 직전에
mode-specific canonical settings boundary를 다시 읽고 raw byte까지 검증한다. 두 검증
사이 atomic replacement나 mode drift가 있으면 두 번째 worker/coordinator를 시작하지
않고 bounded `unexpected_permission_denied`의 `settings_preflight`로 fail closed한다.
denied command는 자동 재시도하지 않는다.

`proposal_result_invalid` 진단은 step contract, output
contract/JSON/envelope, mixed kind, receipt cardinality, coordinator binding의 고정
subreason만 기록한다. 필요한 경우 allowlisted stage나 nonnegative bounded count만
추가하며 prompt, command, output, proposal ID, digest, conversation과 requester 값은
기록하지 않는다.

`/status`의 transport 정상은 Bot API command가 bridge에서 처리된다는 뜻일 뿐이다.
공유 AI runtime 상태는 App 시작 뒤 `아직 확인되지 않음`에서 시작해 완료된 최근
native child 결과만 `ready`, `authentication_required`, `headless_read_denied`,
`headless_permission_denied`, `unexpected_permission_denied`,
`stream_contract_failed`, `terminal_missing`, `terminal_status_failed`,
`terminal_response_invalid`, `conversation_mismatch`, `proposal_result_invalid` 또는
`worker_failed`로 갱신한다. 이 상태에는 identifier, prompt, stderr 또는 credential
자료를 넣지 않는다. bridge의 로컬 명령·오류 회신이 도착하고 Telegram API error가
없는데 `session_bound` 뒤 terminal reason으로 실패했다면 outbound network가 아니라
native result 검증 실패다. `delivery_queued` 전이가 없으므로 `/retry`할 outbox 항목도
생기지 않는다.

## TG-008 — proposal schema

Telegram은 CLI와 같은 native file/tool 권한을 사용한다. `ha_change_propose` MCP를
선택한 broker형 작업은 `operation`, `summary`, optional `ttl_seconds`와 operation별
`payload`만 전달한다. MCP wrapper가 Telegram requester와 conversation을 bind하고
broker가 다음 public wire record를 생성한다. 이 경계의 JSON key는 모두 snake_case다.

```ts
type PreviewLine = {
  line: number;
  text: string;
  redacted: boolean;
  truncated: boolean;
};

type ChangeProposal = {
  proposal_id: string;
  operation:
    | "config_patch"
    | "service_call"
    | "multi_choice_service_call"
    | "device_test";
  risk: "low" | "high";
  requester: {
    surface: "telegram";
    user_id: string;
    chat_id: string;
  };
  preview:
    | ConfigPatchPreview
    | ServiceCallPreview
    | MultiChoiceServiceCallPreview
    | DeviceTestPreview;
  preview_digest: `sha256:${string}`;
  expires_at: string;
};

type ConfigPatchPreview = {
  format: "yaml-line-diff-v1";
  target: string;
  change_kind: "create" | "update" | "no_change";
  expected_sha256: "missing" | `sha256:${string}`;
  replacement_sha256: `sha256:${string}`;
  mutation_sha256: `sha256:${string}`;
  replacement_bytes: number;
  before_line_count: number;
  after_line_count: number;
  before: PreviewLine[];
  after: PreviewLine[];
  omitted_before_lines: number;
  omitted_after_lines: number;
  truncated: boolean;
  activation:
    | {
        kind: "input_boolean_reload";
        reload_service: "input_boolean.reload";
        configuration_sha256: `sha256:${string}`;
        changes: Array<{
          entity_id: string;
          change_kind: "create" | "update" | "remove";
          verified_fields: string[];
        }>;
      }
    | {
        kind: "automation_reload" | "script_reload" | "scene_reload";
        reload_service: string;
        executable: true;
      }
    | {
        kind: "none";
        executable: true;
        apply_result: "restart_required";
      };
};

type ServiceCallPreview = {
  format: "ha-service-call-v1";
  summary: string;
  service: string;
  entity_id: string | string[] | null;
  service_data: Record<string, unknown>;
  precondition:
    | {kind: "none"}
    | {kind: "fresh_entity_state"; entity_id: string; expected_state: string};
  verification:
    | {kind: "api_completion"}
    | {kind: "fresh_entity_state"; entity_id: string; expected_state: string};
};

type MultiChoiceServiceCallPreview = {
  format: "ha-multi-choice-service-call-v1";
  summary: string;
  prompt: string;
  choices: Array<{
    choice_id: string;
    label: string;
    service: string;
    entity_id: string | string[] | null;
    service_data: Record<string, unknown>;
    precondition:
      | {kind: "none"}
      | {kind: "fresh_entity_state"; entity_id: string; expected_state: string};
    verification:
      | {kind: "api_completion"}
      | {kind: "fresh_entity_state"; entity_id: string; expected_state: string};
  }>;
  cancel_label: string;
};

type DeviceTestPreview = {
  format: "device-test-plan-v1";
  summary: string;
  entity_id: string;
  precondition: {
    expected_prior_state: "on" | "off";
    fresh_read_required: true;
  };
  test: {
    service: string;
    verify_state: "on" | "off";
    fresh_verification_required: true;
  };
  restore: {
    service: string;
    verify_state: "on" | "off";
    always: true;
    fresh_verification_required: true;
  };
};
```

broker가 canonical target, operation, diff, 이전 상태와 risk를 계산한다. model이
requester, risk, proposal ID, expiry 또는 `reversible` 표시를 지정할 수 없으며, 알 수
없는 input key는 거부한다. preview에는 secret value, full state attribute, token과
raw API body가 없어야 한다. token/secret/password/auth/key/PIN/code/credential 계열
key와 credential-like value는 redaction하되 preview digest는 실행할 raw payload에 묶는다.

`config_patch`의 human preview는 model summary가 아니라 broker가 normalized
mutation에서 생성한 secret-safe bounded structured diff여야 한다. 최소한 exact
target, 변경 종류, secret value를 제거한 key/line 단위 before/after, 생략 여부와
전체 mutation digest를 포함한다. raw full replacement를 Telegram에 보내지 않는다.
target, digest, byte 수와 model summary만 보여 주는 preview는 실제 replacement를
검토할 수 없으므로 confirmation에 충분하지 않다. `preview_digest`는 이 canonical
preview와 실행할 normalized mutation을 함께 묶어 어느 한쪽이 달라져도 기존
approval을 무효화해야 한다.

`config_patch`는 `secrets.yaml`, `.storage`와 hidden sensitive segment를 제외한
`/config` 내 `.yaml`/`.yml` target을 받는다. expected SHA, 최대 1 MiB replacement와
structured preview를 digest에 묶고 승인 뒤 atomic backup/write와 `ha-config-check`를
수행한다. 실패하면 exact backup을 복원하고 config check를 다시 실행한다. activation을
생략하면 파일 변경은 실행 가능하되 `restart_required`를 반환한다. 명시 activation은
`input_boolean_reload`, `automation_reload`, `script_reload`, `scene_reload`이며 첫 종류만
semantic fresh-state verification을 추가한다.

`service_call`은 live `GET /api/services`에서 모든 domain/service를 확인한다. entity는
생략, 단일 ID 또는 중복 없는 최대 100개 배열이고 `service_data`는 64 KiB/depth 12/
2048 nodes/array 512의 plain JSON이며 prototype key를 거부한다. `expected_state`와
`verify_state`는 단일 entity에서만 선택 지원하며 그 밖의 성공은 API completion까지만
보고한다.

`multi_choice_service_call`은 상호 배타적인 1~31개 선택지를 받는다. `choice_id`는
proposal 안에서 고유한 `[A-Za-z0-9_-]{1,24}`, label과 optional `cancel_label`은 각각
최대 64 UTF-8 byte이며 prompt는 최대 500문자/1,024 UTF-8 byte다. 각 선택지는 위
`service_call` validator 전체를 재사용하고 broker가 한 번 가져온 live service
registry snapshot에서 모두 검증되어야 한다. 하나라도 실패하면 proposal 전체를
거부한다. preview와 digest에는 모든 normalized 선택지를 묶되 callback에는 실행
파라미터를 넣지 않는다.

`device_test` payload는 `light`, `switch`, `input_boolean` 중 exact entity와
`turn_on`/`turn_off`, `expected_prior_state`만 받는다. expected prior와 service가 만드는
test state가 같으면 no-op이므로 proposal 단계에서 거부한다. lock/cover/alarm/climate,
restart/update와 임의 service는 device test allowlist에 들어오지 않는다. preview의
test/restore plan은 broker가 normalized payload에서 만들고 digest에 묶는다.

## TG-009 — global permission과 confirmation

Telegram 전용 mode는 없다. Web/SSH와 동일한 `antigravity_tool_permission`과
`antigravity_sensitive_data_access`를 native 실행에 적용한다. 1.1.13 native
`--sandbox`는 비특권 HAOS App에서 namespace 생성이 실패하므로 세 채널 모두 사용하지
않는다. native sandbox argv override는 거부하고 spawned command/stdio tool executable은
`antigravity_home_assistant-command` AppArmor profile로 discrete `Px` transition한다.
legacy `antigravity_terminal_sandbox`는 deprecated/no-op compatibility 입력으로만 받아
어느 값이든 `false`로 정규화하고 warning을 남긴다. 이 경계를 위해 host privilege를
늘리지 않는다. 2.0.6 이하의 `telegram_access_mode`는 무시하는 migration 입력이며 권한
source가 아니다.

2.1.0 기본 global managed policy는 `request-review`다. URL read, confined
`ha_files_list`/`ha_files_read_text`, exact `ha_change_propose`/
`telegram_action_propose`, managed HA read/validate/memory와 upstream
`readOnly: true` Playwright 네 도구를 allow하고 `ha_files_write_text`/URL execute/command는
ask로 보낸다. mutation-capable browser와 arbitrary MCP는
typed adapter 전까지 fail closed한다. explicit `always-proceed`는 current authenticated
user request 범위에서 mandatory blacklist 밖의 ordinary command/URL,
`mcp(*)`와 installed Playwright interaction을 autonomous-admin으로 허용한다. `strict`와
`proceed-in-sandbox`는 legacy upgrade input이며 user-files updater가
`request-review`로 정규화한다. secrets/storage/OAuth/runtime token/App-owned
permission-MCP policy/SSH-cloud key/credential `/proc`/Recorder-write exact deny는 항상
우선한다.

native `read_file(*)`/`write_file(*)`는 symlink alias 우회를 막기 위해 두 mode에서 전역
deny한다. ordinary file은 server `ha_files`(`serverInfo.name=antigravity-ha-files`)의
`ha_files_list`, `ha_files_read_text`, `ha_files_write_text`만 사용한다. 허용 root는
`/config`, `/share`, `/media`, ordinary `/data/home`, `/tmp`, `/var/tmp`이고 UTF-8
1 MiB·listing 200개, no-symlink/non-regular/multi-hardlink, same-directory atomic write와
optional `expected_sha256`를 강제한다. secrets/storage/.gemini/credential/policy 및
Recorder write는 fail closed하며 sensitive-data marker 없이 Recorder read도 거부한다.

2.0.12에서 Telegram-enabled startup은 위 일반 preserve migration을 좁게 재정의했다.
현재 2.1.2는 ownership state와 관계없이 App 관리 보안 field, selected mode의 sparse
native shape와 known permission bucket의 user-owned rule/stronger deny를 shared
canonical policy로 교체한다. 그 밖의 user customization과 global MCP/OAuth는 그대로
보존하며, canonical input의 재시작은 새
backup이나 write가 없는 idempotent 결과여야 한다. `reset_v2`는 여전히 사용자가
명시적으로 선택하는 broader recovery mode이고 이 reconciliation이 option을 자동
승격하지 않는다.

`request-review`의 Playwright 네 auto-allow는 `browser_console_messages`,
`browser_network_requests`, `browser_snapshot`, `browser_take_screenshot`이다.
`browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_hover`,
`browser_wait_for`, `browser_resize`, `browser_close` 등 upstream `readOnly: false` 도구는
typed adapter 전까지 Telegram에서 fail closed한다. explicit `always-proceed`에서는
current request의 installed Playwright navigation/interaction도 허용한다.

1.1.13 `--print --output-format stream-json`은 native interactive permission request를
외부 transport에 노출하거나 승인 뒤 같은 tool 지점에서 재개하는 protocol을 제공하지
않는다. 따라서 Telegram callback은 native prompt resume가 아니다. `request-review`의 HA service/config
mutation은 `ha_change_propose`, terminal command·bounded inline script·command choices·
finite question은 `telegram_action_propose`로 먼저 등록한다. 둘 다 실행하지 않고 exact
digest/public preview만 broker/coordinator에 등록한다. exact native `run_command`
permission denial을 감지하면 bridge는 proposal이 없는 `request-review`에서만 같은
conversation에 proposal-first 재계획을 최대 한 번 요청할 수 있다. exact single
same-run proposal은 그 receipt를 계속 검증한다. `always-proceed` denial은
`unexpected_permission_denied`로 격리하고 approval card로 전환하지 않으며,
native-file denial은 managed `ha_files`로 안내한다. 어느 경우에도 거부된 invocation을
승인·resume·retry하지 않는다. 임의 future/user plugin MCP
side effect는 transparent intercept할 수 없으며 두 proposal이 표현하지 못하면 fail
closed한다.

App-managed broker의 모든 `config_patch`, `service_call`,
`multi_choice_service_call`, `device_test`는 `high`이며 global native policy와
관계없이 human confirmation이 필요하다. model의 risk 표시는 이 판정을 낮출 수 없다.

인증된 Web/SSH의 명시적 direct operation은 native TUI 또는 현재 사용자 요청을
승인 근거로 사용할 수 있고 Telegram button으로 자동 broker되지 않는다. 이것은 승인
transport 차이이지 HOME, OAuth, global permission을 나눈 별도 runtime이 아니다.
shared OAuth가 없으면 최초 login은 controlling TTY가 필요하므로 Web/SSH에서
`ha-antigravity-login`을 한 번 실행한다.

coordinator 내부 logical record는 wire JSON이 아니다. callback data에는 random
approval ID와 multi-choice일 때만 opaque choice token을 두고 durable state에는 다음
binding을 보관한다.

```ts
type PendingApproval = {
  approvalId: string;
  conversationId: string;
  sessionGeneration: number;
  requester: ChangeProposal["requester"];
  proposalId: string;
  previewDigest: `sha256:${string}`;
  idempotencyKey: string;
  expiresAt: number;
  state: "pending" | "approved";
  choiceTokens?: Array<{token: string; choiceId: string; label: string}>;
  selectedChoiceId?: string | null;
};
```

2.0.11 action approval은 별도 AES-GCM sealed record로 다음 불변조건을 보관한다.

```ts
type TelegramActionApproval = {
  approvalId: string;
  proposalId: string;
  operation: "terminal_command" | "multi_choice_terminal" | "question";
  requester: {userId: string; chatId: string};
  sessionGeneration: number;
  updateId: string;
  runNonce: string;
  conversationId: string;
  requestDigest: `sha256:${string}`;
  previewDigest: `sha256:${string}`;
  status: "pending" | "approved" | "answered" | "denied" | "committed" |
    "completed" | "failed" | "in_doubt";
  choiceTokens?: Array<{token: string; choiceId: string; label: string}>;
};
```

- 기본 TTL은 2분이다.
- binary card는 기존 `v2a:<approval_id>`/`v2d:<approval_id>`를 계속 처리한다.
  multi-choice card는 `v3c:<approval_id>:<opaque_choice_token>`과
  `v3d:<approval_id>`를 사용한다. callback data는 Telegram의 64-byte 상한을
  넘지 않으며 HA domain/service/entity/`service_data` 또는 raw `choice_id`를 싣지
  않는다.
- multi-choice 1~31개에 cancel을 더한 최대 32개 button을 행당 최대 4개, 최대 8행으로
  배치한다. label과 cancel label은 각각 64 UTF-8 byte 이하이고 선택 token→
  `choice_id` mapping은 approval과 함께 암호화해 저장한다.
- callback requester/chat/current generation/conversation이 record와 다르면 generic denial 후 아무 상태도
  바꾸지 않는다.
- callback은 즉시 ACK하고 기본 인증을 검사하지만 승인된 broker 실행은 requester FIFO에
  넣는다. 실행 직전에 durable record, current session과 broker proposal/digest를 다시
  비교하고 1회용 capability를 발급한다.
- Cancel, expiry, `/cancel`, proposal 변경 또는 첫 Confirm/Choice 시 record를
  원자적으로 terminal 상태로 바꾸거나 폐기한다. choice는 broker authorization 전에
  durable record에 먼저 기록한다. bridge restart 뒤 mapping을 복구할 수 있지만
  broker가 재시작해 in-memory proposal을 잃었다면 미접수 approval을 실행하지 않는다.
- 실행 직전 broker가 risk, target와 현재 precondition을 다시 검증하고 결과를 같은
  conversation reply outbox에 넣는다.
- durable idempotency key는 선택한 `choice_id`까지 capability, execute request,
  status/result와 결합한다. 이미 broker가 접수한 실행은 restart 또는 duplicate
  callback 뒤에도 동일 mutation을 정확히 한 번만 접수하며 replay는 저장된
  status/result만 회수한다.
- action card는 `v4a:<approval_id>`/`v4d:<approval_id>` 또는
  `v4c:<approval_id>:<opaque_choice_token>`을 사용한다. callback에는 command,
  script, cwd, timeout이나 raw `choice_id`를 넣지 않는다. 1~31개 action/question
  choice와 cancel은 같은 4×8 bound를 지킨다.
- `/cancel`은 pending/approved action을 terminal 취소 상태로 만들지만 committed action을
  rollback하지 않는다. committed replay는 executor를 다시 시작하지 않고 기존
  terminal result 또는 `in_doubt`만 전달한다.
- TTL cleanup은 아무 결정도 없는 `pending` card만 만료한다. `approved`, `answered`,
  `denied`, `committed`, `completed`, `failed`, `in_doubt` record는 callback input을
  durable ACK할 때까지 TTL 때문에 삭제하지 않는다. 이 보존은 결정 또는 sealed result를
  App outage 중 잃어 이미 승인된 action을 미승인처럼 오인하는 것을 막는다. ACK 완료,
  explicit session invalidation 또는 정상 lifecycle cleanup만 해당 record를 제거한다.
- proposal MCP가 coordinator에 register한 사실만으로는 durable approval이 아니다.
  register 성공 뒤 bridge가 encrypted approval record와 card/outbox를 seal하기 전에
  crash하면 복구 가능한 card가 없으므로 사용자가 원 요청을 다시 보내야 한다.
  registration 자체를 crash-durable로 주장하지 않으며 sealing 이후 decision/result와
  이미 접수된 execution만 durable 범위다.

## TG-010 — 실행과 결과

coordinator의 `execute`는 capability와 binding을 검증한 뒤 `in_progress` idempotency
record를 fsync하고 즉시 durable job 접수 상태를 반환한다. 실제 mutation은 broker의
직렬 worker에서 수행하며 짧은 socket timeout에 묶지 않는다. bridge는 같은 requester와
idempotency key로 `execute_status`를 조회해 `completed` result 또는 재시작 뒤
`in_doubt`를 회수한다. 동일 key의 재시도는 새 mutation을 시작하지 않는다.
`multi_choice_service_call`은 authorization과 execute에 같은 `choice_id`가 있어야 하고
broker가 capability·proposal digest·idempotency record의 선택과 다시 대조한 뒤 해당
proposal 안의 사전 검증된 service call 하나만 실행한다. 다른 선택지를 같은 key로
재시도하거나 binary approval에 choice를 붙이는 요청은 거부한다.

action 실행:

이 경로의 executor는 Supervisor/bot/native OAuth credential을 받지 않는
credential-free executor다.

1. proposal MCP는 active Telegram run의 private 0600
   `telegram-action-proposal.sock`에 exact proposal/digest/preview만 등록하고 실행하지 않음
2. bridge가 receipt와 coordinator record의 requester/update/run/conversation/digest를
   맞춘 뒤 encrypted approval과 card를 durable queue에 기록
3. callback ACK 뒤 selected action을 durable `committed`로 먼저 저장
4. executor에 `{proposal_id, operation, selection_id, action, execution_digest}` exact
   envelope만 전달; clean environment와 fixed protected shell/AppArmor command profile 사용
5. stdout 4 KiB, stderr 2 KiB와 timeout을 bound한 `completed`/`failed`/`in_doubt` result를
   seal하고 same conversation의 새 turn으로 전달
6. `question`은 executor를 실행하지 않고 selected label만 same conversation에 전달
7. commit 이후 process/result 불확실성은 `in_doubt`이며 같은 command/script를 재실행하지 않음

1과 2 사이의 coordinator registration은 process-local이다. 이 구간에서 bridge가
종료되면 registration을 재구성하거나 자동 실행하지 않고 사용자가 요청을 반복한다.
2의 encrypted approval/card sealing부터 durable state로 취급한다.

지원 command/script는 canonical `/config` 또는 allowlisted Antigravity customization
cwd, 120초 이하 timeout과 16 KiB 이하 source로 제한되고 sensitive path/value,
credential dump를 proposal 단계에서 거부한다. executor는 spawn 직전에 shell source에서
식별 가능한 detached/daemon/job-control pattern을 best-effort로 거부하지만, opaque
interpreter나 custom binary의 double-fork를 cgroup 수준으로 봉쇄하지는 않는다. 따라서
background/daemon 작업은 지원 범위가 아니며 이 경계가 불명확한 실행은 `in_doubt`로
끝나고 자동 재실행되지 않는다. executor에는
Supervisor token, bot token, native OAuth, App settings 또는 proposal socket을 전달하지
않는다. 이 protocol은 arbitrary plugin MCP의 transparent interceptor가 아니다.

config 변경:

1. exact YAML target과 expected SHA precondition 재확인
2. recoverable exact backup 확인
3. atomic candidate replace와 digest 확인
4. `ha-config-check`
5. 지원 activation이면 broker가 해당 reload API 호출; 생략이면 `restart_required`
6. `input_boolean_reload`이면 semantic memory begin/fresh verify 연결
7. 실패 시 exact backup restore, config recheck와 reload를 수행하고 결과를 durable 기록
8. 수행·검증된 단계만 성공 회신에 포함

device test:

1. `service_call`과 별도인 typed `device_test` 및 narrow domain/service allowlist 확인
2. exact entity를 fresh read하고 `expected_prior_state` precondition 재확인
3. prior와 다른 test-state service call
4. expected test state를 fresh API로 확인
5. 3~4단계의 성공/실패와 무관하게 broker-derived prior-state service를 반드시 호출
6. prior state를 fresh API로 확인한 뒤에만 transient success 회신
7. test 실패 뒤 restore 성공이면 실패 원인과 verified restore를 durable 기록
8. restore mismatch는 `rollback_failed`, restore 관찰 불능은 `in_doubt`로 fail closed
9. 동일 requester/idempotency key replay는 저장된 결과를 반환하고 service를 재실행하지 않음

restart, update, restore, deletion과 credential 변경은 confirmation 후에도 별도
broker policy와 Home Assistant API precondition을 통과해야 한다. command 성공만
검증 성공으로 표현하지 않는다.

## TG-011 — Bot API와 장애 처리

- HTTPS certificate 검증을 끄지 않는다.
- long poll timeout은 30초, HTTP request timeout은 45초다.
- 429의 `retry_after`를 상한 60초 안에서 따르고, 5xx/network 오류는 jittered
  exponential backoff를 사용한다.
- 시작 단계의 `deleteWebhook`과 `getMe`도 timeout, 429, 5xx, network 오류를 같은
  bounded backoff로 bridge process 안에서 재시도한다. 일시적인 Telegram 연결 실패로
  S6 service가 즉시 재시작되는 loop를 만들지 않는다.
- Telegram 전용 Node process는 network-family auto-selection을 유지하되 각 주소의
  연결 시도 제한을 1,500ms로 설정한다. Node 22 기본 250ms보다 긴 dual-stack 경로에서
  정상 IPv4 TCP 연결이 완료되기 전에 다음 주소로 넘어가 전체 `ETIMEDOUT`이 되는
  실패를 피하면서, IPv4 전용 강제나 IPv6 비활성화는 하지 않는다.
- 401/403을 포함한 retry 불가능한 4xx token/policy 오류는 `connect_blocked`를 한 번
  기록하고 bridge process를 살아 있는 fail-closed 대기 상태로 둔다. 같은 설정으로
  Bot API 요청이나 S6 restart를 반복하지 않으며, 운영자가 App 옵션을 고쳐 다시
  시작해야 한다.
- effective settings gate가 canonical Telegram policy를 충족하지 못하면 Bot API 호출
  전에 `permission_boundary_blocked`를 한 번 기록하고 같은 live fail-closed hold에
  들어간다. 설정을 자동 완화하거나 같은 설정으로 fatal exit/S6 restart를 반복하지
  않으며, safe repair 뒤 App restart가 필요하다.
- message 전송 실패나 execute 응답 유실이 Antigravity 또는 mutation을 재실행하게
  해서는 안 된다. model terminal은 encrypted journal에 먼저 저장하고 결과는 reply
  outbox로 전환한다. 429는 bounded retry하고 전달 여부가 모호한 send는 `/retry`까지
  격리한다. 실행 결과는 `execute_status`로 durable proposal idempotency record에서
  조회하고 같은 conversation에 전달한다.
- Telegram 장애가 Ingress, SSH, memory와 browser service를 중단하지 않는다.

## TG-012 — 로깅과 관측

시작 연결 재시도는 `connect_retry`와 고정 `reason_class`, 다음 대기 시간만 기록한다.
network 진단은 DNS/socket/TLS/Undici의 사전 허용된 `transport_code` 또는 `unknown`만
기록하며 token, Bot API URL, 내부 cause message는 기록하지 않는다.

permission gate 실패는 `permission_boundary_blocked` 한 건과 정제된 error만
기록한다. hold loop는 같은 error를 반복 기록하지 않고 identifier, settings 내용 또는
permission rule 원문을 metric label에 넣지 않는다.

worker 요청 실패는 `request_failed`와 코드에 고정된 `reason_class`만 기록한다.
stderr, exit 원문, prompt, OAuth URL/token과 추정 credential path는 log field가
아니다.

기본 metric:

```text
updates_received_total
updates_denied_total{reason_class}
jobs_active
jobs_queued
jobs_completed_total{result_class}
approvals_total{result_class,risk}
worker_duration_seconds
telegram_api_errors_total{status_class}
```

label에 user/chat/message/proposal 원문을 넣지 않는다. 필요한 correlation은 App
재시작마다 salt가 바뀌는 hash로 만든다. raw prompt, raw NDJSON과 Bot API body는
로그하지 않는다.

현재 bridge는 위 이름을 고정 key로 갖는 process-local bounded counter/gauge/histogram
snapshot을 60초마다 `event=metrics` App 로그로 내보낸다. label 값은 코드에 고정된
reason/result/status class만 허용하며 재시작 시 0부터 시작한다. 장기 보존과 원격
전송은 HAOS 운영 검증 뒤 별도 결정하며, raw identifier를 추가하는 방식은 허용하지
않는다.

## TG-013 — 수용 기준

- unauthenticated user가 pairing 정보와 runtime 상태를 얻지 못한다.
- cross-user/chat callback, replay, expiry와 changed-preview confirmation이 거부된다.
- 31개 choice+cancel의 4×8 layout, `v3c`/`v3d` callback, legacy `v2a`/`v2d`, unknown
  token과 두 번째 다른 선택의 거부를 검증한다.
- shell metacharacter가 argv나 shell execution으로 변하지 않는다.
- per-chat serialization, global concurrency와 queue limit이 지켜진다.
- global permission option이 Web/SSH/Telegram에 동일하게 적용되고 legacy
  `telegram_access_mode`가 권한 source로 사용되지 않는다.
- Telegram-enabled preserve update가 safe legacy settings의 App 관리 보안 field,
  selected mode의 sparse native shape와 known permission boundary를 transaction backup
  뒤 canonicalize하고 그 밖의 top-level
  settings, global MCP와 OAuth를
  보존하며, 두 번째 실행은 write/backup 없이 idempotent하다.
- 2.0.16 `refresh_managed`는 safe parseable settings의 기존 allow/ask/deny bucket이
  malformed여도 managed 세 bucket을 typed merge validation 전에 canonical policy로
  canonicalize한다. unsafe-file preflight와 unrelated-state 보존 범위는 바꾸지 않는다.
- unsafe effective permission fixture는 Bot API 호출 전에
  `permission_boundary_blocked` 한 건을 만들고 bridge process를 exit시키거나 S6 restart
  loop를 만들지 않는다.
- timeout/cancel/restart 뒤 child와 capability가 남지 않는다. bridge-only restart는
  broker가 살아 있을 때 encrypted choice mapping을 복구하고, full App/broker restart는
  미접수 in-memory proposal을 실행하지 않으며 접수된 결과만 durable status로 회수한다.
- proposal register 직후 approval/card sealing 전 bridge crash fixture는 durable
  registration을 주장하지 않고 사용자 재시도 경로로 끝난다.
- token/prompt/raw output canary가 App log, Telegram reply와 artifact에 없다.
- split stderr marker와 대용량 stderr에서도 matcher state가 bounded이고 원문을
  남기지 않으며 exit 1+exact marker, exit 70, 나머지 실패가 서로 오인되지 않는다.
- 첫 요청 전에 binding이 저장되고 healthy 후속 prompt/approval/reply가 같은
  conversation을 사용한다. `/new`는 명시적 회전 command다. terminal worker failure는
  failed conversation을 quarantine하고 update를 durable ACK하며 다음 user request에
  새 generation을 결합하고 failed mutation을 replay하지 않는다.
- `request-review`와 explicit `always-proceed` canonical policy가 각각 Web/SSH/Telegram에
  동일하게 적용되고, 두 mode 모두 mandatory sensitive deny를 유지한다.
- model 성공 뒤 Telegram 실패·process crash에서도 encrypted outbox가 같은 reply를
  재전송하고 ack 뒤에만 제거한다.
- optional bounded `toolAction`/`toolSummary` receipt와 단일 유효 proposal 뒤의 빈
  terminal-text fallback은 승인 카드를 만들고, unknown metadata key와 proposal 없는
  빈 response는 typed failure로 남는다.
- pairing/local command/transport 정상과 공유 native OAuth·Antigravity 상태를 혼동하지
  않고 인증 필요 시 `ha-antigravity-login`만 안전하게 안내한다.
- 실제 1.1.13에서 user global/workspace plugin·agent·rule·MCP와 native permission을
  Web/SSH와 동일하게 상속하고 수정할 수 있다.
- 실제 HAOS에서 조회, 확인 변경, rollback과 Bot API 장애 복구를 검증한다.

local actual 1.1.11 shared-HOME positive control은 global MCP pre-auth launch를
재현했다. 2.0.7은 이를 격리 대상이 아니라 관리자 주 채널의 필수 inheritance
positive canary로 전환한다. primary OAuth backend/path를 추정하지 않았고 실제 HAOS
OAuth, live Telegram session/outbox와 AppArmor enforce는 미검증이므로 최종 수용
기준은 아직 `PARTIAL`이다.
2.0.12 repaired image의 실제 HAOS amd64 update reconciliation, Bot API 재연결·전달과
App restart/reconnect는 2026-08-18 `PASS`했다. `permission_boundary_blocked` hold,
OAuth/unrelated-state 보존과 나머지 HA-004 E2E는 `NOT RUN`이며, aarch64 실기기
`NOT RUN`은 owner-waived experimental 배포 결정일 뿐 Telegram PASS가 아니다. 같은
현장 AppArmor 결과는 `docker-default (enforce)`로 custom attach `FAIL`이며 2.0.13
수정 profile은 다음 startup에서 `/run/s6`·`/run/service` 생성 거부와 exit 111로
`FAIL`했다. 공개 2.0.14도 관찰된 resolved Bashio execute 거부와 exit 126으로 startup
`FAIL`했고, 후속 trace는 init의 resolved `with-contenv` target도 확인했다. 2.0.15는
전체 trace-derived runtime closure 중 Telegram의 resolved `s6-pause`를 Telegram
profile에만 exact execute로 추가했지만, 실제 HAOS의 `refresh_managed`가 malformed
`permissions.ask`를 safe-policy replacement 전에 거부해 bridge가
`permission_boundary_blocked`에 머물렀다. 따라서 2.0.15 Telegram 수용은 `FAIL`이다.
2.0.16은 supported safe settings에서 managed bucket을 검증 전에 canonicalize하지만
unsafe file과 unsafe effective boundary는 계속 Bot API 접촉 없이 fail closed한다.
2.0.16 실제 HAOS reconcile/connect는 성공했지만 native CLI의 AppArmor `file_mmap`
denial과 SIGSEGV/status 139 때문에 모든 worker가 `session_ready` 뒤 실패했다. bridge는
2.0.17부터 native child의 bounded termination signal을 진단에 포함하되 stderr, prompt,
OAuth, token과 사용자 content를 기록하지 않는다. `/new`나 reconnect는 이 crash를
복구하지 않는다. 이후 actual 2.0.17 HAOS amd64에서 basic/no-tool worker completion은
`PASS`했지만 managed MCP와 `telegram_action_propose`는 `FAIL`했다. kernel audit는
`change-proposal-client`의 exact image-owned `supervisor-credential-fd.mjs` module read
거부를 확인했고, 두 confined launcher는 proposal의 requester/run binding 다섯 값을
버렸다. 승인카드 전 실패했으므로 approved write는 `NOT RUN`이고 2.0.17 전체 수용은
`FAIL`이다.

2.0.18은 proposal client에 해당 exact module read를 추가했다. restricted와
sensitive-read launcher는 다섯 run binding이 전부 있거나 전부 없는지만 허용하고,
일부 binding은 fail closed하며 완전한 tuple만 함께 전달한다. 이후 실제 공개 2.0.18
amd64는 Telegram transport/no-tool chat을 `PASS`했지만 첫 managed tool은 terminal
error로 `FAIL`했다. 후속 3~7은 같은 failed conversation reuse라 각 tool의 독립 결과가
아니며 approved write는 `NOT RUN`이다. 2.1.0은 request-review/always-proceed dual mode,
raw native file deny, confined `ha_files`와 failed-conversation quarantine을 적용한다.
자동 회귀는 HAOS 증거가 아니며, 2.1.0 amd64/aarch64의 single read→proposal/approved
`ha_files` write 및 autonomous ordinary MCP work는
배포 시점 `NOT RUN`이다.
