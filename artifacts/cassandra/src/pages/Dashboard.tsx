import { useGetDashboardSummary } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatCompactNumber } from "@/lib/format";
import { AlertTriangle, Activity, Target, TrendingUp, ShieldAlert, BarChart3, PieChart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function Dashboard() {
  const { data: summary, isLoading, isError } = useGetDashboardSummary();

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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-card/50">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase flex items-center">
              <PieChart className="h-4 w-4 mr-2" />
              Opportunities by Domain
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {summary.opportunitiesByDomain.map(item => (
                <div key={item.domain} className="flex items-center">
                  <div className="w-32 text-sm uppercase tracking-wider">{item.domain.replace('_', ' ')}</div>
                  <div className="flex-1 ml-4">
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-primary" 
                        style={{ width: `${Math.max(2, (item.count / summary.opportunitiesTotal) * 100)}%` }} 
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

        <Card className="bg-card/50">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase flex items-center">
              <Activity className="h-4 w-4 mr-2" />
              System Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 text-sm">
              <div className="flex justify-between items-center py-2 border-b border-border/50">
                <span className="text-muted-foreground uppercase">Live Execution</span>
                <span className="font-bold text-muted-foreground">DISABLED (PAPER ONLY)</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border/50">
                <span className="text-muted-foreground uppercase">Kill Switch</span>
                <span className={`font-bold ${summary.killSwitchEngaged ? 'text-destructive' : 'text-emerald-500'}`}>
                  {summary.killSwitchEngaged ? 'ENGAGED' : 'DISARMED'}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border/50">
                <span className="text-muted-foreground uppercase">Last OpenClaw Cycle</span>
                <span className="font-mono">{summary.lastCycleAt ? new Date(summary.lastCycleAt).toLocaleTimeString() : 'Unknown'}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
