const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../lib/logger');
const {
  extractGeminiUsage,
  recordAiCall
} = require('../lib/ai-telemetry');

// Model is env-switchable (GEMINI_MODEL) so rollback/swap needs no code deploy.
// gemini-2.5-flash retires 2026-10-16; stable replacement is gemini-3.1-flash-lite
// (thinking_level defaults to 'minimal' — no added cost/latency).
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const API_TIMEOUT_MS = 30_000;
const ANALYSIS_PROMPT_VERSION = process.env.GEMINI_ANALYSIS_PROMPT_VERSION || 'image-analysis-v1';
const SUGGESTIONS_PROMPT_VERSION = process.env.GEMINI_SUGGESTIONS_PROMPT_VERSION || 'image-suggestions-v1';
const PARSE_TELEMETRY = Symbol('parseTelemetry');

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

function attachParseTelemetry(result, telemetry) {
  Object.defineProperty(result, PARSE_TELEMETRY, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ ...telemetry })
  });
  return result;
}

function getParseTelemetry(result) {
  return result?.[PARSE_TELEMETRY] || {
    parseResult: 'not_attempted',
    schemaResult: 'not_evaluated',
    schemaErrorCodes: []
  };
}

function validateAnalysisSchema(jsonData) {
  const errors = [];
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  const isText = value => typeof value === 'string' && value.trim().length > 0;

  if (!isObject(jsonData)) return ['root_not_object'];
  if (!isObject(jsonData.subject) || !isText(jsonData.subject.description)) {
    errors.push('subject_description_missing');
  }
  if (!isObject(jsonData.scene) || !isText(jsonData.scene.location)) {
    errors.push('scene_location_missing');
  }
  if (!isObject(jsonData.composition) || !isText(jsonData.composition.aspect_ratio)) {
    errors.push('aspect_ratio_missing');
  }
  if (!isObject(jsonData.style_modifiers) || !isText(jsonData.style_modifiers.medium)) {
    errors.push('style_medium_missing');
  }
  if (!isObject(jsonData.constraints) || !Array.isArray(jsonData.constraints.must_keep)) {
    errors.push('must_keep_missing');
  }
  if (!isObject(jsonData.constraints) || !Array.isArray(jsonData.constraints.avoid)) {
    errors.push('avoid_missing');
  }

  return errors;
}

function validateSuggestionsSchema(parsed, expectedCount) {
  const entries = parsed?.suggestions;
  if (!Array.isArray(entries)) return ['suggestions_not_array'];

  const seen = new Set();
  const errors = [];
  for (const entry of entries) {
    if (!Number.isInteger(entry?.index) || entry.index < 1 || entry.index > expectedCount) {
      errors.push('suggestion_index_invalid');
      continue;
    }
    if (seen.has(entry.index)) errors.push('suggestion_index_duplicate');
    seen.add(entry.index);
    if (!Array.isArray(entry.items)
      || entry.items.length < 3
      || entry.items.length > 5
      || entry.items.some(item => typeof item !== 'string' || !item.trim())) {
      errors.push('suggestion_items_invalid');
    }
  }
  if (seen.size !== expectedCount) errors.push('suggestion_index_missing');
  return [...new Set(errors)];
}

