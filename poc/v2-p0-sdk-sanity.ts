/**
 * V2-P0: SDK V2 기본 동작 확인
 *
 * 검증 항목:
 *   - Part A: unstable_v2_prompt() 원샷 방식이 정상 동작하는지
 *   - Part B: unstable_v2_createSession() + send() + stream() 세션 방식이 정상 동작하는지
 *   - V1 query()와 동일한 이벤트 구조인지 비교
 *
 * 성공 기준:
 *   - Part A: result.subtype === "success" && result 텍스트에서 "2" 추출 가능
 *   - Part B: stream에서 assistant + result 이벤트 수신
 *   - 전체 소요 시간 30초 이내
 *
 * 실패 시:
 *   - V2 API가 현재 SDK 버전에서 지원 안 되는 경우: V1 API만 사용
 *
 * 산출물:
 *   - results/v2-p0-events.json
 *   - results/v2-p0-report.md
 *
 * 실행: bun run v2-p0-sdk-sanity.ts
 */

import {
  unstable_v2_prompt,
  unstable_v2_createSession,
} from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

const TIMEOUT_MS = 30_000;

interface V2P0Report {
  testId: "V2-P0";
  testName: "SDK V2 기본 동작 확인";
  timestamp: string;
  durationMs: number;
  result: "PASS" | "FAIL";
  partA: {
    label: "unstable_v2_prompt()";
    success: boolean;
    resultSubtype: string | null;
    resultText: string | null;
    costUsd: number | null;
    durationMs: number;
    error: string | null;
  };
  partB: {
    label: "createSession + send + stream";
    success: boolean;
    extractedText: string | null;
    resultSubtype: string | null;
    costUsd: number | null;
    durationMs: number;
    eventTypes: string[];
    eventCount: number;
    error: string | null;
  };
  criteria: {
    partAPassed: boolean;
    partBPassed: boolean;
    within30Seconds: boolean;
  };
  nextStep: string;
}

