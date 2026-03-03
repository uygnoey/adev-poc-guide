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

## 핵심 발견

- **SDK `query()`**: 동시 5개까지 안정적으로 동작, 크로스 오염 없음
- **Agent Teams**: 전체 라이프사이클(생성→메시지→삭제) 동작 확인. teammate 종료 처리에 주의 필요
- **Hooks**: subagent 내부 도구 호출까지 감지 가능 → stream-monitor의 핵심 메커니즘으로 채택
- **디스크 IPC**: `~/.claude/teams/` + `~/.claude/tasks/` 경로 확정, inbox는 JSON Array 형식

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
