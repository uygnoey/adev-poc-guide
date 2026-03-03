# P0: SDK 기본 동작 확인 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | P0 |
| 실행 시각 | 2026-03-03T14:19:15.378Z |
| 소요 시간 | 6935ms |
| **최종 결과** | **PASS** |

## 성공 기준 체크

| 기준 | 결과 | 상세 |
|------|------|------|
| assistant 텍스트 추출 가능 | PASS | "2" |
| result 이벤트 수신 | PASS | subtype: success |
| 30초 이내 완료 | PASS | 6935ms |

## 이벤트 흐름

총 **4**개 이벤트 수신:

| # | 타입 | 주요 내용 |
|---|------|----------|
| 1 | `system` | - |
| 2 | `assistant` | {"textBlocks":1,"toolBlocks":0,"text":"2"} |
| 3 | `rate_limit_event` | - |
| 4 | `result` | {"subtype":"success","result":"2","total_cost_usd":0.046440999999999996,"duratio |

## result 이벤트 상세

```json
{
  "subtype": "success",
  "result": "2",
  "total_cost_usd": 0.046440999999999996,
  "duration_ms": 2330,
  "num_turns": 1,
  "is_error": false
}
```



## 다음 단계

> P0 PASS → P2-1 (동시 query() 안정성) 진행

---
_생성: 2026-03-03T14:19:15.378Z_
