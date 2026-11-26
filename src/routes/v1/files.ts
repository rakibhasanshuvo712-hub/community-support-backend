import type { FastifyInstance } from 'fastify';
import type { Binary } from 'mongodb';
import { AppError } from '../../lib/errors.js';
import { getDb } from '../../lib/mongo.js';
import { verifyFileToken } from '../../middleware/auth.js';

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Files'],
        summary: 'Serve uploaded image or signed private document',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { token } = request.query;

      const db = await getDb();
      const file = await db.collection('file_blobs').findOne({ id });
      if (!file) {
        throw new AppError(404, 'NOT_FOUND', 'File not found');
      }

      if (file.bucket === 'private-documents') {
        if (!token || !verifyFileToken(token, id)) {
          throw new AppError(403, 'FORBIDDEN', 'Valid signed token required for private documents');
        }
      }

      const raw = file.data as Binary | Buffer;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer);

      return reply
        .header('Content-Type', String(file.mime_type))
        .header('Content-Disposition', `inline; filename="${String(file.file_name)}"`)
        .header(
          'Cache-Control',
          file.bucket === 'private-documents' ? 'private, max-age=300' : 'public, max-age=3600'
        )
        .send(buf);
    }
  );
}
