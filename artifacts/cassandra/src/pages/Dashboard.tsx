import { useGetDashboardSummary, useGetBacktestSummary } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatCompactNumber, formatDateTime } from "@/lib/format";
import { AlertTriangle, Activity, Target, TrendingUp, ShieldAlert, BarChart3, PieChart, Bell, LineChart, Shuffle, Bot, Gauge, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";

export default function Dashboard() {
  const { data: summary, isLoading, isError } = useGetDashboardSummary();
  const { data: backtest } = useGetBacktestSummary();
  const headline30d = backtest?.headlines.find((h) => h.lookbackDays === 30);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Terminal Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !summary) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Terminal Dashboard</h1>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>System Error</AlertTitle>
          <AlertDescription>Failed to fetch dashboard telemetry. OpenClaw orchestrator may be offline.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Terminal Dashboard</h1>
          <p className="text-muted-foreground">System telemetry & paper capital allocation.</p>
        </div>
        
        {summary.killSwitchEngaged && (
          <div className="flex items-center px-3 py-1.5 bg-destructive/10 border border-destructive/30 text-destructive rounded font-bold uppercase tracking-wider text-sm animate-pulse">
            <ShieldAlert className="w-4 h-4 mr-2" />
            Kill Switch Engaged
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">Paper P&L (Realized)</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${summary.paperRealizedPnl >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>
              {summary.paperRealizedPnl >= 0 ? '+' : ''}{formatCurrency(summary.paperRealizedPnl)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Unrealized: <span className={summary.paperUnrealizedPnl >= 0 ? 'text-emerald-500' : 'text-destructive'}>{summary.paperUnrealizedPnl >= 0 ? '+' : ''}{formatCurrency(summary.paperUnrealizedPnl)}</span>
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">Win Rate</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">
              {formatPercent(summary.paperWinRate)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.paperOpenCount} open positions
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">Universe Edge</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">
              {formatPercent(summary.topEdge)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Max absolute edge available
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/50">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">24h Signals</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {formatCompactNumber(summary.signalsLast24h)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {formatCompactNumber(summary.opportunitiesTotal)} active opportunities
            </p>
          </CardContent>
        </Card>

        {/* 30D Calibration tile — links into the Backtest page. */}
        <Link
          href="/backtest?lookbackDays=30"
          className="block group"
          data-testid="dashboard-tile-calibration"
        >
          <Card className="bg-card/50 group-hover:border-primary/40 transition-colors h-full">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase">
                30D Calibration
              </CardTitle>
              <Gauge className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {headline30d ? (
                <>
                  <div className="text-2xl font-bold text-primary">
                    Brier{" "}
                    {headline30d.brierScore != null
                      ? headline30d.brierScore.toFixed(3)
                      : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Hit {formatPercent(headline30d.hitRate ?? 0)} ·{" "}
                    {headline30d.totalEntries} resolved
                  </p>
                </>
              ) : (
                <>
                  <div className="text-2xl font-bold text-muted-foreground">—</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    No backtest yet. Open page to run.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Risk alerts banner: render anything backend flagged so the operator
          can react before drilling into individual surfaces. */}
      {summary.alerts && summary.alerts.length > 0 && (
        <Card className="bg-card/50 border-destructive/30">
          <CardHeader className="pb-2 border-b border-destructive/20">
            <CardTitle className="text-sm font-medium uppercase flex items-center text-destructive">
              <Bell className="h-4 w-4 mr-2" /> Active Alerts ({summary.alerts.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-2">
            {summary.alerts.map((a, i) => {
              const cls =
                a.severity === "critical"
                  ? "border-destructive/40 text-destructive bg-destructive/10"
                  : a.severity === "warning"
                    ? "border-amber-500/40 text-amber-500 bg-amber-500/10"
                    : "border-primary/40 text-primary bg-primary/10";
              return (
                <div
                  key={`${a.kind}-${i}`}
                  className={`flex items-start gap-3 p-2 rounded border ${cls}`}
                >
                  <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="uppercase text-[10px] tracking-wider">
                        {a.severity}
                      </Badge>
                      <span className="font-mono text-xs uppercase opacity-80">{a.kind}</span>
                    </div>
                    <div className="mt-1">{a.message}</div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Top opportunities preview — pulled directly from the backend
            summary so the dashboard doesn't depend on a separate query. */}
        <Card className="bg-card/50 lg:col-span-2">
          <CardHeader className="pb-2 border-b border-border/50">
            <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
              <TrendingUp className="h-4 w-4 mr-2" /> Top Opportunities
              <Link href="/top" className="ml-auto text-[10px] text-muted-foreground hover:text-primary uppercase tracking-wider">
                See all →
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {summary.topOpportunities && summary.topOpportunities.length > 0 ? (
              <div className="divide-y divide-border/30">
                {summary.topOpportunities.slice(0, 5).map((o) => {
                  // Surface signal attribution inline so the operator can see
                  // which top picks were driven by ambient signals — and by
                  // how much — without clicking through to the detail page.
                  const hasShift = o.appliedSignalCount > 0;
                  const shiftPts = o.ambientShift * 100;
                  const shiftSign = shiftPts >= 0 ? "+" : "";
                  const shiftClass =
                    shiftPts > 0
                      ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/5"
                      : shiftPts < 0
                        ? "text-red-400 border-red-500/40 bg-red-500/5"
                        : "text-muted-foreground border-border/40";
                  return (
                    <Link
                      key={o.id}
                      href={`/opportunities/${o.id}`}
                      className="flex flex-col gap-1.5 p-3 text-sm hover:bg-secondary/30 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="uppercase text-[10px] tracking-wider shrink-0">
                          {o.domain.replace('_', ' ')}
                        </Badge>
                        <span className="line-clamp-1 flex-1 font-medium">{o.question}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatPercent(o.modelProb)} vs {formatPercent(o.marketProb)}
                        </span>
                        <span className={`font-mono text-xs font-bold ${o.edge > 0 ? "text-emerald-500" : "text-destructive"}`}>
                          {o.edge > 0 ? "+" : ""}{formatPercent(o.edge)}
                        </span>
                      </div>
                      {hasShift ? (
                        <div className="flex items-center gap-2 pl-[64px]">
                          <Badge
                            variant="outline"
                            className={`text-[10px] uppercase tracking-wider font-mono gap-1 ${shiftClass}`}
                            data-testid={`badge-applied-signals-${o.id}`}
                          >
                            <Zap className="h-3 w-3" />
                            {shiftSign}{shiftPts.toFixed(1)} pts from {o.appliedSignalCount} signal{o.appliedSignalCount === 1 ? "" : "s"}
                          </Badge>
                        </div>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No opportunities ranked yet.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Random Walk entry point lives on the dashboard so the operator
            can break out of domain myopia without leaving the home screen. */}
        <Card className="bg-card/50 border-primary/20">
          <CardHeader className="pb-2 border-b border-border/50">
            <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
              <Shuffle className="h-4 w-4 mr-2" /> Random Walk
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 text-sm space-y-3">
            <p className="text-muted-foreground text-xs">
              Surface a weighted-random opportunity to challenge the current focus.
            </p>
            <Link
              href="/random"
              className="inline-flex items-center justify-center w-full rounded-md border border-primary/40 text-primary bg-primary/5 hover:bg-primary/10 px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors"
            >
              Spin universe →
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Open paper trades — drives realized/unrealized headline numbers
            above; surfacing the rows here gives one-click context. */}
        <Card className="bg-card/50">
          <CardHeader className="pb-2 border-b border-border/50">
            <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
              <LineChart className="h-4 w-4 mr-2" /> Active Paper Trades
              <Link href="/paper" className="ml-auto text-[10px] text-muted-foreground hover:text-primary uppercase tracking-wider">
                Manage →
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {summary.activeTrades && summary.activeTrades.length > 0 ? (
              <div className="divide-y divide-border/30">
                {summary.activeTrades.slice(0, 6).map((t) => (
                  <Link
                    key={t.id}
                    href={`/opportunities/${t.opportunityId}`}
                    className="flex items-center gap-3 p-3 text-sm hover:bg-secondary/30 transition-colors"
                  >
                    <Badge
                      variant="outline"
                      className={`uppercase text-[10px] tracking-wider shrink-0 ${t.direction === "yes" ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}
                    >
                      {t.direction}
                    </Badge>
                    <span className="line-clamp-1 flex-1 font-medium">{t.question || t.marketKey}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatCurrency(t.sizeUsd)}
                    </span>
                    <span className={`font-mono text-xs font-bold ${t.unrealizedPnl >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {t.unrealizedPnl >= 0 ? "+" : ""}{formatCurrency(t.unrealizedPnl)}
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No open paper positions.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase flex items-center">
                <PieChart className="h-4 w-4 mr-2" />
                Opportunities by Domain
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {summary.opportunitiesByDomain.map(item => (
                  <div key={item.domain} className="flex items-center">
                    <div className="w-32 text-sm uppercase tracking-wider">{item.domain.replace('_', ' ')}</div>
                    <div className="flex-1 ml-4">
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${Math.max(2, (item.count / Math.max(1, summary.opportunitiesTotal)) * 100)}%` }}
                        />
                      </div>
                    </div>
                    <div className="ml-4 w-12 text-right text-sm font-medium">
                      {formatCompactNumber(item.count)}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Agent + system status block: combines orchestrator vitals with
              the kill-switch / live-exec posture so the operator gets one
              authoritative panel for "is the brain on?" */}
          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase flex items-center">
                <Bot className="h-4 w-4 mr-2" />
                Agent &amp; System Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between items-center py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground uppercase text-xs">Orchestrator</span>
                  <span className={`font-bold uppercase text-xs ${summary.agentStatus?.openclawRunning ? "text-primary" : "text-muted-foreground"}`}>
                    {summary.agentStatus?.openclawRunning ? "RUNNING" : "SLEEPING"}
                    <span className="text-muted-foreground ml-2 font-mono">
                      {summary.agentStatus?.cycleIntervalSec ?? 0}s
                    </span>
                  </span>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground uppercase text-xs">Last Cycle</span>
                  <span className="font-mono text-xs">
                    {summary.agentStatus?.lastCycleAt
                      ? formatDateTime(summary.agentStatus.lastCycleAt)
                      : summary.lastCycleAt
                        ? formatDateTime(summary.lastCycleAt)
                        : "Never"}
                  </span>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground uppercase text-xs">Last Daily Brief</span>
                  <span className="font-mono text-xs">
                    {summary.agentStatus?.lastDailyBriefAt
                      ? formatDateTime(summary.agentStatus.lastDailyBriefAt)
                      : "Never"}
                  </span>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground uppercase text-xs">Scoring Model</span>
                  <span className="font-mono text-xs">
                    {summary.agentStatus?.scoringModelVersion ?? "default"}
                  </span>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground uppercase text-xs">Kill Switch</span>
                  <span className={`font-bold text-xs ${summary.killSwitchEngaged ? "text-destructive" : "text-emerald-500"}`}>
                    {summary.killSwitchEngaged ? "ENGAGED" : "DISARMED"}
                  </span>
                </div>
                <div className="flex justify-between items-center py-1.5">
                  <span className="text-muted-foreground uppercase text-xs">Live Execution</span>
                  <span className="font-bold text-xs text-muted-foreground">
                    DISABLED (PAPER ONLY)
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
