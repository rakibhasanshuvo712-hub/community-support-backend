import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { dbQuery } from '../../lib/db.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'API & Neon PostgreSQL health check',
      },
    },
    async () => {
      let dbStatus: 'connected' | 'unconfigured' | 'error' = 'unconfigured';
      if (isDatabaseConfigured()) {
        try {
          await dbQuery('SELECT 1');
          dbStatus = 'connected';
        } catch {
          dbStatus = 'error';
        }
      }

      return {
        status: 'ok',
        service: 'community-support-api',
        version: '1.0.0',
        provider: 'neon-postgres',
        timestamp: new Date().toISOString(),
        database: dbStatus,
      };
    }
  );
}
