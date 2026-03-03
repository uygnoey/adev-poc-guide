# adev PoC — Claude Agent SDK + Agent Teams 검증

adev 시스템의 2계층(자율 개발)에서 사용할 **Claude Agent SDK**와 **Agent Teams**의 실제 동작을 검증하는 PoC 프로젝트.
이 PoC 결과에 따라 v2.3 아키텍처가 확정된다.

## 결과 요약

**전체 5/5 PASS** — v2.3 아키텍처 채택 확정

| 테스트 | 결과 | 소요 시간 | 비용 |
|--------|------|-----------|------|
| **P0** — SDK 기본 동작 | PASS | 6.9s | $0.046 |
| **P2-1** — 동시 query() 안정성 | PASS | 23.8s | — |
| **P2-2** — Agent Teams 기본 동작 | PASS | 132.5s | $0.875 |
| **P2-3** — Agent Teams Hooks 감시 | PASS | 76.2s | $0.785 |
| **P3** — 디스크 기반 IPC 확인 | PASS | 156.0s | $1.082 |

> 총 PoC 비용: ~$2.79

## 테스트별 상세 결과

### P0: SDK 기본 동작 확인

`query()`로 "1+1은?" 전송 → `"2"` 응답 정상 수신.

| 성공 기준 | 결과 | 상세 |
|-----------|------|------|
| assistant 텍스트 추출 가능 | PASS | `"2"` |
| result 이벤트 수신 | PASS | `subtype: "success"` |
| 30초 이내 완료 | PASS | 6,935ms |

**이벤트 흐름** (총 4개): `system` → `assistant` → `rate_limit_event` → `result`

```json
{
  "subtype": "success",
  "result": "2",
  "total_cost_usd": 0.046,
  "duration_ms": 2330,
  "num_turns": 1
}
```

**발견사항**:
- `allowedTools: []`로 설정해도 system init에 TeamCreate, TeamDelete, SendMessage 등이 포함됨
- Agent Teams 도구는 allowedTools와 별도 레이어에서 관리됨
- `rate_limit_event`가 매 query마다 발생 — `rateLimitType: "five_hour"` 등 rate limit 메타데이터 제공

---

### P2-1: 동시 query() 안정성

독립 query()를 `Promise.all`로 동시 실행하여 병렬 안정성 검증.

| 성공 기준 | 결과 |
|-----------|------|
| 3개 동시 query 전체 성공 | PASS |
| 5개 동시 query 전체 성공 | PASS |
| 전체 60초 이내 완료 | PASS |

**Phase 1 — 3개 동시** (13.5s):

| ID | 프롬프트 | 결과 | 소요 시간 |
|----|---------|------|-----------|
| coder-1 | 1 × 1 | `"1"` | 12.4s |
| coder-2 | 2 × 2 | `"4"` | 12.8s |
| coder-3 | 3 × 3 | `"9"` | 13.5s |

**Phase 2 — 5개 동시** (10.2s):

| ID | 프롬프트 | 결과 | 소요 시간 |
|----|---------|------|-----------|
| coder-1 | 1 × 1 | `"1"` | 8.6s |
| coder-2 | 2 × 2 | `"4"` | 10.2s |
| coder-3 | 3 × 3 | `"9"` | 8.1s |
| coder-4 | 4 × 4 | `"16"` | 8.4s |
| coder-5 | 5 × 5 | `"25"` | 8.5s |

**발견사항**:
- 5개 동시 실행에서도 모든 결과가 정확 — 크로스 오염 없음
- 5개 동시가 3개보다 오히려 빠름 (10.2s vs 13.5s) — `cache_read_input_tokens` 활용 효과 추정
- 각 query가 독립 subprocess로 spawn → 완전 격리 확인

---

### P2-2: Agent Teams 기본 동작

Agent Teams 라이프사이클(TeamCreate → Agent → SendMessage → TeamDelete)이 SDK `query()`에서 동작하는지 확인.

| 성공 기준 | 결과 |
|-----------|------|
| TeamCreate 감지 | PASS |
| Task/TaskCreate 감지 | FAIL (Agent 도구로 대체됨) |
| SendMessage 감지 | PASS |
| TeamDelete 감지 | PASS |
| **Agent Teams 도구 1개 이상 감지** | **PASS** |

**라이프사이클 타임라인**:

| 시점(ms) | 도구 | 설명 |
|---------|------|------|
| 9,774 | `TeamCreate` | `poc-test-team` 팀 생성 |
| 14,105 | `Agent` | `researcher` teammate 추가 |
| 18,163 | `SendMessage` | "상태를 보고해" 메시지 전송 |
| 25,976 | `SendMessage` | shutdown_request 전송 |
| 29,224~124,360 | `TeamDelete` ×7 | teammate 종료 대기 + 반복 삭제 시도 |

**전체 tool_use 목록** (18개):

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

```json
{
  "subtype": "success",
  "total_cost_usd": 0.875,
  "duration_ms": 128097,
  "num_turns": 19
}
```