const SYSTEM_PROMPT = `You are an expert AI image prompt engineer specializing in Nano Banana Pro, Midjourney, and DALL-E.

When given an image, analyze it with extreme precision and generate a HYBRID prompt that combines natural prose with structured JSON.

=== OUTPUT FORMAT ===
Your output must have TWO parts:

PART 1: PROSE DESCRIPTION (3-5 sentences)
A vivid, natural language description of the overall scene, mood, and artistic style. Start with the medium and style, then describe the key visual impact.

PART 2: JSON STRUCTURE
A detailed JSON object with the following structure:

{
  "subject": {
    "type": "person|animal|object|scene",
    "description": "detailed physical description",
    "hair": {"style": "...", "color": "..."},
    "expression": "...",
    "pose": "...",
    "clothing": [
      {"item": "...", "color": "... #HEX", "fabric": "...", "fit": "...", "detail": "..."}
    ],
    "accessories": [
      {"item": "...", "color": "...", "material": "...", "location": "..."}
    ]
  },
  "scene": {
    "location": "...",
    "time": "...",
    "weather": "...",
    "lighting": {
      "type": "...",
      "direction": "...",
      "quality": "..."
    },
    "background_elements": ["...", "..."],
    "key_element": {"description": "any unique/special element in the scene"}
  },
  "technical": {
    "camera_model": "...",
    "lens": "...",
    "aperture": "...",
    "iso": "...",
    "shutter_speed": "..."
  },
  "composition": {
    "framing": "...",
    "angle": "...",
    "focus_point": "...",
    "aspect_ratio": "1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 4:5 | 5:4 | 3:2 | 2:3 | 21:9"
  },
  "style_modifiers": {
    "medium": "photography|3d_render|illustration|...",
    "aesthetic": ["...", "..."],
    "color_palette": "description of dominant colors with hex codes",
    "post_processing": "..."
  },
  "constraints": {
    "must_keep": ["critical element 1", "critical element 2"],
    "avoid": ["thing to avoid 1", "thing to avoid 2"]
  }
}

=== RULES ===
1. Analyze ONLY what is visible. Do NOT invent elements.
2. All colors must include hex codes: "pink #E84887"
3. Read any text exactly as shown (e.g., "Fumla" not "Formula")
4. For the prose part, describe the overall visual impact and mood
5. For the JSON part, be extremely specific and detailed
6. Camera/lens settings should match the apparent depth of field and perspective
7. If the image is not a photograph, adjust technical settings to match the medium (e.g., for illustration, use render_engine instead of camera)
8. Include at least 5 items in must_keep constraints
9. Include at least 3 items in avoid constraints
10. Analyze the image's aspect ratio precisely. If the image is square, use 1:1. If wider than tall, determine the closest standard ratio (16:9, 3:2, 4:3, 21:9). If taller than wide, use the inverse (9:16, 2:3, 3:4). This must be included in the output.`;

