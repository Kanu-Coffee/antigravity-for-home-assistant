# Documentation

[한국어 README](../README.md) · [English README](../README.en.md)

> [!IMPORTANT]
> [v2 문서 패키지](v2/README.md)가 현재 v2 구현의 유일한 canonical 제품·아키텍처·
> 보안·Telegram·migration·test 계약입니다. 다른 개발 문서와 충돌하면 `docs/v2/`를
> 따릅니다.

## v2 canonical 계약

- [문서 패키지 읽기 순서와 상태 규칙](v2/README.md)
- [제품 요구사항](v2/product-spec.md)
- [아키텍처](v2/architecture.md)
- [Antigravity 1.1.13 계약](v2/antigravity-contract.md)
- [보안 계약](v2/security.md)
- [Telegram 계약](v2/telegram-spec.md)
- [Migration·release 계약](v2/migration-release.md)
- [테스트 계획](v2/test-plan.md)
- [구현 체크리스트](v2/checklist.md)

## 사용자 문서

- [한국어 사용 설명서](../antigravity_home_assistant/DOCS.md)
- [English user guide](../antigravity_home_assistant/DOCS.en.md)
- [한국어 프롬프트 예시](examples.ko.md)
- [English prompt examples](examples.en.md)
- [지원 안내](../SUPPORT.md)
- [보안 정책](../.github/SECURITY.md)
- [변경 기록](../antigravity_home_assistant/CHANGELOG.md)

## 개발·운영 문서

- [v1 개발 기록](development/README.md) — superseded historical evidence
- [보관 문서 안내](archive/README.md)

`docs/development/*.md` 전체는 v1 당시의 판단과 증거를 재현하기 위해 보존합니다.
amd64-only, 비-native 설정, legacy runtime 환경과 과거 release 절차를 현재 v2
지침으로 사용하지 마세요. 사용자 가이드는 현재 공개 버전을 기준으로 유지하고,
구현 상태 판정은 v2 checklist와 실제 test evidence를 사용합니다.
