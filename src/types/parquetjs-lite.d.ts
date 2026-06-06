declare module 'parquetjs-lite' {
  export class ParquetReader {
    static openFile(filePath: string, options?: unknown): Promise<ParquetReader>;
    getCursor(columns?: string[]): {
      next(): Promise<Record<string, unknown> | null>;
    };
    close(): Promise<void>;
  }
}
