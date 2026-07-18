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
    realismConstraint: 'ultra-realistic, natural skin and material textures, physically plausible lighting, real camera optics, no waxy skin, no plastic-looking surfaces, no over-smoothed CGI look'
  },
  'Documentary': {
    visualStyle: 'handheld documentary footage, naturalistic framing, vérité aesthetic',
    colorGrade: 'desaturated naturalistic grade, slight bleach-bypass',
    lighting: 'available light, overcast diffuse fill'
  },
  'Animation': {
    visualStyle: '2D animation, bold outlines, flat color fills, graphic composition',
    colorGrade: 'vivid flat palette, high contrast',
    lighting: 'stylized cel-shaded lighting, graphic shadows'
  }
};

module.exports = STYLE_TEMPLATES;
