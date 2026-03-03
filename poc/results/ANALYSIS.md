# adev PoC 결과 종합 분석

> 분석일: 2026-03-04
> 대상: Claude Agent SDK v0.2.x + Agent Teams PoC (P0 ~ P3)
> Claude Code: v2.1.63 / 모델: claude-sonnet-4-6

---

## 전체 결과 요약

| 테스트 | 결과 | 소요 시간 | 비용 (USD) | 턴 수 |
|--------|------|-----------|------------|-------|
| **P0** — SDK 기본 동작 | **PASS** | 6.9s | $0.046 | 1 |
| **P2-1** — 동시 query() 안정성 | **PASS** | 23.8s | — | 1×8 |
| **P2-2** — Agent Teams 기본 동작 | **PASS** | 132.5s | $0.875 | 19 |
| **P2-3** — Agent Teams Hooks 감시 | **PASS** | 76.2s | $0.785 | 10 |
| **P3** — 디스크 기반 IPC 확인 | **PASS** | 156.0s | $1.082 | 19 |

**전체 5/5 PASS**

---

## 아키텍처 결정

POC-SPEC.md 매트릭스 기준:

| P0 | P2-1 | P2-2 | P2-3 | P3 | 결정 |
|----|------|------|------|----|------|
| ✅ | ✅ | ✅ | ✅ | ✅ | **v2.3 스펙 그대로. Hooks 기반 stream-monitor** |

- **1차 감시 전략**: Hooks 기반 (`PreToolUse` / `PostToolUse` / `TeammateIdle`)
- **2차 백업 전략**: 디스크 폴링 (`~/.claude/teams/` + `~/.claude/tasks/`)

---

## 테스트별 상세 분석

### P0: SDK 기본 동작 확인

- `query()`로 "1+1은?" 전송 → `"2"` 응답 정상 수신
- 이벤트 흐름: `system` → `assistant` → `rate_limit_event` → `result` (총 4개)
- API 응답 시간: 2,330ms (전체 6,935ms)

**핵심 발견**:

- `allowedTools: []`로 설정해도 system init에 TeamCreate, TeamDelete, SendMessage 등이 포함됨
- Agent Teams 도구는 allowedTools와 별도 레이어에서 관리됨
- `rate_limit_event`가 매 query마다 발생 — `resetsAt`, `rateLimitType: "five_hour"` 등 rate limit 메타데이터 제공

**system init 이벤트에서 확인된 사용 가능 도구**:

```
Agent, TaskOutput, Bash, Glob, Grep, ExitPlanMode, Read, Edit, Write,
NotebookEdit, WebFetch, TodoWrite, WebSearch, TaskStop, AskUserQuestion,
Skill, EnterPlanMode, EnterWorktree, TeamCreate, TeamDelete, SendMessage, ToolSearch
```

---

### P2-1: 동시 query() 안정성

#### Phase 1 — 3개 동시 (총 13.5s)

| 쿼리 | 프롬프트 | 결과 | 소요 시간 |
|-------|---------|------|-----------|
| coder-1 | 1 × 1 | "1" | 12.4s |
| coder-2 | 2 × 2 | "4" | 12.8s |
| coder-3 | 3 × 3 | "9" | 13.5s |

#### Phase 2 — 5개 동시 (총 10.2s)

| 쿼리 | 프롬프트 | 결과 | 소요 시간 |
|-------|---------|------|-----------|
| coder-1 | 1 × 1 | "1" | 8.6s |
| coder-2 | 2 × 2 | "4" | 10.2s |
| coder-3 | 3 × 3 | "9" | 8.1s |
| coder-4 | 4 × 4 | "16" | 8.4s |
| coder-5 | 5 × 5 | "25" | 8.5s |

**핵심 발견**:

1. 5개 동시 실행에서도 **모든 결과가 정확** — 크로스 오염 없음
2. 5개 동시가 3개보다 오히려 빠름 (10.2s vs 13.5s) — cache_read_input_tokens 활용 효과 추정
3. 각 query가 독립 subprocess로 spawn → 완전 격리 확인
4. 모든 query에서 동일한 이벤트 패턴: `system` → `assistant` → `rate_limit_event` → `result`

---

### P2-2: Agent Teams 기본 동작

#### 라이프사이클 감지 결과

| 단계 | 도구 | 감지 | 시점(ms) |
|------|------|------|---------|
| 팀 생성 | `TeamCreate` | PASS | 9,774 |
| teammate 추가 | `Agent` | PASS | 14,105 |
| 메시지 전송 | `SendMessage` | PASS | 18,163 |
| 종료 요청 | `SendMessage (shutdown_request)` | PASS | 25,976 |
| 팀 삭제 | `TeamDelete` | PASS | 124,360 (최종) |
| Task/TaskCreate | — | **FAIL** | 미감지 |

#### tool_use 전체 목록 (18개)

| 시간(ms) | 도구명 | Agent Teams? |
|---------|--------|-------------|
| 9,774 | `TeamCreate` | YES |
| 14,105 | `Agent` | YES |
| 18,163 | `SendMessage` | YES |
| 25,976 | `SendMessage` | YES |
| 29,224 | `TeamDelete` | YES |
| 38,644 | `TeamDelete` | YES |
| 45,252 | `Bash` | no |
| 51,115 | `TeamDelete` | YES |
| 58,820 | `Bash` | no |
| 66,544 | `TeamDelete` | YES |
| 71,705 | `SendMessage` | YES |
| 74,378 | `Bash` | no |
| 81,594 | `TeamDelete` | YES |
| 90,075 | `Read` | no |
| 97,178 | `Bash` | no |
| 107,536 | `TeamDelete` | YES |
| 122,532 | `Edit` | no |
| 124,360 | `TeamDelete` | YES |

**핵심 발견**:

1. **Task/TaskCreate 미사용**: teammate 생성은 `Agent` 도구(subagent spawn)로 수행됨
2. **TeamDelete 7회 반복**: researcher teammate가 `shutdown_request`에 응답하지 않아 모델이 반복 시도
   - 시도 순서: shutdown_request → TeamDelete → 대기(Bash sleep) → 재시도 → config.json 직접 편집(Edit) → 최종 삭제 성공
3. **teammate 종료의 비결정성**: 132.5초 중 약 100초가 종료 처리에 소비됨
4. 전체 비용 $0.875, 19턴 소요 — 팀 관리 오버헤드가 상당함

---

### P2-3: Agent Teams Hooks 감시

#### Hooks 발화 통계

| Hook 이벤트 | 발화 횟수 | Agent Teams 관련 |
|-------------|----------|-----------------|
| PreToolUse | 12회 | 전부 YES |
| PostToolUse | 12회 | 전부 YES |
| TeammateIdle | 2회 | `worker` teammate |
| TaskCompleted | 0회 | **미발화** |

총 **26개** Hook 이벤트, 전부 Agent Teams 관련.

#### Hook 이벤트 타임라인

