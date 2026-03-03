# adev PoC Spec — SDK + Agent Teams 검증

## 목적

adev 시스템의 2계층(자율 개발)에서 사용할 Claude Agent SDK + Agent Teams의 실제 동작을 검증한다.
이 PoC 결과에 따라 v2.3 아키텍처가 확정되거나 대안으로 전환된다.

---

## 검증 항목 (순서대로 실행)

### P0: SDK 기본 동작 확인

**목적**: query()가 정상 동작하는지 확인. 나머지 모든 PoC의 전제조건.

**해야 할 것**:
- `query()`로 간단한 프롬프트 전송 ("1+1은? 숫자만 답해.")
- model: "sonnet", maxTurns: 1, allowedTools: [], permissionMode: "bypassPermissions"
- 스트림에서 받은 모든 이벤트의 type, keys, content 구조를 JSON 파일로 dump

**성공 기준**:
- `msg.type === "assistant"` 이벤트에서 텍스트 추출 가능
- `msg.type === "result"` 이벤트 수신
- 전체 소요 시간 30초 이내

**실패 시**: Claude Code 설치/인증 문제. 나머지 PoC 진행 불가.

**산출물**: `p0-events.json` (모든 이벤트 raw dump)

---

### P2-1: 동시 query() 안정성

**목적**: CODE Phase에서 coder×N 병렬 실행 패턴 검증. Agent Teams 미사용.

**해야 할 것**:
- 독립 query() 3개를 Promise.all로 동시 실행
- 독립 query() 5개를 Promise.all로 동시 실행
- 각 query는 model: "sonnet", maxTurns: 1, allowedTools: [], permissionMode: "bypassPermissions"
- 각 query에 고유 프롬프트 부여 (coder-1, coder-2, ...)
- 각 query의 result 수신 여부 + 소요 시간 측정

**성공 기준**:
- 5개 query 모두 `msg.type === "result"` 수신
- 개별 타임아웃 60초 이내

**실패 시**: Promise.all 동시 수를 3개 이하로 제한.

**산출물**: 각 query별 성공여부 + 소요시간 콘솔 출력

---

### P2-2: Agent Teams 기본 동작

**목적**: Agent Teams 라이프사이클(TeamCreate → Task → SendMessage → TeamDelete)이 SDK query()에서 동작하는지 확인.

**해야 할 것**:
- `options.env`에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"` 설정
- 프롬프트로 Claude에게 팀 생성 → teammate spawn → 메시지 전송 → 팀 삭제를 지시
- assistant 메시지의 `msg.message.content[]`에서 `block.type === "tool_use"` 블록 수집
- tool_use 블록의 `block.name`에서 TeamCreate, Task, SendMessage, TeamDelete 감지

**주의**: Agent Teams 도구는 우리 코드에서 호출하는 게 아니라, Claude 모델이 tool_use로 호출한다.
우리는 프롬프트만 주고, 스트림에서 tool_use 블록을 관찰하는 것이다.

**성공 기준**:
- tool_use 블록에서 TeamCreate 최소 1회 감지
- 전체 라이프사이클(Create→Task→Send→Delete) 감지가 이상적

**실패 시**:
- env가 전달 안 되는 경우: settingSources로 시도
- Agent Teams 자체가 안 되는 경우: Agent Teams 제거 → DESIGN Phase도 독립 query()로 전환

**산출물**: `p2-2-tool-calls.json` (감지된 tool_use 목록)

---

### P2-3: Agent Teams Hooks 감시

**목적**: SDK의 hooks 옵션으로 Agent Teams 도구 호출을 실시간 모니터링할 수 있는지 확인.
이게 되면 adev의 stream-monitor를 Hooks 기반으로 구현한다.

**해야 할 것**:
- query() options에 hooks 설정:
  - PreToolUse: 도구 호출 전 콜백 → tool_name, tool_input 로깅
  - PostToolUse: 도구 호출 후 콜백 → tool_name, tool_result 로깅
  - TaskCompleted: teammate 작업 완료 콜백
  - TeammateIdle: teammate 대기 상태 콜백
- Agent Teams 프롬프트 실행 (P2-2와 동일)

**⚠️ 불확실 사항**: 
- hooks를 query() options에 직접 넘기는 정확한 구조가 미확인
- SDK 문서에 HookEvent 타입은 있지만 options.hooks 예제는 부족
- **Claude Code는 SDK 소스를 직접 확인하여 정확한 hooks 구조를 파악할 것**

