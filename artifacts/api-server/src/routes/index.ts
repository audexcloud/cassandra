import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import opportunitiesRouter from "./opportunities";
import signalsRouter from "./signals";
import paperTradesRouter from "./paperTrades";
import journalRouter from "./journal";
import openclawRouter from "./openclaw";
import riskRouter from "./risk";
import anthropicRouter from "./anthropic";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(opportunitiesRouter);
router.use(signalsRouter);
router.use(paperTradesRouter);
router.use(journalRouter);
router.use(openclawRouter);
router.use(riskRouter);
router.use(anthropicRouter);

export default router;
