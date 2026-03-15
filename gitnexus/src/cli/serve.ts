import { createServer } from '../server/api.js';

export const serveCommand = async (options?: { port?: string; host?: string; corsOrigins?: string }) => {
  const port = Number(options?.port ?? 4747);
  const host = options?.host ?? '127.0.0.1';

  // Pass extra CORS origins to env so the server picks them up
  if (options?.corsOrigins) {
    const existing = process.env.GITNEXUS_CORS_ORIGINS ?? '';
    process.env.GITNEXUS_CORS_ORIGINS = existing
      ? `${existing},${options.corsOrigins}`
      : options.corsOrigins;
  }

  await createServer(port, host);
};
