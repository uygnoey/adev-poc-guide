# adev PoC Skill — Claude Agent SDK 올바른 사용법

## ⚠️ 이 문서를 반드시 먼저 읽고 코드를 작성할 것

이 PoC는 Claude Agent SDK의 실제 동작을 검증하는 것이다.
**추측으로 코드를 짜면 안 된다.** 불확실한 것은 반드시:
1. SDK 소스코드를 직접 확인 (`node_modules/@anthropic-ai/claude-agent-sdk/`)
2. 또는 최소 코드로 먼저 테스트
3. 결과를 JSON으로 dump한 후 분석

---

## SDK 기본 패턴

### query() — 핵심 함수

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// query()는 AsyncGenerator<SDKMessage, void>를 반환
const q = query({
  prompt: "프롬프트 텍스트",
  options: {
    model: "sonnet",              // "sonnet" | "opus" | "haiku"
    maxTurns: 250,                // 기본값 250
    permissionMode: "bypassPermissions",  // PoC에서는 항상 이거
    allowedTools: [],             // 빈 배열 = 도구 없음
    settingSources: [],           // 빈 배열 = 파일시스템 설정 무시
  },
});

for await (const msg of q) {
  // msg는 SDKMessage 타입
}
```

출처: https://platform.claude.com/docs/en/agent-sdk/typescript

### SDKMessage 타입 (실제 구조)

```typescript
type SDKMessage =
  | SDKAssistantMessage        // type: "assistant"
  | SDKUserMessage             // type: "user"
  | SDKUserMessageReplay       // type: "user_message_replay"
  | SDKResultMessage           // type: "result"
  | SDKSystemMessage           // type: "system"
  | SDKPartialAssistantMessage // type: "stream_event" (includePartialMessages: true 필요)
  | SDKCompactBoundaryMessage  // type: "compact_boundary"
```

### assistant 메시지에서 텍스트 추출

```typescript
if (msg.type === "assistant") {
  for (const block of msg.message.content) {
    if (block.type === "text") {
      console.log(block.text);  // 텍스트
    }
    if (block.type === "tool_use") {
      console.log(block.name);  // 도구 이름 (예: "TeamCreate", "Bash")
      console.log(block.input); // 도구 입력 (객체)
    }
  }
}
```

### result 메시지

```typescript
if (msg.type === "result") {
  console.log(msg.subtype);       // "success" | "error" | ...
  console.log(msg.total_cost_usd); // 비용
  console.log(msg.result);        // 최종 텍스트 결과
}
```

### stream_event (실시간 스트리밍)

```typescript
// includePartialMessages: true 설정 필요
const q = query({
  prompt: "...",
  options: { includePartialMessages: true },
});

for await (const msg of q) {
  if (msg.type === "stream_event") {
    const event = msg.event;
    // event.type: "content_block_start" | "content_block_delta" | "content_block_stop" | ...
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      process.stdout.write(event.delta.text);  // 실시간 텍스트
    }
  }
}
```

출처: https://platform.claude.com/docs/en/agent-sdk/streaming-output

---

## Agent Teams 패턴

### 핵심 원리

Agent Teams 도구(TeamCreate, Task, SendMessage, TeamDelete)는 **Claude 모델이 tool_use로 호출**한다.
우리 코드에서 직접 호출하는 것이 아니다.

우리가 하는 것:
1. env에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"` 설정
2. 프롬프트로 팀 생성/관리를 지시
3. 스트림에서 tool_use 블록을 관찰

### Agent Teams 활성화

```typescript
const q = query({
  prompt: "팀을 만들어서 ...",
  options: {
    model: "sonnet",
    permissionMode: "bypassPermissions",
    settingSources: [],
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
  },
});
```

**⚠️ 불확실**: `options.env`가 실제로 Claude Code subprocess에 전달되는지.
안 되면 시스템 환경변수로 설정:
```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

### Agent Teams 도구 목록

| 도구 | 역할 | input 예시 |
|------|------|-----------|
| TeamCreate | 팀 생성 | `{ team_name: "my-team", description: "..." }` |
| Task / TaskCreate | teammate spawn | `{ subject: "...", description: "..." }` |
| SendMessage | 메시지 전송 | `{ type: "message", recipient: "agent-1", content: "..." }` |
| TeamDelete | 팀 삭제 | `{}` |

출처: https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/

### tool_use에서 Agent Teams 도구 감지

```typescript
for await (const msg of q) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "tool_use") {
        // block.name이 Agent Teams 도구인지 확인
        const isAgentTeams = ["TeamCreate", "TaskCreate", "Task", 
                              "SendMessage", "TeamDelete"].includes(block.name);
        if (isAgentTeams) {
          console.log(`Agent Teams 도구: ${block.name}`, block.input);
        }
      }
    }
  }
}
```

---

## Hooks 패턴

### SDK Hook 이벤트 타입

```typescript
type HookEvent =
  | "PreToolUse"        // 도구 호출 전
  | "PostToolUse"       // 도구 호출 후
  | "PostToolUseFailure"
  | "Notification"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PermissionRequest"
  | "Setup"
  | "TeammateIdle"      // Agent Teams: teammate 대기
  | "TaskCompleted"     // Agent Teams: 작업 완료
  | "ConfigChange"
  | "WorktreeCreate"
  | "WorktreeRemove"
