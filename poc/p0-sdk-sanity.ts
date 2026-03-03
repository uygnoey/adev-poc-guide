/**
 * P0: SDK 기본 동작 확인
 *
 * 검증 항목:
 *   - query()가 정상 동작하는지
 *   - SDKMessage 이벤트 구조가 문서와 일치하는지
 *
 * 성공 기준:
 *   - msg.type === "assistant" 이벤트에서 텍스트 추출 가능
 *   - msg.type === "result" 이벤트 수신
 *   - 전체 소요 시간 30초 이내
 *
 * 실패 시:
 *   - Claude Code 설치/인증 문제. 나머지 PoC 진행 불가.
 *
 * 산출물:
 *   - results/p0-events.json (모든 이벤트 raw dump)
 *   - results/p0-report.md  (사람이 읽을 수 있는 상세 결과서)
 *
 * 실행: bun run p0-sdk-sanity.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

const TIMEOUT_MS = 30_000;

interface P0Report {
  testId: "P0";
  testName: "SDK 기본 동작 확인";
  timestamp: string;
  durationMs: number;
  result: "PASS" | "FAIL";
  criteria: {
    assistantTextExtracted: boolean;
    resultEventReceived: boolean;
    within30Seconds: boolean;
  };
  extractedText: string | null;
  resultEvent: Record<string, unknown> | null;
  allEvents: Array<{ type: string; keys: string[]; content?: unknown }>;
  rawEvents: unknown[];
  error: string | null;
  nextStep: string;
}

function generateMarkdown(report: P0Report): string {
  const c = report.criteria;
  return `# P0: SDK 기본 동작 확인 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | P0 |
| 실행 시각 | ${report.timestamp} |
| 소요 시간 | ${report.durationMs}ms |
| **최종 결과** | **${report.result}** |

## 성공 기준 체크

| 기준 | 결과 | 상세 |
|------|------|------|
| assistant 텍스트 추출 가능 | ${c.assistantTextExtracted ? "PASS" : "FAIL"} | ${report.extractedText ? `"${report.extractedText}"` : "추출 실패"} |
| result 이벤트 수신 | ${c.resultEventReceived ? "PASS" : "FAIL"} | ${report.resultEvent ? `subtype: ${report.resultEvent.subtype}` : "미수신"} |
| 30초 이내 완료 | ${c.within30Seconds ? "PASS" : "FAIL"} | ${report.durationMs}ms |

## 이벤트 흐름

총 **${report.rawEvents.length}**개 이벤트 수신:

| # | 타입 | 주요 내용 |
|---|------|----------|
${report.allEvents.map((e, i) => `| ${i + 1} | \`${e.type}\` | ${e.content ? JSON.stringify(e.content).substring(0, 80) : "-"} |`).join("\n")}

## result 이벤트 상세

${report.resultEvent ? `\`\`\`json
${JSON.stringify(report.resultEvent, null, 2)}
\`\`\`` : "_result 이벤트 미수신_"}

${report.error ? `## 에러\n\n\`\`\`\n${report.error}\n\`\`\`` : ""}

## 다음 단계

> ${report.nextStep}

---
_생성: ${report.timestamp}_
`;
}

async function main() {
  console.log("=== P0: SDK 기본 동작 확인 ===\n");
  const start = Date.now();

  // 1. Setup
  mkdirSync("results", { recursive: true });

  const rawEvents: unknown[] = [];
  const eventSummary: Array<{ type: string; keys: string[]; content?: unknown }> = [];
  let extractedText: string | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  let error: string | null = null;

  // 2. Execute
  try {
    console.log('[Setup] query() 호출 시작...');
    console.log('[Setup] prompt: "1+1은? 숫자만 답해."');
    console.log('[Setup] model: sonnet, maxTurns: 1, allowedTools: [], permissionMode: bypassPermissions\n');

    const q = query({
      prompt: "1+1은? 숫자만 답해.",
      options: {
        model: "sonnet",
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
      },
    });

    for await (const msg of q) {
      const elapsed = Date.now() - start;

      if (elapsed > TIMEOUT_MS) {
        console.log(`[Timeout] ${TIMEOUT_MS}ms 초과. 스트림 중단.`);
        break;
      }

      rawEvents.push(JSON.parse(JSON.stringify(msg)));

      const summary: { type: string; keys: string[]; content?: unknown } = {
        type: (msg as Record<string, unknown>).type as string,
        keys: Object.keys(msg as Record<string, unknown>),
      };

      if (msg.type === "assistant") {
        const textBlocks = msg.message.content.filter(
          (b: { type: string }) => b.type === "text"
        );
        const toolBlocks = msg.message.content.filter(
          (b: { type: string }) => b.type === "tool_use"
        );

        if (textBlocks.length > 0) {
          extractedText = textBlocks
            .map((b: { type: "text"; text: string }) => b.text)
            .join("");
          summary.content = {
            textBlocks: textBlocks.length,
            toolBlocks: toolBlocks.length,
            text: extractedText,
          };
          console.log(`[Event] assistant (${elapsed}ms) - text: "${extractedText}"`);
        } else {
          console.log(`[Event] assistant (${elapsed}ms) - no text blocks`);
        }
      } else if (msg.type === "result") {
        const resultText = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
        resultEvent = {
          subtype: msg.subtype,
          result: resultText,
          total_cost_usd: msg.total_cost_usd,
          duration_ms: msg.duration_ms,
          num_turns: msg.num_turns,
          is_error: msg.is_error,
        };
        summary.content = resultEvent;
        console.log(`[Event] result (${elapsed}ms) - subtype: ${msg.subtype}, result: "${resultText}"`);
        eventSummary.push(summary);
        break;
      } else {
        console.log(`[Event] ${msg.type} (${elapsed}ms)`);
      }

      eventSummary.push(summary);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[Error] ${error}`);
  }

  const durationMs = Date.now() - start;

  // 3. Analyze
  const criteria = {
    assistantTextExtracted: extractedText !== null && extractedText.length > 0,
    resultEventReceived: resultEvent !== null,
    within30Seconds: durationMs <= TIMEOUT_MS,
  };

  const pass = criteria.assistantTextExtracted && criteria.resultEventReceived && criteria.within30Seconds;

  // 4. Dump
  const report: P0Report = {
    testId: "P0",
    testName: "SDK 기본 동작 확인",
    timestamp: new Date().toISOString(),
    durationMs,
    result: pass ? "PASS" : "FAIL",
    criteria,
    extractedText,
    resultEvent,
    allEvents: eventSummary,
    rawEvents,
    error,
    nextStep: pass
      ? "P0 PASS → P2-1 (동시 query() 안정성) 진행"
      : "Claude Code 설치/인증 문제 해결 필요. 나머지 PoC 진행 불가.",
  };

  writeFileSync("results/p0-events.json", JSON.stringify(report, null, 2));
  writeFileSync("results/p0-report.md", generateMarkdown(report));

  // 5. 결론 출력
  console.log("\n" + "=".repeat(60));
  console.log(`P0: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`assistant 텍스트 추출: ${criteria.assistantTextExtracted ? "✅" : "❌"} (${extractedText ?? "없음"})`);
  console.log(`result 이벤트 수신: ${criteria.resultEventReceived ? "✅" : "❌"}`);
  console.log(`30초 이내 완료: ${criteria.within30Seconds ? "✅" : "❌"}`);
  console.log(`이벤트 총 개수: ${rawEvents.length}`);
  console.log(`이벤트 타입: ${eventSummary.map((e) => e.type).join(", ")}`);
  if (error) console.log(`에러: ${error}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과: results/p0-events.json + results/p0-report.md`);
}

main();