/* ── JSON → 포맷팅된 프롬프트 텍스트 + brackets 동시 생성 ── */
function buildFormattedPrompt(prose, jsonData) {
  const MAX_BRACKETS = 30;
  const { subject, scene, technical, composition, style_modifiers, constraints } = jsonData;

  // ── Phase 1: 우선순위별 브라켓 후보 수집 ──
  // 1순위: 색상(HEX), 소재/재질, 오브제/사물, 의상 아이템
  // 2순위: 조명 타입, 카메라, 렌즈, 배경 요소, 헤어
  // 3순위: 구도, 앵글, 포커스, 스타일/미학
  // 제외: CONSTRAINTS, ASPECT RATIO
  const candidates = []; // { value, description, priority }

  function addCandidate(value, description, priority) {
    if (!value || typeof value !== 'string' || !value.trim()) return;
    candidates.push({ value: value.trim(), description, priority });
  }

  // 1순위: 의상 (color+fabric+item 조합), 액세서리 (item+color+material 조합)
  subject?.clothing?.forEach((c, i) => {
    const v = [c.color, c.fabric, c.item].filter(Boolean).join(' ');
    if (v) addCandidate(v, `Clothing ${i + 1}`, 1);
  });
  subject?.accessories?.forEach((a, i) => {
    const v = [a.item, a.color, a.material].filter(Boolean).join(' ');
    if (v) addCandidate(v, `Accessory ${i + 1}`, 1);
  });

  // 2순위: 헤어, 배경, 조명, 카메라, 렌즈
  addCandidate(subject?.hair?.color,           'Hair color',         2);
  addCandidate(subject?.hair?.style,           'Hair style',         2);
  scene?.background_elements?.forEach(el => addCandidate(el, 'Background', 2));
  addCandidate(scene?.lighting?.type,          'Lighting type',      2);
  addCandidate(scene?.lighting?.direction,     'Lighting direction', 2);
  addCandidate(scene?.lighting?.quality,       'Lighting quality',   2);
  addCandidate(technical?.camera_model,        'Camera',             2);
  addCandidate(technical?.lens,                'Lens',               2);
  addCandidate(technical?.aperture,            'Aperture',           2);
  addCandidate(technical?.iso,                 'ISO',                2);

  // 3순위: 주제 묘사, 씬, 구도, 스타일
  addCandidate(subject?.description,                'Subject',       3);
  addCandidate(subject?.expression,                 'Expression',    3);
  addCandidate(subject?.pose,                       'Pose',          3);
  addCandidate(scene?.location,                     'Location',      3);
  addCandidate(scene?.time,                         'Time of day',   3);
  addCandidate(scene?.weather,                      'Weather',       3);
  addCandidate(scene?.key_element?.description,     'Key element',   3);
  addCandidate(composition?.framing,                'Framing',       3);
  addCandidate(composition?.angle,                  'Camera angle',  3);
  addCandidate(composition?.focus_point,            'Focus point',   3);
  addCandidate(style_modifiers?.medium,             'Medium',        3);
  style_modifiers?.aesthetic?.forEach(a => addCandidate(a, 'Aesthetic', 3));
  addCandidate(style_modifiers?.color_palette,      'Color palette', 3);

  // 우선순위 정렬 → 중복 제거 → 상위 MAX_BRACKETS 선택
  candidates.sort((a, b) => a.priority - b.priority);

  const selectedValues = new Set();
  const brackets = [];

  for (const c of candidates) {
    if (brackets.length >= MAX_BRACKETS) break;
    if (selectedValues.has(c.value)) continue;
    selectedValues.add(c.value);
    brackets.push({ original: c.value, description: c.description, suggestions: [] });
  }

  // ── Phase 2: 섹션 출력 순서 유지하며 텍스트 빌드 ──
  // selectedValues에 있는 값만 [bracket], 나머지는 일반 텍스트
  function b(value) {
    if (!value || typeof value !== 'string' || !value.trim()) return value || '';
    const v = value.trim();
    return selectedValues.has(v) ? `[${v}]` : v;
  }

  let text = prose ? prose + '\n\n' : '';

  // SUBJECT
  if (subject) {
    let line = `SUBJECT: ${b(subject.description)}`;
    if (subject.hair?.color || subject.hair?.style) {
      line += ` with ${b(subject.hair.color)} hair styled in ${b(subject.hair.style)}`;
    }
    if (subject.expression) line += `. Expression: ${b(subject.expression)}`;
    if (subject.pose)       line += `. Pose: ${b(subject.pose)}`;
    text += line + '\n\n';

    // CLOTHING & STYLING
    if (subject.clothing?.length) {
      const items = subject.clothing.map(c => {
        const v = [c.color, c.fabric, c.item].filter(Boolean).join(' ');
        return b(v);
      });
      text += `CLOTHING & STYLING: ${items.join(', ')}\n\n`;
    }

    // ACCESSORIES
    if (subject.accessories?.length) {
      const items = subject.accessories.map(a => {
        const v = [a.item, a.color, a.material].filter(Boolean).join(' ');
        return b(v);
      });
      text += `ACCESSORIES: ${items.join(', ')}\n\n`;
    }
  }

  // SCENE
  if (scene) {
    let line = `SCENE: ${b(scene.location)}`;
    if (scene.time)    line += ` at ${b(scene.time)}`;
    if (scene.weather) line += `, ${b(scene.weather)}`;
    if (scene.key_element?.description) line += `. Key element: ${b(scene.key_element.description)}`;
    text += line + '\n\n';

    if (scene.background_elements?.length) {
      const items = scene.background_elements.map(el => b(el));
      text += `BACKGROUND: ${items.join(', ')}\n\n`;
    }

    if (scene.lighting) {
      const parts = [
        scene.lighting.type      && b(scene.lighting.type),
        scene.lighting.direction && b(scene.lighting.direction),
        scene.lighting.quality   && b(scene.lighting.quality),
      ].filter(Boolean);
      text += `LIGHTING: ${parts.join(', ')}\n\n`;
    }
  }

  // TECHNICAL
  if (technical) {
    const parts = [
      technical.camera_model && b(technical.camera_model),
      technical.lens         && b(technical.lens),
      technical.aperture     && b(technical.aperture),
      technical.iso          && `ISO ${b(technical.iso)}`,
    ].filter(Boolean);
    text += `TECHNICAL: ${parts.join(', ')}\n\n`;
  }

  // COMPOSITION
  if (composition) {
    const parts = [
      composition.framing     && b(composition.framing),
      composition.angle       && b(composition.angle),
      composition.focus_point && `focus on ${b(composition.focus_point)}`,
    ].filter(Boolean);
    text += `COMPOSITION: ${parts.join(', ')}\n\n`;
  }

  // STYLE
  if (style_modifiers) {
    const parts = [
      style_modifiers.medium        && b(style_modifiers.medium),
      ...(style_modifiers.aesthetic || []).map(a => b(a)),
      style_modifiers.color_palette && b(style_modifiers.color_palette),
    ].filter(Boolean);
    text += `STYLE: ${parts.join(', ')}\n\n`;
  }

  // ASPECT RATIO — 브라켓 없이 일반 텍스트
  if (composition?.aspect_ratio) {
    text += `ASPECT RATIO: ${composition.aspect_ratio}\n\n`;
  }

  // CONSTRAINTS — 브라켓 없이 일반 텍스트
  if (constraints) {
    if (constraints.must_keep?.length) {
      text += `CONSTRAINTS - Must keep: ${constraints.must_keep.join(', ')}\n`;
    }
    if (constraints.avoid?.length) {
      text += `CONSTRAINTS - Avoid: ${constraints.avoid.join(', ')}\n`;
    }
  }

  return { formattedPrompt: text.trim(), brackets };
}

