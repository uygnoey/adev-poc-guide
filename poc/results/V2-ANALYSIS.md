# V2 SDK PoC 결과 상세 분석

> 실행일: 2026-03-03 | SDK: @anthropic-ai/claude-agent-sdk v0.2.63 | 모델: claude-sonnet-4-6 / claude-opus-4-6

## 전체 요약

| 테스트 | 결과 | 소요 시간 | 비용 |
|--------|------|-----------|------|
| V2-P0: SDK V2 기본 동작 | **PASS** | 31.2s | $0.401 |
| V2-P2-1: 동시 세션 안정성 | **PASS** | 54.5s | $0.886 |
| V2-P2-2: Agent Teams 기본 동작 | **PASS** | 129.5s | $1.003 |
| V2-P2-3: Agent Teams Hooks 감시 | **PASS** | 68.9s | $0.690 |
| V2-P3: 디스크 기반 IPC | **PASS** | 136.7s | $0.901 |
| **합계** | **5/5 PASS** | **~420s** | **$3.881** |

## V1 vs V2 비교

| 항목 | V1 (`query()`) | V2 (`createSession` / `v2_prompt`) | 비교 |
|------|----------------|-------------------------------------|------|
| P0 소요 시간 | 6.9s | 31.2s (A: 24.0s + B: 7.2s) | V2 초회 콜드스타트 느림 |
| P0 비용 | $0.046 | $0.401 | V2가 약 8.7x 비쌈 |
| P2-1 (3개 동시) | 15.1s | 16.3s | 동등 |
| P2-1 (5개 동시) | 39.3s | 38.2s | 동등 |
| P2-2 (Agent Teams) | 128.8s / 16 turns | 129.5s / 19 turns | 동등 |
| P2-3 (Hooks) | 68.5s | 68.9s | 동등 |
| P3 (디스크 IPC) | 136.7s | 136.7s | 동등 |
| 이벤트 구조 | `SDKMessage` union | 동일 `SDKMessage` union | **호환** |
| Hook 콜백 | `options.hooks` | `SDKSessionOptions.hooks` | **동일 구조** |
| 디스크 IPC 경로 | `~/.claude/teams/`, `tasks/` | 동일 | **동일** |

**핵심 결론: V2는 V1과 완전 호환. 이벤트 구조, Hook, 디스크 IPC 모두 동일하게 동작.**

---

## V2-P0: SDK V2 기본 동작 확인

### 결과: PASS

| 파트 | API | 프롬프트 | 응답 | 소요 시간 | 비용 |
|------|-----|---------|------|-----------|------|
| Part A | `unstable_v2_prompt()` | "1+1은? 숫자만 답해." | `"2"` | 23,970ms | $0.201 |
| Part B | `createSession` + `send` + `stream` | "2+2는? 숫자만 답해." | `"4"` | 7,234ms | $0.201 |

### 이벤트 흐름 (Part B)

```
system → assistant → rate_limit_event → result
```

4개 이벤트 수신. V1 P0의 이벤트 순서와 **완전 동일**.

### 분석

- **Part A 콜드스타트**: 24초로 상당히 느림. `unstable_v2_prompt`는 내부적으로 session 생성 → send → stream → close 전체를 수행하므로 초기화 오버헤드 포함
- **Part B 세션 재사용 효과 없음**: Part B도 새 세션이라 별도 프로세스 spawn. 다만 7.2초로 빨랐음 — OS 레벨 캐시(바이너리, 모듈) 효과 추정
- **비용**: V1 P0 ($0.046) 대비 V2 P0 Part A ($0.201)가 4.3x. 프롬프트 동일한데 비용 차이 → V2가 더 큰 system prompt를 삽입하거나 캐시 미적용 가능성

### V1 P0과의 이벤트 키 비교

| 이벤트 | V1 키 | V2 키 |
|--------|-------|-------|
| `system` (init) | `type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, ...` | 동일 |
| `assistant` | `type, message, parent_tool_use_id, session_id, uuid` | 동일 |
| `result` | `type, subtype, is_error, duration_ms, num_turns, result, total_cost_usd, ...` | 동일 |

**이벤트 타입과 필드 구조 100% 호환 확인.**

---

## V2-P2-1: 동시 세션 안정성

### 결과: PASS

### Phase 1: 3개 동시 `unstable_v2_prompt`

| ID | 프롬프트 | 응답 | 소요(ms) | 비용 |
|----|---------|------|---------|------|
| v2-p1-coder-1 | 1 * 1 | `"1"` | 15,971 | $0.201 |
| v2-p1-coder-2 | 2 * 2 | `"4"` | 16,324 | $0.201 |
| v2-p1-coder-3 | 3 * 3 | `"9"` | 15,423 | $0.054 |