**발견사항**:
- **Task/TaskCreate 미사용**: teammate 생성은 `Agent` 도구(subagent spawn)로 수행됨
- **TeamDelete 7회 반복**: researcher가 shutdown_request에 응답하지 않아 모델이 반복 시도
  - 시도 순서: shutdown_request → TeamDelete → 대기(Bash sleep) → 재시도 → config.json 직접 편집(Edit) → 최종 삭제 성공
- **teammate 종료의 비결정성**: 132.5초 중 약 100초가 종료 처리에 소비됨

---

### P2-3: Agent Teams Hooks 감시

SDK의 hooks 옵션으로 Agent Teams 도구 호출을 실시간 모니터링할 수 있는지 확인.

| 성공 기준 | 결과 |
|-----------|------|
| PreToolUse 훅 발생 | PASS (12회) |
| PostToolUse 훅 발생 | PASS (12회) |
| TeammateIdle 훅 발생 | PASS (2회) |
| TaskCompleted 훅 발생 | FAIL (미발화) |
| **Agent Teams 도구 in Hooks** | **PASS** |

**Hook 이벤트 타임라인** (총 26개):

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

**Hook rawInput 구조 예시**:

```json
{
  "session_id": "6ce9907b-...",
  "transcript_path": "C:\\Users\\...\\6ce9907b-....jsonl",
  "hook_event_name": "PreToolUse",
  "tool_name": "TeamCreate",
  "tool_input": { "team_name": "poc-hook-team", "description": "..." },
  "tool_use_id": "toolu_011EH2i8aZpCFVkX9DMnh2uH"
}
```

**Stream vs Hook 감지 비교**:

| 감시 방식 | 감지 수 | 비고 |
|----------|--------|------|
| Stream (tool_use) | 9개 | leader의 직접 호출만 |
| Hook (Pre/PostToolUse) | 24개 | subagent 내부까지 포함 (2.7배) |

```json
{
  "subtype": "success",
  "total_cost_usd": 0.785,
  "duration_ms": 66982,
  "num_turns": 10
}
```

**발견사항**:
- **Hooks가 SDK `options`에서 정상 동작** — `query()` options에 hooks를 직접 전달하는 방식 확인
- **Pre/Post 쌍 보장**: 모든 PreToolUse에 PostToolUse가 정확히 대응 (12ms 미만 간격)
- **Hook이 subagent 내부의 도구 호출까지 캡처** → stream-monitor는 Hooks 기반이 훨씬 정확
- **TaskCompleted 미발화**: 작업 완료 감지는 `result` 이벤트 또는 디스크 기반으로 별도 구현 필요

---

### P3: 디스크 기반 IPC 확인

Agent Teams 실행 중 생성되는 파일시스템 구조를 확인하여, 디스크 폴링 감시 가능성 검증.

| 성공 기준 | 결과 |
|-----------|------|
| 팀 디렉토리 발견 | PASS |
| 파일 발견 (1개 이상) | PASS |
| JSON 파싱 가능 | PASS |
| inbox 구조 발견 | PASS |

**발견된 파일시스템 구조**:

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

**파일 생성 타임라인**:

| 경과(ms) | 이벤트 |
|---------|--------|
| 38,027 | `teams/poc-ipc-team/` + `config.json` 생성 |
| 38,027 | `tasks/poc-ipc-team/` + `.lock` 생성 |
| 43,671 | `tasks/poc-ipc-team/1.json` 생성 (태스크) |
| 47,253 | `inboxes/` + `observer.json` 생성 |
| 47,764 | `team-lead.json` 생성 |

**파싱된 JSON 내용**:

`config.json` — 팀 구성 정보:
```json
{
  "name": "poc-ipc-team",
  "description": "IPC 테스트용 POC 팀",
  "createdAt": 1772551008998,
  "leadAgentId": "team-lead@poc-ipc-team",
  "members": [{
    "agentId": "team-lead@poc-ipc-team",
    "name": "team-lead",
    "agentType": "team-lead",
    "model": "claude-opus-4-6"
  }]
}
```

`tasks/1.json` — 태스크:
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

`inboxes/observer.json` — leader → teammate 메시지:
```json
[{
  "from": "team-lead",
  "text": "상태 보고",
  "summary": "상태 보고 요청",
  "timestamp": "2026-03-03T15:16:58.299Z",
  "read": false
}]
```

`inboxes/team-lead.json` — teammate → leader 응답:
```json
[{
  "from": "observer",
  "text": "Hello",
  "summary": "Hello 응답",
  "timestamp": "2026-03-03T15:16:58.806Z",
  "color": "blue",
  "read": false
}]
```

```json
{
  "subtype": "success",
  "total_cost_usd": 1.082,
  "num_turns": 19
}
```

**발견사항**:
- **경로 확정**: `~/.claude/teams/{team_name}/` + `~/.claude/tasks/{team_name}/` — POC-SKILL.md 예상과 일치
- **inbox는 JSON Array** (JSONL 아님) — 전체 파일을 읽고 파싱해야 함
- **`.lock` 파일** 존재 → 동시성 제어 메커니즘 내장
- **500ms 폴링**으로 파일 변경 감지 충분
- teammate → leader 응답에 `"color": "blue"` 필드가 추가됨

