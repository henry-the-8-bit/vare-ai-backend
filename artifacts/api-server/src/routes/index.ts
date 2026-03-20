import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import onboardingRouter from "./onboarding.js";
import agentConfigRouter from "./agentConfig.js";
import connectRouter from "./connect.js";
import syncRouter from "./sync.js";
import testRouter from "./testRoutes.js";
import healthScanRouter from "./healthScan.js";
import normalizationRouter from "./normalization.js";
import fitmentRouter from "./fitment.js";
import probeRouter from "./probe.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/onboarding", onboardingRouter);
router.use("/onboarding", agentConfigRouter);
router.use("/onboarding", connectRouter);
router.use("/onboarding", syncRouter);
router.use("/onboarding", healthScanRouter);
router.use("/onboarding", normalizationRouter);
router.use("/onboarding", fitmentRouter);
router.use("/onboarding", probeRouter);
router.use("/test", testRouter);

export default router;
