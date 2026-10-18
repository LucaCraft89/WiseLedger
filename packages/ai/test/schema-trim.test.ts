import { describe, expect, it } from 'vitest';
import { extractionSchema } from '../src/analyst/prompts.js';

describe('extractionSchema', () => {
  it('leaves rgbInvoice to the code when the text prints at most one payment request', () => {
    const slim = extractionSchema(false) as { properties: Record<string, unknown>; required: string[] };
    expect(slim.properties).not.toHaveProperty('rgbInvoice');
    expect(slim.required).not.toContain('rgbInvoice');
    expect(slim.required).toContain('total');
  });
  it('keeps rgbInvoice when the model must choose between several', () => {
    const full = extractionSchema(true) as { properties: Record<string, unknown>; required: string[] };
    expect(full.properties).toHaveProperty('rgbInvoice');
    expect(full.required).toContain('rgbInvoice');
  });
});
