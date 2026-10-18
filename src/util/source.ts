// Random-access byte sources. The worker reads files through Blob.slice so it
// never has to materialise a 100 MB+ file as a single ArrayBuffer.

export interface Source {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class BlobSource implements Source {
  readonly size: number;
  constructor(private readonly blob: Blob) {
    this.size = blob.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
  }
}

export class BytesSource implements Source {
  readonly size: number;
  constructor(private readonly bytes: Uint8Array) {
    this.size = bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.size));
    return this.bytes.subarray(start, Math.min(start + Math.max(0, length), this.size));
  }
}

export const CHUNK = 4 * 1024 * 1024;

export async function* chunks(src: Source, size = CHUNK): AsyncGenerator<{ offset: number; bytes: Uint8Array }> {
  for (let offset = 0; offset < src.size; offset += size) {
    yield { offset, bytes: await src.read(offset, size) };
  }
}
