import { describe, expect, it } from 'vitest';
import { adbArgs, assertAllowed, parseDevices, parseDf, parseSha256Line, parseStatLine } from './adb';

describe('adb allowlist', () => {
  it.each(
    [
      adbArgs({ op: 'devices' }),
      adbArgs({ op: 'getprop', serial: 'R1', property: 'ro.product.model' }),
      adbArgs({ op: 'df', serial: 'R1', path: '/storage/emulated/0' }),
      adbArgs({ op: 'list-files', serial: 'R1', root: '/storage/emulated/0/DCIM' }),
      adbArgs({ op: 'list-special', serial: 'R1', root: '/storage/emulated/0' }),
      adbArgs({
        op: 'sha256',
        serial: 'R1',
        paths: ["/sdcard/it's; rm -rf $(x) `y` > z.jpg", '/sdcard/b.mp4'],
      }),
      adbArgs({ op: 'pull', serial: 'R1', remote: '/sdcard/DCIM/a.jpg', local: '/tmp/a.jpg' }),
    ].map((args) => [args]),
  )('allows the read-only template %j', (args) => {
    expect(() => assertAllowed(args)).not.toThrow();
  });

  it.each([
    [['push', 'a', '/sdcard/a']],
    [['install', 'x.apk']],
    [['-s', 'R1', 'push', 'a', '/sdcard/a']],
    [['-s', 'R1', 'uninstall', 'com.whatsapp']],
    [['-s', 'R1', 'shell', 'rm -rf /sdcard/DCIM']],
    [['-s', 'R1', 'shell', 'mv /sdcard/a /sdcard/b']],
    [['-s', 'R1', 'shell', "find '/sdcard' -delete"]],
    [['-s', 'R1', 'shell', "find '/sdcard' -exec rm {} +"]],
    [['-s', 'R1', 'shell', "find '/sdcard'; rm -rf /sdcard"]],
    [['-s', 'R1', 'shell', "sha256sum -- '/sdcard/a' && touch /sdcard/b"]],
    [['-s', 'R1', 'shell', "sha256sum -- '/sdcard/a' > /sdcard/out"]],
    [['-s', 'R1', 'shell', 'getprop $(rm -rf /sdcard)']],
    [['-s', 'R1', 'shell', 'getprop', 'x']],
    [['-s', 'R1', 'pull', '/sdcard/a', '/tmp/a']],
    [['shell', 'ls']],
  ])('rejects %j', (args) => {
    expect(() => assertAllowed(args)).toThrow(/refusing adb command/);
  });

  it('quotes paths so they cannot break out of the command', () => {
    const [, , , command] = adbArgs({ op: 'sha256', serial: 'R1', paths: ["/sdcard/it's.jpg"] });
    expect(command).toBe("sha256sum -- '/sdcard/it'\\''s.jpg'");
  });
});

describe('adb output parsing', () => {
  it('parses devices', () => {
    const output = [
      'List of devices attached',
      'RZCX30G3QLK            device usb:1-1 product:r9qxxx model:SM_G990E device:r9q transport_id:1',
      'ABC unauthorized usb:1-2 transport_id:2',
      '',
    ].join('\n');
    expect(parseDevices(output)).toEqual([
      { serial: 'RZCX30G3QLK', state: 'device', model: 'SM_G990E' },
      { serial: 'ABC', state: 'unauthorized' },
    ]);
  });

  it('parses stat lines, including names with pipes and spaces', () => {
    expect(parseStatLine('2595643|1769346129|/storage/emulated/0/DCIM/a | b.mp4')).toEqual({
      size: 2595643,
      mtimeSeconds: 1769346129,
      path: '/storage/emulated/0/DCIM/a | b.mp4',
    });
    expect(parseStatLine('garbage')).toBeNull();
  });

  it('parses sha256sum lines', () => {
    const hash = 'a'.repeat(64);
    expect(parseSha256Line(`${hash}  /storage/emulated/0/x y.jpg`)).toEqual({
      sha256: hash,
      path: '/storage/emulated/0/x y.jpg',
    });
  });

  it('parses df -k', () => {
    const output =
      'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/fuse 235000000 194000000 41000000 83% /storage/emulated';
    expect(parseDf(output)).toEqual({
      totalBytes: 235000000 * 1024,
      usedBytes: 194000000 * 1024,
      freeBytes: 41000000 * 1024,
    });
  });
});
