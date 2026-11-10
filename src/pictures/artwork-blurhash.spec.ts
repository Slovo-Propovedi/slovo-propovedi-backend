import { artworkBlurhashMap } from './artwork-blurhash';
import { PicturesService } from './pictures.service';

const createPicturesService = () =>
  ({ findBlurhashes: jest.fn() }) as unknown as PicturesService;

describe('artworkBlurhashMap', () => {
  it('returns an empty Map without querying for empty input', async () => {
    const picturesService = createPicturesService();

    await expect(artworkBlurhashMap(picturesService, [])).resolves.toEqual(
      new Map(),
    );
    expect(picturesService.findBlurhashes).not.toHaveBeenCalled();
  });

  it('keys the result by the original URL and dedupes lookups', async () => {
    const picturesService = createPicturesService();
    picturesService.findBlurhashes.mockResolvedValue(
      new Map([
        ['cover-a.jpg', 'hash-a'],
        ['cover-b.jpg', null],
      ]),
    );
    const coverA = 'https://minio.example.com/files/cover-a.jpg';
    const coverB = 'https://minio.example.com/files/cover-b.jpg';

    const result = await artworkBlurhashMap(picturesService, [
      coverA,
      coverB,
      coverA,
    ]);

    expect(picturesService.findBlurhashes).toHaveBeenCalledTimes(1);
    expect(picturesService.findBlurhashes).toHaveBeenCalledWith([
      'cover-a.jpg',
      'cover-b.jpg',
    ]);
    expect(result).toEqual(
      new Map([
        [coverA, 'hash-a'],
        [coverB, null],
      ]),
    );
  });

  it('silently skips malformed and foreign-bucket URLs', async () => {
    const picturesService = createPicturesService();
    picturesService.findBlurhashes.mockResolvedValue(
      new Map([['cover-a.jpg', 'hash-a']]),
    );
    const coverA = 'https://minio.example.com/files/cover-a.jpg';

    const result = await artworkBlurhashMap(picturesService, [
      'not-a-url',
      'https://cdn.example.com/other/cover-x.jpg',
      coverA,
    ]);

    expect(picturesService.findBlurhashes).toHaveBeenCalledWith([
      'cover-a.jpg',
    ]);
    expect(result).toEqual(new Map([[coverA, 'hash-a']]));
  });
});
