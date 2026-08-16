# Security policy

[한국어](#한국어) · [English](#english)

## 한국어

Antigravity for Home Assistant는 `/config` read-write, Home Assistant Core API와 Supervisor `manager` 권한을 사용하는 관리자 도구입니다. 취약점은 일반 버그와 분리해 비공개로 제보해 주세요.

### 지원 범위

보안 수정은 원칙적으로 [가장 최근 공개 릴리스](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases)를 대상으로 합니다. 이 프로젝트는 현재 `stage: experimental`입니다. 지원 architecture는 설치하려는 릴리스의 App metadata와 GHCR manifest를 기준으로 확인하세요. 이전 버전에서 문제가 발생했다면 최신 릴리스에서도 재현되는지 비밀정보 없이 확인해 주세요.

### 비공개 제보

가능하면 GitHub의 [비공개 취약점 제보](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new)를 사용하세요. 해당 기능이 보이지 않으면 공개 이슈에 취약점 상세나 재현 코드를 올리지 말고, 민감정보 없는 최소 내용으로 private contact가 필요하다고 알려 주세요.

다음을 포함하면 확인에 도움이 됩니다.

- 영향을 받는 앱 버전, Home Assistant Core/OS 버전과 장치 architecture
- 공격 전제조건과 영향 범위
- 최소 재현 단계
- 예상 동작과 실제 동작
- 비밀정보를 제거한 로그 또는 screenshot
- 가능하면 완화 방법

다음을 보내지 마세요.

- `SUPERVISOR_TOKEN`, Antigravity native OAuth/session 자료, browser 또는 Telegram token
- SSH private key, `secrets.yaml`, `.storage` 원본
- 실제 사용자명, 내부/외부 URL, IP, entity·device·area 이름
- 공개 dashboard screenshot이나 Home Assistant backup

### 긴급 완화

credential 노출이나 원격 접근 문제가 의심되면 먼저 앱을 중지하고 SSH port mapping과 Telegram bridge를 비활성화하세요. 관련 공개키, Bot token과 Antigravity session을 폐기하고, 자동 browser identity를 사용했다면 사용자 가이드의 제거 절차를 따르세요. 노출된 secret을 로그나 이슈에 다시 붙여 넣지 마세요.

### 보안 경계

- custom AppArmor profile은 항상 활성화되며 App option으로 끌 수 없습니다.
- `antigravity_sensitive_data_access`는 AppArmor를 끄는 option이 아닙니다. Web/SSH/Telegram Antigravity child에 같은 조건부 read-only 진단 profile을 적용하며 쓰기, browser, memory와 App credential 접근은 계속 차단합니다.
- `/config`는 앱에 read-write로 연결되며 Web/SSH/Telegram Antigravity가 같은 관리자 환경을 사용합니다. native 승인, terminal sandbox와 prompt 지침만을 완전한 경계로 간주하지 마세요.
- 앱은 Supervisor `admin`, Docker API, Home Assistant `full_access`, host network를 사용하지 않습니다.
- SSH는 공개키 전용이며 인터넷 직접 노출을 지원되는 배포 방식으로 간주하지 않습니다.
- Headless browser의 관리형 HA 사용자는 local-only, non-admin, `system-read-only`이지만 모든 entity state를 볼 수 있습니다.
- Telegram은 기본 OFF인 관리자 주 채널입니다. exact user/chat 인증 뒤 CLI의 `/data/home`, `/config`, OAuth, global/workspace customization과 permission을 상속하므로 Bot token, 허용 chat과 Telegram 계정을 관리자 credential처럼 보호해야 합니다. 고위험 변경에는 별도 사람 확인이 필요합니다.

현재 threat model과 실제 HAOS 검증 gate는 [v2 보안 계약](../docs/v2/security.md)을 확인하세요.

## English

Antigravity for Home Assistant is an administrative tool with read-write access to `/config`, the Home Assistant Core API, and the Supervisor `manager` role. Please report vulnerabilities privately and separately from ordinary bugs.

Security fixes normally target the [latest public release](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases). The project is experimental. Confirm supported architectures from that release's App metadata and GHCR manifest.

Use [GitHub private vulnerability reporting](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new) when available. If it is unavailable, do not publish exploit details or secrets in an issue; open a minimal, non-sensitive request for a private contact channel.

Include affected versions, architecture, prerequisites, impact, minimal reproduction steps, expected versus actual behavior, and redacted evidence. Never send Supervisor, browser, or Telegram tokens, Antigravity native OAuth/session data, SSH private keys, `secrets.yaml`, `.storage`, Home Assistant backups, private URLs, or identifying entity and user data.

If credential exposure or unintended remote access is suspected, stop the app, disable SSH and Telegram, revoke affected keys, Bot tokens, and sessions, and follow the browser-identity removal procedure in the [user guide](../antigravity_home_assistant/DOCS.en.md). Do not paste the exposed secret into another report.

The custom AppArmor profile is always enabled. `antigravity_sensitive_data_access` selects the same conditional read-only diagnostic profile for Web, SSH, and Telegram Antigravity; it does not disable AppArmor or grant browser, memory, or App-credential access. `/config` remains read-write and all three Antigravity surfaces are administrator tools. Telegram is off by default, requires exact user/chat authorization, and intentionally inherits the CLI's `/data/home`, `/config`, OAuth, global/workspace customizations, and permissions. Protect the Bot token, authorized chats, and Telegram accounts as administrator credentials; high-risk changes still require separate human confirmation. See the current [v2 security contract](../docs/v2/security.md) for the threat model and required HAOS enforcement evidence.