| 시간(ms) | Hook | 도구/대상 |
|---------|------|----------|
| 14,867 | PreToolUse | `TeamCreate` |
| 14,879 | PostToolUse | `TeamCreate` |
| 18,942 | PreToolUse | `Agent` |
| 18,957 | PostToolUse | `Agent` |
| 22,821 | PreToolUse | `SendMessage` |
| 22,825 | PostToolUse | `SendMessage` |
| 23,462 | PreToolUse | `SendMessage` |
| 23,466 | PostToolUse | `SendMessage` |
| 26,077 | **TeammateIdle** | `worker` |
| 28,260 | PreToolUse | `SendMessage` |
| 28,267 | PostToolUse | `SendMessage` |
| 29,827 | PreToolUse | `TeamDelete` |
| 29,829 | PostToolUse | `TeamDelete` |
| 30,010 | PreToolUse | `SendMessage` |
| 30,014 | PostToolUse | `SendMessage` |
| 32,311 | **TeammateIdle** | `worker` |
| 35,370 | PreToolUse | `SendMessage` |
| 35,374 | PostToolUse | `SendMessage` |
| 37,810 | PreToolUse | `TeamDelete` |
| 37,811 | PostToolUse | `TeamDelete` |
| 44,565 | PreToolUse | `TeamDelete` |
| 44,566 | PostToolUse | `TeamDelete` |
| 54,834 | PreToolUse | `TeamDelete` |
| 54,836 | PostToolUse | `TeamDelete` |
| 63,832 | PreToolUse | `TeamDelete` |
| 63,833 | PostToolUse | `TeamDelete` |

#### Hook rawInput 구조

Hooks에서 수신하는 데이터가 매우 풍부함:

```json
{
  "session_id": "6ce9907b-...",
  "transcript_path": "C:\\Users\\...\\6ce9907b-....jsonl",
  "cwd": "C:\\Users\\yeongyu\\adev-poc-guide\\poc",
  "permission_mode": "bypassPermissions",
  "hook_event_name": "PreToolUse",
  "tool_name": "TeamCreate",
  "tool_input": { "team_name": "poc-hook-team", "description": "..." },
  "tool_use_id": "toolu_011EH2i8aZpCFVkX9DMnh2uH"
}
```

**핵심 발견**:

1. **Hooks가 SDK `options`에서 정상 동작** — `query()` options에 hooks를 직접 전달하는 방식 확인
2. **Pre/Post 쌍 보장**: 모든 PreToolUse에 PostToolUse가 정확히 대응 (12ms 미만 간격)
3. **Stream vs Hook 감지 범위 차이**:
   - Stream (tool_use): 9개 감지
   - Hook (Pre/PostToolUse): 24개 감지 (2.7배)
   - Hook이 **subagent 내부의 도구 호출까지 캡처** → stream-monitor는 Hooks 기반이 훨씬 정확
4. **TeammateIdle 발화 확인**: teammate가 idle 상태로 전환될 때 감지 가능
5. **TaskCompleted 미발화**: 작업 완료 감지는 `result` 이벤트 또는 디스크 기반으로 별도 구현 필요

---

### P3: 디스크 기반 IPC 확인

#### 발견된 파일시스템 구조

```
~/.claude/
├── teams/poc-ipc-team/
│   ├── config.json              ← 팀 설정 (512B)
│   └── inboxes/
│       ├── observer.json        ← teammate inbox (167B)
│       └── team-lead.json       ← leader inbox (171B)
└── tasks/poc-ipc-team/
    ├── .lock                    ← 동시성 제어 (0B)
    └── 1.json                   ← 태스크 상세 (184B)
```

#### 파일별 내용

**config.json** — 팀 구성 정보:
```json
{
  "name": "poc-ipc-team",
  "description": "IPC 테스트용 POC 팀",
  "createdAt": 1772551008998,
  "leadAgentId": "team-lead@poc-ipc-team",
  "leadSessionId": "c6c69d02-...",
  "members": [{
    "agentId": "team-lead@poc-ipc-team",
    "name": "team-lead",
    "agentType": "team-lead",
    "model": "claude-opus-4-6",
    "joinedAt": 1772551008998,
    "tmuxPaneId": "",
    "cwd": "C:\\Users\\yeongyu\\adev-poc-guide\\poc",
    "subscriptions": []
  }]
}
```

**tasks/1.json** — 태스크 상세:
```json
{
  "id": "1",
  "subject": "observer",
  "description": "Hello라고 답해",
  "status": "in_progress",
  "blocks": [],
  "blockedBy": [],
  "metadata": { "_internal": true }
}
```

