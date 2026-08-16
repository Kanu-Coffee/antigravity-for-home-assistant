# v2 Telegram 브리지 사양

`TG-*`는 이 계약의 안정 식별자다. 문구나 순서가 바뀌어도 기존 번호를 다른
요구사항에 재사용하지 않는다.

## TG-001 — 범위

2.0.7 Telegram 브리지는 Antigravity와 별개인 축소 agent가 아니라 같은 관리자
환경을 노출하는 transport adapter다. Bot API long polling, 인증, stable session,
per-session queue, print transport, 암호화 reply outbox와 confirmation routing을
담당한다. shell, interactive TUI와 tmux pane scraping은 범위 밖이다.

첫 v2 릴리스는 UTF-8 text message만 처리한다. voice, photo, document, location,
inline mode, group mention 자동 응답과 webhook server는 지원하지 않는다.

## TG-002 — 활성화와 인증

bridge 시작 조건은 다음을 모두 만족해야 한다.

1. `telegram_enabled=true`
2. `telegram_bot_token`이 schema와 secret-file preflight를 통과
3. static allowlist 또는 유효한 local pairing identity가 하나 이상 존재
4. App init과 readonly/proposal broker가 ready

1~2가 충족됐지만 3이 아직 충족되지 않으면 bridge는 Bot API에 접속하거나 종료하지
않고 bounded local authorization state만 주기적으로 다시 확인한다. 이 대기 상태는
한 번만 정제해 기록하며 S6 restart loop를 만들지 않는다. local pairing 생성은 같은
프로세스에서 감지하고, static option 변경은 App 재시작 뒤 반영한다. authorization
state의 type/mode/schema가 안전하지 않으면 대기하지 않고 fail closed 한다.

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
- 실행 중 queue는 `/run`에만 저장한다. approval은 conversation/user/chat에 결합하며
  restart 뒤 유효성을 다시 증명할 수 없으면 취소한다.
- conversation binding은 opaque Antigravity conversation ID만 `/data`에 저장하고
  idle timeout으로 만료하거나 worker 실패 시 교체하지 않는다. response는 delivery가
  끝날 때까지만 sealed reply outbox에 저장하고 처리 완료 prompt는 저장하지 않는다.
