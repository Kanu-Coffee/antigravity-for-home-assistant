# v2 마이그레이션과 릴리스

`MIG-*`는 이 계약의 안정 식별자다. 문구나 순서가 바뀌어도 기존 번호를 다른
요구사항에 재사용하지 않는다.

## MIG-001 — 배포 모델

public App은 사용자의 HAOS에서 source build하지 않고 GHCR prebuilt image를
받는다.

```yaml
version: "2.0.0"
arch:
  - amd64
  - aarch64
image: ghcr.io/kanu-coffee/antigravity-for-home-assistant
breaking_versions:
  - "2.0.0"
```

`apparmor`의 Supervisor 기본값은 `true`다. pinned App linter가 중복 기본값을
거부하므로 metadata key는 생략하지만 같은 디렉터리의 custom `apparmor.txt`가
기본 profile을 대체하며 `apparmor: false`는 허용하지 않는다.

Supervisor는 `version`을 image tag로 사용한다. 같은 numeric tag에 amd64와
aarch64 manifest가 모두 있을 때만 `config.yaml`에 두 아키텍처를 선언한다.
첫 v2는 보안·설정·Telegram 계약이 바뀌므로 breaking version으로 표시하고
자동 major update가 아니라 사용자가 release note를 읽고 선택하게 한다.

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
| Telegram | bot option, static allowlist, `/data/antigravity-ha/telegram-home` | option 보존, dedicated native auth 보존, managed customization 재검증. legacy pairing/session은 폐기 |
| 임시 상태 | `/run/antigravity-ha/**` | 매 시작 폐기 |

OAuth, token과 private key는 backup 대상이어도 내용을 읽어 변환하거나 log하지
않는다. regular file, owner, link count와 mode를 검증한 뒤 같은 filesystem에서
보호된 archive에 byte-for-byte 보존한다.
대화형 `/data/home`의 OAuth 자료를 Telegram HOME으로 복사하지 않는다. 기존 v1에
별도 Telegram identity가 없으면 update 후 trusted local TTY에서
`ha-telegram-login`을 실행하며, 실제 HAOS OAuth 성공 전에는 bot을 계속 끈다.

## MIG-003 — migration mode

mode와 무관하게 App 소유 `home-assistant` plugin은 안전한 ownership marker가
확인되면 App version당 한 번 image의 canonical copy로 갱신한다. 신규 설치는 현재
version을 marker에 기록한다. 같은 이름의 기존 plugin에 marker가 없거나 marker가
안전하지 않으면 사용자 소유 충돌로 보고 덮어쓰지 않은 채 App start를 중단한다.
이 보안 갱신은 `preserve`가 억제할 수 없다.

### `preserve` 기본값

- existing native OAuth, settings, keybindings, conversation, 사용자 MCP/plugin을
  변경하지 않는다.
- native settings와 global MCP 파일이 없을 때만 기본 파일을 만든다. 기존 파일의
  사용자 key와 server는 그대로 보존한다.
- 위 공통 규칙에 따라 ownership이 확인된 App 관리 plugin은 canonical refresh하고,
  같은 이름의 사용자 소유 plugin은 conflict로 중단한다.
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

- `refresh_managed`와 같은 settings key·permission rule 구조 merge를 수행하되,
  기존 settings의 App ownership state가 없거나 모호하면 보존 경고로 계속하지 않고
  conflict로 중단한다.
- plugin 내부 MCP/rules/skills 갱신은 mode가 아니라 위 공통 version별 plugin
  transaction이 담당한다. global MCP 파일은 존재하면 byte-preserve한다.
- 공식 CLI OAuth 자료, `/config`, SSH host key, authorized keys, browser identity,
  memory DB와 사용자 소유 plugin/MCP server는 보존한다.
- 이 mode는 같은 App version에서 한 번만 실행하고 성공 뒤 option을 자동으로
  바꾸지 않는다. 다음 restart에서는 completion state로 재실행을 건너뛴다.

## MIG-004 — v1 옵션 변환

v2.0.x는 update input을 읽기 위해 deprecated v1 key와 enum을 migration-only로
수용할 수 있다. 이 값은 native CLI에 전달하지 않고 다음처럼 보수적으로
변환한다.

