'use strict';

require('dotenv').config();

const baseUrl = String(process.env.APP_URL || '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('APP_URL is required, for example https://promptgen-ai.com');
  process.exit(1);
}

async function check(path, validate) {
  const started = Date.now();
  const response = await fetch(baseUrl + path, {
    headers: { 'user-agent': 'promptgen-smoke/1.0' },
    redirect: 'manual'
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  if (validate && !validate(body, response)) {
    throw new Error(`${path} returned an unexpected response`);
  }

  console.log(JSON.stringify({
    path,
    status: response.status,
    durationMs: Date.now() - started,
    requestId: response.headers.get('x-request-id')
  }));
}

async function main() {
  await check('/api/health', (body) => {
    try {
      return JSON.parse(body).status === 'ok';
    } catch (_) {
      return false;
    }
  });
  await check('/', (body) => body.includes('PromptGen') || body.includes('Prompt'));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
