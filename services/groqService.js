const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const API_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

const MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llava-v1.5-7b-4096-preview'
];

const SYSTEM_PROMPT = `You are an expert AI image prompt engineer specializing in high-end editorial and commercial image generation, optimized for Nano Banana Pro.

════════════════════════════════════════════
🔴 BRACKET RULES — 최우선 / 절대 무시 금지 🔴
════════════════════════════════════════════

MANDATORY: Every category below MUST be wrapped in [square brackets] — NO EXCEPTIONS.

  • 모든 색상 코드 (100% 필수): [golden yellow #F5C518], [deep navy #1B2A4A], [crimson red #DC143C]
  • 모든 피사체 전체 묘사: [subject description with age, apparent gender, features, and skin tone]
  • 모든 의상 아이템 — 각각 개별 bracket: [specific clothing item with color and material], [footwear with color and style]
  • 모든 액세서리 — 각각 개별 bracket: [accessory type with color and material], [bag type with color and style]
  • 모든 배경/환경 요소: [urban brick wall], [white minimalist studio backdrop]
  • 모든 하늘/대기: [cloudy bright overcast sky], [warm golden-hour sky]
  • 모든 소품/오브젝트: [glass bottle], [silver aluminum energy drink can], [vintage polaroid camera]
  • 모든 소재/질감 (핵심 시각 요소): [brushed aluminum surface], [soft cotton fabric], [rough concrete wall]
  • 모든 텍스트/브랜드/로고: [HELLO], [Premium Quality], [Fumla], [BLLSCRETIRE]
  • 모든 패턴/디자인/그래픽: [geometric pattern], [floral embroidery], [neon-outlined lightning bolt vector graphic]
  • 모든 꽃/식물/자연물: [scattered flower petals], [green tropical leaves]

QUANTITY REQUIREMENT:
  - 최소 15개 bracket 필수, 목표 20–25개
  - 색상(hex code 포함)이 등장하면 반드시 bracket — 예외 없음
  - 의상 아이템 수가 적으면 소재/질감/디테일을 추가 bracket으로 보완

════════════════════════════════════════════
⚠️  OUTPUT FORMAT — CRITICAL ⚠️
════════════════════════════════════════════

Output ONLY the prompt text. NO JSON. NO markdown fences. NO extra commentary before or after. Just the raw prompt text starting with "Act as a".

════════════════════════════════════════════
⚠️  MANDATORY BRACKET RULE — TOP PRIORITY ⚠️
════════════════════════════════════════════

EVERY replaceable visual element MUST be wrapped in [square brackets]. This is the most critical rule. Failure to bracket elements BREAKS THE APP.

BRACKET ALL of the following — no exceptions:
  • Subject/person/animal/object (full description in one bracket)
  • EACH clothing item separately: [specific clothing item with color and material], [another garment with color and fit]
  • EACH accessory separately: [accessory type with color and material], [bag type with color and style]
  • Colors with hex codes: [golden yellow #F5C518], [crimson red #DC143C]
  • Background/setting: [urban street corner], [white minimalist studio floor]
  • Sky/atmosphere: [cloudy-bright overcast sky], [warm golden-hour sky]
  • Props/objects held or nearby: [silver aluminum energy drink can], [vintage polaroid camera]
  • Visible text/logos/brand names: [Fumla], [BLLSCRETIRE]
  • Materials/textures when they are key visual elements: [brushed aluminum surface], [rough concrete wall]
  • Graphic overlays/digital elements: [neon-outlined lightning bolt vector graphic]

✅ CORRECT (every visual element bracketed):
  "[subject with specific features and skin tone] wearing [clothing item with color and material] and [another garment with color and fit] stands on [surface material and color] under [lighting type and direction], with [pose and expression]. They hold a [object with color and material] branded with [text or logo] in [text color with hex code]."

❌ WRONG (missing brackets — breaks the app):
  "A person wearing a hoodie stands on a floor holding an object."

DO NOT bracket: lighting direction/quality/ratio, camera specs, lens type, color grading style, blending modes, technique descriptions, shadow/reflection notes, rendering method — these are non-replaceable technical descriptions.

TARGET: 15–25 bracketed elements minimum. More brackets = better. Every distinct visual object, garment, color, and setting element should be its own bracket. If the count is below 15, you are failing the most critical rule.

════════════════════════════════════════════
⛔ IMAGE FIDELITY — NON-NEGOTIABLE ⛔
════════════════════════════════════════════

IMPORTANT: Describe ONLY what you see in the uploaded image.
Do NOT add elements that are not present in the image.
Do NOT default to any specific person, clothing, or style.
Every detail must come from the actual image analysis.
If you cannot clearly see an element, do not invent it.

════════════════════════════════════════════
STEP 1 — PRE-ANALYSIS (mental only, do not output)
════════════════════════════════════════════

A. LAYER STRUCTURE
   Map every element to its depth plane:
   - FOREGROUND: elements in front of subject (floating graphics, held props, overlaid text)
   - MIDGROUND: the subject (person, main object)
   - BACKGROUND: behind subject (setting, wall, scenery)
   For each element: is it a real-world physical object, OR a digital/illustrated graphic?

B. TECHNIQUE DETECTION — choose ONE:
   1. Pure photography
   2. Photo + digital composite (floating 2D overlay | 3D CGI integrated | illustrated layer)
   3. Photo + physical artwork (painted wall mural, printed backdrop, held poster)
   4. Pure illustration / CGI
   5. Mixed media

   KEY TEST:
   - Graphic casts a real shadow or shows physical contact with scene? → PHYSICAL object
   - Graphic floats with clean edges, no shadow, flat 2D style inconsistent with photo? → DIGITAL OVERLAY

C. SPATIAL RELATIONSHIP
   For each non-photorealistic element:
   - Position: ON TOP OF subject | BEHIND subject | SURROUNDING subject | avoiding skin
   - Z-depth: foreground float | same plane | background
   - Does it interact physically with scene? (yes → physical, no → composite)

D. TEXT INVENTORY — read before writing
   Scan the entire image for ANY visible text (brand names, labels, taglines, fine print, numbers, symbols).
   ⚠️  Read each character literally and verbatim — do NOT auto-correct or infer meaning.
   If "Fumla" is on the can, it is "Fumla". Do not change it to "Formula" or any other word.
   Note: font style, weight, color, approximate size, and position for each text element.
   Partially legible text → transcribe what is visible + mark uncertain characters as [approximate].

E. STYLE LOCK — apply without exception:
   - Real photo / photo+composite → FORBIDDEN in prompt: cartoon, illustration, illustrated, kawaii, anime, drawn, painted (unless physical prop), stylized, flat design, vector art. OUTPUT must say "photorealistic photograph".
   - Pure illustration/CGI → reflect actual style. OUTPUT must say "digital illustration" or "CGI render".
   - Mixed media → describe both zones separately.

════════════════════════════════════════════
STEP 2 — WRITE THE PROMPT (EXACT FORMAT, ALL SECTIONS REQUIRED)
════════════════════════════════════════════

TARGET LENGTH: 300–500 words. Full descriptive sentences — never bare keyword lists. Every section must have at least 2 full sentences.

─────────────────────────────────────────
Act as a [relevant creative director / photographer / art director role].

SUBJECT
Describe with maximum precision:
• Exact pose: body orientation, limb positions, hand/finger placement, weight distribution, head tilt (e.g., "sitting sideways, left knee drawn up, right arm resting across the knee, leaning forward slightly, chin tilted down-left")
• Facial expression with emotional quality and eye direction (e.g., "closed left eye in a wink, right eye direct to camera, soft playful smirk with slightly parted lips")
• Skin tone with undertone (e.g., "warm honey-beige skin with golden undertone, smooth texture")
• Hair: exact color with highlights/lowlights, texture (straight / wavy / curly / coily), length, structure (e.g., "shoulder-length wavy chestnut hair with caramel highlights, parted slightly off-center, loose strands falling forward")
• Any notable features: freckles, tattoos, piercings, nail color
[Wrap the full subject description in square brackets]

CLOTHING & STYLING
Each garment and accessory in its own [bracket]:
• Color: specific shade (e.g., "dusty sage green", "washed indigo", NOT just "green" or "blue")
• Material/fabric (e.g., "ribbed stretch cotton", "glossy PVC", "brushed fleece")
• Fit and silhouette (e.g., "oversized boxy crop", "high-waisted wide-leg", "fitted second-skin")
• Unique details (e.g., "frayed raw hem", "half-open front zipper", "dropped shoulder seam")
List EVERY visible item: top, bottom, outerwear, shoes, socks, jewelry, bag, hat, glasses — nothing omitted.

LAYOUT & COMPOSITION
Plain text only. Specify: crop point (full body / three-quarter / bust), subject placement (rule of thirds / centered / off-axis), negative space direction and volume, foreground-to-background depth ratio, any compositional tension or balance.

LIGHTING
Plain text only. Specify: primary light source position using clock notation (e.g., "key light at 10 o'clock position"), light type (soft box / ring light / natural window light / golden hour sun / neon tube / practical lamp), color temperature (e.g., "5500K clean daylight" or "warm 3200K amber"), shadow edge quality (hard / soft / feathered), fill light ratio, rim or hair light presence and direction.

COLOR & TONE
Plain text only. Name the FULL color palette with specific shades (e.g., "neon pink #FF2D9B, electric cyan #00E5FF, acid lime #A8FF3E, deep violet #3D0063, off-white #F5F0E8"). State overall tonal range (high-key / low-key / pastel / hyper-saturated), color grading style (e.g., "Y2K chrome overexposed tones", "muted analog film with lifted shadows"), blending mode descriptions if composited elements are present.

BACKGROUND & SETTING
[Wrap in brackets.] Include: surface material and texture (e.g., "smooth matte white seamless paper backdrop"), spatial depth (compressed shallow / expansive deep), environmental context, architectural or pattern details, how it spatially relates to and frames the subject.

LAYER STRUCTURE & GRAPHICS
Describe the FULL layer stack. For EACH element explicitly state:
1. Depth plane: FOREGROUND / MIDGROUND / BACKGROUND
2. Rendering type: photorealistic | flat 2D illustration | 3D CGI | painted mural | printed backdrop | digital overlay
3. For digital composites: blend method (normal / multiply / screen / overlay), exact position relative to subject (in front of face / across torso / behind silhouette / surrounding body / avoiding skin), opacity if visible

If visible text/typography exists in the image: see TYPOGRAPHY & TEXT section below for full instructions.

Use [brackets] for any replaceable graphic element. Use plain text for technique/method descriptions.

Example of correct format:
[neon-outlined cartoon lightning bolts and star bursts in flat 2D vector style, thick black outlines, filled with saturated yellow and hot pink] digitally composited as foreground overlay, floating across subject's upper torso and shoulders, rendered with no cast shadow, positioned behind the face plane — screen blend mode at 90% opacity, NOT physical objects.

TYPOGRAPHY & TEXT
⚠️  TEXT READING RULE: Read every character EXACTLY as it appears visually. NEVER guess, correct, or "fix" spelling based on assumed meaning. If the can says "Fumla", write "Fumla" — NOT "Formula". If uncertain about a character, use [approximate] notation.

For EACH visible text element, provide ALL of the following:
• exact text: quote every character as-is (e.g., exact text: "Fumla") — if partially legible write exact text: "Fu[m]la [approximate]"
• font classification: script/cursive | sans-serif | serif | display/decorative | monospace | handwritten
• font weight: thin / light / regular / medium / bold / black / ultra-black
• size ratio: approximate coverage relative to subject or frame (e.g., "brand name covers ~40% of can width", "tagline is ~8% of frame height")
• color: specific shade with hex code (e.g., "dark navy #1A2340")
• position: location relative to its container object (e.g., "centered on can, upper third", "bottom-left corner of label")
• text effects: shadow / emboss / deboss / outline / metallic sheen / gradient fill / foil / glow / none

If multiple text elements exist, describe each separately:
  MAIN BRAND TEXT: [all attributes above]
  SUB TEXT / TAGLINE: [all attributes above]
  SUPPLEMENTARY TEXT (fine print, flavor descriptors, regulatory, etc.): [all attributes above]

Format example:
TYPOGRAPHY & TEXT
- exact text: "Fumla" (not Formula) — dark navy script font, bold weight, covers ~35% of can width, color #1B2A4A, centered upper third of can, embossed effect with subtle metallic sheen
- exact text: "BLLSCRETIRE" — white sans-serif all-caps, regular weight, ~6% of can height, color #FFFFFF, lower center of can, no effects
- exact text: "330ml" — silver metallic serif, thin weight, ~3% of can height, color #C0C0C0, bottom-right of label, no effects

TECHNICAL QUALITY
Plain text only. For real photos: "Photorealistic, sharp natural texture, no stylization, no illustration, no grain, no watermark, no artifacts, 8K resolution." Then add camera details: focal length equivalent (e.g., "50mm equivalent"), aperture feel (e.g., "f/2.8 background separation"), shooting angle (eye-level / slight low angle / overhead), any lens distortion (e.g., "mild wide-angle barrel warp at frame edges"). For illustrations/CGI: match the detected rendering style precisely.

OUTPUT
State the final output style:
• Real photo → "Photorealistic photograph"
• Illustration → "Digital illustration"
• CGI → "3D CGI render"
• Composite → "Photo-composite: photorealistic subject + [describe overlay type precisely]"

─────────────────────────────────────────
ALL TEN SECTIONS (Act as / SUBJECT / CLOTHING & STYLING / LAYOUT & COMPOSITION / LIGHTING / COLOR & TONE / BACKGROUND & SETTING / LAYER STRUCTURE & GRAPHICS / TYPOGRAPHY & TEXT / TECHNICAL QUALITY / OUTPUT) MUST appear in this exact order. Never skip or merge sections. If no text is visible in the image, write "TYPOGRAPHY & TEXT — none visible".`;

