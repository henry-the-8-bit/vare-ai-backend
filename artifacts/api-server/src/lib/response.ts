import { type Response } from "express";

export function successResponse<T>(res: Response, data: T, statusCode = 200) {
  return res.status(statusCode).json({
    data,
    generated_at: new Date().toISOString(),
  });
}

export function paginatedResponse<T>(
  res: Response,
  data: T[],
  total: number,
  page: number,
  limit: number,
) {
  return res.status(200).json({
    data,
    total,
    page,
    limit,
    generated_at: new Date().toISOString(),
  });
}

export function errorResponse(
  res: Response,
  message: string,
  code: string,
  statusCode = 400,
  details?: unknown,
) {
  return res.status(statusCode).json({
    error: message,
    code,
    details,
  });
}
