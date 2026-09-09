import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { ReverseContractError } from "./claude-errors.js";

// Async codecs keep compressed uploads from blocking every active stream.
const CODECS = new Map([
  ["gzip", promisify(zlib.gunzip)],
  ["br", promisify(zlib.brotliDecompress)],
  ["deflate", promisify(zlib.inflate)],
  ...(typeof zlib.zstdDecompress === "function" ? [["zstd", promisify(zlib.zstdDecompress)] as const] : []),
]);

export const hasNativeDecoders = (): boolean => CODECS.has("zstd");

export const decodeBody = async (
  raw: Buffer, encoding: string | string[] | undefined, limit: number,
): Promise<Buffer> => {
  if (!encoding || encoding === "identity") return raw;
  const codec = typeof encoding === "string" ? CODECS.get(encoding.toLowerCase()) : undefined;
  if (!codec) throw new ReverseContractError("unsupported_content_encoding");
  try { return await codec(raw, { maxOutputLength: limit }); }
  catch { throw new ReverseContractError("invalid_or_oversized_compressed_body"); }
};
