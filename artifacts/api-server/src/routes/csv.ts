import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import {
  csvUploadsTable,
  csvColumnMappingsTable,
  merchantsTable,
} from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse, paginatedResponse } from "../lib/response.js";
import {
  parseAndSaveCsv,
  confirmMappings,
  runImport,
  suggestMappings,
  VARE_FIELDS,
} from "../services/csvImportService.js";
import { advanceOnboardingPhase } from "../services/phaseService.js";
import { VERTICAL_FIELDS, isValidVertical, getRequiredFields, type VerticalId } from "../data/verticalFields.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv") || file.mimetype === "text/plain") {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are accepted"));
    }
  },
});

router.get("/csv/fields", requireAuth, (req: Request, res: Response) => {
  const vertical = String(req.query["vertical"] ?? "");

  // If a valid vertical is provided, return UCP-compliant vertical-specific fields
  if (vertical && isValidVertical(vertical)) {
    successResponse(res, { fields: VERTICAL_FIELDS[vertical], vertical, protocol: "ucp" });
    return;
  }

  // Default: return the legacy flat field list for backwards compatibility
  successResponse(res, { fields: VARE_FIELDS });
});

router.post("/csv/upload", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  if (!req.file) {
    errorResponse(res, "No file uploaded. Send a CSV as multipart/form-data field 'file'.", "NO_FILE", 400);
    return;
  }

  try {
    const result = await parseAndSaveCsv(req.file.buffer, req.file.originalname, merchantId);

    await db
      .update(merchantsTable)
      .set({ sourceType: "csv", updatedAt: new Date() })
      .where(eq(merchantsTable.id, merchantId));

    void advanceOnboardingPhase(merchantId);

    successResponse(res, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse CSV";
    errorResponse(res, message, "PARSE_ERROR", 400);
  }
});

const uploadJsonSchema = z.union([
  z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    encoding: z.enum(["base64", "utf8"]).optional().default("base64"),
  }),
  z.object({
    filename: z.string().min(1).max(255),
    downloadUrl: z.string().url(),
  }),
]);

router.post("/csv/upload-json", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  req.log.info({ bodyKeys: Object.keys(req.body ?? {}) }, "upload-json incoming");

  const parsed = uploadJsonSchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ body: req.body, errors: parsed.error.flatten() }, "upload-json validation failed");
    errorResponse(res, "Validation failed. Send { filename, content, encoding? } or { filename, downloadUrl }", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const { filename } = parsed.data;

  let buffer: Buffer;

  if ("downloadUrl" in parsed.data) {
    // Download the file from the signed URL (Supabase Storage)
    try {
      const resp = await fetch(parsed.data.downloadUrl);
      if (!resp.ok) {
        errorResponse(res, `Failed to download file: HTTP ${resp.status}`, "DOWNLOAD_ERROR", 400);
        return;
      }
      const arrayBuf = await resp.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to download file";
      errorResponse(res, message, "DOWNLOAD_ERROR", 400);
      return;
    }
  } else {
    // Legacy path: inline base64/utf8 content
    const { content, encoding } = parsed.data;
    try {
      buffer = encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf8");
    } catch {
      errorResponse(res, "Failed to decode file content. Ensure content is valid base64.", "DECODE_ERROR", 400);
      return;
    }
  }

  if (buffer.length === 0) {
    errorResponse(res, "File content is empty", "EMPTY_FILE", 400);
    return;
  }

  if (buffer.length > 50 * 1024 * 1024) {
    errorResponse(res, "File exceeds 50 MB limit", "FILE_TOO_LARGE", 400);
    return;
  }

  try {
    const result = await parseAndSaveCsv(buffer, filename, merchantId);

    await db
      .update(merchantsTable)
      .set({ sourceType: "csv", updatedAt: new Date() })
      .where(eq(merchantsTable.id, merchantId));

    void advanceOnboardingPhase(merchantId);

    successResponse(res, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse CSV";
    errorResponse(res, message, "PARSE_ERROR", 400);
  }
});