| v1 입력 | v2 결과 |
| --- | --- |
| `antigravity_approval_policy=untrusted` | `antigravity_tool_permission=strict` |
| `antigravity_approval_policy=on-request` | `antigravity_tool_permission=request-review` |
| `antigravity_approval_policy=never` | `request-review`로 낮추고 명시적 경고. auto-approve를 승계하지 않음 |
| `antigravity_sandbox_mode=*` | `antigravity_terminal_sandbox=true` |
| `browser_approval_policy=*` | 제거. v2 browser MCP allowlist 사용 |
| `antigravity_user_files_update_mode=preserve` | `preserve` |
| `...=refresh_agents` | `refresh_managed` |
| `...=refresh_all` | `refresh_managed`; `reset_v2`는 사용자가 새로 선택해야 함 |
| `antigravity_token` | import하지 않음. 공식 OAuth 필요 상태 보고 |
| `telegram_allowed_chat_ids` | 유효 ID만 보존. user allowlist와 교집합을 이루거나 새 private pairing 전까지 모든 메시지를 거부 |
| legacy Telegram pairing/session | `/data/antigravity-ha/quarantine/v1-telegram/`으로 root-only 원자 격리하고 v2에서 재사용하지 않음 |
| `home_assistant_browser_token` | 새 secret으로 복사하지 않음. 관리 identity 재검증 또는 setup 안내 |

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
7. postcondition과 Antigravity plugin discovery를 확인한 뒤 commit한다.
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
`plugin validate`를 통과한 뒤 rename/fsync하고, target digest, plugin validation과
`ha-telegram` discovery를 postcondition으로 검사한다. stage validation 실패,
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
9. 실제 1.1.11의 `AGY_CLI_DISABLE_AUTO_UPDATE=true` propagation과 updater
   spawn/version/digest canary

Candidate와 Builder workflow 조건:

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
  `HA_ARCH`로 가능한 full image suite를 실행한다. public 이전 image가 필요한 update
  suite의 arm64 범위는 실제 HAOS evidence로 닫는다.
- leaf별 SPDX JSON을 exact leaf digest에서 만들고 각 파일이 16 MiB 미만인지
  검사한다. 모든 artifact name에는 run ID와 run attempt가 포함된다.
- HAOS rehearsal은 candidate 재build 없이 별도 `Candidate / finalize`에서 해당
  candidate digest와 source SHA에 결합한다. 양 arch install/update, AppArmor enforce,
  Telegram mode, migration, rollback, native updater와 repository install/update가 모두
  `PASS`이고 각 sanitized evidence URI와 SHA-256이 있어야 한다. finalize는 repository
  Actions artifact archive 또는 public release asset을 실제 다운로드해 content SHA-256을
  비교한 뒤에만 final artifact를 만든다. finalize dispatch SHA가 candidate source와
  같아야 하며 verifier script도 그 exact source SHA를 다시 checkout해서 실행한다.
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

1. 모든 자동 검사가 green인 release commit에서 `Candidate / build`를 수동 실행한다.
2. machine candidate artifact의 generic exact digest를 실제 HAOS amd64와 aarch64에
   설치해 upgrade rehearsal을 수행한다.
3. `preserve`, `refresh_managed`, `reset_v2`, rollback, AppArmor enforce, Telegram 세
   모드, browser, memory, updater canary와 repository install/update 증거를 기록한다.
4. [release-evidence-template.json](release-evidence-template.json)을 secret과 식별자 없이
   채우고 같은 source ref에서 `Candidate / finalize`에 JSON으로 전달한다.
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
10. 새 HAOS에서 post-publish repository metadata와 App install/update를 확인한다.

1~4의 외부 evidence가 하나라도 없거나 `NOT_RUN`이면 finalize와 Builder는 fail
closed한다. 현재 이 repository에는 실제 HAOS final evidence와 public candidate package
상태가 없으므로 v2 release gate는 `PARTIAL`이다.

`stage: experimental`은 최소 두 아키텍처의 실제 HAOS 릴리스 회귀와 한 번의
성공적인 이전 public version update가 쌓일 때까지 유지한다.

## MIG-011 — 릴리스 증거 양식

machine record는 source SHA, candidate run/attempt, generic/staging/leaf digest와 자동
gate를 가진다. manual record는 template의 정확한 여덟 gate와 candidate digest를
가진다. finalize artifact archive 자체의 SHA-256까지 annotated tag에 다음처럼 묶는다.

```text
Candidate-Run-ID: <positive integer>
Candidate-Run-Attempt: <positive integer>
Release-Evidence-Run-ID: <positive integer>
Release-Evidence-Run-Attempt: <positive integer>
Release-Evidence-Artifact: release-evidence-<version>-<source>-<candidate-run>-<candidate-attempt>-<evidence-run>-<evidence-attempt>
Release-Evidence-SHA256: sha256:<64 lowercase hex>
```

template의 `NOT_RUN`은 의도적인 fail-closed 초기값이다. 필수 완료 조건의 실제
sanitized evidence가 없으면 final artifact, numeric image와 GitHub Release를 만들지
않으며 v2 완료로 표시하지 않는다. 자동화가 검증하는 것은 allowlisted repository에서
다운로드한 evidence byte와 digest, candidate/source 결합이다. 보고서 안의 실제 HAOS
행위가 정직하게 수행됐다는 의미까지 암호학적으로 증명하지는 않으므로, finalizer를
실행한 repository maintainer가 sanitized report를 검토한 trusted-attestor 경계로 남는다.
