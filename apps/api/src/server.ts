import { closeContext, createContext } from './context';
import { env } from './env';
import { createApp } from './http/app';
import { createJobs } from './workers/queues';

const config = env();
const context = await createContext(config);
context.jobs = createJobs(context.redis);
const server = createApp(context).listen(config.API_PORT, () => {
  context.logger.info(`API listening on ${config.API_PUBLIC_URL}`);
});

const shutdown = () => {
  server.close(() => {
    void closeContext(context).then(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
