import { Router, type IRouter } from "express";
import { successResponse } from "../lib/response.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  successResponse(res, { status: "ok" });
});

export default router;
