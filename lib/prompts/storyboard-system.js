'use strict';

const STYLE_TEMPLATES = require('./style-templates');

const NARRATIVE_ARC_9 = [
  'Setup — Establish the world and protagonist',
  'Introduction — Introduce key relationships',
  'Tension — Build conflict or desire',
  'Event — An inciting or complicating event',
  'Peak — Emotional or physical peak',
  'Turn — A reversal or revelation',
  'Climax — The decisive confrontation',
  'Aftermath — Immediate consequences',
  'Ending — Resolution and closing image'
];

const NARRATIVE_ARC_4 = [
  'Setup — Establish world and character',
  'Tension — Rising conflict',
  'Climax — The decisive moment',
  'Ending — Resolution'
];

const CAMERA_ANGLE_POOL = [
  'ELS', 'LS', 'WS', 'MLS', 'MS', 'MCU', 'CU', 'ECU',
  'High Angle', 'Low Angle', "Bird's Eye", "Worm's Eye", 'Eye Level', 'Dutch Angle',
  'Static', 'Dolly', 'Tracking', 'Pan', 'Tilt', 'Handheld', 'Crane',
  'OTS', 'Two Shot', 'Three Shot', 'POV', 'Profile', 'Frame-in-Frame'
];

// Seedance 2.0 videos are capped at 15 seconds total. Per-shot durations must
// sum to ≤15s, so the even split is ~1.5s/shot for 9 cuts and ~3.5s/shot for 4.
const MAX_TOTAL_SECONDS = 15;

function buildSystemPrompt({ style, cutCount }) {
  const template = STYLE_TEMPLATES[style] || STYLE_TEMPLATES['Cinematic'];
  const arc = cutCount === 9 ? NARRATIVE_ARC_9 : NARRATIVE_ARC_4;
  const arcText = arc.map((a, i) => `  Shot ${i + 1}: ${a}`).join('\n');
  const perShot = cutCount === 9 ? 1.5 : 3.5;

  return `You are a professional storyboard director and cinematographer. Generate a ${cutCount}-shot storyboard for the given scenario.

## Style: ${style}
- Visual Style: ${template.visualStyle}
- Color Grade: ${template.colorGrade}
- Lighting: ${template.lighting}

## Narrative Arc (follow this exactly)
${arcText}

## Camera Angle Pool
${CAMERA_ANGLE_POOL.join(', ')}

## Duration Budget (STRICT — Seedance 2.0 renders at most ${MAX_TOTAL_SECONDS} seconds total)
- Each shot has a "durationSeconds" number field.
- The SUM of all ${cutCount} durationSeconds MUST NOT exceed ${MAX_TOTAL_SECONDS}.0 — this is an absolute cap.
- Distribute roughly evenly: about ${perShot} seconds per shot. You may give a pivotal shot slightly more by taking time from others, but the total must stay within ${MAX_TOTAL_SECONDS} seconds.
- The duration cue inside each videoPrompt MUST be generated from that shot's durationSeconds (e.g., durationSeconds: ${perShot} → "~${perShot} seconds").

## Rules
1. Each shot must have a UNIQUE cameraAngle — no repeats across all ${cutCount} shots.
2. ${cutCount === 9 ? 'Shot 5 (index 4) MUST use ECU or CU (Extreme Close-Up or Close-Up).' : 'At least one shot must use ECU or CU.'}
3. Each videoPrompt MUST:
   - Contain "16:9"
   - Contain "cinematic 24fps"
   - Contain a duration cue matching its durationSeconds (e.g., "~${perShot} seconds")
   - End with "cinematic 24fps"
4. Characters: assign neutral English names (e.g., "Alex", "Jordan", "Morgan"). Maintain them consistently.
5. No text, logos, or numbers visible in the scene.

## Output Format (JSON only — no markdown, no explanation)
{
  "characters": { "protagonist": "Alex", "love_interest": "Jordan" },
  "shots": [
    {
      "shotNumber": 1,
      "narrativeBeat": "Setup",
      "description": "Brief scene description",
      "cameraAngle": "<unique angle from pool>",
      "action": "What characters/elements are doing",
      "emotion": "Dominant emotion",
      "lighting": "Specific lighting for this shot",
      "colorGrade": "Color grade for this shot",
      "durationSeconds": ${perShot},
      "videoPrompt": "Full Seedance 2.0 compatible prompt. 16:9, [camera angle], [action], [emotion], [lighting], [color grade], ~${perShot} seconds, cinematic 24fps"
    }
  ]
}`;
}

module.exports = { buildSystemPrompt };
