# Task: Groq → Gemini 2.5 Flash 전환 + 하이브리드 프롬프트

## 목표
groqService.js를 geminiService.js로 교체. 시스템 프롬프트를 Prose+JSON 하이브리드 방식으로 변경.

## 수락 기준
- `@google/generative-ai` 설치 완료
- `services/geminiService.js` 생성 (analyzeImage, parseHybridResponse, generateSuggestions)
- `routes/analyze.js`가 geminiService를 참조
- `groqService.js` → `groqService.js.backup` 이름 변경
- 기존 app.js와의 brackets 배열 호환성 유지

## 체크리스트
- [x] tasks/todo.md 작성
- [x] @google/generative-ai 설치
- [x] services/geminiService.js 생성
- [x] routes/analyze.js 수정 (groqService → geminiService)
- [x] groqService.js → groqService.js.backup 이름 변경
- [x] diff 확인

## Working Notes
- Gemini 모델명: gemini-2.5-flash-preview-05-20 (사용자 지정)
- analyzeImage 재시도: 최대 2회 (3회 시도)
- generateSuggestions temperature: 0.8
- parseHybridResponse: prose + JSON 분리, JSON 값에서 brackets 추출
- analysis: JSON 구조에서 mapping (composition, lighting, mood, layers, style, technique)
- brackets format 호환: { original, description, suggestions }