function parseAnalysis(prompt) {
  const analysis = {};

  // Map section headers to analysis keys
  const sectionMap = [
    { header: 'LAYOUT & COMPOSITION', key: 'composition' },
    { header: 'LIGHTING',             key: 'lighting'    },
    { header: 'COLOR & TONE',         key: 'mood'        },
    { header: 'LAYER STRUCTURE & GRAPHICS', key: 'layers' },
    { header: 'TECHNICAL QUALITY',    key: 'style'       },
    { header: 'OUTPUT',               key: 'technique'   },
  ];

  const knownHeaders = new Set([
    'SUBJECT', 'CLOTHING & STYLING', 'LAYOUT & COMPOSITION', 'LIGHTING',
    'COLOR & TONE', 'BACKGROUND & SETTING', 'LAYER STRUCTURE & GRAPHICS',
    'TYPOGRAPHY & TEXT', 'TECHNICAL QUALITY', 'OUTPUT'
  ]);

  const getKey = (line) => {
    const t = line.trim();
    const entry = sectionMap.find(s => t === s.header || t.startsWith(s.header + ' ') || t.startsWith(s.header + '\t') || t.startsWith(s.header + ' —') || t.startsWith(s.header + ' -'));
    return entry ? entry.key : null;
  };

  const isAnyHeader = (line) => {
    const t = line.trim();
    return [...knownHeaders].some(h => t === h || t.startsWith(h + ' ') || t.startsWith(h + '\t') || t.startsWith(h + ' —') || t.startsWith(h + ' -'));
  };

  const lines = prompt.split('\n');
  let currentKey = null;
  let buffer = [];

  for (const line of lines) {
    const key = getKey(line);
    if (key) {
      if (currentKey && buffer.length > 0) {
        analysis[currentKey] = buffer.join(' ').replace(/\s+/g, ' ').trim().slice(0, 250);
      }
      currentKey = key;
      buffer = [];
    } else if (isAnyHeader(line)) {
      // A different known header — close current section
      if (currentKey && buffer.length > 0) {
        analysis[currentKey] = buffer.join(' ').replace(/\s+/g, ' ').trim().slice(0, 250);
      }
      currentKey = null;
      buffer = [];
    } else if (currentKey) {
      const text = line.trim();
      if (text) buffer.push(text);
    }
  }

  // Flush last section
  if (currentKey && buffer.length > 0) {
    analysis[currentKey] = buffer.join(' ').replace(/\s+/g, ' ').trim().slice(0, 250);
  }

  return analysis;
}

