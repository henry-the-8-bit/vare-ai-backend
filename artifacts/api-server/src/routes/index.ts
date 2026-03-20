import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import onboardingRouter from "./onboarding.js";
import agentConfigRouter from "./agentConfig.js";
import testRouter from "./testRoutes.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/onboarding", onboardingRouter);
router.use("/onboarding", agentConfigRouter);
router.use("/test", testRouter);

export default router;
