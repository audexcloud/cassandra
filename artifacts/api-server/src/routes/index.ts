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
import agentStructuredRouter from "./agentStructured";
import backtestRouter from "./backtest";
import winnerAccountsRouter from "./winnerAccounts";

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
router.use(agentStructuredRouter);
router.use(backtestRouter);
router.use(winnerAccountsRouter);

export default router;
