'use strict';

const {
  ANALYSIS_RESPONSE_JSON_SCHEMA,
  createSuggestionsResponseJsonSchema
} = require('../../lib/gemini-response-schemas');

describe('Gemini response JSON Schemas', () => {
  test('uses the documented JSON Schema envelope for image analysis', () => {
    expect(ANALYSIS_RESPONSE_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['prose', 'analysis']
    });
    expect(ANALYSIS_RESPONSE_JSON_SCHEMA.properties.analysis.required).toEqual([
      'subject',
      'scene',
      'technical',
      'composition',
      'style_modifiers',
      'constraints'
    ]);
    expect(
      ANALYSIS_RESPONSE_JSON_SCHEMA
        .properties.analysis
        .properties.constraints
        .properties.must_keep
        .minItems
    ).toBe(5);
  });

  test('binds suggestion counts and indexes to the active bracket batch', () => {
    const schema = createSuggestionsResponseJsonSchema(7);
    const suggestions = schema.properties.suggestions;

    expect(suggestions).toMatchObject({ minItems: 7, maxItems: 7 });
    expect(suggestions.items.properties.index).toMatchObject({ minimum: 1, maximum: 7 });
    expect(suggestions.items.properties.items).toMatchObject({ minItems: 3, maxItems: 5 });
  });
});
