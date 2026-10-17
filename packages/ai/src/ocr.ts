// OCR_LATIN text for image invoices (alternative to the vision projector; b-001 favours vision).
type Sdk = typeof import('@qvac/sdk');

let ocrModel: Promise<{ sdk: Sdk; modelId: string }> | undefined;

/** Lines of text read from an image, with the mean confidence (R9 input). */
export async function ocrImage(path: string): Promise<{ text: string; confidence: number }> {
  ocrModel ??= (async () => {
    const sdk = await import('@qvac/sdk');
    const load = sdk.loadModel as unknown as (o: Record<string, unknown>) => Promise<string>;
    const modelId = await load({ modelSrc: sdk.OCR_LATIN, modelConfig: { langList: ['en', 'it'] } });
    return { sdk, modelId };
  })();
  const { sdk, modelId } = await ocrModel;
  const run = (
    sdk.ocr as unknown as (o: Record<string, unknown>) => { blocks: Promise<{ text: string; confidence?: number }[]> }
  )({
    modelId,
    image: path,
    options: { paragraph: false },
  });
  const blocks = await run.blocks;
  const confidence = blocks.reduce((s, b) => s + (b.confidence ?? 0), 0) / Math.max(1, blocks.length);
  return { text: blocks.map((b) => b.text).join('\n'), confidence };
}

export async function unloadOcr(): Promise<void> {
  if (!ocrModel) return;
  const { sdk, modelId } = await ocrModel;
  ocrModel = undefined;
  await sdk.unloadModel({ modelId, clearStorage: false });
}
