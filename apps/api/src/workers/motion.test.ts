import { describe, expect, it } from 'vitest';
import { findEmbeddedVideo, motionClipArgs, mp4Length } from './motion';

const box = (type: string, body: Buffer = Buffer.alloc(8)) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};
const ftyp = (brand: string) =>
  box('ftyp', Buffer.concat([Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from('isommp42')]));
const video = Buffer.concat([
  ftyp('isom'),
  box('moov', Buffer.alloc(40, 1)),
  box('mdat', Buffer.alloc(200, 2)),
]);
// A JPEG whose EXIF happens to mention "ftyp" must not fool the search.
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
  Buffer.from('Exif..ftyp..mentioned'),
  Buffer.alloc(300, 7),
  Buffer.from([0xff, 0xd9]),
]);

describe('embedded video in a motion photo', () => {
  it('finds a Samsung clip between the image and its trailer', () => {
    const file = Buffer.concat([jpeg, Buffer.from('MotionPhoto_Data'), video, Buffer.from('SEFHxxxxSEFT')]);
    expect(findEmbeddedVideo(file)).toEqual({ start: jpeg.length + 16, length: video.length });
  });

  it('finds a Google clip at the end, and one after a HEIC image', () => {
    expect(findEmbeddedVideo(Buffer.concat([jpeg, video]))).toEqual({
      start: jpeg.length,
      length: video.length,
    });
    const heic = Buffer.concat([ftyp('heic'), box('meta', Buffer.alloc(64)), box('mdat', Buffer.alloc(500))]);
    expect(findEmbeddedVideo(Buffer.concat([heic, box('mpvd', video)]))).toEqual({
      start: heic.length + 8,
      length: video.length,
    });
  });

  it('ignores photos without a complete video', () => {
    expect(findEmbeddedVideo(jpeg)).toBeNull();
    const noMovie = Buffer.concat([ftyp('isom'), box('mdat', Buffer.alloc(100))]);
    expect(findEmbeddedVideo(Buffer.concat([jpeg, noMovie]))).toBeNull();
    // Truncated: the mdat box claims more bytes than the file has.
    const truncated = Buffer.concat([jpeg, video.subarray(0, video.length - 10)]);
    expect(findEmbeddedVideo(truncated)).toBeNull();
    expect(mp4Length(video, 0)).toBe(video.length);
  });
});

describe('motion clip', () => {
  it('becomes H.264 at most 720p on its short side, keeping its shape and sound', () => {
    const landscape = motionClipArgs('/in.mp4', '/out.mp4', { width: 1440, height: 1080, hdr: false });
    expect([landscape.width, landscape.height]).toEqual([960, 720]);
    expect(landscape.args).toContain('scale=960:720:flags=bicubic,format=yuv420p,setsar=1');
    expect(landscape.args).toEqual(expect.arrayContaining(['libx264', '0:a:0?', '+faststart']));
    const small = motionClipArgs('/in.mp4', '/out.mp4', { width: 480, height: 640, hdr: true });
    expect([small.width, small.height]).toEqual([480, 640]);
    expect(small.args.find((arg) => arg.startsWith('scale='))).toMatch(
      /^scale=480:640:flags=bicubic,zscale=.*tonemap/,
    );
  });
});
