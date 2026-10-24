/**
 * /uploads/[...path]
 * Serves files from /public/uploads/ dynamically so that newly uploaded
 * files are accessible without requiring a server restart or rebuild.
 * Supports HTTP Range requests for video streaming and seeking.
 */

import { createReadStream, existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';

const MIME_TYPES = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg:  'image/svg+xml',
  mp4:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
  avi:  'video/x-msvideo',
  mkv:  'video/x-matroska',
  ogg:  'video/ogg',
  m4a:  'audio/mp4',
  pdf:  'application/pdf',
};

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg']);
// Byte-range (206) support: videos + Mini Chat voice notes (Safari needs ranges for <audio>).
const RANGE_EXTS = new Set([...VIDEO_EXTS, 'm4a']);

export async function GET(request, { params }) {
  try {
    const segments = (await params).path;
    if (!segments || segments.length === 0) {
      return new NextResponse('Not found', { status: 404 });
    }

    // Prevent directory traversal
    const fileName = segments.join('/');
    if (fileName.includes('..') || fileName.startsWith('/')) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    const filePath = path.join(process.cwd(), 'public', 'uploads', fileName);

    if (!existsSync(filePath)) {
      return new NextResponse('Not found', { status: 404 });
    }

    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const supportsRange = RANGE_EXTS.has(ext);

    const stat = statSync(filePath);
    const fileSize = stat.size;

    // ── Range request (video streaming / seeking) ─────────────────────────────
    const rangeHeader = request.headers.get('range');

    if (supportsRange && rangeHeader) {
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);

      if (start >= fileSize || end >= fileSize || start > end) {
        return new NextResponse('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` },
        });
      }

      const chunkSize = end - start + 1;

      // Stream the requested chunk
      const stream = createReadStream(filePath, { start, end });
      const readable = new ReadableStream({
        start(controller) {
          stream.on('data',  (chunk) => controller.enqueue(chunk));
          stream.on('end',   ()      => controller.close());
          stream.on('error', (err)   => controller.error(err));
        },
        cancel() { stream.destroy(); },
      });

      return new NextResponse(readable, {
        status: 206,
        headers: {
          'Content-Type':   contentType,
          'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': String(chunkSize),
          'Cache-Control':  'public, max-age=31536000, immutable',
        },
      });
    }

    // ── Full file (images + non-range video requests) ─────────────────────────
    const buffer = await readFile(filePath);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type':   contentType,
        'Content-Length': String(fileSize),
        'Accept-Ranges':  'bytes',
        'Cache-Control':  'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new NextResponse('Server error', { status: 500 });
  }
}
