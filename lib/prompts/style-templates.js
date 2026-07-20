'use strict';

const STYLE_TEMPLATES = {
  'Pixar 3D': {
    visualStyle: 'Pixar 3D animation, vibrant colors, expressive characters, soft subsurface lighting, polished CGI render',
    colorGrade: 'warm saturated palette, clean highlights',
    lighting: 'soft studio three-point lighting, gentle rim light'
  },
  'Cinematic': {
    visualStyle: 'anamorphic cinematic photography, film grain, shallow depth of field, lens flares',
    colorGrade: 'teal-orange LUT, filmic tone-mapping',
    lighting: 'dramatic chiaroscuro, motivated practical lights',
    realismConstraint: 'ultra-realistic, natural skin and material textures, physically plausible lighting, real camera optics, no waxy skin, no plastic-looking surfaces, no over-smoothed CGI look',
    continuityConstraint: 'anatomically correct hands and limbs with realistic joint angles and clear contact points, physically plausible balance, momentum, and weight transfer, lock recurring character identity, face, age, hair, wardrobe, carried props, weather, wetness, set geography, and motivated light direction across shots, no fused limbs, no duplicated people or props',
    frameSafetyConstraint: 'compose every panel for a 16:9 frame-safe crop, keeping faces, hands, contact points, and story-critical props inside the safe area'
  },
  'Documentary': {
    visualStyle: 'ultra-realistic handheld documentary photography, naturalistic framing, observational vérité aesthetic, authentic real-world detail',
    colorGrade: 'desaturated naturalistic grade, slight bleach-bypass',
    lighting: 'available light, overcast diffuse fill',
    realismConstraint: 'ultra-realistic, authentic skin, fabric, surface, and environmental textures, natural available light, physically plausible motion, real documentary camera optics, no waxy skin, no plastic-looking surfaces, no synthetic CGI or over-smoothed AI look'
  },
  'Animation': {
    visualStyle: '2D animation, bold outlines, flat color fills, graphic composition',
    colorGrade: 'vivid flat palette, high contrast',
    lighting: 'stylized cel-shaded lighting, graphic shadows'
  }
};

module.exports = STYLE_TEMPLATES;