- `/new`만 새 binding을 생성하며 Antigravity 내부 history 파일을 임의 삭제하지 않는다.

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
  "--conversation", "<bound-id>",
  "--sandbox" // global option이 true일 때만
]
cwd = "/config"
HOME = "/data/home"
stdin = normalized prompt
```

Antigravity 1.1.11은 non-TTY stdin이 pipe되면 print mode를 자동 선택한다. 값 없는
`--print`/`-p`는 boolean switch가 아니라 다음 argv를 prompt 값으로 소비하므로 넣지
않는다. global agent·plugin의 slash command를 그대로 상속하므로
`--disable-slash-commands`도 넣지 않는다. 이 규칙으로 prompt는 argv나 environment에
노출되지 않고 stdin에만 남는다.

첫 실행 전에 App이 생성·보관한 conversation ID를 결합하고 항상
`--conversation <opaque-id>`로 전달한다. prompt에서 CLI flag, environment, model,
conversation 또는 path를 추출하지 않는다. worker 실패·timeout·App 재시작은 binding을
바꾸지 않으며 `/new`만 새 ID를 만든다.

worker environment는 Web/SSH wrapper와 같은 HOME, PATH, locale, native permission,
sandbox 및 민감정보 profile 선택과 requester binding을 사용한다. Supervisor,
Telegram, browser raw credential과 shell startup 변수는 environment value로 전달하지
않는다. HOME은 `/data/home`, cwd는 `/config`이며 OAuth와 user global/workspace
plugin·agent·rule·MCP를 의도적으로 상속하고 수정할 수 있다. 별도 Telegram settings,
plugin copy, safe cwd, HOME bootstrap 또는 login helper는 없다.

actual Antigravity 1.1.11 shared-HOME canary는 user global stdio MCP가 OAuth 인증 완료
전에도 실행될 수 있음을 재현했다. 2.0.7은 이를 관리자 주 채널의 명시적 동작으로
채택한다. local container 증거를 실제 HAOS OAuth 성공, credential 비유출 또는
AppArmor enforce 증거로 확대하지 않는다.

stdout NDJSON 총량은 4 MiB, 단일 line은 256 KiB로 제한한다. 최종 사용자 text는
32 KiB까지 허용해 Telegram 4096-character 경계에 맞춰 최대 8개 message로
Unicode-safe 분할한다. 초과 결과는 local raw output을 보존하지 않고 요약 실패를
보고한다.

pinned 1.1.11 stream의 top-level discriminator는 `type`이 아니라 `event`다. init과
terminal result는 같은 conversation ID여야 하며, terminal은
`result.status == "SUCCESS"`와 관리형 schema JSON을 담은 `result.response`를 모두
충족해야 한다. legacy `type`, 실패 status, 다른 conversation ID와 recursive
fallback payload는 거부한다.

pinned 1.1.11 native child의 stderr는 원문을 저장·로그·회신하지 않는다. bridge는
`Error: authentication required. Run 'antigravity-real' to log in, then retry.`라는
고정 byte marker만 marker 길이 미만의 tail을 유지하는 bounded streaming matcher로
판정한다. exit 1과 이 marker가 모두 있으면 `authentication_required`로 분류한다.
그 밖의 nonzero는 `worker_failed`다. 인증 필요 응답은 trusted local TTY의
`ha-antigravity-login`을 안내한다.
exit 0, stdout 0 byte와 pinned headless auto-denial marker가 정확히 함께 있을 때만
`headless_read_denied`로 분류한다. marker가 있어도 nonzero, malformed
nonempty stream 또는 정상 terminal result이면 이 분류를 적용하지 않는다. stderr의
마지막 줄이나 tool target은 저장·로그·회신하지 않는다.

`/status`의 transport 정상은 Bot API command가 bridge에서 처리된다는 뜻일 뿐이다.
공유 AI runtime 상태는 App 시작 뒤 `아직 확인되지 않음`에서 시작해 완료된 최근
native child 결과만 `ready`, `authentication_required`, `headless_read_denied` 또는
`worker_failed`로 갱신한다. 이 상태에는 identifier,
prompt, stderr 또는 credential 자료를 넣지 않는다.

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
  operation: "config_patch" | "service_call" | "device_test";
  risk: "low" | "high";
  requester: {
    surface: "telegram";
    user_id: string;
    chat_id: string;
  };
  preview: ConfigPatchPreview | ServiceCallPreview | DeviceTestPreview;
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
        kind: "none";
        executable: false;
        reason: "supported_activation_contract_required";
      };
};

type ServiceCallPreview = {
  summary: string;
  service: string;
  entity_id: string;
  expected_state: "on" | "off";
  verify_state: "on" | "off";
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
raw API body가 없어야 한다.

`config_patch`의 human preview는 model summary가 아니라 broker가 normalized
mutation에서 생성한 secret-safe bounded structured diff여야 한다. 최소한 exact
target, 변경 종류, secret value를 제거한 key/line 단위 before/after, 생략 여부와
전체 mutation digest를 포함한다. raw full replacement를 Telegram에 보내지 않는다.
target, digest, byte 수와 model summary만 보여 주는 preview는 실제 replacement를
검토할 수 없으므로 confirmation에 충분하지 않다. `preview_digest`는 이 canonical
preview와 실행할 normalized mutation을 함께 묶어 어느 한쪽이 달라져도 기존
approval을 무효화해야 한다.

첫 실행 가능한 `config_patch` payload는
`activation: {"kind":"input_boolean_reload"}`를 포함해야 한다. broker는
`configuration.yaml`의 단일 canonical root-level `input_boolean: !include`가 target을
가리키는지, replacement가 flat helper map과 `name`/`icon`/`initial` 제한을 지키는지
검사하고 affected entity expectation을 직접 만든다. 기존 helper의 `initial` 변경처럼
fresh API로 완전히 증명할 수 없는 mutation은 거부한다. activation 없는 임의 YAML은
structured preview까지만 제공하며 승인돼도 파일을 쓰지 않는다.

`device_test` payload는 `light`, `switch`, `input_boolean` 중 exact entity와
`turn_on`/`turn_off`, `expected_prior_state`만 받는다. expected prior와 service가 만드는
test state가 같으면 no-op이므로 proposal 단계에서 거부한다. lock/cover/alarm/climate,
restart/update와 임의 service는 device test allowlist에 들어오지 않는다. preview의
test/restore plan은 broker가 normalized payload에서 만들고 digest에 묶는다.

## TG-009 — global permission과 confirmation

Telegram 전용 mode는 없다. Web/SSH와 동일한 `antigravity_tool_permission`,
`antigravity_terminal_sandbox`, `antigravity_sensitive_data_access`를 native 실행에
적용한다. 2.0.6 이하의 `telegram_access_mode`는 무시하는 migration 입력이며 권한
source가 아니다.

1.1.11 `stream-json`은 native interactive permission request를 외부 transport에
노출하거나 승인 뒤 같은 turn을 재개하는 protocol을 제공하지 않는다. 따라서 공유
global allow rule에 포함된 plugin·agent·rule·settings·`/config` file action은
headless-compatible하게 처리하고, App 관리 HA mutation의 사람 확인은 same-session
broker proposal/button으로 수행한다. 그 밖의 native tool이 `request-review`를 요구하면
Telegram 전용 auto-approve를 만들지 않고 비대화형 거부한다. 사용자는 Web/SSH에서
검토하거나 global `antigravity_tool_permission`을 명시적으로 변경해야 한다.

지원 activation이 없는 preview-only `config_patch`는 broker가 `high`로 분류한다.
사용자가 확인해도 실행 단계에서 파일을 쓰지 않고 fail closed한다.

현재 `low`인 유일한 config 정책은 broker가 canonical root-level
`input_boolean: !include` target, restricted helper schema, affected entity expectation,
backup/config-check/reload/rollback plan을 모두 계산한 `input_boolean_reload` 중 기존
helper의 `name`/`icon` metadata를 fresh API로 완전히 검증할 수 있는 update다. helper
create/remove, 기존 metadata 제거, 임의 YAML, 모든 `service_call`과 모든
`device_test`는 계속 `high`이거나 검증 불가능으로 거부된다. model의 risk 표시는 이
판정을 낮출 수 없다. `device_test`는 global native policy와 관계없이 human
confirmation 없이 실행되지 않는다.

고위험 목록은 [security.md](security.md)에 정의하며 global policy로 낮출 수 없다.

coordinator 내부 record는 wire JSON이 아니다. 구현은 random approval ID를 Map key와
callback data에 두고 다음 값을 보관한다.

```ts
type PendingApproval = {
  conversationId: string;
  requester: ChangeProposal["requester"];
  proposal: ChangeProposal;
  idempotencyKey: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
};

