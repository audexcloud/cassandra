import { useMemo, useState } from "react";
import { useSearch, Link } from "wouter";
import {
  useGetBacktestSummary,
  useGetBacktestCalibration,
  useRunBacktest,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ZAxis,
  Legend,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  RefreshCcw,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { formatPercent } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetBacktestSummaryQueryKey,
  getGetBacktestCalibrationQueryKey,
} from "@workspace/api-client-react";

type Lookback = 30 | 90 | 365;

function parseQuery(search: string): { scope?: string; lookback?: Lookback } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const scope = params.get("scope") ?? undefined;
  const lbRaw = params.get("lookbackDays");
  const lb = lbRaw ? Number(lbRaw) : undefined;
  return {
    scope,
    lookback: lb === 30 || lb === 90 || lb === 365 ? lb : undefined,
  };
}

function scopeLabel(scope: string): string {
  if (scope === "overall") return "OVERALL";
  if (scope.startsWith("domain:")) return `DOMAIN: ${scope.slice("domain:".length).toUpperCase()}`;
  if (scope.startsWith("signalCategory:")) {
    return `SIGNAL: ${scope
      .slice("signalCategory:".length)
      .replace(/_/g, " ")
      .toUpperCase()}`;
  }
  return scope.toUpperCase();
}

function formatScore(v: number | null | undefined, digits = 3): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

