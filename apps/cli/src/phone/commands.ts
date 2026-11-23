import type { Command } from 'commander';

export function registerPhoneCommands(program: Command): void {
  program.command('phone').description('Import from an Android phone over adb (read-only)');
}