type PendingApprovals = Map<string, PendingApproval>; // approval ID → record
```

- 기본 TTL은 2분이다.
- inline Confirm/Cancel button의 callback data에는 random approval ID만 넣는다.
- callback conversation/user/chat이 record와 다르면 generic denial 후 아무 상태도
  바꾸지 않는다.
- Confirm은 preview digest와 현재 proposal을 다시 비교하고 1회용 capability를
  발급한다.
- Cancel, expiry, restart, `/cancel`, proposal 변경 또는 첫 Confirm 시 record를
  즉시 폐기한다.
- 실행 직전 broker가 risk, target와 현재 precondition을 다시 검증하고 결과를 같은
  conversation reply outbox에 넣는다.

## TG-010 — 실행과 결과

coordinator의 `execute`는 capability와 binding을 검증한 뒤 `in_progress` idempotency
record를 fsync하고 즉시 durable job 접수 상태를 반환한다. 실제 mutation은 broker의
직렬 worker에서 수행하며 짧은 socket timeout에 묶지 않는다. bridge는 같은 requester와
idempotency key로 `execute_status`를 조회해 `completed` result 또는 재시작 뒤
`in_doubt`를 회수한다. 동일 key의 재시도는 새 mutation을 시작하지 않는다.

config 변경:

1. exact target, include source와 precondition 재확인
2. 기존 entity fresh state와 recoverable backup 확인
3. `memory_begin_change`로 broker-generated expectation commit
4. atomic candidate replace와 digest 확인
5. `ha-config-check`
6. `input_boolean.reload`
7. fresh API 기반 `memory_verify_change`
8. 실패 시 backup restore/reload/API verify와 rollback memory record
9. 모든 단계가 증명된 경우에만 성공 회신

reload가 지원되지 않거나 semantic memory의 begin/verify expectation을 표현할 수
없으면 해당 단계가 수행된 것처럼 보고하지 않는다. 첫 v2의 end-to-end 변경 완료
판정에는 supported reload와 `memory_begin_change`/`memory_verify_change` 연결이
모두 필요하다. 현재 이 local 실행 계약은 canonical input boolean include에만 있고,
automation/script/theme/다른 YAML에는 적용하지 않는다.

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
- shell metacharacter가 argv나 shell execution으로 변하지 않는다.
- per-chat serialization, global concurrency와 queue limit이 지켜진다.
- global permission option이 Web/SSH/Telegram에 동일하게 적용되고 legacy
  `telegram_access_mode`가 권한 source로 사용되지 않는다.
- timeout/cancel/restart 뒤 child와 capability가 남지 않는다.
- token/prompt/raw output canary가 App log, Telegram reply와 artifact에 없다.
- split stderr marker와 대용량 stderr에서도 matcher state가 bounded이고 원문을
  남기지 않으며 exit 1+exact marker, exit 70, 나머지 실패가 서로 오인되지 않는다.
- 첫 요청 전에 binding이 저장되고 후속 prompt/approval/reply가 같은 conversation을
  사용하며 오직 `/new`만 새 ID를 만든다.
- model 성공 뒤 Telegram 실패·process crash에서도 encrypted outbox가 같은 reply를
  재전송하고 ack 뒤에만 제거한다.
- pairing/local command/transport 정상과 공유 native OAuth·Antigravity 상태를 혼동하지
  않고 인증 필요 시 `ha-antigravity-login`만 안전하게 안내한다.
- 실제 1.1.11에서 user global/workspace plugin·agent·rule·MCP와 native permission을
  Web/SSH와 동일하게 상속하고 수정할 수 있다.
- 실제 HAOS에서 조회, 확인 변경, rollback과 Bot API 장애 복구를 검증한다.

local actual 1.1.11 shared-HOME positive control은 global MCP pre-auth launch를
재현했다. 2.0.7은 이를 격리 대상이 아니라 관리자 주 채널의 필수 inheritance
positive canary로 전환한다. primary OAuth backend/path를 추정하지 않았고 실제 HAOS
OAuth, live Telegram session/outbox와 AppArmor enforce는 미검증이므로 최종 수용
기준은 아직 `PARTIAL`이다.
