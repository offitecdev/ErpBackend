import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodError } from 'zod';

interface ValidationSchemas {
    body?: ZodType;
    query?: ZodType;
    params?: ZodType;
}

const formatIssues = (error: ZodError) =>
    error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
    }));

/**
 * Strict request validation via Zod. Parsed (and thereby coerced/stripped)
 * values replace the originals, so handlers downstream only ever see data the
 * schema approved. Validation failures answer 400 with field-level messages —
 * never internals.
 *
 * Usage: router.post('/x', validate({ body: mySchema }), handler)
 */
export const validate = ({ body, query, params }: ValidationSchemas) =>
    (req: Request, res: Response, next: NextFunction): void => {
        try {
            if (params) Object.assign(req.params, params.parse(req.params));
            if (query) Object.assign(req.query, query.parse(req.query));
            if (body) req.body = body.parse(req.body);
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                res.status(400).json({
                    error: 'Doğrulama hatası: gönderilen veriler geçersiz.',
                    details: formatIssues(error),
                });
                return;
            }
            next(error);
        }
    };
