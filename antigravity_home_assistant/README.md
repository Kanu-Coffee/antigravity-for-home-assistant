<p align="right">
  <strong>한국어</strong> · <a href="README.en.md">English</a>
</p>

# Antigravity for Home Assistant

Home Assistant 안에서 antigravity와 대화하며 설정을 살펴보고 대시보드, 자동화, 엔티티와 오류를 정리할 수 있는 Ingress Web 터미널 앱입니다.

<p align="center">
  <img src="https://raw.githubusercontent.com/Kanu-Coffee/antigravity-for-home-assistant/main/docs/assets/web-terminal-preview.png" alt="Antigravity for Home Assistant 실제 Web 터미널 미리보기">
</p>

<p align="center"><em>공개 0.5.0 이미지의 실제 Web 터미널을 격리 Docker에서 캡처했습니다. 실제 HAOS에서는 Home Assistant Ingress 안에 표시됩니다.</em></p>

## 주요 기능

- `/config` 전체를 읽고 수정하는 Antigravity CLI
- Home Assistant Core API와 Supervisor `manager` helper
- 브라우저를 닫았다 다시 열어도 이어지는 공유 `tmux` Web 터미널
- ChatGPT 모바일 Remote가 앱 내장 antigravity에 직접 연결할 수 있는 공개키 전용 SSH
- CLI와 같은 `/data/home`·`/config`·전역 설정을 사용하는 관리자급 Telegram 주 채널
- Home Assistant 모바일 앱/웹의 **OPEN WEB UI**
- 대시보드의 데스크톱·모바일 화면과 console/network 오류를 확인하는 Headless Chromium
- HA 구조와 사용자가 명시한 별칭·용도·선호를 보존하는 프로젝트 자체 검증형 로컬 메모리
- 앱 버그와 기능 제안을 읽기 전용으로 검증하고 정제된 보고서로 만드는 `/ha-feedback`

> [!WARNING]
> 이 앱은 Home Assistant 설정을 직접 바꿀 수 있는 강한 관리자 도구입니다. Telegram도 CLI와 동등한 관리자 채널이므로 bot token, 허용 chat과 Telegram 계정을 보호하세요. 중요한 변경 전에는 backup을 만들고 계획과 diff를 확인하며 SSH 포트를 인터넷에 직접 공개하지 마세요.

**2.1.1 native settings 호환성 수정:** 공개 2.1.0의 첫 Web `agy` 실행에서
Antigravity 1.1.13이 `request-review` mode에서 non-canonical top-level
`toolPermission`과 `enableTerminalSandbox`를 제거하려 했지만, 최종 `settings.json` 교체는 AppArmor의
의도된 write/link/lock deny에 막혀 atomic rename 오류와 default fallback이
나타났습니다. 임시 파일과 대상은 같은 디렉터리이므로 `EXDEV`가 아닙니다. 2.1.1의
native shape에서 `request-review`는 top-level `toolPermission`을 생략하고
`always-proceed`는 exact `"toolPermission":"always-proceed"`를 유지하며, 두 mode 모두
`enableTerminalSandbox`를 생략합니다. App option의 Telegram mode와 known native
permission bucket을 대조하고 native order로 기록하며, `always-proceed`에서는 empty
`ask`를 생략합니다. settings/OAuth/policy deny는 유지하며 copy/unlink fallback이나
settings write grant는 추가하지 않습니다.

Telegram token과 allowlist는 `/data/options.json`에 있고 Bridge는 별도 S6 서비스이며,
proposal MCP 이름은 `telegram_action`입니다. Core `telegram_bot` service 또는 이름이
`telegram`인 MCP의 부재만으로 Bridge 비활성을 판정하지 마세요. 2.1.1 실제 HAOS
Web/AppArmor/Telegram/browser/memory 수용은 양 아키텍처 모두 `NOT RUN`, 전체 v2는
`PARTIAL`입니다.

**2.1.0 운영 권한 재설계:** 공개 2.0.18 실제 HAOS 18.2 amd64는 App startup,
native `antigravity --version` status 0, Telegram transport와 no-tool chat을
`PASS`했습니다. 그러나 Web `agy`/`antigravity` interactive I/O와 첫 managed Telegram
tool은 `FAIL`했고, kernel audit는 `/dev/pts/0` inherited/open `rw` denial을 기록했습니다.
후속 3~7은 failed conversation을 재사용했으므로 독립 tool 결과가 아니며 approved
write는 `NOT RUN`입니다. 공개 2.0.18 수용은 전체 `FAIL`입니다.

2.1.0은 supported mount·manager API·installed MCP·command와 bounded Host/Supervisor
log projection을 operational blacklist 아래 엽니다. raw log는 제공하지 않고 exact App
token과 known credential-shaped line/block을 제거하지만 arbitrary unkeyed application
text의 완전한 secret 판별은 보장하지 않습니다. native `read_file`/`write_file`은 symlink
alias 우회를 막기 위해 두 mode에서 전역 deny하며 ordinary file은 confined `ha_files`의
`ha_files_list`, `ha_files_read_text`, `ha_files_write_text`만 사용합니다. secrets,
`.storage`, OAuth/token/key, policy, credential `/proc`, Recorder write와 raw host/Docker
경계는 계속 막습니다. `request-review`가 기본이고 explicit `always-proceed`는 blacklist
밖 installed MCP·command·URL·Playwright interaction의 autonomous-admin mode입니다.
`strict`/`proceed-in-sandbox`는 `request-review`로 정규화합니다. 이 breaking 전환은
`breaking_versions`에 2.1.0을 추가합니다. 2.1.0 amd64/aarch64 실기기 수용은 배포 시점
`NOT RUN`, 전체 v2 수용은 `PARTIAL`입니다. 2.0.12 downgrade는 clean/safe/lossless
fallback이 아닙니다.

