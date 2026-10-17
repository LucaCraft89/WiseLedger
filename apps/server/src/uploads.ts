// Upload checks: only PDF, PNG, JPEG, TXT and XML, recognised by extension AND content (magic bytes / valid text).
import { extname } from 'node:path';
import type { InvoiceSourceKind } from 'core';
import { ApiFailure } from './orchestrator.js';

type FileType = 'pdf' | 'png' | 'jpeg' | 'txt' | 'xml';

const BY_EXT: Record<string, FileType> = {
  '.pdf': 'pdf',
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.txt': 'txt',
  '.xml': 'xml',
};

const LABEL: Record<FileType, string> = { pdf: 'PDF', png: 'PNG image', jpeg: 'JPEG image', txt: 'text', xml: 'XML' };
const KIND: Record<FileType, InvoiceSourceKind> = { pdf: 'pdf', png: 'image', jpeg: 'image', txt: 'text', xml: 'xml' };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function asText(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

function matches(type: FileType, data: Buffer): boolean {
  switch (type) {
    case 'pdf':
      return data.subarray(0, 1024).includes('%PDF-');
    case 'png':
      return data.subarray(0, 8).equals(PNG_MAGIC);
    case 'jpeg':
      return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'txt':
      return asText(data) !== undefined;
    case 'xml': {
      const text = asText(data.subarray(0, 3).equals(UTF8_BOM) ? data.subarray(3) : data);
      return text?.trimStart().startsWith('<') === true;
    }
  }
}

export const ACCEPTED_FILES_MESSAGE = 'We can read invoices as PDF, PNG, JPEG, TXT or XML files.';

/** Returns the invoice kind, or throws 415 with a plain message. */
export function checkUpload(filename: string, data: Buffer): InvoiceSourceKind {
  const ext = extname(filename).toLowerCase();
  const type = BY_EXT[ext];
  if (!type) {
    const what = ext ? `"${ext}" files` : 'files without an extension';
    throw new ApiFailure(415, 'UNSUPPORTED_FILE', `${ACCEPTED_FILES_MESSAGE} We cannot read ${what}.`);
  }
  if (!matches(type, data)) {
    throw new ApiFailure(
      415,
      'UNSUPPORTED_FILE',
      `This file is named ${ext} but its content is not a ${LABEL[type]} file. Please export the invoice again and upload it.`,
    );
  }
  return KIND[type];
}

export function tooLarge(maxMb: number): ApiFailure {
  return new ApiFailure(
    413,
    'FILE_TOO_LARGE',
    `This file is larger than ${maxMb} MB. Please upload a smaller file (for example a PDF instead of a photo).`,
  );
}
