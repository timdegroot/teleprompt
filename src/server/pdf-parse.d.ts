declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
  }

  export default function pdf(buffer: Buffer): Promise<PdfParseResult>;
}