export default function Backtest() {
  const search = useSearch();
  const initial = useMemo(() => parseQuery(search), [search]);
  const [scope, setScope] = useState<string>(initial.scope ?? "overall");
  const [lookback, setLookback] = useState<Lookback>(initial.lookback ?? 30);
  const { toast } = useToast();
  const qc = useQueryClient();

  const summary = useGetBacktestSummary();
  const calibration = useGetBacktestCalibration({
    scope,
    lookbackDays: lookback,
  });
  const run = useRunBacktest({
    mutation: {
      onSuccess: () => {
        toast({ title: "Backtest refreshed", description: "Recomputed for all standard windows." });
        qc.invalidateQueries({ queryKey: getGetBacktestSummaryQueryKey() });
        qc.invalidateQueries({
          queryKey: getGetBacktestCalibrationQueryKey({
            scope,
            lookbackDays: lookback,
          }),
        });
      },
      onError: (err) => {
        toast({
          title: "Backtest failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const headlines = summary.data?.headlines ?? [];
  const scopes = summary.data?.scopes ?? [];

  const calibrationData = useMemo(() => {
    const buckets = calibration.data?.buckets ?? [];
    return buckets
      .filter((b) => b.count > 0)
      .map((b) => ({
        predicted: b.predictedAvg,
        realized: b.realizedRate,
        count: b.count,
        bucket: `${(b.bucketLow * 100).toFixed(0)}–${(b.bucketHigh * 100).toFixed(0)}%`,
      }));
  }, [calibration.data]);

  const hitRateData = (calibration.data?.hitRateByBucket ?? []).map((b, i) => ({
    bucket: `${(b.low * 100).toFixed(0)}–${(b.high * 100).toFixed(0)}%`,
    hitRate: b.hitRate,
    count: b.count,
    idx: i,
  }));

  return (
    <div className="space-y-6" data-testid="page-backtest">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Backtest</h1>
          <p className="text-muted-foreground">
            Calibration of forecasts vs. realised outcomes from the journal.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={scope} onValueChange={(v) => setScope(v)}>
            <SelectTrigger className="w-[260px] bg-card" data-testid="scope-select">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>
              {(scopes.length > 0 ? scopes : ["overall"]).map((s) => (
                <SelectItem key={s} value={s} data-testid={`scope-option-${s}`}>
                  {scopeLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(lookback)}
            onValueChange={(v) => setLookback(Number(v) as Lookback)}
          >
            <SelectTrigger className="w-[140px] bg-card" data-testid="lookback-select">
              <SelectValue placeholder="Window" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 DAYS</SelectItem>
              <SelectItem value="90">90 DAYS</SelectItem>
              <SelectItem value="365">365 DAYS</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate()}
            data-testid="run-backtest"
          >
            <RefreshCcw className={`w-4 h-4 mr-2 ${run.isPending ? "animate-spin" : ""}`} />
            Re-run
          </Button>
        </div>
      </div>

      {/* Headline metric tiles, one per standard lookback. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {summary.isLoading ? (
          [30, 90, 365].map((lb) => <Skeleton key={lb} className="h-28 w-full" />)
        ) : (
          headlines.map((h) => (
            <Card
              key={h.lookbackDays}
              className={`bg-card/50 ${
                h.lookbackDays === lookback ? "border-primary/40" : ""
              }`}
              data-testid={`headline-${h.lookbackDays}d`}
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground uppercase">
                  {h.lookbackDays}D Calibration
                </CardTitle>
                <Target className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">
                  Brier {formatScore(h.brierScore)}
                </div>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-3">
                  <span>Log-loss {formatScore(h.logLoss)}</span>
                  <span>Hit {formatPercent(h.hitRate ?? 0)}</span>
                  <span>{h.totalEntries} resolved</span>
                </p>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {calibration.isError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>No backtest run yet</AlertTitle>
          <AlertDescription>
            Click "Re-run" to compute calibration for the standard lookback windows.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {/* Calibration curve: predicted vs realised, with diagonal target. */}
          <Card className="bg-card/50">
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
                <TrendingUp className="h-4 w-4 mr-2" />
                Calibration Curve — {scopeLabel(scope)} · {lookback}D
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {calibration.isLoading ? (
                <Skeleton className="h-[320px] w-full" />
              ) : calibrationData.length === 0 ? (
                <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
                  No resolved entries in this window for this scope.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <ScatterChart margin={{ top: 10, right: 10, bottom: 30, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis
                      type="number"
                      dataKey="predicted"
                      domain={[0, 1]}
                      tickFormatter={(v) => `${Math.round(v * 100)}%`}
                      label={{ value: "Predicted probability", position: "insideBottom", offset: -10 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="realized"
                      domain={[0, 1]}
                      tickFormatter={(v) => `${Math.round(v * 100)}%`}
                      label={{ value: "Realised rate", angle: -90, position: "insideLeft" }}
                    />
                    <ZAxis type="number" dataKey="count" range={[60, 360]} name="count" />
                    <Tooltip
                      cursor={{ strokeDasharray: "3 3" }}
                      formatter={(value: number, name: string) => {
                        if (name === "predicted" || name === "realized") {
                          return [`${(value * 100).toFixed(1)}%`, name];
                        }
                        return [value, name];
                      }}
                    />
                    <Legend verticalAlign="top" height={24} />
                    <ReferenceLine
                      segment={[
                        { x: 0, y: 0 },
                        { x: 1, y: 1 },
                      ]}
                      stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="4 4"
                      ifOverflow="extendDomain"
                    />
                    <Scatter
                      name="Buckets (sized by N)"
                      data={calibrationData}
                      fill="hsl(var(--primary))"
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                Each dot is a probability bucket. Bucket size scales with the number of
                resolved entries inside it. A perfectly calibrated forecaster sits on the
                dashed diagonal — points above mean we underpredict the YES rate, points
                below mean we overpredict.
              </p>
            </CardContent>
          </Card>

          {/* Hit rate by confidence bucket — separate chart because the
              x-axis is |2p-1| not p. */}
          <Card className="bg-card/50">
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
                <Activity className="h-4 w-4 mr-2" />
                Hit Rate by Confidence Bucket
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {calibration.isLoading ? (
                <Skeleton className="h-[260px] w-full" />
              ) : hitRateData.every((b) => b.count === 0) ? (
                <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
                  No data.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={hitRateData} margin={{ top: 10, right: 10, bottom: 30, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis
                      dataKey="bucket"
                      label={{ value: "Confidence |2p-1|", position: "insideBottom", offset: -10 }}
                    />
                    <YAxis
                      domain={[0, 1]}
                      tickFormatter={(v) => `${Math.round(v * 100)}%`}
                      label={{ value: "Hit rate", angle: -90, position: "insideLeft" }}
                    />
                    <Tooltip
                      formatter={(v: number, n: string) =>
                        n === "hitRate"
                          ? [`${(v * 100).toFixed(1)}%`, "Hit rate"]
                          : [v, n]
                      }
                    />
                    <Bar dataKey="hitRate" fill="hsl(var(--primary))" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Per-domain quick links so the operator can pivot scope from
              this page in one click. */}
          <Card className="bg-card/50">
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
                <TrendingDown className="h-4 w-4 mr-2" />
                Other Scopes
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 flex flex-wrap gap-2">
              {scopes.length === 0 ? (
                <span className="text-sm text-muted-foreground">No scopes yet.</span>
              ) : (
                scopes.map((s) => (
                  <Button
                    key={s}
                    variant={s === scope ? "default" : "outline"}
                    size="sm"
                    onClick={() => setScope(s)}
                    data-testid={`scope-chip-${s}`}
                  >
                    <Badge
                      variant="secondary"
                      className="mr-2 uppercase text-[9px] tracking-wider"
                    >
                      {s.startsWith("domain:")
                        ? "DOMAIN"
                        : s.startsWith("signalCategory:")
                          ? "SIGNAL"
                          : "ALL"}
                    </Badge>
                    {scopeLabel(s)}
                  </Button>
                ))
              )}
            </CardContent>
          </Card>

          <div className="text-xs text-muted-foreground">
            <Link href="/journal" className="underline hover:text-primary">
              ← Back to Journal
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
