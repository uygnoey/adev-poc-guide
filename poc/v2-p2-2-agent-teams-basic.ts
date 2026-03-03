/**
 * V2-P2-2: V2 Agent Teams 기본 동작
 *
 * 검증 항목:
 *   - V2 Session API로 Agent Teams 라이프사이클이 동작하는지 확인
 *   - createSession에 env 옵션으로 AGENT_TEAMS 활성화
 *   - session.send() + session.stream()에서 tool_use 감지
 *
 * 성공 기준:
 *   - tool_use 블록에서 TeamCreate 최소 1회 감지
 *
 * 실패 시:
 *   - V2 Session에서 Agent Teams 미작동 → V1 query() 사용
 *
 * 산출물:
 *   - results/v2-p2-2-tool-calls.json
 *   - results/v2-p2-2-report.md
 *
 * 실행: bun run v2-p2-2-agent-teams-basic.ts
 */

import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

const TIMEOUT_MS = 180_000;

const AGENT_TEAMS_TOOLS = [
  "TeamCreate", "team_create",
  "TaskCreate", "task_create",
  "TaskList", "TaskUpdate", "TaskGet",
  "SendMessage", "send_message",
  "TeamDelete", "team_delete",
  "Agent",
];

interface ToolCallEvent {
  timestamp: string;
  elapsedMs: number;
  blockName: string;
  blockInput: unknown;
  isAgentTeams: boolean;
}

interface V2P22Report {
  testId: "V2-P2-2";
  testName: "V2 Agent Teams 기본 동작";
  timestamp: string;
  durationMs: number;
  result: "PASS" | "FAIL";
  criteria: {
    teamCreateDetected: boolean;
    taskDetected: boolean;
    sendMessageDetected: boolean;
    teamDeleteDetected: boolean;
    anyAgentTeamsToolDetected: boolean;
  };
  envConfig: Record<string, string>;
  toolCalls: ToolCallEvent[];
  agentTeamsToolCalls: ToolCallEvent[];
  allEventTypes: string[];
  allToolNames: string[];
  assistantTexts: string[];
  resultEvent: Record<string, unknown> | null;
  error: string | null;
  nextStep: string;
}

function generateMarkdown(report: V2P22Report): string {
  const c = report.criteria;

  return `# V2-P2-2: V2 Agent Teams 기본 동작 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | V2-P2-2 |
| 실행 시각 | ${report.timestamp} |
| 소요 시간 | ${report.durationMs}ms |
| **최종 결과** | **${report.result}** |

## 환경 설정

\`\`\`json
${JSON.stringify(report.envConfig, null, 2)}
\`\`\`

## 성공 기준 체크

| 기준 | 결과 |
|------|------|
| TeamCreate 감지 | ${c.teamCreateDetected ? "PASS" : "FAIL"} |
| Task/TaskCreate 감지 | ${c.taskDetected ? "PASS" : "FAIL"} |
| SendMessage 감지 | ${c.sendMessageDetected ? "PASS" : "FAIL"} |
| TeamDelete 감지 | ${c.teamDeleteDetected ? "PASS" : "FAIL"} |
| **Agent Teams 도구 1개 이상 감지** | **${c.anyAgentTeamsToolDetected ? "PASS" : "FAIL"}** |

## 감지된 도구 호출

### 전체 tool_use (${report.toolCalls.length}개)

| 시간(ms) | 도구명 | Agent Teams? |
|---------|--------|-------------|
${report.toolCalls.length > 0 ? report.toolCalls.map((t) => `| ${t.elapsedMs} | \`${t.blockName}\` | ${t.isAgentTeams ? "YES" : "no"} |`).join("\n") : "| - | _없음_ | - |"}

### Agent Teams 도구만 (${report.agentTeamsToolCalls.length}개)

${report.agentTeamsToolCalls.length > 0 ? report.agentTeamsToolCalls.map((t) => `- **${t.blockName}** (${t.elapsedMs}ms): \`${JSON.stringify(t.blockInput).substring(0, 100)}\``).join("\n") : "_Agent Teams 도구 미감지_"}

## 감지된 이벤트 타입

\`[${report.allEventTypes.join(", ")}]\`

## 감지된 도구 이름 (전체)

\`[${report.allToolNames.join(", ")}]\`

## result 이벤트

${report.resultEvent ? `\`\`\`json\n${JSON.stringify(report.resultEvent, null, 2)}\n\`\`\`` : "_미수신_"}

${report.error ? `## 에러\n\n\`\`\`\n${report.error}\n\`\`\`` : ""}

## 다음 단계

> ${report.nextStep}

---
_생성: ${report.timestamp}_
`;
}

async function main() {
  console.log("=== V2-P2-2: V2 Agent Teams 기본 동작 ===\n");
  const start = Date.now();

  mkdirSync("results", { recursive: true });

  const toolCalls: ToolCallEvent[] = [];
  const allEventTypes: string[] = [];
  const allToolNames: string[] = [];
  const assistantTexts: string[] = [];
  let resultEvent: Record<string, unknown> | null = null;
  let error: string | null = null;

  const envConfig = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };

  const prompt = `너는 Agent Teams 기능을 사용해야 한다.

