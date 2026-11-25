import type { FastifyInstance } from 'fastify';
import { isSupabaseConfigured } from '../../config/env.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'API & database health check',
      },
    },
    async () => {
      let dbStatus: 'connected' | 'unconfigured' | 'error' = 'unconfigured';
      if (isSupabaseConfigured()) {
        const { error } = await supabaseAdmin.from('categories').select('id').limit(1);
        dbStatus = error ? 'error' : 'connected';
      }

      return {
        status: 'ok',
        service: 'community-support-api',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        database: dbStatus,
      };
    }
  );
}