**inbox 메시지 구조** (JSON Array 형식):
```json
[
  {
    "from": "team-lead",
    "text": "상태 보고",
    "summary": "상태 보고 요청",
    "timestamp": "2026-03-03T15:16:58.299Z",
    "read": false
  }
]
```

teammate → leader 응답에는 `"color": "blue"` 필드가 추가됨.

#### 파일 생성 타임라인

| 경과(ms) | 이벤트 |
|---------|--------|
| 38,027 | `teams/poc-ipc-team/` 디렉토리 + `config.json` 생성 |
| 38,027 | `tasks/poc-ipc-team/` 디렉토리 + `.lock` 생성 |
| 43,671 | `tasks/poc-ipc-team/1.json` 생성 (태스크) |
| 47,253 | `teams/.../inboxes/` 디렉토리 + `observer.json` 생성 |
| 47,764 | `teams/.../inboxes/team-lead.json` 생성 |

**핵심 발견**:

1. **경로 확정**: `~/.claude/teams/{team_name}/` + `~/.claude/tasks/{team_name}/` — POC-SKILL.md 예상과 일치
2. **inbox는 JSON Array** (JSONL 아님) — 전체 파일을 읽고 파싱해야 함
3. **`.lock` 파일** 존재 → 동시성 제어 메커니즘 내장
4. **500ms 폴링**으로 파일 변경 감지 충분 (실제 생성 시점 정확히 포착)
5. **subagent 트랜스크립트 경로** 확인: `~/.claude/projects/.../subagents/agent-{id}.jsonl`

---

## 프로덕션 적용 시 주의사항

### 1. teammate 종료 비결정성

P2-2에서 TeamDelete가 7회 반복됨. 권장 패턴:

```
shutdown_request 전송 → 10초 대기 → TeamDelete 시도
→ 실패 시 재시도 (최대 3회, 5초 간격)
→ 최종 실패 시 config.json에서 member 직접 제거 후 TeamDelete
```

### 2. TaskCompleted 미발화

Hooks의 `TaskCompleted`가 한 번도 발화되지 않음. 작업 완료 감지 대안:
- `result` 이벤트의 `subtype: "success"` 감시
- 디스크의 `tasks/{id}.json`의 `status` 필드 폴링
- `TeammateIdle` 이벤트 + 추가 로직 조합

### 3. 비용 관리

| 패턴 | 예상 비용/회 |
|------|-------------|
| 단순 query (P0) | ~$0.05 |
| 동시 query 5개 (P2-1) | ~$0.25 |
| Agent Teams 1회 라이프사이클 | ~$0.8 ~ $1.1 |

Agent Teams 사용 시 팀 관리 오버헤드(생성/메시지/종료/삭제)만으로 10~19턴이 소비됨.

### 4. Hook vs Stream 감시 범위

| 감시 방식 | 감지 범위 | 권장 용도 |
|----------|----------|----------|
| Stream tool_use | leader의 직접 호출만 | 최종 결과 수집 |
| Hooks (Pre/PostToolUse) | leader + subagent 내부까지 | **stream-monitor (권장)** |
| 디스크 폴링 | 파일 생성/변경 시점 | 백업 감시, 메시지 내용 확인 |

### 5. 동시 query 안정성

- 5개까지 안정적 확인
- `rate_limit_event`의 `rateLimitType: "five_hour"` 모니터링 필요
- 그 이상은 추가 검증 권장

---

## 결론

모든 PoC가 PASS되어 **v2.3 아키텍처를 그대로 채택**할 수 있다.

- **SDK `query()`**: 안정적, 동시 5개까지 검증됨
- **Agent Teams**: 라이프사이클 전체 동작 확인, teammate 종료 처리에 주의 필요
- **Hooks**: stream-monitor의 핵심 메커니즘으로 채택 가능 (subagent 내부까지 감지)
- **디스크 IPC**: 백업 감시 전략으로 유효, inbox 구조 확정

총 PoC 비용: **약 $2.79**