**성공 기준**:
- PreToolUse/PostToolUse 콜백에서 Agent Teams 도구(TeamCreate 등) 이벤트 1개 이상 수신

**실패 시**:
- hooks가 options에 지원 안 되는 경우: 커맨드 기반 hooks (settings.json)로 시도
- hooks 자체가 Agent Teams 도구를 못 잡는 경우: P3(디스크 IPC)로 감시 전략 전환

**산출물**: `p2-3-hook-logs.json` (훅 이벤트 목록)

---

### P3: 디스크 기반 IPC 확인

**목적**: Agent Teams 실행 중 생성되는 파일시스템 구조를 확인하여, 
Hooks가 안 될 경우의 대안(디스크 폴링 감시) 가능성 검증.

**해야 할 것**:
- Agent Teams query() 실행과 동시에 파일시스템 폴링 (500ms 간격):
  - `~/.claude/teams/` 디렉토리 감시
  - `~/.claude/tasks/` 디렉토리 감시
- 새로 생성되는 파일/디렉토리 기록
- JSON 파일 발견 시 내용 파싱 시도
- 특히 inbox 파일의 구조 확인 (from, text, timestamp 등)

**참고 경로** (출처에 따라 다를 수 있음):
- `~/.claude/teams/{team_name}/config.json`
- `~/.claude/tasks/{team_name}/`
- `~/.claude/teams/{team_name}/inboxes/{agent_name}.json` 또는 `.jsonl`

**성공 기준**:
- 팀 관련 디렉토리 또는 파일 1개 이상 발견
- JSON/JSONL 파싱하여 메시지 구조 확인 가능

**실패 시**:
- 경로가 다른 경우: `find ~/.claude -name "*.json" -newer` 로 탐색
- 파일이 아예 없는 경우: Agent Teams 완전 제거 → 독립 query() + LanceDB 통신으로 전환

**산출물**: `p3-disk-findings.json` (발견된 파일 + 내용)

---

## 전체 실행 순서

```
P0 (필수 선행)
 ↓ PASS
P2-1 (동시 query)
 ↓ PASS
P2-2 (Agent Teams 기본)
 ↓ PASS
P2-3 (Hooks 감시)    →  FAIL → P3 (디스크 IPC)
 ↓ PASS                       ↓ PASS
아키텍처 확정               대안 확정
```

## PoC 결과 → 아키텍처 결정 매트릭스

| P0 | P2-1 | P2-2 | P2-3 | P3 | 결정 |
|----|------|------|------|----|------|
| ✅ | ✅ | ✅ | ✅ | - | v2.3 스펙 그대로. Hooks 기반 stream-monitor |
| ✅ | ✅ | ✅ | ❌ | ✅ | Agent Teams 유지. 디스크 폴링 감시 |
| ✅ | ✅ | ✅ | ❌ | ❌ | Agent Teams 유지하되 감시 없이 result만 수집 |
| ✅ | ✅ | ❌ | - | - | Agent Teams 제거. DESIGN도 독립 query(). adev가 aggregation |
| ✅ | ❌ | - | - | - | 동시 query() 수 축소 (3개 이하) |
| ❌ | - | - | - | - | SDK 설치/인증 문제 해결 필요 |

---

## 출처

| 내용 | 출처 | 확인일 |
|------|------|--------|
| SDK query() 타입 | https://platform.claude.com/docs/en/agent-sdk/typescript | 2026-03-03 |
| SDKMessage 타입 정의 | 위 동일 (SDKAssistantMessage, SDKResultMessage 등) | 2026-03-03 |
| SDK Quickstart | https://platform.claude.com/docs/en/agent-sdk/quickstart | 2026-03-03 |
| SDK Streaming | https://platform.claude.com/docs/en/agent-sdk/streaming-output | 2026-03-03 |
| SDK HookEvent 타입 | 위 typescript 레퍼런스 (PreToolUse, PostToolUse 등) | 2026-03-03 |
| Agent Teams 공식 문서 | https://code.claude.com/docs/en/agent-teams | 2026-03-03 |
| Agent Teams 도구 구조 | https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/ | 2026-03-03 |
| Agent Teams 디스크 IPC | https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol | 2026-03-03 |
| Agent Teams SDK 실행 | Isaac Kargar, Medium (2026-02) | 2026-03-03 |
| npm 패키지 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk (v0.2.63) | 2026-03-03 |
