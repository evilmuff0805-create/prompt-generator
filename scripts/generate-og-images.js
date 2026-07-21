'use strict';

const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');

sharp.cache(false);
sharp.concurrency(1);

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const WIDTH = 1200;
const HEIGHT = 630;
const PANEL = { left: 610, top: 105, width: 540, height: 360 };

const previews = [
  {
    output: 'og-image-landing.png',
    source: 'gallery/storyboards/case-study-story06-1280.webp',
    eyebrow: 'AI STORYBOARD DIRECTION',
    title: ['Direct your story.', 'Shot by shot.'],
    description: ['4 or 9 consistent shots with', 'Seedance-ready prompts'],
    chips: ['STORYBOARD', 'IMAGE TO PROMPT', 'ENDFRAME']
  },
  {
    output: 'og-image-storyboard.png',
    source: 'gallery/storyboards/case-study-story06-1280.webp',
    eyebrow: 'PROMPTGEN STORYBOARD',
    title: ['AI Storyboard', 'Generator'],
    description: ['Scenario + references into', 'consistent 4- or 9-shot direction'],
    chips: ['4 OR 9 SHOTS', 'SEEDANCE-READY']
  },
  {
    output: 'og-image-image-to-prompt.png',
    source: 'gallery/pipeline-image-to-prompt-640.webp',
    eyebrow: 'PROMPT ANALYSIS',
    title: ['Image to Prompt'],
    description: ['Turn any reference into a precise,', 'editable AI prompt'],
    chips: ['EDITABLE OUTPUT', 'FREE TOOL']
  },
  {
    output: 'og-image-frame.png',
    source: 'gallery/pipeline-endframe-640.webp',
    eyebrow: 'VIDEO CONTINUITY',
    title: ['Endframe', 'Extractor'],
    description: ['Carry the final frame into your', 'next AI video scene'],
    chips: ['PNG EXPORT', 'FREE TOOL']
  }
];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textLines(lines, x, y, size, lineHeight, weight, fill) {
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + (index * lineHeight)}" font-family="Arial, Helvetica, sans-serif" ` +
    `font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`
  )).join('');
}

function chipMarkup(chips) {
  let x = 60;
  return chips.map(label => {
    const width = Math.max(114, 28 + (label.length * 9));
    const markup = `
      <rect x="${x}" y="538" width="${width}" height="38" rx="19" fill="#101923" stroke="#2f4c52" />
      <text x="${x + 16}" y="563" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="1.2" fill="#b8c5c8">${escapeXml(label)}</text>`;
    x += width + 12;
    return markup;
  }).join('');
}

function backgroundSvg() {
  return Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#05070d" />
          <stop offset="0.58" stop-color="#081219" />
          <stop offset="1" stop-color="#171529" />
        </linearGradient>
        <radialGradient id="mint" cx="0" cy="0" r="1">
          <stop offset="0" stop-color="#10f5c2" stop-opacity="0.26" />
          <stop offset="1" stop-color="#10f5c2" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="lavender" cx="0" cy="0" r="1">
          <stop offset="0" stop-color="#a98cff" stop-opacity="0.24" />
          <stop offset="1" stop-color="#a98cff" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#bg)" />
      <circle cx="410" cy="110" r="360" fill="url(#mint)" />
      <circle cx="1120" cy="590" r="420" fill="url(#lavender)" />
      <path d="M0 505 C250 438 410 520 650 446 S1000 372 1200 424 V630 H0Z" fill="#080a12" opacity="0.52" />
    </svg>
  `);
}

function overlaySvg(preview) {
  const titleY = preview.title.length === 1 ? 258 : 226;
  const descriptionY = preview.title.length === 1 ? 330 : 360;
  return Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2af5c6" stop-opacity="0.54" />
          <stop offset="0.55" stop-color="#d9faff" stop-opacity="0.16" />
          <stop offset="1" stop-color="#a98cff" stop-opacity="0.62" />
        </linearGradient>
        <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#06090f" stop-opacity="0.98" />
          <stop offset="0.72" stop-color="#06090f" stop-opacity="0.1" />
          <stop offset="1" stop-color="#06090f" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect x="634" y="79" width="516" height="360" rx="26" fill="#a98cff" opacity="0.08" stroke="#a98cff" stroke-opacity="0.22" />
      <rect x="586" y="129" width="540" height="360" rx="26" fill="#10f5c2" opacity="0.06" stroke="#10f5c2" stroke-opacity="0.2" />
      <rect x="${PANEL.left}" y="${PANEL.top}" width="${PANEL.width}" height="${PANEL.height}" rx="24" fill="none" stroke="url(#panel)" stroke-width="2" />
      <rect x="${PANEL.left}" y="${PANEL.top}" width="190" height="${PANEL.height}" fill="url(#fade)" opacity="0.6" />
      <rect x="60" y="55" width="48" height="48" rx="15" fill="#102b2a" stroke="#1bd9ba" stroke-opacity="0.75" />
      <text x="71" y="88" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="900" fill="#10f5c2">PG</text>
      <text x="125" y="88" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="800" fill="#f5f7fb">PromptGen</text>
      <rect x="60" y="128" width="${Math.max(188, 36 + (preview.eyebrow.length * 9.5))}" height="38" rx="19" fill="#0c1f21" stroke="#16aa96" stroke-opacity="0.72" />
      <circle cx="80" cy="147" r="5" fill="#10f5c2" />
      <text x="94" y="152" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="800" letter-spacing="1.4" fill="#b9fff1">${escapeXml(preview.eyebrow)}</text>
      ${textLines(preview.title, 60, titleY, 54, 60, 850, '#f7f8fb')}
      ${textLines(preview.description, 62, descriptionY, 22, 32, 500, '#aeb8c6')}
      ${chipMarkup(preview.chips)}
      <text x="1148" y="559" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700" fill="#9aa7b6">promptgen-ai.com</text>
    </svg>
  `);
}

async function generatePreview(preview) {
  const roundedMask = Buffer.from(`
    <svg width="${PANEL.width}" height="${PANEL.height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${PANEL.width}" height="${PANEL.height}" rx="24" fill="#fff" />
    </svg>
  `);
  const panel = await sharp(path.join(PUBLIC, preview.source))
    .resize(PANEL.width, PANEL.height, { fit: 'cover', position: 'centre' })
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const output = await sharp(backgroundSvg())
    .composite([
      { input: panel, left: PANEL.left, top: PANEL.top },
      { input: overlaySvg(preview), left: 0, top: 0 }
    ])
    .png({ compressionLevel: 9, palette: true, quality: 92, colours: 256 })
    .toBuffer();
  await fs.writeFile(path.join(PUBLIC, preview.output), output);
}

async function main() {
  for (const preview of previews) await generatePreview(preview);
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error);
    process.exit(1);
  }
);
