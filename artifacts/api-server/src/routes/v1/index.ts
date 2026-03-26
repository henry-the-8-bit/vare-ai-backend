import { Router, type IRouter } from "express";
import catalogRouter from "./catalog.js";
import ordersRouter from "./orders.js";
import platformSpecsRouter from "./platformSpecs.js";

const router: IRouter = Router({ mergeParams: true });

router.use("/merchants/:merchant_slug", catalogRouter);
router.use("/merchants/:merchant_slug", ordersRouter);
router.use("/merchants/:merchant_slug", platformSpecsRouter);

export default router;
