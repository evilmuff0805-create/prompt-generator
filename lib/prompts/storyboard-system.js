'use strict';

const STYLE_TEMPLATES = require('./style-templates');
const { FACE_IDENTITY_CONSTRAINT } = require('./storyboard-constraints');

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
  const realismConstraint = template.realismConstraint
    ? `\n- Mandatory Realism Constraint: ${template.realismConstraint}`
    : '';
  const continuityConstraint = template.continuityConstraint
    ? `\n- Mandatory Physical Continuity: ${template.continuityConstraint}`
    : '';
  const frameSafetyConstraint = template.frameSafetyConstraint
    ? `\n- Mandatory Frame Safety: ${template.frameSafetyConstraint}`
    : '';
  const videoPromptStyleRules = [
    template.realismConstraint
      ? 'Contain the exact phrase "ultra-realistic" and preserve the mandatory realism constraint above'
      : null,
    template.continuityConstraint
      ? 'Preserve the mandatory physical continuity constraint and prior-shot state; never duplicate or remove recurring people or story-critical props without an explicit narrative cause'
      : null,
    template.frameSafetyConstraint
      ? 'Compose for a 16:9 frame-safe crop with faces, hands, contact points, and story-critical props inside the safe area'
      : null
  ].filter(Boolean).map(rule => `\n   - ${rule}`).join('');
  const cinematicContinuityRules = template.continuityConstraint
    ? `\n6. Cinematic Physical Continuity:\n   - Make each shot one readable subject-action-result beat.\n   - Carry forward character, prop, weather, wetness, set, and lighting state from the prior shot; change state only when the narrative explicitly shows the cause.\n   - Preserve varied actions and camera choices while obeying the continuity and frame-safety constraints above.`
    : '';

  return `You are a professional storyboard director and cinematographer. Generate a ${cutCount}-shot storyboard for the given scenario.

## Style: ${style}
- Visual Style: ${template.visualStyle}
- Color Grade: ${template.colorGrade}
- Lighting: ${template.lighting}${realismConstraint}${continuityConstraint}${frameSafetyConstraint}
- Mandatory Face Identity: ${FACE_IDENTITY_CONSTRAINT}

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
   - Contain the exact phrase "preserve facial identity" and carry the mandatory face-identity constraint above; apply it only when a face is visible so POV, insert, and environment shots remain truthful
   - End with "cinematic 24fps"${videoPromptStyleRules}
4. Characters: assign neutral English names (e.g., "Alex", "Jordan", "Morgan"). Maintain them consistently.
5. No text, logos, or numbers visible in the scene.${cinematicContinuityRules}

## Output Format (JSON only — no markdown, no explanation)
{
  "characters": [
    { "role": "protagonist", "name": "Alex" },
    { "role": "love_interest", "name": "Jordan" }
  ],
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
      "videoPrompt": "Full Seedance 2.0 compatible prompt. 16:9, [camera angle], [action], [emotion], [lighting], [color grade], when a recurring face is visible preserve facial identity and stable facial geometry frame to frame, ~${perShot} seconds, cinematic 24fps"
    }
  ]
}`;
}

module.exports = { buildSystemPrompt };
