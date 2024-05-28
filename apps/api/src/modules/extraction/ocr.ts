import type { Config } from '../../config';

export interface OcrResult {
  text: string;
  /** Mean word confidence between 0 and 1. */
  confidence: number;
}

export interface OcrProvider {
  readonly name: string;
  readonly version: string;
  recognize(image: Buffer): Promise<OcrResult>;
  /** Optional: rasterize a PDF page for OCR (scanned PDFs). */
  renderPdfPage?(pdf: Buffer, pageNo: number): Promise<Buffer | null>;
}

/**
 * Tesseract (WASM) OCR. Language data is downloaded on first use and cached;
 * workers are created lazily and reused.
 */
export class TesseractOcr implements OcrProvider {
  readonly name = 'tesseract';
  readonly version = '7';
  private worker: Promise<import('tesseract.js').Worker> | null = null;

  private getWorker() {
    if (!this.worker) {
      this.worker = import('tesseract.js').then(({ createWorker }) => createWorker('eng'));
    }
    return this.worker;
  }

  async recognize(image: Buffer): Promise<OcrResult> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(image);
    return { text: data.text, confidence: (data.confidence ?? 0) / 100 };
  }
}

export function createOcr(config: Config): OcrProvider | null {
  return config.OCR_PROVIDER === 'tesseract' ? new TesseractOcr() : null;
}
