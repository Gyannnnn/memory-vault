import { describe, expect, it } from 'vitest';
import { codecString, parseStreamProbe } from './media-tools';
import { localCandidates } from './originals';
import { planRenditions, playlistStats, transcodeArgs } from './transcode';

const sizes = (probe: { width: number; height: number; frameRate?: number }) =>
  planRenditions({ frameRate: 30, ...probe }).map((rendition) => `${rendition.width}x${rendition.height}`);

describe('quality ladder', () => {
  it('never upscales, and names renditions by their short side', () => {
    expect(sizes({ width: 3840, height: 2160 })).toEqual(['640x360', '1280x720', '1920x1080']);
    expect(sizes({ width: 1080, height: 1920 })).toEqual(['360x640', '720x1280', '1080x1920']);
    expect(sizes({ width: 1280, height: 720 })).toEqual(['640x360', '1280x720']);
    expect(sizes({ width: 640, height: 360 })).toEqual(['640x360']);
    // Smaller than 360p: one version at the original size.
    expect(sizes({ width: 320, height: 240 })).toEqual(['320x240']);
    // Odd sizes round to even numbers, as H.264 needs.
    expect(sizes({ width: 1366, height: 769 })).toEqual(['640x360', '1278x720']);
  });

  it('caps the frame rate at 30 below 1080p and at 60 for 1080p', () => {
    const fps = planRenditions({ width: 1920, height: 1080, frameRate: 59.94 }).map((r) => r.fps);
    expect(fps).toEqual([30, 30, 59.94]);
  });
});

describe('ffmpeg arguments', () => {
  const renditions = planRenditions({ width: 1920, height: 1080, frameRate: 60 });

  it('decodes once and writes one single-file fMP4 HLS output per rendition', () => {
    const args = transcodeArgs(
      '/in/clip.mp4',
      '/out',
      { hasAudio: true, hdr: false, frameRate: 60 },
      renditions,
    );
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]split=3[s0][s1][s2]');
    expect(graph).toContain('[s0]scale=640:360:flags=bicubic,fps=30,format=yuv420p,setsar=1[v0]');
    expect(graph).toContain('[s2]scale=1920:1080:flags=bicubic,format=yuv420p,setsar=1[v2]');
    expect(graph).not.toContain('tonemap');
    expect(args.filter((arg) => arg === '0:a:0')).toHaveLength(3);
    expect(args).toContain('/out/720p.mp4');
    expect(args.at(-1)).toBe('/out/1080p.m3u8');
    expect(args.filter((arg) => arg === 'single_file')).toHaveLength(3);
  });

  it('tone-maps HDR and leaves out audio when there is none', () => {
    const args = transcodeArgs(
      '/in/hdr.mov',
      '/out',
      { hasAudio: false, hdr: true, frameRate: 30 },
      renditions,
    );
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(
      /^\[0:v\]scale=1920:1080:flags=bicubic,zscale=t=linear.*tonemap=tonemap=hable.*split=3/,
    );
    expect(args).not.toContain('0:a:0');
    expect(args).not.toContain('aac');
  });
});

describe('playlists and probes', () => {
  it('works out peak and average bandwidth from byte ranges', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="720p.mp4",BYTERANGE="1372@0"',
      '#EXTINF:4.000000,',
      '#EXT-X-BYTERANGE:723834@1372',
      '720p.mp4',
      '#EXTINF:4.000000,',
      '#EXT-X-BYTERANGE:754873@725206',
      '720p.mp4',
      '#EXTINF:1.000000,',
      '#EXT-X-BYTERANGE:174931@1480079',
      '720p.mp4',
      '#EXT-X-ENDLIST',
    ].join('\n');
    expect(playlistStats(playlist)).toEqual({
      durationSeconds: 9,
      bandwidth: 1509746,
      averageBandwidth: 1469901,
    });
  });

  it('reads display size after rotation, HDR and audio from ffprobe', () => {
    const probe = parseStreamProbe(
      JSON.stringify({
        format: { duration: '12.5' },
        streams: [
          {
            codec_type: 'video',
            width: 3840,
            height: 2160,
            avg_frame_rate: '30000/1001',
            color_transfer: 'arib-std-b67',
            side_data_list: [{ rotation: -90 }],
          },
          { codec_type: 'audio' },
        ],
      }),
    );
    expect(probe).toEqual({
      width: 2160,
      height: 3840,
      durationMs: 12500,
      frameRate: 30000 / 1001,
      hasAudio: true,
      hdr: true,
    });
  });

  it('describes the codecs for the master playlist', () => {
    expect(
      codecString({
        streams: [{ codec_type: 'video', profile: 'High', level: 31 }, { codec_type: 'audio' }],
      }),
    ).toBe('avc1.64001f,mp4a.40.2');
    expect(codecString({ streams: [{ codec_type: 'video', profile: 'High', level: 42 }] })).toBe(
      'avc1.64002a',
    );
  });
});

describe('local copies', () => {
  it('looks at the uploader path, the laptop mount and phone staging, never outside them', () => {
    expect(
      localCandidates(
        {
          localPath: '/home/me/vault-staging/phone-s21fe/DCIM/a.mp4',
          origins: [
            { sourceId: 'phone:s21fe', path: 'DCIM/a.mp4' },
            { sourceId: 'laptop:s21fe', path: 'Camera/a.mp4' },
            { sourceId: 'phone:s21fe', path: '../../etc/passwd' },
          ],
        },
        '/home/me/vault-staging=/mnt/sources/staging',
      ),
    ).toEqual([
      '/mnt/sources/staging/phone-s21fe/DCIM/a.mp4',
      '/home/me/vault-staging/phone-s21fe/DCIM/a.mp4',
      '/mnt/sources/laptop/Camera/a.mp4',
      '/mnt/sources/staging/laptop-s21fe/Camera/a.mp4',
    ]);
  });
});
