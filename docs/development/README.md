# Superseded v1 development evidence

[현재 v2 계약](../v2/README.md) · [프로젝트 README](../../README.md) ·
[기여 안내](../../CONTRIBUTING.md) · [보관 문서](../archive/README.md)

> [!CAUTION]
> 이 디렉터리의 모든 Markdown 문서는 superseded historical evidence입니다.
> 현재 제품·런타임·보안·패키징·테스트 계약이 아니며, 구현 지침으로 사용하면
> 안 됩니다. v2 작업의 유일한 canonical 계약은 [`docs/v2/`](../v2/README.md)입니다.

## 현재 작업 라우팅

v2 작업은 다음 순서로 읽습니다.

1. 루트 [AGENTS.md](../../AGENTS.md)
2. [v2 문서 색인과 상태 규칙](../v2/README.md)
3. [제품 사양](../v2/product-spec.md)과 [아키텍처](../v2/architecture.md)
4. 변경에 해당하는 [Antigravity](../v2/antigravity-contract.md),
   [보안](../v2/security.md), [Telegram](../v2/telegram-spec.md) 또는
   [migration·release](../v2/migration-release.md) 계약
5. [테스트 계획](../v2/test-plan.md)과 [구현 체크리스트](../v2/checklist.md)

구현 파일이나 test가 존재한다는 사실만으로 `VERIFIED`라고 표시하지 않습니다.
실제 test ID, source SHA, image digest, architecture와 필요한 HAOS/AppArmor 증거를
기록합니다.

## 이 디렉터리를 보존하는 이유

아래 파일은 v1 당시의 설계 의도, 조사와 릴리스 증거를 추적하는 데만 사용합니다.
내용에 나오는 단일 아키텍처, legacy provider 설정, `config.toml`, `runtime.env`,
shell/tmux Telegram 또는 과거 option 이름은 v2 계약이 아닙니다.

| Historical document | 보존 목적 |
| --- | --- |
| [rules.md](rules.md) | 당시 저장소 작업 원칙 |
| [product_spec.md](product_spec.md) | v1 제품 요구와 수용 기준 |
| [architecture.md](architecture.md) | v1 신뢰 경계와 runtime 구조 |
| [addon_spec.md](addon_spec.md) | v1 App metadata와 option 설계 |
| [security.md](security.md) | v1 threat model과 guardrail |
| [test_plan.md](test_plan.md) | v1 검증 전략 |
| [decisions.md](decisions.md) | 과거 architecture decision |
| [references.md](references.md) | 당시 참고 자료 |
| [progress.md](progress.md) | 과거 CI·실기 증거 |
| [releasing.md](releasing.md) | 과거 publish 절차 |

historical 문서에서 재사용할 아이디어가 있으면 먼저 v2 요구사항 ID와 test mapping을
추가하고 canonical 문서에 새 결정으로 반영합니다. 이 디렉터리의 문구를 그대로
현재 상태나 지원 범위로 인용하지 않습니다.