## 빠른 시작

1. 앱을 설치하고 시작합니다. 현재 **amd64와 aarch64 지원**, `stage: experimental`, `boot: manual`입니다.
2. **OPEN WEB UI**를 누릅니다.
3. 처음 한 번 `ha-antigravity-login`으로 로그인합니다.
4. `ha-antigravity`를 실행합니다.
5. “현재 구성을 읽기 전용으로 살펴보고 아직 수정하지 마”라고 시작해 보세요.

Telegram을 켜면 같은 OAuth, 전역 plugin/agent/rule/MCP와 권한 정책을 사용합니다.
첫 요청에서 만든 대화는 `/new` 전까지 유지되고 승인과 응답도 그 session에서
이어집니다. 별도 Telegram 로그인이나 HOME은 없습니다. 2.0.11은 HA 변경뿐 아니라
관리형 terminal command, inline script, 명령 선택지와 유한 질문도 proposal-first
Telegram 카드로 처리합니다. 최대 31개 선택지와 취소를 지원하며 승인된 exact action
하나만 실행합니다. 고정 CLI가 native permission prompt를 외부에서 재개할 수 없으므로
임의의 미래/plugin MCP를 투명하게 가로채지는 않으며 지원하지 않는 side effect는
fail closed합니다. 최초 OAuth가 없으면 Web/SSH에서 한 번 로그인해야 합니다.

Telegram의 기본 effective native 권한은 `request-review`이고 explicit
`always-proceed`도 지원합니다. `strict`와 `proceed-in-sandbox`는 legacy upgrade 입력으로
`request-review`에 정규화합니다. request-review의 Playwright 자동 허용은 upstream
`readOnly: true`인 console/network/snapshot/screenshot 네 도구뿐이고
navigate/tabs/hover/wait/resize/close 등은 typed adapter 전까지 fail closed합니다.
always-proceed는 current authenticated user request 범위의 installed Playwright
interaction을 허용하지만 mandatory blacklist를 열지는 않습니다.
proposal 등록 뒤 encrypted approval/card가 봉인되기 전 bridge가 종료되면 등록 자체를
복구할 수 없으므로 원래 요청을 다시 보내야 합니다.

권한 drift 복구를 위해 `reset_v2`를 명시 선택하면 안전한 settings를 backup하고 기존
ownership state와 무관하게 managed field와 선택 mode의 known permission bucket을 exact
default로 되돌립니다. `request-review`는 `allow`/`deny`/`ask`를 기록하고,
`always-proceed`는 `allow`/`deny`만 기록해 empty `ask`를 생략합니다. permissions 밖의
사용자 top-level 설정, global MCP, plugin, OAuth와
`/config`는 보존하며, `preserve`로 되돌릴 때까지 매 시작 drift를 다시 복구합니다.
2.0.12부터 Telegram을 켠 상태에서는 root-owned single-link regular·256 KiB 이하의
parse 가능한 settings를 자동 복구합니다. 현재 2.1.1은 App 관리 보안 field,
선택 mode의 sparse native shape와 known permission bucket을 exact policy로 맞추므로
업데이트 뒤 수동 `reset_v2` 없이 bridge를 시작할 수 있습니다.
unknown allow/ask/deny는 보존하지 않고 기존 mode는 0600으로 강화합니다. symlink,
hardlink, non-root owner, 크기 초과 또는 parse 불가능 파일은 Bot API 접속과 재시작
loop 없이 fail closed합니다.

SSH를 사용하지 않는다면 `authorized_keys`를 비워 둬도 됩니다. Web UI는 그대로 동작합니다.

## 활용 예시

```text
Bubble Card가 이미 설치되어 있는지 확인하고,
현재 대시보드를 보존하면서 모바일 1열 홈 화면을 설계해 줘.
먼저 계획과 diff만 보여 주고 승인 뒤 적용·검증해 줘.
```

```text
내 평일 기상·외출·귀가 시간과 현재 센서를 바탕으로
만들 만한 자동화 5개를 오작동 방지 조건과 함께 제안해 줘.
아직 파일은 수정하지 마.
```

```text
/ha-feedback bug 앱에서 발견한 증상을 읽기 전용으로 재현·진단하고 공개 가능한 보고서를 만들어 줘.
```

GitHub 직접 제출은 후보 검색이 가능한 경우의 10분 만료·1회용 preview와 별도 확인 뒤에만 실행됩니다. 검색 또는 제출 결과가 불확실하면 자동 재시도하지 않고 Issue Form으로 전환합니다.

설치, 전체 설정값, 모바일 Remote, 업데이트, 보안과 문제 해결은 [한국어 사용 설명서](DOCS.md)를 확인하세요. 영문 안내는 [English user guide](DOCS.en.md)에 있습니다.

비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 보증받은 제품이 아닙니다.