다음을 순서대로 수행해:
1. "v2-poc-team"이라는 이름의 팀을 생성해 (TeamCreate)
2. 팀에 "researcher"라는 teammate를 추가하고 "Hello world라고 답해"라는 태스크를 줘
3. teammate에게 "상태를 보고해"라는 메시지를 보내
4. 팀을 삭제해 (TeamDelete)

각 단계를 반드시 실행하고, 도구를 사용해서 수행해.`;

  let session: ReturnType<typeof unstable_v2_createSession> | null = null;
  try {
    console.log("[Setup] V2 createSession + Agent Teams");
    console.log("[Setup] env:", JSON.stringify(envConfig));
    console.log("[Setup] model: sonnet, permissionMode: bypassPermissions\n");

    session = unstable_v2_createSession({
      model: "sonnet",
      permissionMode: "bypassPermissions",
      env: { ...process.env, ...envConfig },
    });

    await session.send(prompt);

    for await (const msg of session.stream()) {
      const elapsed = Date.now() - start;

      if (elapsed > TIMEOUT_MS) {
        console.log(`[Timeout] ${TIMEOUT_MS}ms 초과. 스트림 중단.`);
        break;
      }

      const msgType = (msg as Record<string, unknown>).type as string;
      if (!allEventTypes.includes(msgType)) allEventTypes.push(msgType);

      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            assistantTexts.push(block.text);
            console.log(`[Text] (${elapsed}ms) ${block.text.substring(0, 100)}`);
          }

          if (block.type === "tool_use") {
            const isAgentTeams = AGENT_TEAMS_TOOLS.includes(block.name);
            toolCalls.push({
              timestamp: new Date().toISOString(),
              elapsedMs: elapsed,
              blockName: block.name,
              blockInput: block.input,
              isAgentTeams,
            });

            if (!allToolNames.includes(block.name)) allToolNames.push(block.name);

            const marker = isAgentTeams ? "🎯 AGENT TEAMS" : "🔧 TOOL";
            console.log(`[${marker}] (${elapsed}ms) ${block.name}`);
          }
        }
      }

      if (msg.type === "result") {
        const resultText = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
        resultEvent = {
          subtype: msg.subtype,
          result: typeof resultText === "string" ? resultText.substring(0, 200) : resultText,
          total_cost_usd: msg.total_cost_usd,
          duration_ms: msg.duration_ms,
          num_turns: msg.num_turns,
        };
        console.log(`\n[Result] (${elapsed}ms) subtype: ${msg.subtype}, turns: ${msg.num_turns}, cost: $${msg.total_cost_usd}`);
        break;
      }
    }

  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[Error] ${error}`);
  } finally {
    session?.close();
    console.log("[Session] close() 완료");
  }

  const durationMs = Date.now() - start;

  const agentTeamsToolCalls = toolCalls.filter((t) => t.isAgentTeams);
  const hasToolName = (names: string[]) =>
    agentTeamsToolCalls.some((t) => names.includes(t.blockName));

  const criteria = {
    teamCreateDetected: hasToolName(["TeamCreate", "team_create"]),
    taskDetected: hasToolName(["TaskCreate", "task_create", "TaskList", "TaskUpdate", "TaskGet"]),
    sendMessageDetected: hasToolName(["SendMessage", "send_message"]),
    teamDeleteDetected: hasToolName(["TeamDelete", "team_delete"]),
    anyAgentTeamsToolDetected: agentTeamsToolCalls.length > 0,
  };

  const pass = criteria.teamCreateDetected;

  const report: V2P22Report = {
    testId: "V2-P2-2",
    testName: "V2 Agent Teams 기본 동작",
    timestamp: new Date().toISOString(),
    durationMs,
    result: pass ? "PASS" : "FAIL",
    criteria,
    envConfig,
    toolCalls,
    agentTeamsToolCalls,
    allEventTypes,
    allToolNames,
    assistantTexts,
    resultEvent,
    error,
    nextStep: pass
      ? "V2-P2-2 PASS → V2-P2-3 (V2 Hooks 감시) 진행"
      : "V2 Session에서 Agent Teams 미작동. V1 query() 사용 권장.",
  };

  writeFileSync("results/v2-p2-2-tool-calls.json", JSON.stringify(report, null, 2));
  writeFileSync("results/v2-p2-2-report.md", generateMarkdown(report));

  console.log("\n" + "=".repeat(60));
  console.log(`V2-P2-2: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`전체 tool_use: ${toolCalls.length}개`);
  console.log(`Agent Teams tool_use: ${agentTeamsToolCalls.length}개`);
  console.log(`TeamCreate: ${criteria.teamCreateDetected ? "✅" : "❌"}`);
  console.log(`SendMessage: ${criteria.sendMessageDetected ? "✅" : "❌"}`);
  console.log(`TeamDelete: ${criteria.teamDeleteDetected ? "✅" : "❌"}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과: results/v2-p2-2-tool-calls.json + results/v2-p2-2-report.md`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
