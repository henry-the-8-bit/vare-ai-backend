import { Router, type IRouter } from "express";
import catalogRouter from "./catalog.js";
import ordersRouter from "./orders.js";

const router: IRouter = Router({ mergeParams: true });

router.use("/merchants/:merchant_slug", catalogRouter);
router.use("/merchants/:merchant_slug", ordersRouter);

export default router;