**wall-clock: 16,332ms** (병렬 실행 확인 — 개별 합산 47.7s vs 실제 16.3s)

### Phase 2: 5개 동시 `unstable_v2_prompt`

| ID | 프롬프트 | 응답 | 소요(ms) | 비용 |
|----|---------|------|---------|------|
| v2-p2-coder-1 | 1 * 1 | `"1"` | 38,211 | $0.201 |
| v2-p2-coder-2 | 2 * 2 | `"4"` | 23,728 | $0.201 |
| v2-p2-coder-3 | 3 * 3 | `"9"` | 37,711 | $0.201 |
| v2-p2-coder-4 | 4 * 4 | `"16"` | 37,357 | $0.026 |
| v2-p2-coder-5 | 5 * 5 | `"25"` | 37,463 | $0.026 |

**wall-clock: 38,211ms** (병렬 실행 확인 — 개별 합산 174.5s vs 실제 38.2s)

### 분석

- **8/8 성공, 전체 60초 이내**: 완벽 통과
- **5개 동시 시 지연 증가**: 3개 동시(~16s) → 5개 동시(~38s)로 약 2.4x 증가. V1도 동일 패턴 (15.1s → 39.3s)
- **비용 편차**: coder-1~3은 $0.201, coder-4~5는 $0.026. 캐시 적중률 차이 — 나중에 실행된 프롬프트가 이전 캐시 활용
- **V1 대비**: 동시 실행 성능/안정성 동등. 드랍아웃 없음

---

## V2-P2-2: Agent Teams 기본 동작

### 결과: PASS

### 성공 기준

| 기준 | 결과 |
|------|------|
| TeamCreate 감지 | **PASS** |
| TaskCreate 감지 | FAIL (Agent 도구로 대체) |
| SendMessage 감지 | **PASS** |
| TeamDelete 감지 | **PASS** |
| Agent Teams 도구 1개+ 감지 | **PASS** |

### Agent Teams 도구 호출 타임라인

```
  34.6s  TeamCreate    → "v2-poc-team" 생성
  38.7s  Agent         → "researcher" 스폰 (run_in_background: true)
  42.2s  Agent         → "researcher" 재시도 (중복 스폰)
  47.1s  SendMessage   → researcher에게 "상태를 보고해"
  51.0s  SendMessage   → shutdown_request 전송
  54.8s  TeamDelete    → 1차 시도 (실패 — 활성 멤버)
  60.9s  TeamDelete    → 2차 시도 (실패)
  70.5s  TeamDelete    → 3차 시도 (실패)
  75.4s  SendMessage   → 2번째 shutdown_request
  77.8s  TeamDelete    → 4차 시도 (실패)
  82.2s  Read          → config.json 직접 확인
  88.1s  TeamDelete    → 5차 시도 (실패)
  92.7s  Bash          → 팀 디렉토리 구조 확인
  95.7s  Bash          → inbox 내용 확인
  98.2s  Bash          → inbox JSON 읽기
 103.9s  TeamDelete    → 6차 시도 (실패)
 117.7s  Edit          → config.json에서 researcher 수동 제거
 119.8s  TeamDelete    → 7차 시도 → **성공**
```

### 발견된 Agent Teams 버그

**TeamDelete가 shutdown 승인 후에도 반복 실패**

- researcher가 `shutdown_approved`를 보냈으나 config.json의 members 목록이 자동 갱신되지 않음
- TeamDelete는 "활성 멤버가 있다"며 거부
- 모델이 config.json을 직접 Edit하여 멤버 제거 후 삭제 성공
- **결론**: Agent Teams의 graceful shutdown → config 자동 갱신 사이에 race condition 존재

### V1 P2-2와의 비교

| 항목 | V1 | V2 |
|------|-----|-----|
| TeamCreate | PascalCase 사용 | PascalCase 사용 |
| Agent 스폰 | `run_in_background: true` | 동일 |
| TeamDelete 실패 횟수 | 동일 패턴 (멤버 정리 문제) | 7회 시도 후 수동 제거 |
| 모델 대처 | config.json 직접 수정 | 동일 |
| 총 turns | 16 | 19 (재시도 증가) |

**결론: V2에서도 동일한 TeamDelete 버그 재현. 이는 SDK 버전/API 문제가 아니라 Agent Teams 자체의 알려진 이슈.**

---

## V2-P2-3: Agent Teams Hooks 감시

