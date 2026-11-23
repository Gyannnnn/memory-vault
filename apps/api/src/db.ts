import { PrismaPg } from '@prisma/adapter-pg';
import { uuidv7 } from 'uuidv7';
import { Prisma, PrismaClient } from './generated/prisma/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
export { Prisma };

export const newId = (): string => uuidv7();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Runs `work` in a transaction whose row-level-security context is `userId`.
 * Every read or write of library tables must go through here.
 */
export async function withUser<T>(db: Db, userId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(userId)) throw new Error('withUser requires a user id');
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return work(tx);
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}