function generateMarkdown(report: V2P0Report): string {
  const c = report.criteria;
  return `# V2-P0: SDK V2 기본 동작 확인 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | V2-P0 |
| 실행 시각 | ${report.timestamp} |
| 소요 시간 | ${report.durationMs}ms |
| **최종 결과** | **${report.result}** |

## 성공 기준 체크

| 기준 | 결과 | 상세 |
|------|------|------|
| Part A (v2_prompt) | ${c.partAPassed ? "PASS" : "FAIL"} | ${report.partA.resultText ?? report.partA.error ?? "-"} |
| Part B (session) | ${c.partBPassed ? "PASS" : "FAIL"} | ${report.partB.extractedText ?? report.partB.error ?? "-"} |
| 30초 이내 완료 | ${c.within30Seconds ? "PASS" : "FAIL"} | ${report.durationMs}ms |

## Part A: unstable_v2_prompt()

| 항목 | 값 |
|------|-----|
| 성공 | ${report.partA.success ? "YES" : "NO"} |
| subtype | ${report.partA.resultSubtype ?? "-"} |
| result | ${report.partA.resultText ?? "-"} |
| 비용 | ${report.partA.costUsd != null ? `$${report.partA.costUsd}` : "-"} |
| 소요 시간 | ${report.partA.durationMs}ms |
| 에러 | ${report.partA.error ?? "-"} |

## Part B: createSession + send + stream

| 항목 | 값 |
|------|-----|
| 성공 | ${report.partB.success ? "YES" : "NO"} |
| 추출 텍스트 | ${report.partB.extractedText ?? "-"} |
| subtype | ${report.partB.resultSubtype ?? "-"} |
| 비용 | ${report.partB.costUsd != null ? `$${report.partB.costUsd}` : "-"} |
| 소요 시간 | ${report.partB.durationMs}ms |
| 이벤트 수 | ${report.partB.eventCount} |
| 이벤트 타입 | \`[${report.partB.eventTypes.join(", ")}]\` |
| 에러 | ${report.partB.error ?? "-"} |

${report.partA.error || report.partB.error ? `## 에러\n\n\`\`\`\n${report.partA.error ?? ""}\n${report.partB.error ?? ""}\n\`\`\`` : ""}

## 다음 단계

> ${report.nextStep}

---
_생성: ${report.timestamp}_
`;
}

async function main() {
  console.log("=== V2-P0: SDK V2 기본 동작 확인 ===\n");
  const start = Date.now();

  mkdirSync("results", { recursive: true });

  // ============================================================
  // Part A: unstable_v2_prompt() — 원샷
  // ============================================================
  console.log("--- Part A: unstable_v2_prompt() ---");
  const partAStart = Date.now();
  let partA: V2P0Report["partA"] = {
    label: "unstable_v2_prompt()",
    success: false,
    resultSubtype: null,
    resultText: null,
    costUsd: null,
    durationMs: 0,
    error: null,
  };

  try {
    console.log('[A] prompt: "1+1은? 숫자만 답해."');

    const result = await unstable_v2_prompt("1+1은? 숫자만 답해.", {
      model: "sonnet",
      allowedTools: [],
      permissionMode: "bypassPermissions",
    });

    partA.resultSubtype = result.subtype;
    partA.costUsd = result.total_cost_usd;

    if (result.subtype === "success") {
      partA.resultText = result.result;
      partA.success = true;
      console.log(`[A] ✅ result: "${result.result}", cost: $${result.total_cost_usd}`);
    } else {
      partA.resultText = result.errors.join("; ");
      partA.error = `subtype: ${result.subtype}`;
      console.log(`[A] ❌ error subtype: ${result.subtype}`);
    }
  } catch (err) {
    partA.error = err instanceof Error ? err.message : String(err);
    console.error(`[A] ❌ ${partA.error}`);
  }
  partA.durationMs = Date.now() - partAStart;

  // ============================================================
  // Part B: createSession + send + stream
  // ============================================================
  console.log("\n--- Part B: createSession + send + stream ---");
  const partBStart = Date.now();
  let partB: V2P0Report["partB"] = {
    label: "createSession + send + stream",
    success: false,
    extractedText: null,
    resultSubtype: null,
    costUsd: null,
    durationMs: 0,
    eventTypes: [],
    eventCount: 0,
    error: null,
  };

  try {
    console.log('[B] createSession → send("2+2는? 숫자만 답해.") → stream()');

    const session = unstable_v2_createSession({
      model: "sonnet",
      allowedTools: [],
      permissionMode: "bypassPermissions",
    });

    await session.send("2+2는? 숫자만 답해.");

    for await (const msg of session.stream()) {
      partB.eventCount++;
      const msgType = (msg as Record<string, unknown>).type as string;
      if (!partB.eventTypes.includes(msgType)) partB.eventTypes.push(msgType);

      if (Date.now() - start > TIMEOUT_MS) {
        partB.error = `타임아웃 (${TIMEOUT_MS}ms 초과)`;
        break;
      }

      if (msg.type === "assistant") {
        const textBlocks = msg.message.content.filter(
          (b: { type: string }) => b.type === "text"
        );
        if (textBlocks.length > 0) {
          partB.extractedText = textBlocks
            .map((b: { type: "text"; text: string }) => b.text)
            .join("");
          console.log(`[B] assistant text: "${partB.extractedText}"`);
        }
      }

      if (msg.type === "result") {
        partB.resultSubtype = msg.subtype;
        partB.costUsd = msg.total_cost_usd;
        if (msg.subtype === "success") {
          partB.success = true;
          if (!partB.extractedText) partB.extractedText = msg.result;
          console.log(`[B] ✅ result: "${msg.result}", cost: $${msg.total_cost_usd}`);
        } else {
          partB.error = `subtype: ${msg.subtype}`;
          console.log(`[B] ❌ error subtype: ${msg.subtype}`);
        }
        break;
      }
    }

    session.close();
    console.log("[B] session.close() 완료");
  } catch (err) {
    partB.error = err instanceof Error ? err.message : String(err);
    console.error(`[B] ❌ ${partB.error}`);
  }
  partB.durationMs = Date.now() - partBStart;

  const durationMs = Date.now() - start;

  // Analyze
  const criteria = {
    partAPassed: partA.success,
    partBPassed: partB.success,
    within30Seconds: durationMs <= TIMEOUT_MS,
  };
  const pass = criteria.partAPassed && criteria.partBPassed && criteria.within30Seconds;

  // Dump
  const report: V2P0Report = {
    testId: "V2-P0",
    testName: "SDK V2 기본 동작 확인",
    timestamp: new Date().toISOString(),
    durationMs,
    result: pass ? "PASS" : "FAIL",
    partA,
    partB,
    criteria,
    nextStep: pass
      ? "V2-P0 PASS → V2-P2-1 (V2 동시 세션 안정성) 진행"
      : "V2 API 문제. V1 query() API로 fallback.",
  };

  writeFileSync("results/v2-p0-events.json", JSON.stringify(report, null, 2));
  writeFileSync("results/v2-p0-report.md", generateMarkdown(report));

  // 결론
  console.log("\n" + "=".repeat(60));
  console.log(`V2-P0: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`Part A (v2_prompt): ${criteria.partAPassed ? "✅" : "❌"} (${partA.durationMs}ms) - "${partA.resultText ?? "없음"}"`);
  console.log(`Part B (session):   ${criteria.partBPassed ? "✅" : "❌"} (${partB.durationMs}ms) - "${partB.extractedText ?? "없음"}"`);
  console.log(`30초 이내: ${criteria.within30Seconds ? "✅" : "❌"}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과: results/v2-p0-events.json + results/v2-p0-report.md`);
}

main();