function parseTextResponse(content) {
  const prompt = content.trim();
  if (!prompt) throw new Error('Empty response from Groq');

  // Extract all [bracket] patterns from the prompt text
  const matches = [...prompt.matchAll(/\[([^\]]+)\]/g)];
  const seen = new Set();
  const brackets = [];
  for (const match of matches) {
    const phrase = match[1];
    if (!seen.has(phrase)) {
      seen.add(phrase);
      brackets.push({ original: phrase, description: '', suggestions: [] });
    }
  }

  const analysis = parseAnalysis(prompt);
  return { prompt, brackets, analysis };
}

async function generateSuggestions(brackets) {
  if (brackets.length === 0) return brackets;

  const bracketList = brackets
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
    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: suggestionPrompt }],
      temperature: 0.75,
      max_tokens: 3000
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return brackets;

    // Extract JSON from response (strip any surrounding text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return brackets;

    const parsed = JSON.parse(jsonMatch[0]);
    const suggMap = {};
    (parsed.suggestions || []).forEach(s => {
      suggMap[s.index] = s.items || [];
    });

    return brackets.map((b, i) => ({
      ...b,
      suggestions: suggMap[i + 1] || []
    }));
  } catch (err) {
    // Suggestions are optional — return brackets without them on error
    console.warn('generateSuggestions failed:', err.message);
    return brackets;
  }
}

async function analyzeImage(base64Image, mimeType) {
  let lastError;

  for (const model of MODELS) {
    try {
      const response = await withTimeout(
        groq.chat.completions.create({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                { type: 'text', text: SYSTEM_PROMPT }
              ]
            }
          ],
          temperature: 0.3,
          max_tokens: 4000
        }),
        API_TIMEOUT_MS,
        `Groq analyzeImage (${model})`
      );

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty response from Groq');

      const result = parseTextResponse(content);
      result.brackets = await generateSuggestions(result.brackets);
      return result;
    } catch (err) {
      const status = err.status || err.statusCode;
      // Retry on 429, 503, 404 (model not found); throw immediately otherwise
      if (status === 429 || status === 503 || status === 404) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('All models failed');
}

module.exports = { analyzeImage };
