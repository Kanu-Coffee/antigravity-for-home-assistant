# Security policy

[한국어](#한국어) · [English](#english)

## 한국어

Antigravity for Home Assistant는 `/config` read-write, Home Assistant Core API,
Supervisor `manager` 권한을 사용하는 실험 단계의 관리자 도구입니다. 보안 수정은
원칙적으로 가장 최근 공개 릴리스를 대상으로 합니다.

취약점은 가능하면 GitHub의
[비공개 취약점 제보](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new)로
보내 주세요. 기능을 사용할 수 없다면 공개 이슈에는 민감정보 없이 비공개 연락이
필요하다는 사실만 남기세요.

제보에는 영향받는 App·HAOS·Core 버전과 architecture, 공격 전제조건, 영향,
최소 재현 단계, 예상·실제 동작, 비밀정보를 제거한 증거를 포함해 주세요. 다음
자료는 보내지 마세요.

- Supervisor credential 또는 Antigravity Remote/OAuth/session 자료
- browser identity, GitHub credential, private key, `secrets.yaml`, `.storage`
- Home Assistant backup, private URL/IP, 실제 사용자·entity·device 식별정보

원격 접근이나 credential 노출이 의심되면 App을 중지하고 Antigravity 및 관리형
browser session을 폐기한 뒤 필요한 계정 credential을 교체하세요. 노출된 값을
다른 로그나 이슈에 다시 붙여 넣지 마세요.

보안 경계는 다음과 같습니다.

- AppArmor는 항상 활성화되며 option으로 끌 수 없습니다.
- `antigravity_sensitive_data_access`는 제한된 Home Assistant 민감 경로의 read-only
  진단만 추가하며 App credential, Remote token 또는 쓰기 권한을 허용하지 않습니다.
- Remote와 Ingress는 같은 관리자용 Antigravity HOME과 `/config`를 사용합니다.
  Antigravity의 native permission 결정을 우회하지 마세요.
- Supervisor credential은 전용 helper profile에 격리되고 일반 Antigravity process의
  환경이나 파일 접근면에 노출되지 않아야 합니다.
- 관리형 browser 사용자는 local-only, non-admin, `system-read-only`이지만 모든
  entity state를 볼 수 있습니다.
- App은 Docker API, `full_access`, host network 또는 공개 SSH/Telegram channel을
  제공하지 않습니다.

현재 설계와 검증 범위는 [보안 문서](../docs/development/security.md)와
[테스트 계획](../docs/development/test_plan.md)을 확인하세요.

## English

Antigravity for Home Assistant is an experimental administrative tool with
read-write `/config` access, the Home Assistant Core API, and the Supervisor
`manager` role. Security fixes normally target the latest public release.

Use [GitHub private vulnerability reporting](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new)
when possible. Otherwise, open only a non-sensitive request for a private
contact channel. Include affected App, HAOS, and Core versions, architecture,
prerequisites, impact, minimal reproduction steps, expected and actual
behavior, and redacted evidence.

Never send Supervisor credentials; Antigravity Remote, OAuth, or session data;
browser identities; GitHub credentials; private keys; `secrets.yaml`;
`.storage`; Home Assistant backups; private URLs or IPs; or identifying user,
entity, and device data.

If remote access or credential exposure is suspected, stop the App, revoke the
Antigravity and managed-browser sessions, and rotate affected account
credentials. Do not paste the exposed value into another log or issue.

The custom AppArmor policy is always enabled. The sensitive-data option adds
only bounded read-only diagnostics and does not expose App credentials, the
Remote token, or write access. Remote and Ingress share the administrator
Antigravity HOME and `/config`, and native permission decisions must not be
bypassed. The Supervisor credential remains isolated to dedicated helper
profiles. The managed browser user is local-only, non-admin, and
`system-read-only`, but can see all entity state. The App exposes no Docker API,
`full_access`, host network, public SSH service, or Telegram channel.

See the current [security design](../docs/development/security.md) and
[test plan](../docs/development/test_plan.md) for boundaries and evidence
requirements.
