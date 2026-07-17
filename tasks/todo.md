# Archived Task: Groq → Gemini 전환 + 하이브리드 프롬프트

> Superseded on 2026-07-17. The live Image to Prompt route uses
> `services/geminiService.js` with the configurable `GEMINI_MODEL` default
> `gemini-3.1-flash-lite`. The unused Groq service, SDK, key, tests, and privacy
> claim were removed after a repository-wide import audit found no runtime
> caller. This file is retained only as migration history.

## 목표
groqService.js를 geminiService.js로 교체. 시스템 프롬프트를 Prose+JSON 하이브리드 방식으로 변경.

## 수락 기준
- `@google/generative-ai` 설치 완료
- `services/geminiService.js` 생성 (analyzeImage, parseHybridResponse, generateSuggestions)
- `routes/analyze.js`가 geminiService를 참조
- 미사용 Groq 서비스·SDK·키·테스트 제거
- 기존 app.js와의 brackets 배열 호환성 유지

## 체크리스트
- [x] tasks/todo.md 작성
- [x] @google/generative-ai 설치
- [x] services/geminiService.js 생성
- [x] routes/analyze.js 수정 (groqService → geminiService)
- [x] 미사용 Groq 서비스·SDK·키·테스트 제거
- [x] diff 확인

## Working Notes
- Gemini 모델 기본값: gemini-3.1-flash-lite (`GEMINI_MODEL`로 교체 가능)
- analyzeImage 재시도: 최대 2회 (3회 시도)
- generateSuggestions temperature: 0.8
- parseHybridResponse: prose + JSON 분리, JSON 값에서 brackets 추출
- analysis: JSON 구조에서 mapping (composition, lighting, mood, layers, style, technique)
- brackets format 호환: { original, description, suggestions }