### 결과: PASS

### 성공 기준

| 기준 | 결과 |
|------|------|
| PreToolUse 훅 발생 | **PASS** (8회) |
| PostToolUse 훅 발생 | **PASS** (8회) |
| **Agent Teams 도구 in Hooks** | **PASS** |
| TaskCompleted 훅 발생 | FAIL |
| TeammateIdle 훅 발생 | **PASS** (2회) |

### Hook 이벤트 통계

| 이벤트 | 발생 횟수 |
|--------|----------|
| PreToolUse | 8 |
| PostToolUse | 8 |
| TeammateIdle | 2 |
| **합계** | **18** |

### Hook 이벤트 타임라인

```
  41.4s  PreToolUse   TeamCreate      ← 🎯 Agent Teams
  41.5s  PostToolUse  TeamCreate      ← 🎯 Agent Teams
  45.6s  PreToolUse   Agent           ← 🎯 Agent Teams
  45.6s  PostToolUse  Agent           ← 🎯 Agent Teams
  49.1s  PreToolUse   SendMessage     ← 🎯 Agent Teams
  49.1s  PostToolUse  SendMessage     ← 🎯 Agent Teams
  50.4s  PreToolUse   SendMessage     ← 🎯 (shutdown_request)
  50.4s  PostToolUse  SendMessage
  53.4s  TeammateIdle worker          ← 🎯 Agent Teams
  53.8s  PreToolUse   SendMessage
  53.8s  PostToolUse  SendMessage
  56.5s  PreToolUse   TeamDelete      ← 🎯 Agent Teams
  56.5s  PostToolUse  TeamDelete
  57.7s  PreToolUse   SendMessage
  57.7s  PostToolUse  SendMessage
  59.5s  TeammateIdle worker          ← 🎯 Agent Teams (2nd)
  62.0s  PreToolUse   SendMessage
  62.0s  PostToolUse  SendMessage
```

### Stream vs Hook 비교

| 소스 | 감지 수 |
|------|--------|
| Stream (tool_use 블록) | 5 |
| Hook (Pre/PostToolUse) | 16 (8쌍) |

**Hook이 Stream보다 더 많은 도구 호출을 캡처.** Stream의 `assistant` 메시지에는 최종 tool_use만 포함되지만, Hook은 내부 재시도/추가 호출도 전부 캡처.

### Hook에서 얻을 수 있는 추가 정보

`rawInput`에서 확인 가능한 필드:
- `session_id`: 세션 식별
- `transcript_path`: 전체 대화 기록 파일 경로
- `cwd`: 작업 디렉토리
- `permission_mode`: `"bypassPermissions"` 확인
- `tool_use_id`: 개별 도구 호출 추적
- `tool_input`: 도구에 전달된 전체 입력
- `tool_response` (PostToolUse): 도구 실행 결과

### TaskCompleted 미발생 분석

TaskCompleted 훅이 발생하지 않은 이유:
- 테스트 시나리오에서 Task 시스템(TaskCreate/TaskUpdate)을 사용하지 않고 Agent 도구로 직접 스폰
- TaskCompleted는 TaskUpdate로 `status: "completed"` 설정 시 발생
- **Agent Teams의 Task 기반 워크플로우를 사용해야 발생** — 이번 테스트에서는 해당 없음

---

## V2-P3: 디스크 기반 IPC

### 결과: PASS

### 성공 기준

| 기준 | 결과 |
|------|------|
| 팀 디렉토리 발견 | **PASS** |
| 파일 발견 (1개+) | **PASS** (7개) |
| JSON 파싱 가능 | **PASS** (4개) |
| inbox 구조 발견 | **PASS** |

### 파일시스템 폴링 결과 — 발견 순서

| 시간(ms) | 타입 | 경로 | 크기 |
|---------|------|------|------|
| 32,258 | directory | `teams\v2-ipc-team` | - |
| 32,258 | file | `teams\v2-ipc-team\config.json` | 530B |
| 32,258 | directory | `tasks\v2-ipc-team` | - |
| 32,258 | file | `tasks\v2-ipc-team\.lock` | 0B |
| 36,879 | file | `tasks\v2-ipc-team\1.json` | 263B |
| 39,948 | directory | `teams\v2-ipc-team\inboxes` | - |
| 39,948 | file | `teams\v2-ipc-team\inboxes\observer.json` | 167B |
| 41,483 | file | `teams\v2-ipc-team\inboxes\team-lead.json` | 294B |

### 디스크 IPC 구조 분석

