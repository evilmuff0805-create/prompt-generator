'use strict';

const http = require('http');
const express = require('express');
const multer = require('multer');
const analyzeRouter = require('../../routes/analyze');
const storyboardRouter = require('../../routes/storyboard');

function multipartBody(options = {}) {
  const boundary = options.boundary || '----promptgen-security-test';
  const fieldName = options.fieldName || 'image';
  const filename = options.filename || 'test.png';
  const contentType = options.contentType || 'image/png';
  const data = options.data || Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const tail = options.close === false
    ? Buffer.alloc(0)
    : Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, data, tail]);

  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length)
    }
  };
}

function runUpload(middleware, payload) {
  const app = express();

  app.post('/upload', middleware, (req, res) => {
    res.status(200).json({
      fieldName: req.file?.fieldname,
      mimeType: req.file?.mimetype,
      size: req.file?.size,
      bufferLength: req.file?.buffer?.length ?? null
    });
  });

  app.use((error, req, res, next) => {
    void next;
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({
      code: error.code || 'UPLOAD_ERROR',
      message: error.message
    });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const request = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/upload',
        method: 'POST',
        headers: payload.headers
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          server.close();
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode,
            body: raw ? JSON.parse(raw) : {}
          });
        });
      });

      request.on('error', (error) => {
        server.close();
        reject(error);
      });
      request.end(payload.body);
    });

    server.on('error', reject);
  });
}

describe('Multer 2 upload security regression', () => {
  const analysisPolicy = analyzeRouter._uploadSecurity;
  const storyboardPolicy = storyboardRouter._uploadSecurity;

  test('analysis accepts an allowlisted image through the real multipart parser', async () => {
    const middleware = analysisPolicy.createAnalysisUpload({
      storage: multer.memoryStorage(),
      maxFileSize: 64
    }).single('image');

    const result = await runUpload(middleware, multipartBody());

    expect(result).toEqual({
      status: 200,
      body: {
        fieldName: 'image',
        mimeType: 'image/png',
        size: 4,
        bufferLength: 4
      }
    });
  });

  test('analysis rejects a disallowed MIME type before the handler', async () => {
    const middleware = analysisPolicy.createAnalysisUpload({
      storage: multer.memoryStorage(),
      maxFileSize: 64
    }).single('image');

    const result = await runUpload(middleware, multipartBody({
      contentType: 'text/plain',
      filename: 'payload.txt',
      data: Buffer.from('not an image')
    }));

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('UPLOAD_ERROR');
    expect(result.body.message).toMatch(/Only JPEG, PNG, WebP, and GIF/);
  });

  test('analysis rejects oversized multipart bodies with MulterError', async () => {
    const middleware = analysisPolicy.createAnalysisUpload({
      storage: multer.memoryStorage(),
      maxFileSize: 64
    }).single('image');

    const result = await runUpload(middleware, multipartBody({
      data: Buffer.alloc(65, 0x41)
    }));

    expect(result).toMatchObject({
      status: 413,
      body: { code: 'LIMIT_FILE_SIZE' }
    });
  });

  test('analysis rejects unexpected file field names', async () => {
    const middleware = analysisPolicy.createAnalysisUpload({
      storage: multer.memoryStorage(),
      maxFileSize: 64
    }).single('image');

    const result = await runUpload(middleware, multipartBody({
      fieldName: 'avatar'
    }));

    expect(result).toMatchObject({
      status: 400,
      body: { code: 'LIMIT_UNEXPECTED_FILE' }
    });
  });

  test('Multer 2 fails closed on a truncated multipart body', async () => {
    const middleware = analysisPolicy.createAnalysisUpload({
      storage: multer.memoryStorage(),
      maxFileSize: 64
    }).single('image');

    const result = await runUpload(middleware, multipartBody({ close: false }));

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('UPLOAD_ERROR');
    expect(result.body.message).toMatch(/end of form/i);
  });

  test('analysis magic-byte validation rejects MIME spoofing', () => {
    expect(analysisPolicy.verifyMagicBytes(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'image/png'
    )).toBe(true);
    expect(analysisPolicy.verifyMagicBytes(
      Buffer.from('plain text'),
      'image/png'
    )).toBe(false);
  });

  test('Storyboard keeps uploads in memory and preserves the configured cap', async () => {
    const middleware = storyboardPolicy.createStoryboardUpload({
      maxFileSize: 64
    }).single('image');

    const accepted = await runUpload(middleware, multipartBody({
      contentType: 'image/jpeg',
      filename: 'reference.jpg',
      data: Buffer.from([0xff, 0xd8, 0xff])
    }));
    const oversized = await runUpload(middleware, multipartBody({
      contentType: 'image/jpeg',
      filename: 'reference.jpg',
      data: Buffer.alloc(65, 0x42)
    }));

    expect(accepted).toMatchObject({
      status: 200,
      body: {
        mimeType: 'image/jpeg',
        size: 3,
        bufferLength: 3
      }
    });
    expect(oversized).toMatchObject({
      status: 413,
      body: { code: 'LIMIT_FILE_SIZE' }
    });
  });

  test('Storyboard MIME policy excludes GIF and non-image payloads', () => {
    expect(storyboardPolicy.isAllowedStoryboardMime('image/jpeg')).toBe(true);
    expect(storyboardPolicy.isAllowedStoryboardMime('image/png')).toBe(true);
    expect(storyboardPolicy.isAllowedStoryboardMime('image/webp')).toBe(true);
    expect(storyboardPolicy.isAllowedStoryboardMime('image/gif')).toBe(false);
    expect(storyboardPolicy.isAllowedStoryboardMime('text/plain')).toBe(false);
  });
});
