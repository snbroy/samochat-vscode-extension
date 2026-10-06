import { join } from "node:path";

const dataUrl = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const maxOcrChars = 8000;

type OcrWorker = {
  recognize(image: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
};

/** Reads text out of screenshots locally (Tesseract), so only plain text is sent to the SaMo API. */
export async function extractTextFromImages(extensionPath: string, images: string[]): Promise<string[]> {
  const modules = join(extensionPath, "node_modules");
  const { createWorker } = require("tesseract.js") as {
    createWorker(lang: string, oem: number, options: Record<string, unknown>): Promise<OcrWorker>;
  };
  const worker = await createWorker("eng", 1, {
    langPath: join(modules, "@tesseract.js-data", "eng", "4.0.0_best_int"),
    corePath: join(modules, "tesseract.js-core"),
    gzip: true,
    cacheMethod: "none",
  });
  try {
    const results: string[] = [];
    for (const image of images) {
      const match = dataUrl.exec(image);
      if (!match) {
        results.push("");
        continue;
      }
      const { data } = await worker.recognize(Buffer.from(match[1], "base64"));
      results.push(cleanOcrText(data.text));
    }
    return results;
  } finally {
    await worker.terminate();
  }
}

export function cleanOcrText(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxOcrChars);
}