```

출처: https://platform.claude.com/docs/en/agent-sdk/typescript

### ⚠️ Hooks 사용법 — 불확실한 부분

SDK 문서에 HookEvent 타입과 HookCallback 타입은 정의되어 있지만,
**query() options에 hooks를 넘기는 정확한 구조는 명확하지 않다.**

**Claude Code에게 부탁**: 
1. `node_modules/@anthropic-ai/claude-agent-sdk/`에서 Options 타입 정의를 확인
2. hooks 필드가 있는지, 구조가 어떤지 직접 확인
3. 없다면 settings.json 커맨드 기반 hooks로 대안 탐색

### 커맨드 기반 hooks (대안)

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "TeamCreate|SendMessage|TeamDelete",
      "hooks": [{
        "type": "command",
        "command": "echo '{\"tool_name\": \"$TOOL_NAME\"}' >> /tmp/adev-hooks.jsonl"
      }]
    }]
  }
}
```

출처: https://code.claude.com/docs/en/hooks

---

## 디스크 IPC 패턴

### Agent Teams 파일 구조

```
~/.claude/
├── teams/
│   └── {team_name}/
│       ├── config.json
│       └── inboxes/
│           └── {agent_name}.json
└── tasks/
    └── {team_name}/
        └── {task_id}.json
```

출처: 
- https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/
- https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol

### inbox 메시지 구조 (예상)

```json
[
  {
    "from": "leader",
    "text": "Hello, report your status",
    "summary": "...",
    "timestamp": "2026-03-03T...",
    "read": false
  }
]
```

또는 JSONL 형식일 수 있음:
```jsonl
{"id":"msg-1","from":"leader","text":"Hello","timestamp":"...","read":false}
```

**⚠️ 불확실**: 정확한 경로와 형식은 Claude Code 버전에 따라 다를 수 있다.
`find ~/.claude -name "*.json" -newer /tmp/marker` 로 탐색 권장.

---

## 절대 하지 말 것 (함정 목록)

### ❌ 잘못된 이벤트 파싱

```typescript
// 틀림: 존재하지 않는 구조
if (msg.type === "text") { ... }
if (msg.text) { ... }

// 맞음: 공식 구조
if (msg.type === "assistant") {
  msg.message.content.filter(b => b.type === "text").map(b => b.text);
}
```

### ❌ Agent Teams 도구 직접 호출

```typescript
// 틀림: JS에서 호출할 수 없음
await TeamCreate({ team_name: "test" });

// 맞음: 프롬프트로 지시, 스트림에서 관찰
query({ prompt: "TeamCreate로 팀을 만들어..." });
```

### ❌ 타임아웃 없는 스트림 소비

```typescript
// 위험: 무한 대기 가능
for await (const msg of q) { ... }

// 안전: 타임아웃 추가
const start = Date.now();
for await (const msg of q) {
  if (Date.now() - start > 120_000) break;  // 2분
  if (msg.type === "result") break;
}
```

### ❌ 추측으로 코드 작성

```
불확실한 것 → 반드시 먼저 확인:
1. SDK 소스 확인: cat node_modules/@anthropic-ai/claude-agent-sdk/dist/index.d.ts
2. 최소 코드 테스트: 한 줄짜리 query() 먼저 실행
3. 결과 dump: JSON.stringify(msg, null, 2) 로 전체 구조 기록
```

---

## 코드 품질 규칙

1. **이해하기 쉽게**: 각 파일 상단에 목적/검증항목/성공기준 주석
2. **일관된 패턴**: 모든 PoC 파일이 동일한 구조 (setup → execute → analyze → dump)
3. **self-contained**: 각 파일이 독립 실행 가능. 외부 유틸 의존 최소화
4. **결과 dump**: 모든 테스트가 JSON 파일로 상세 결과 저장
5. **에러 처리**: try/catch + 의미 있는 에러 메시지 + 다음 단계 가이드