router.get("/csv/uploads", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;

  const [rows, [{ cnt }]] = await Promise.all([
    db
      .select({
        id: csvUploadsTable.id,
        filename: csvUploadsTable.filename,
        rowCount: csvUploadsTable.rowCount,
        status: csvUploadsTable.status,
        importedCount: csvUploadsTable.importedCount,
        errorCount: csvUploadsTable.errorCount,
        createdAt: csvUploadsTable.createdAt,
        updatedAt: csvUploadsTable.updatedAt,
      })
      .from(csvUploadsTable)
      .where(eq(csvUploadsTable.merchantId, merchantId))
      .orderBy(desc(csvUploadsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ cnt: db.$count(csvUploadsTable, eq(csvUploadsTable.merchantId, merchantId)) })
      .from(csvUploadsTable)
      .where(eq(csvUploadsTable.merchantId, merchantId)),
  ]);

  paginatedResponse(res, rows, Number(cnt), page, limit);
});

router.get("/csv/uploads/:uploadId", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const uploadId = String(req.params["uploadId"] ?? "");

  const [upload] = await db
    .select({
      id: csvUploadsTable.id,
      filename: csvUploadsTable.filename,
      originalHeaders: csvUploadsTable.originalHeaders,
      rowCount: csvUploadsTable.rowCount,
      status: csvUploadsTable.status,
      importedCount: csvUploadsTable.importedCount,
      errorCount: csvUploadsTable.errorCount,
      createdAt: csvUploadsTable.createdAt,
      updatedAt: csvUploadsTable.updatedAt,
    })
    .from(csvUploadsTable)
    .where(and(eq(csvUploadsTable.id, uploadId), eq(csvUploadsTable.merchantId, merchantId)))
    .limit(1);

  if (!upload) {
    errorResponse(res, "Upload not found", "NOT_FOUND", 404);
    return;
  }

  const mappings = await db
    .select()
    .from(csvColumnMappingsTable)
    .where(eq(csvColumnMappingsTable.csvUploadId, uploadId));

  const suggestions =
    mappings.length === 0
      ? suggestMappings(upload.originalHeaders as string[])
      : null;

  successResponse(res, { ...upload, mappings, suggestions });
});

const mappingsSchema = z.object({
  mappings: z.array(
    z.object({
      csvHeader: z.string().min(1),
      vareField: z.string().nullable(),
    }),
  ),
});

router.post("/csv/uploads/:uploadId/mappings", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const uploadId = String(req.params["uploadId"] ?? "");

  const parsed = mappingsSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  try {
    await confirmMappings(uploadId, merchantId, parsed.data.mappings);
    void advanceOnboardingPhase(merchantId);
    successResponse(res, { confirmed: true, uploadId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to confirm mappings";
    errorResponse(res, message, "MAPPING_ERROR", 400);
  }
});

router.post("/csv/uploads/:uploadId/import", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const uploadId = String(req.params["uploadId"] ?? "");

  try {
    const result = await runImport(uploadId, merchantId);
    void advanceOnboardingPhase(merchantId);
    successResponse(res, {
      uploadId,
      imported: result.imported,
      errors: result.errors,
      message: `Import complete. ${result.imported} products imported, ${result.errors} rows skipped.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    errorResponse(res, message, "IMPORT_ERROR", 400);
  }
});

router.get("/csv/uploads/:uploadId/errors", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const uploadId = String(req.params["uploadId"] ?? "");

  const [upload] = await db
    .select({ errors: csvUploadsTable.errors, errorCount: csvUploadsTable.errorCount })
    .from(csvUploadsTable)
    .where(and(eq(csvUploadsTable.id, uploadId), eq(csvUploadsTable.merchantId, merchantId)))
    .limit(1);

  if (!upload) {
    errorResponse(res, "Upload not found", "NOT_FOUND", 404);
    return;
  }

  successResponse(res, {
    uploadId,
    errorCount: upload.errorCount,
    errors: upload.errors ?? [],
    note: upload.errorCount && upload.errorCount > 500 ? "Only the first 500 errors are stored" : null,
  });
});

router.delete("/csv/uploads/:uploadId", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const uploadId = String(req.params["uploadId"] ?? "");

  const [upload] = await db
    .select({ id: csvUploadsTable.id, status: csvUploadsTable.status })
    .from(csvUploadsTable)
    .where(and(eq(csvUploadsTable.id, uploadId), eq(csvUploadsTable.merchantId, merchantId)))
    .limit(1);

  if (!upload) {
    errorResponse(res, "Upload not found", "NOT_FOUND", 404);
    return;
  }

  if (upload.status === "importing") {
    errorResponse(res, "Cannot delete an upload while import is in progress", "CONFLICT", 409);
    return;
  }

  await db
    .delete(csvUploadsTable)
    .where(eq(csvUploadsTable.id, uploadId));

  successResponse(res, { deleted: true, uploadId });
});

export default router;