/* ── JSON → analysis 객체 변환 ── */
function buildAnalysis(jsonData) {
  const { composition, scene, style_modifiers } = jsonData;

  const lightingStr = scene?.lighting
    ? [scene.lighting.type, scene.lighting.direction, scene.lighting.quality].filter(Boolean).join(', ')
    : '';

  return {
    composition:  composition?.framing || '',
    lighting:     lightingStr,
    mood:         (style_modifiers?.aesthetic || []).join(', '),
    layers:       scene?.location || '',
    style:        style_modifiers?.medium || '',
    technique:    style_modifiers?.post_processing || '',
    aspectRatio:  composition?.aspect_ratio || '',
  };
}

/* ── 응답 파싱: prose + JSON 분리 → 포맷팅된 프롬프트 생성 ── */
function parseHybridResponse(content) {
  const text = content.trim();
  if (!text) throw new Error('Empty response from Gemini');

  let jsonData = null;
  let jsonBlockStart = text.length;
  let jsonCandidateFound = false;

  // 1) ```json ... ``` 코드블록에서 JSON 우선 추출
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    jsonCandidateFound = true;
    try {
      jsonData = JSON.parse(codeBlockMatch[1].trim());
      jsonBlockStart = text.indexOf(codeBlockMatch[0]);
    } catch { /* 파싱 실패 시 raw 시도 */ }
  }

  // 2) 코드블록 없으면 raw { ... } 추출
  if (!jsonData) {
    const rawMatch = text.match(/\{[\s\S]*\}/);
    if (rawMatch) {
      jsonCandidateFound = true;
      try {
        jsonData = JSON.parse(rawMatch[0]);
        jsonBlockStart = text.indexOf(rawMatch[0]);
      } catch { /* 파싱 실패 */ }
    }
  }

  // 3) prose = JSON 블록 이전 텍스트에서 헤더/마크다운 잔재 제거
  const prose = text.slice(0, jsonBlockStart)
    .replace(/^PART\s+\d+\s*:\s*.+$/gim, '')  // "PART 1: PROSE DESCRIPTION" 등 제거
    .replace(/```json\s*/gi, '')               // 잔여 ```json 제거
    .replace(/```\s*/g, '')                    // 잔여 ``` 제거
    .replace(/\n{3,}/g, '\n\n')               // 연속 빈 줄 정리
    .trim();

  if (!jsonData) {
    return attachParseTelemetry(
      { prompt: prose, brackets: [], analysis: {} },
      {
        parseResult: jsonCandidateFound ? 'failed' : 'missing',
        schemaResult: 'degraded',
        schemaErrorCodes: [jsonCandidateFound ? 'json_invalid' : 'json_missing']
      }
    );
  }

  // 4) JSON 값들을 [bracket]으로 감싼 포맷팅된 텍스트 + brackets 배열 동시 생성
  const { formattedPrompt, brackets } = buildFormattedPrompt(prose, jsonData);
  const analysis = buildAnalysis(jsonData);
  const schemaErrorCodes = validateAnalysisSchema(jsonData);

  return attachParseTelemetry(
    { prompt: formattedPrompt, brackets, analysis },
    {
      parseResult: 'passed',
      schemaResult: schemaErrorCodes.length === 0 ? 'passed' : 'degraded',
      schemaErrorCodes
    }
  );
}

/* ── 대안 제안 생성 (Gemini) ── */
async function generateSuggestions(brackets) {
  if (brackets.length === 0) return brackets;

  const BATCH_LIMIT = 30;
  const activeBrackets = brackets.slice(0, BATCH_LIMIT);
  const startedAt = Date.now();

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.8, maxOutputTokens: 12000 },
  });

  const bracketList = activeBrackets
    .map((b, i) => `${i + 1}. [${b.original}]`)
    .join('\n');

  const suggestionPrompt = `For each bracketed element below, generate 3–5 alternative replacement values that could substitute it in an AI image prompt.

Rules:
- For COLOR elements (containing hex codes like #XXXXXX): suggest different specific colors WITH their hex codes (e.g., "crimson red #DC143C", "ocean blue #0077BE")
- For CLOTHING items: suggest alternative garments in the same category (e.g., for [cropped hoodie] → "leather jacket", "oversized t-shirt", "denim vest")
- For SUBJECT/PERSON: suggest alternative character descriptions (different ethnicity, age, style)
- For BACKGROUND/SETTING: suggest alternative environments or locations
- For OBJECTS/PROPS: suggest alternative objects or products
- For VISIBLE TEXT/LOGOS: suggest alternative brand names or text
- Keep each suggestion concise (similar length/format to the original)
- Do NOT repeat the original in the suggestions

Return ONLY valid JSON — no explanation, no markdown, just the raw JSON object:
{
  "suggestions": [
    { "index": 1, "items": ["alt1", "alt2", "alt3"] },
    { "index": 2, "items": ["alt1", "alt2", "alt3"] }
  ]
}

Elements:
${bracketList}`;

  try {
    const result  = await model.generateContent(suggestionPrompt);
    const content = result.response.text();
    const usage = extractGeminiUsage(result.response.usageMetadata);
    if (!content) {
      recordAiCall({
        outcome: 'completed',
        provider: 'google',
        operation: 'image.suggestions',
        model: MODEL,
        promptVersion: SUGGESTIONS_PROMPT_VERSION,
        startedAt,
        parseResult: 'missing',
        schemaResult: 'degraded',
        usage
      });
      return brackets;
    }

    // ```json 코드블록 우선 추출, 없으면 raw { } 추출
    let jsonStr = content;
    const codeBlock = content.match(/```json\s*([\s\S]*?)```/i);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      recordAiCall({
        outcome: 'completed',
        provider: 'google',
        operation: 'image.suggestions',
        model: MODEL,
        promptVersion: SUGGESTIONS_PROMPT_VERSION,
        startedAt,
        parseResult: 'missing',
        schemaResult: 'degraded',
        usage
      });
      return brackets;
    }

    // JSON 파싱 — 실패 시 잘린 JSON 복구 시도
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      let fixed = jsonMatch[0];
      const openBrackets  = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;
      const openBraces    = (fixed.match(/\{/g) || []).length;
      const closeBraces   = (fixed.match(/\}/g) || []).length;
      fixed += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
      fixed += '}'.repeat(Math.max(0, openBraces   - closeBraces));
      try {
        parsed = JSON.parse(fixed);
      } catch {
        recordAiCall({
          outcome: 'completed',
          provider: 'google',
          operation: 'image.suggestions',
          model: MODEL,
          promptVersion: SUGGESTIONS_PROMPT_VERSION,
          startedAt,
          parseResult: 'failed',
          schemaResult: 'degraded',
          usage
        });
        return brackets;
      }
    }

    const schemaErrorCodes = validateSuggestionsSchema(parsed, activeBrackets.length);
    const suggMap = {};
    const suggestionEntries = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    suggestionEntries.forEach(s => {
      if (!Number.isInteger(s?.index) || !Array.isArray(s?.items)) return;
      suggMap[s.index] = s.items
        .filter(item => typeof item === 'string' && item.trim())
        .slice(0, 5);
    });

    const withSuggestions = activeBrackets.map((b, i) => ({ ...b, suggestions: suggMap[i + 1] || [] }));
    recordAiCall({
      outcome: 'completed',
      provider: 'google',
      operation: 'image.suggestions',
      model: MODEL,
      promptVersion: SUGGESTIONS_PROMPT_VERSION,
      startedAt,
      parseResult: 'passed',
      schemaResult: schemaErrorCodes.length === 0 ? 'passed' : 'degraded',
      usage
    });
    return withSuggestions;
  } catch (err) {
    recordAiCall({
      outcome: 'failed',
      provider: 'google',
      operation: 'image.suggestions',
      model: MODEL,
      promptVersion: SUGGESTIONS_PROMPT_VERSION,
      startedAt,
      parseResult: 'not_attempted',
      schemaResult: 'not_evaluated',
      errorCode: err?.code || err?.name,
      errorStatus: err?.status || err?.statusCode
    });
    logger.warn('image.suggestions.degraded', {
      provider: 'google',
      model: MODEL,
      promptVersion: SUGGESTIONS_PROMPT_VERSION,
      bracketCount: activeBrackets.length,
      errorCode: err?.code || err?.name
    });
    return brackets;
  }
}

