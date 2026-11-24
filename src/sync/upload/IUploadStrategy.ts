import type { IWebDAVClient, UploadOptions } from '../../network/IWebDAVClient';
export type { UploadOptions } from '../../network/IWebDAVClient';

/** Outcome of an upload: skipped (over the size limit) or sent. */
export type UploadOutcome = 'uploaded' | 'skipped';

/** Size limits an upload strategy applies. */
export interface UploadConfig {
  /** Absolute size cap (MB), read on every upload so a settings change applies at once; files above it are skipped. `0` = unlimited. */
  maxFileSizeMB(): number;
  /** Size (MB) above which a chunked upload is used instead of a single PUT. */
  uploadChunkThresholdMB: number;
}

/** Uploads a file by single PUT, chunked upload or skip, depending on size and server capabilities. */
export interface IUploadStrategy {
  /** Uploads one file; resolves to `'skipped'` when over the size limit. */
  upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number, opts?: UploadOptions): Promise<UploadOutcome>;
}
