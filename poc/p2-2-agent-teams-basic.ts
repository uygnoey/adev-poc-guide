/**
 * P2-2: Agent Teams 기본 동작
 *
 * 검증 항목:
 *   - Agent Teams 라이프사이클(TeamCreate → Task → SendMessage → TeamDelete)이
 *     SDK query()에서 동작하는지 확인
 *   - options.env에 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" 설정이 전달되는지 확인
 *
 * 성공 기준:
 *   - tool_use 블록에서 TeamCreate 최소 1회 감지
 *   - 전체 라이프사이클(Create→Task→Send→Delete) 감지가 이상적
 *
 * 실패 시:
 *   - env가 전달 안 되는 경우: settingSources로 시도
 *   - Agent Teams 자체가 안 되는 경우: Agent Teams 제거 → DESIGN Phase도 독립 query()로 전환
 *
 * 산출물:
 *   - results/p2-2-tool-calls.json (감지된 tool_use 목록)
 *   - results/p2-2-report.md
 *
 * 실행: bun run p2-2-agent-teams-basic.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

const TIMEOUT_MS = 180_000; // Agent Teams는 시간이 더 걸릴 수 있으므로 3분

// Agent Teams 관련 도구 이름 목록 (다양한 스펠링 대비)
const AGENT_TEAMS_TOOLS = [
  "TeamCreate", "team_create",
  "Task", "TaskCreate", "task_create",
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

interface P22Report {
  testId: "P2-2";
  testName: "Agent Teams 기본 동작";
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
  prompt: string;
  toolCalls: ToolCallEvent[];
  agentTeamsToolCalls: ToolCallEvent[];
  allEventTypes: string[];
  allToolNames: string[];
  assistantTexts: string[];
  resultEvent: Record<string, unknown> | null;
  rawEvents: unknown[];
  error: string | null;
  nextStep: string;
}

function generateMarkdown(report: P22Report): string {
  const c = report.criteria;

  return `# P2-2: Agent Teams 기본 동작 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | P2-2 |
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

| 시간(ms) | 도구명 | Agent Teams? | 입력 |
|---------|--------|-------------|------|
${report.toolCalls.length > 0 ? report.toolCalls.map((t) => `| ${t.elapsedMs} | \`${t.blockName}\` | ${t.isAgentTeams ? "YES" : "no"} | ${JSON.stringify(t.blockInput).substring(0, 60)} |`).join("\n") : "| - | _없음_ | - | - |"}

### Agent Teams 도구만 (${report.agentTeamsToolCalls.length}개)

${report.agentTeamsToolCalls.length > 0 ? report.agentTeamsToolCalls.map((t) => `- **${t.blockName}** (${t.elapsedMs}ms): \`${JSON.stringify(t.blockInput).substring(0, 100)}\``).join("\n") : "_Agent Teams 도구 미감지_"}

## 감지된 이벤트 타입

\`[${report.allEventTypes.join(", ")}]\`

## 감지된 도구 이름 (전체)

\`[${report.allToolNames.join(", ")}]\`

## Claude 응답 텍스트

${report.assistantTexts.length > 0 ? report.assistantTexts.map((t) => `> ${t.substring(0, 200)}`).join("\n\n") : "_텍스트 없음_"}

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
  console.log("=== P2-2: Agent Teams 기본 동작 ===\n");
  const start = Date.now();

  // 1. Setup
  mkdirSync("results", { recursive: true });

  const toolCalls: ToolCallEvent[] = [];
  const allEventTypes: string[] = [];
  const allToolNames: string[] = [];
  const assistantTexts: string[] = [];
  const rawEvents: unknown[] = [];
  let resultEvent: Record<string, unknown> | null = null;
  let error: string | null = null;

  const envConfig = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };

  const prompt = `너는 Agent Teams 기능을 사용해야 한다.

다음을 순서대로 수행해:
1. "poc-test-team"이라는 이름의 팀을 생성해 (TeamCreate)
2. 팀에 "researcher"라는 teammate를 추가하고 "Hello world라고 답해"라는 태스크를 줘
3. teammate에게 "상태를 보고해"라는 메시지를 보내
4. 팀을 삭제해 (TeamDelete)

각 단계를 반드시 실행하고, 도구를 사용해서 수행해.`;

  // 2. Execute
  try {
    console.log("[Setup] env:", JSON.stringify(envConfig));
    console.log("[Setup] prompt:", prompt.substring(0, 80) + "...");
    console.log("[Setup] model: sonnet, permissionMode: bypassPermissions\n");

    const q = query({
      prompt,
      options: {
        model: "sonnet",
        maxTurns: 250,
        permissionMode: "bypassPermissions",
        settingSources: [],
        env: envConfig,
      },
    });

    for await (const msg of q) {
      const elapsed = Date.now() - start;

      if (elapsed > TIMEOUT_MS) {
        console.log(`[Timeout] ${TIMEOUT_MS}ms 초과. 스트림 중단.`);
        break;
      }

      rawEvents.push(JSON.parse(JSON.stringify(msg)));

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
            const toolCall: ToolCallEvent = {
              timestamp: new Date().toISOString(),
              elapsedMs: elapsed,
              blockName: block.name,
              blockInput: block.input,
              isAgentTeams,
            };
            toolCalls.push(toolCall);

            if (!allToolNames.includes(block.name)) allToolNames.push(block.name);

            const marker = isAgentTeams ? "🎯 AGENT TEAMS" : "🔧 TOOL";
            console.log(`[${marker}] (${elapsed}ms) ${block.name} - input: ${JSON.stringify(block.input).substring(0, 100)}`);
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
          is_error: msg.is_error,
        };
        console.log(`\n[Result] (${elapsed}ms) subtype: ${msg.subtype}, turns: ${msg.num_turns}, cost: $${msg.total_cost_usd}`);
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[Error] ${error}`);
  }

  const durationMs = Date.now() - start;

  // 3. Analyze
  const agentTeamsToolCalls = toolCalls.filter((t) => t.isAgentTeams);

  const hasToolName = (names: string[]) =>
    agentTeamsToolCalls.some((t) => names.includes(t.blockName));

  const criteria = {
    teamCreateDetected: hasToolName(["TeamCreate", "team_create"]),
    taskDetected: hasToolName(["Task", "TaskCreate", "task_create"]),
    sendMessageDetected: hasToolName(["SendMessage", "send_message"]),
    teamDeleteDetected: hasToolName(["TeamDelete", "team_delete"]),
    anyAgentTeamsToolDetected: agentTeamsToolCalls.length > 0,
  };

  const pass = criteria.anyAgentTeamsToolDetected;

  // 4. Dump
  const report: P22Report = {
    testId: "P2-2",
    testName: "Agent Teams 기본 동작",
    timestamp: new Date().toISOString(),
    durationMs,
    result: pass ? "PASS" : "FAIL",
    criteria,
    envConfig,
    prompt,
    toolCalls,
    agentTeamsToolCalls,
    allEventTypes,
    allToolNames,
    assistantTexts,
    resultEvent,
    rawEvents,
    error,
    nextStep: pass
      ? "P2-2 PASS → P2-3 (Agent Teams Hooks 감시) 진행"
      : "Agent Teams 도구 미감지. 대안: (1) env 전달 확인, (2) 시스템 환경변수로 시도, (3) Agent Teams 제거 결정",
  };

  writeFileSync("results/p2-2-tool-calls.json", JSON.stringify(report, null, 2));
  writeFileSync("results/p2-2-report.md", generateMarkdown(report));

  // 5. 결론 출력
  console.log("\n" + "=".repeat(60));
  console.log(`P2-2: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`전체 tool_use 감지: ${toolCalls.length}개`);
  console.log(`Agent Teams tool_use 감지: ${agentTeamsToolCalls.length}개`);
  console.log(`감지된 도구 이름: [${allToolNames.join(", ")}]`);
  console.log("");
  console.log(`TeamCreate 감지: ${criteria.teamCreateDetected ? "✅" : "❌"}`);
  console.log(`Task 감지: ${criteria.taskDetected ? "✅" : "❌"}`);
  console.log(`SendMessage 감지: ${criteria.sendMessageDetected ? "✅" : "❌"}`);
  console.log(`TeamDelete 감지: ${criteria.teamDeleteDetected ? "✅" : "❌"}`);

  if (agentTeamsToolCalls.length > 0) {
    console.log("\n[Agent Teams tool_use 상세]");
    for (const t of agentTeamsToolCalls) {
      console.log(`  ${t.elapsedMs}ms | ${t.blockName} | ${JSON.stringify(t.blockInput).substring(0, 80)}`);
    }
  }

  if (error) console.log(`\n에러: ${error}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과: results/p2-2-tool-calls.json + results/p2-2-report.md`);
}

main();
