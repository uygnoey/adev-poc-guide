# adev PoC — Claude Agent SDK + Agent Teams 검증

## 목적

adev 시스템의 2계층에서 사용할 SDK + Agent Teams의 실제 동작을 검증한다.
이 PoC 결과에 따라 아키텍처가 확정된다.

## 필수 참고 문서

이 디렉토리에 있는 문서를 **반드시 먼저 읽고** 코드를 작성할 것:

1. **POC-SPEC.md** — 검증 항목, 성공 기준, 실패 대안
2. **POC-SKILL.md** — SDK 올바른 사용법, 이벤트 구조, 함정 목록
3. **POC-ARCHITECTURE.md** — 파일 구조, 실행 순서, 공통 패턴

## 핵심 규칙

### 코드 작성 원칙
- **추측 금지**: 불확실하면 SDK 소스를 직접 확인 (`node_modules/@anthropic-ai/claude-agent-sdk/`)
- **최소 코드 먼저**: 복잡한 테스트 전에 한 줄짜리 query()부터 확인
- **결과 dump**: 모든 이벤트를 JSON으로 저장 후 분석
- **타임아웃 필수**: 모든 스트림 소비에 2분 타임아웃

### SDK 핵심 사실
- `query()`는 Claude Code subprocess를 spawn한다
- Agent Teams 도구(TeamCreate, SendMessage 등)는 **Claude 모델이 tool_use로 호출**한다
- 우리 코드에서 직접 호출하는 게 아니다 — 프롬프트로 지시하고 스트림에서 관찰한다
- `msg.type`: "assistant" / "result" / "system" / "stream_event"
- assistant 텍스트: `msg.message.content.filter(b => b.type === "text")`
- tool_use 감지: `msg.message.content.filter(b => b.type === "tool_use")`

### 코드 품질
- 이해하기 쉽게: 파일 상단에 목적/검증항목/성공기준 주석
- 일관된 패턴: setup → execute → analyze → dump
- self-contained: 각 파일 독립 실행 가능
- 에러 시: 의미 있는 메시지 + 다음 단계 안내

## 실행 순서

```
P0 → P2-1 → P2-2 → P2-3 → P3
각 단계 PASS 확인 후 다음 진행
```

## 불확실한 것들 (직접 확인 필요)

1. `options.env`가 실제로 subprocess에 전달되는지
2. `options.hooks` 구조 — SDK 소스에서 Options 타입 직접 확인
3. Agent Teams 도구 이름 정확한 스펠링 (TeamCreate vs team_create)
4. 디스크 IPC 경로 (~/.claude/teams/ 가 맞는지)

이것들은 코드 작성 전에 SDK 소스나 최소 테스트로 먼저 확인할 것.