/* ── 이미지 분석 (메인 함수) ── */
async function analyzeImage(base64Image, mimeType) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: { temperature: 0.3, maxOutputTokens: 16000 },
  });

  let lastError;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const attemptNumber = attempt + 1;
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        model.generateContent([
          { inlineData: { mimeType, data: base64Image } },
          'Analyze this image and generate the hybrid prompt.',
        ]),
        API_TIMEOUT_MS,
        'Gemini analyzeImage'
      );

      const content = result.response.text();
      if (!content) throw new Error('Empty response from Gemini');

      const parsed = parseHybridResponse(content);
      const parseTelemetry = getParseTelemetry(parsed);
      recordAiCall({
        outcome: 'completed',
        provider: 'google',
        operation: 'image.analysis',
        model: MODEL,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        attempt: attemptNumber,
        maxAttempts: MAX_ATTEMPTS,
        startedAt,
        parseResult: parseTelemetry.parseResult,
        schemaResult: parseTelemetry.schemaResult,
        usage: extractGeminiUsage(result.response.usageMetadata)
      });
      if (parseTelemetry.schemaResult === 'degraded') {
        logger.warn('image.analysis.schema_degraded', {
          provider: 'google',
          model: MODEL,
          promptVersion: ANALYSIS_PROMPT_VERSION,
          schemaErrorCodes: parseTelemetry.schemaErrorCodes
        });
      }
      parsed.brackets = await generateSuggestions(parsed.brackets);
      return parsed;
    } catch (err) {
      const status = err.status || err.statusCode;
      const retryScheduled = attempt < MAX_ATTEMPTS - 1 && (status === 429 || status === 503);
      recordAiCall({
        outcome: 'failed',
        provider: 'google',
        operation: 'image.analysis',
        model: MODEL,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        attempt: attemptNumber,
        maxAttempts: MAX_ATTEMPTS,
        startedAt,
        retryScheduled,
        parseResult: 'not_attempted',
        schemaResult: 'not_evaluated',
        errorCode: err?.code || err?.name,
        errorStatus: status
      });
      if (retryScheduled) {
        lastError = err;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Gemini API failed after retries');
}

module.exports = {
  analyzeImage,
  parseHybridResponse,
  buildFormattedPrompt,
  buildAnalysis,
  validateAnalysisSchema,
  validateSuggestionsSchema,
  getParseTelemetry
};