---

## 프로덕션 적용 시 주의사항

### teammate 종료 비결정성
P2-2에서 TeamDelete가 7회 반복됨. 권장 패턴:
```
shutdown_request → 10초 대기 → TeamDelete 시도
→ 실패 시 재시도 (최대 3회, 5초 간격)
→ 최종 실패 시 config.json에서 member 직접 제거 후 TeamDelete
```

### TaskCompleted 미발화
Hooks의 `TaskCompleted`가 한 번도 발화되지 않음. 대안:
- `result` 이벤트의 `subtype: "success"` 감시
- 디스크의 `tasks/{id}.json`의 `status` 필드 폴링
- `TeammateIdle` 이벤트 + 추가 로직 조합

### 비용
| 패턴 | 예상 비용/회 |
|------|-------------|
| 단순 query (P0) | ~$0.05 |
| 동시 query 5개 (P2-1) | ~$0.25 |
| Agent Teams 1회 라이프사이클 | ~$0.8 ~ $1.1 |

### Hook vs Stream 감시 범위
| 감시 방식 | 감지 범위 | 권장 용도 |
|----------|----------|----------|
| Stream tool_use | leader의 직접 호출만 | 최종 결과 수집 |
| Hooks (Pre/PostToolUse) | leader + subagent 내부까지 | **stream-monitor (권장)** |
| 디스크 폴링 | 파일 생성/변경 시점 | 백업 감시, 메시지 내용 확인 |

---

## 프로젝트 구조

```
├── CLAUDE.md                 ← Claude Code 지침
├── POC-SPEC.md               ← 검증 항목, 성공 기준, 실패 대안
├── POC-SKILL.md              ← SDK 사용법, 이벤트 구조, 함정 목록
├── POC-ARCHITECTURE.md       ← 파일 구조, 실행 순서, 공통 패턴
└── poc/
    ├── p0-sdk-sanity.ts          ← SDK 기본 동작 확인
    ├── p2-1-concurrent-query.ts  ← 동시 query() 안정성
    ├── p2-2-agent-teams-basic.ts ← Agent Teams 라이프사이클
    ├── p2-3-agent-teams-hooks.ts ← Hooks 감시 가능성
    ├── p3-disk-ipc.ts            ← 디스크 기반 IPC 확인
    └── results/                  ← 결과 JSON + 분석 리포트
```

## 실행 순서

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

## 사전 요구사항

- **Node.js** 18+
- **Claude Code CLI** 설치 (`npm i -g @anthropic-ai/claude-code`)
- **API 인증**: `ANTHROPIC_API_KEY` 환경변수 또는 Claude Code 로그인 (Pro/Max)

## 설치 및 실행

```bash
cd poc
npm install

# 순서대로 실행 (각 단계 PASS 확인 후 다음 진행)
npm run p0      # SDK 기본 동작
npm run p2-1    # 동시 query() 안정성
npm run p2-2    # Agent Teams 기본 동작
npm run p2-3    # Agent Teams Hooks 감시
npm run p3      # 디스크 기반 IPC 확인
```

결과는 `poc/results/`에 JSON + Markdown 리포트로 저장된다.

## 아키텍처 결정 매트릭스

| P0 | P2-1 | P2-2 | P2-3 | P3 | 결정 |
|----|------|------|------|----|------|
| ✅ | ✅ | ✅ | ✅ | — | v2.3 스펙 그대로. Hooks 기반 stream-monitor |
| ✅ | ✅ | ✅ | ❌ | ✅ | Agent Teams 유지. 디스크 폴링 감시 |
| ✅ | ✅ | ✅ | ❌ | ❌ | Agent Teams 유지하되 감시 없이 result만 수집 |
| ✅ | ✅ | ❌ | — | — | Agent Teams 제거. 독립 query()로 전환 |
| ✅ | ❌ | — | — | — | 동시 query() 수 축소 (3개 이하) |
| ❌ | — | — | — | — | SDK 설치/인증 문제 해결 필요 |

## 주요 문서

| 문서 | 내용 |
|------|------|
| [POC-SPEC.md](POC-SPEC.md) | 검증 항목별 상세 스펙, 성공/실패 기준 |
| [POC-SKILL.md](POC-SKILL.md) | SDK 올바른 사용법, 함정 목록 |
| [POC-ARCHITECTURE.md](POC-ARCHITECTURE.md) | 파일 구조, 의존성, 공통 패턴 |
| [poc/results/ANALYSIS.md](poc/results/ANALYSIS.md) | 전체 결과 종합 분석 |

## 참고 출처

- [Claude Agent SDK - TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK - Streaming](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent Teams 공식 문서](https://code.claude.com/docs/en/agent-teams)
- [@anthropic-ai/claude-agent-sdk (npm)](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

## License

Private — adev 내부 검증용
