import { MinioService } from 'src/minio/minio.service';
import { PicturesService } from './pictures.service';

/**
 * Builds the `artwork URL → blurhash | null` Map a response normalizer needs.
 *
 * URLs are deduped and reduced to their bucket object name before the single
 * batched lookup. A malformed or foreign-bucket URL is skipped silently (the
 * same policy as `referenced-files.ts`): one bad stored row must not break a
 * catalog response, it merely has no placeholder.
 */
export const artworkBlurhashMap = async (
  picturesService: PicturesService,
  urls: readonly string[],
): Promise<Map<string, string | null>> => {
  const uniqueUrls = [...new Set(urls)];
  if (!uniqueUrls.length) {
    return new Map();
  }

  const fileNameByUrl = new Map<string, string>();
  for (const url of uniqueUrls) {
    try {
      fileNameByUrl.set(url, MinioService.extractFileNameFromUrl(url));
    } catch {
      // Skipped deliberately — see the function comment.
    }
  }

  const blurhashesByFileName = await picturesService.findBlurhashes([
    ...new Set(fileNameByUrl.values()),
  ]);
  const blurhashByUrl = new Map<string, string | null>();
  for (const [url, fileName] of fileNameByUrl) {
    blurhashByUrl.set(url, blurhashesByFileName.get(fileName) ?? null);
  }
  return blurhashByUrl;
};
