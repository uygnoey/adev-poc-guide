# V2-P0: SDK V2 기본 동작 확인 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | V2-P0 |
| 실행 시각 | 2026-03-03T16:45:53.671Z |
| 소요 시간 | 31204ms |
| **최종 결과** | **PASS** |

## 성공 기준 체크

| 기준 | 결과 | 상세 |
|------|------|------|
| Part A (v2_prompt) | PASS | 2 |
| Part B (session) | PASS | 4 |
| 30초 이내 완료 | PASS | 31204ms |

## Part A: unstable_v2_prompt()

| 항목 | 값 |
|------|-----|
| 성공 | YES |
| subtype | success |
| result | 2 |
| 비용 | $0.20051600000000003 |
| 소요 시간 | 23970ms |
| 에러 | - |

## Part B: createSession + send + stream

| 항목 | 값 |
|------|-----|
| 성공 | YES |
| 추출 텍스트 | 4 |
| subtype | success |
| 비용 | $0.20051600000000003 |
| 소요 시간 | 7234ms |
| 이벤트 수 | 4 |
| 이벤트 타입 | `[system, assistant, rate_limit_event, result]` |
| 에러 | - |



## 다음 단계

> V2-P0 PASS → V2-P2-1 (V2 동시 세션 안정성) 진행

---
_생성: 2026-03-03T16:45:53.671Z_
