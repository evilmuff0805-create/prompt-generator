'use strict';

const text = (description) => ({ type: 'string', description });
const textArray = (description, limits = {}) => ({
  type: 'array',
  description,
  items: { type: 'string' },
  ...limits
});

const ANALYSIS_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prose: text('A vivid 3-5 sentence description of the scene, mood, medium, and visual impact.'),
    analysis: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              enum: ['person', 'animal', 'object', 'scene'],
              description: 'The primary visible subject category.'
            },
            description: text('A precise physical description using only visible details.'),
            hair: {
              type: 'object',
              additionalProperties: false,
              properties: {
                style: text('Visible hair style.'),
                color: text('Visible hair color including a hex code when applicable.')
              },
              required: ['style', 'color']
            },
            expression: text('Visible facial expression.'),
            pose: text('Visible pose or orientation.'),
            orientation_and_gaze: text(
              'Viewer-relative body and head direction, camera-facing view, eye direction, and visible gaze target. Distinguish viewer coordinates from the subject\'s anatomical sides.'
            ),
            clothing: {
              type: 'array',
              description: 'Visible clothing items.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  item: text('Garment name.'),
                  color: text('Visible color including a hex code.'),
                  fabric: text('Apparent fabric or material.'),
                  fit: text('Apparent fit.'),
                  detail: text('Other visible garment detail.')
                },
                required: ['item', 'color', 'fabric', 'fit', 'detail']
              }
            },
            accessories: {
              type: 'array',
              description: 'Visible accessories.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  item: text('Accessory name.'),
                  color: text('Visible color including a hex code.'),
                  material: text('Apparent material.'),
                  location: text('Where the accessory appears on the subject.')
                },
                required: ['item', 'color', 'material', 'location']
              }
            }
          },
          required: [
            'type',
            'description',
            'expression',
            'pose',
            'orientation_and_gaze',
            'clothing',
            'accessories'
          ]
        },
        scene: {
          type: 'object',
          additionalProperties: false,
          properties: {
            location: text('Visible setting or environment.'),
            time: text('Apparent time of day.'),
            weather: text('Visible or apparent weather.'),
            lighting: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: text('Lighting source or style.'),
                direction: text('Apparent light direction.'),
                quality: text('Apparent light quality.')
              },
              required: ['type', 'direction', 'quality']
            },
            background_elements: textArray('Visible background elements.'),
            object_layout: textArray(
              'Compositionally important visible objects with count, viewer-relative frame position, and relationship to the subject.',
              { minItems: 1 }
            ),
            depth_layers: textArray(
              'Exactly ordered foreground, midground, and background descriptions, including visibly empty layers.',
              { minItems: 3, maxItems: 3 }
            ),
            key_element: {
              type: 'object',
              additionalProperties: false,
              properties: {
                description: text('A unique or especially important visible element.')
              },
              required: ['description']
            }
          },
          required: [
            'location',
            'time',
            'weather',
            'lighting',
            'background_elements',
            'object_layout',
            'depth_layers'
          ]
        },
        technical: {
          type: 'object',
          additionalProperties: false,
          description: 'Estimated capture settings for photos or render settings for non-photographic media.',
          properties: {
            camera_model: text('Estimated camera or capture system.'),
            lens: text('Estimated lens or field of view.'),
            aperture: text('Estimated aperture or depth-of-field equivalent.'),
            iso: text('Estimated ISO or sensitivity equivalent.'),
            shutter_speed: text('Estimated shutter speed or motion treatment.'),
            render_engine: text('Apparent render engine or illustration technique for non-photographic media.')
          }
        },
        composition: {
          type: 'object',
          additionalProperties: false,
          properties: {
            framing: text('Visible framing.'),
            angle: text('Visible camera or viewing angle.'),
            focus_point: text('Primary visual focus.'),
            viewpoint: text(
              'Visible camera elevation, azimuth, roll, and distance without fabricated capture metadata.'
            ),
            subject_placement: text(
              'Viewer-relative grid position, approximate frame share, and scale of the primary subject.'
            ),
            negative_space: text(
              'Viewer-relative location and approximate share of intentionally open image area.'
            ),
            spatial_relationships: textArray(
              'Key left/right/above/below/front/behind relationships between visible subjects and objects.',
              { minItems: 2 }
            ),
            aspect_ratio: {
              type: 'string',
              enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3', '21:9'],
              description: 'Closest standard aspect ratio.'
            }
          },
          required: [
            'framing',
            'angle',
            'focus_point',
            'viewpoint',
            'subject_placement',
            'negative_space',
            'spatial_relationships',
            'aspect_ratio'
          ]
        },
        style_modifiers: {
          type: 'object',
          additionalProperties: false,
          properties: {
            medium: text('Photography, 3D render, illustration, or other visible medium.'),
            aesthetic: textArray('Visible aesthetic qualities.'),
            color_palette: text('Dominant visible colors including hex codes.'),
            color_distribution: text(
              'Viewer-relative distribution of warm/cool, dominant/accent colors across the frame.'
            ),
            tonal_contrast: text(
              'Regional shadow, midtone, highlight, saturation, contrast, and white-balance relationships.'
            ),
            post_processing: text('Apparent post-processing or finishing technique.')
          },
          required: [
            'medium',
            'aesthetic',
            'color_palette',
            'color_distribution',
            'tonal_contrast',
            'post_processing'
          ]
        },
        constraints: {
          type: 'object',
          additionalProperties: false,
          properties: {
            must_keep: textArray('Critical visible elements that must be preserved.', { minItems: 6 }),
            avoid: textArray('Hallucinations or visual errors to avoid.', { minItems: 5 })
          },
          required: ['must_keep', 'avoid']
        }
      },
      required: ['subject', 'scene', 'technical', 'composition', 'style_modifiers', 'constraints']
    }
  },
  required: ['prose', 'analysis']
};

function createSuggestionsResponseJsonSchema(expectedCount) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      suggestions: {
        type: 'array',
        description: 'One replacement set for every supplied bracket index.',
        minItems: expectedCount,
        maxItems: expectedCount,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: {
              type: 'integer',
              minimum: 1,
              maximum: expectedCount,
              description: 'The one-based bracket index from the request.'
            },
            items: textArray('Three to five concise replacement values.', {
              minItems: 3,
              maxItems: 5
            })
          },
          required: ['index', 'items']
        }
      }
    },
    required: ['suggestions']
  };
}

module.exports = {
  ANALYSIS_RESPONSE_JSON_SCHEMA,
  createSuggestionsResponseJsonSchema
};
