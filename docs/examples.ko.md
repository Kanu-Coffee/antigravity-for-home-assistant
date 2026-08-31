# Antigravity Remote 프롬프트 예시

[프로젝트 README](../README.md) · [사용 설명서](../antigravity_home_assistant/DOCS.md)

Remote task는 실제 `/config`와 Home Assistant API를 사용할 수 있습니다. 처음에는
읽기 전용 조사와 계획만 요청하고, 변경 전에 backup·diff·검증 방법을 확인하세요.

## 구성 점검

```text
현재 /config를 읽기 전용으로 살펴봐.
구문 오류, 더 이상 존재하지 않는 entity 참조, 중복된 automation 후보를 찾아서
근거 파일과 line을 표시해 줘. 아직 파일을 수정하거나 service를 호출하지 마.
```

```text
최근 Core log에서 반복되는 오류를 credential을 노출하지 않는 범위로 분류해 줘.
가장 영향이 큰 원인 세 개와 각각의 확인 절차를 제안하고, 추측은 명확히 표시해 줘.
```

## 안전한 변경

```text
주방 조명이 일몰 뒤 움직임이 있을 때만 켜지는 automation을 설계해 줘.
현재 entity와 기존 automation을 먼저 확인하고 충돌을 설명해.
적용 전에는 정확한 diff와 rollback 방법을 보여 주고 내 승인을 기다려.
적용 후 ha-config-check와 새 state로 검증해.
```

```text
이 dashboard의 현재 구조를 보존하면서 모바일 1열 배치를 제안해 줘.
desktop과 mobile 화면을 browser로 확인하고 console/network 오류도 조사해.
먼저 screenshot 요약과 변경 계획만 보여 줘.
```

Antigravity native permission이 `ask`로 판단한 작업은 Remote에 승인 UI를 표시합니다.
승인 전에 target, 명령, 파일과 범위를 확인하세요.

## Browser 검사

```text
Home dashboard를 desktop과 mobile viewport에서 읽기 전용으로 확인해.
겹침, 잘림, 빈 card, console error와 실패한 network request를 표로 정리해.
browser 결과만으로 실제 기기 성능을 단정하지 마.
```

화면 안의 이름, 위치, 상태와 screenshot은 개인 정보일 수 있습니다. 결과를 공개하기
전에 redaction을 확인하세요.

## Memory

```text
앞으로 “주방 메인등”은 light.kitchen_main을 뜻한다고 기억해.
기존 memory와 충돌하는지 먼저 확인하고, 저장한 provenance를 요약해 줘.
```

```text
현재 memory 상태를 확인하고 stale 또는 conflict 항목만 보여 줘.
현재 state나 로그의 일시적 관찰은 장기 memory로 승격하지 마.
```

사용자가 명시한 별칭·용도·선호는 explicit memory가 될 수 있습니다. 발견한 구조는
근거를 수집하고 검증한 뒤에만 적용합니다.

## 버그와 기능 feedback

`/ha-feedback`은 App에 관한 버그 또는 기능 요청을 읽기 전용으로 조사하고 공개 가능한
보고서를 준비합니다. 첫 요청은 조사와 보고서 작성만 승인하며 외부 제출은 승인하지
않습니다.

```text
/ha-feedback bug App을 재부팅한 뒤 Remote instance가 나타나지 않는 증상과 영향을 조사해 줘.
```

```text
/ha-feedback feature browser 진단 결과를 하나의 요약 artifact로 제공하는 기능을 검토해 줘.
```

보고서에는 재현 단계, expected/actual behavior, 영향, 공개 가능한 evidence와 실행한
check가 포함되어야 합니다. candidate issue 검색과 외부 제출은 별도 현재 turn 확인이
있을 때만 진행합니다. vulnerability, 인증 우회 또는 credential 노출 가능성이 있으면
공개 검색·제출을 모두 중단하고
[비공개 보안 신고](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new)를
사용하세요.

## 3.0 초기화 점검

```text
3.0 전환이 완료됐는지 읽기 전용으로 확인해.
/config, /share, /media가 보존됐는지와 새 네 option만 남았는지 점검하고,
인증 파일 내용이나 token은 출력하지 마.
```

실제 HAOS 결과와 source/container/emulated 결과를 구분하세요. 수행하지 않은 항목은
`NOT RUN`, 일부만 수행한 항목은 `PARTIAL`로 남깁니다.
