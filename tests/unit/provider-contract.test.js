'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('AI provider contract', () => {
  test('Image to Prompt imports only the active Gemini service', () => {
    const route = read('routes/analyze.js');

    expect(route).toContain("require('../services/geminiService')");
    expect(route).not.toMatch(/groq/i);
    expect(fs.existsSync(path.join(root, 'services', 'groqService.js'))).toBe(false);
  });

  test('production dependency and environment metadata contain no Groq runtime', () => {
    const packageJson = JSON.parse(read('package.json'));
    const packageLock = read('package-lock.json');
    const envExample = read('.env.example');

    expect(packageJson.dependencies).not.toHaveProperty('groq-sdk');
    expect(packageLock).not.toContain('node_modules/groq-sdk');
    expect(envExample).not.toContain('GROQ_API_KEY');
  });

  test('privacy names the providers and data flows used by the current code', () => {
    const privacy = read('public/privacy.html');

    expect(privacy).toContain('Google Gemini API');
    expect(privacy).toContain('OpenAI API');
    expect(privacy).toContain('Storyboard reference uploads');
    expect(privacy).toContain('Generated Storyboard grids');
    expect(privacy).toContain('90 days from creation');
    expect(privacy).not.toContain('Groq API');
  });
});
