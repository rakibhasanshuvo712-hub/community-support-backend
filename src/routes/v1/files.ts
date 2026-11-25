import type { FastifyInstance } from 'fastify';
import { dbQuery } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
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

      const res = await dbQuery<{
        bucket: string;
        file_name: string;
        mime_type: string;
        data: Buffer;
      }>('SELECT bucket, file_name, mime_type, data FROM file_blobs WHERE id = $1', [id]);

      const file = res.rows[0];
      if (!file) {
        throw new AppError(404, 'NOT_FOUND', 'File not found');
      }

      if (file.bucket === 'private-documents') {
        if (!token || !verifyFileToken(token, id)) {
          throw new AppError(403, 'FORBIDDEN', 'Valid signed token required for private documents');
        }
      }

      return reply
        .header('Content-Type', file.mime_type)
        .header('Content-Disposition', `inline; filename="${file.file_name}"`)
        .header('Cache-Control', file.bucket === 'private-documents' ? 'private, max-age=300' : 'public, max-age=3600')
        .send(file.data);
    }
  );
}