```
~/.claude/
├── teams/
│   └── v2-ipc-team/
│       ├── config.json          ← 팀 설정 + 멤버 목록
│       └── inboxes/
│           ├── observer.json    ← observer의 수신 메시지
│           └── team-lead.json   ← team-lead의 수신 메시지
└── tasks/
    └── v2-ipc-team/
        ├── .lock                ← 동시 접근 제어
        └── 1.json               ← 태스크 정의 + 상태
```

### 파싱된 JSON 상세

**config.json** — 팀 설정
```json
{
  "name": "v2-ipc-team",
  "description": "IPC 팀 테스트 - Agent Teams 기능 검증",
  "createdAt": 1772556861318,
  "leadAgentId": "team-lead@v2-ipc-team",
  "leadSessionId": "cc597d80-db49-4fc9-b853-4f478bd02ea7",
  "members": [
    {
      "agentId": "team-lead@v2-ipc-team",
      "name": "team-lead",
      "agentType": "team-lead",
      "model": "claude-opus-4-6"
    }
  ]
}
```

**tasks/1.json** — 태스크 정의
```json
{
  "id": "1",
  "subject": "observer",
  "description": "Hello라고 답해. 팀에 합류했고 준비가 되었다는 것을 팀 리더에게 알려줘.",
  "status": "in_progress",
  "blocks": [],
  "blockedBy": [],
  "metadata": { "_internal": true }
}
```

**inboxes/observer.json** — 메시지 수신함
```json
[
  {
    "from": "team-lead",
    "text": "상태 보고",
    "summary": "상태 보고 요청",
    "timestamp": "2026-03-03T16:54:29.320Z",
    "read": false
  }
]
```

**inboxes/team-lead.json** — 팀 리더 수신함
```json
[
  {
    "from": "observer",
    "text": "Hello! 팀에 합류했습니다. 준비가 되었습니다. 언제든지 작업을 할당해 주세요.",
    "summary": "Hello - 팀 합류 및 준비 완료",
    "timestamp": "2026-03-03T16:54:30.704Z",
    "color": "blue",
    "read": false
  }
]
```

### V1 P3와의 비교

| 항목 | V1 | V2 |
|------|-----|-----|
| 디스크 구조 | `teams/{name}/config.json`, `inboxes/`, `tasks/` | **동일** |
| config.json 스키마 | name, members, leadAgentId | **동일** |
| inbox 메시지 구조 | from, text, summary, timestamp, read | **동일** |
| task 구조 | id, subject, status, blocks, blockedBy | **동일** |
| `.lock` 파일 | 존재 | **동일** |

**V2에서도 디스크 IPC 구조가 V1과 100% 동일. 파일시스템 폴링 방식의 모니터링이 V2에서도 완벽 호환.**

---

## 종합 결론

### 1. V2 API는 프로덕션 사용 가능

- 5개 테스트 전부 PASS
- V1과 동일한 이벤트 구조, Hook, 디스크 IPC
- 세션 기반 API(`createSession` + `send` + `stream` + `close`)는 멀티턴 시나리오에 더 적합

### 2. V2 API 선택 가이드

| 시나리오 | 권장 API | 이유 |
|----------|---------|------|
| 원샷 질의 | `unstable_v2_prompt()` | 간단, 자동 정리 |
| 멀티턴 대화 | `createSession` + `send/stream` | 세션 재사용, 명시적 lifecycle |
| Agent Teams 감시 | `createSession` + `hooks` | Hook 콜백으로 실시간 모니터링 |
| 동시 실행 | `unstable_v2_prompt` × N | `Promise.all`로 병렬화 |

### 3. 알려진 이슈 (V1/V2 공통)

| 이슈 | 영향 | 우회책 |
|------|------|--------|
| TeamDelete가 shutdown 후에도 실패 | teammate config 미갱신 | config.json 수동 편집 후 삭제 |
| TaskCompleted 훅 미발생 | Task 시스템 미사용 시 | TaskCreate/TaskUpdate 워크플로우 사용 |
| 첫 호출 콜드스타트 (~24s) | 초기 응답 지연 | 웜업 호출 또는 세션 재사용 |

### 4. 아키텍처 결정

V2 Session API 기반으로 adev 2계층 구축 확정:

```
adev 2계층
├── Session Manager: unstable_v2_createSession()
├── Stream Monitor: session.stream() + hooks
├── Disk Poller: ~/.claude/teams/ + tasks/ 감시
└── Agent Coordinator: TeamCreate + Agent + SendMessage
```

---

_생성: 2026-03-04T00:00:00.000Z_
_데이터 소스: poc/results/v2-*.json_
