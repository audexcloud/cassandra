import { useGetDashboardSummary, useGetOpportunity, useGetRiskConfig, useCreatePaperTrade } from "@workspace/api-client-react";
import { Link, useParams } from "wouter";
import { formatPercent, formatCurrency, formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ArrowLeft, ExternalLink, Activity, Info, ShieldAlert, LineChart, Hand, Target, Eye, ArrowUpRight, ArrowDownRight, Minus, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getGetOpportunityQueryKey, getListPaperTradesQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";

const tradeSchema = z.object({
  direction: z.enum(["yes", "no"], { required_error: "Select a direction" }),
  sizeUsd: z.coerce.number().min(1, "Size must be at least $1"),
  rationale: z.string().optional(),
});

type TradeFormValues = z.infer<typeof tradeSchema>;

export default function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const oppId = parseInt(id || "0", 10);

  const { data: opp, isLoading, isError } = useGetOpportunity(oppId);
  const { data: riskConfig } = useGetRiskConfig();
  const { data: summary } = useGetDashboardSummary();
  const createTrade = useCreatePaperTrade();
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<TradeFormValues>({
    resolver: zodResolver(tradeSchema),
    defaultValues: {
      direction: undefined,
      sizeUsd: 100,
      rationale: "",
    }
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-16 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-6">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !opp) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load opportunity details.</AlertDescription>
        </Alert>
        <Link href="/opportunities" className="text-primary hover:underline inline-flex items-center text-sm">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Universe
        </Link>
      </div>
    );
  }

  const isKillSwitchEngaged = riskConfig?.killSwitchEngaged || summary?.killSwitchEngaged;
  
  // Use config to cap max size
  const bankroll = riskConfig?.bankrollUsd || 100000;
  const recommendedSize = bankroll * opp.kellyFraction;
  const maxSize = riskConfig?.maxPositionUsd || recommendedSize * 2; // Fallback cap

  // "Why not trade?" gate evaluation — mirrors evaluateRiskGate() on the server
  // so the operator sees every blocking reason BEFORE attempting to submit.
  // The server still re-validates on POST /paper-trades; this is a UX shortcut.
  const proposedSize = form.watch("sizeUsd") || 0;
  const gateReasons: string[] = [];
  if (riskConfig?.killSwitchEngaged) {
    gateReasons.push("Kill switch is engaged — all new trades are blocked.");
  }
  if (riskConfig?.liveExecutionEnabled) {
    gateReasons.push("Live execution is permanently disabled in this build.");
  }
  if (riskConfig?.watchOnlyMode) {
    gateReasons.push("Watch-only mode is on — observation only, no new paper trades may be opened.");
  }
  if (
    typeof riskConfig?.maxSpread === "number" &&
    typeof opp.spread === "number" &&
    opp.spread > riskConfig.maxSpread
  ) {
    gateReasons.push(
      `Bid/ask spread ${formatPercent(opp.spread)} exceeds ceiling ${formatPercent(riskConfig.maxSpread)}.`,
    );
  }
  if (riskConfig && proposedSize > (riskConfig.maxPositionUsd || 0)) {
    gateReasons.push(
      `Size ${formatCurrency(proposedSize)} exceeds max position ${formatCurrency(riskConfig.maxPositionUsd || 0)}.`,
    );
  }
  if (
    typeof riskConfig?.minConfidence === "number" &&
    opp.confidence < riskConfig.minConfidence
  ) {
    gateReasons.push(
      `Confidence ${formatPercent(opp.confidence)} below floor ${formatPercent(riskConfig.minConfidence)}.`,
    );
  }
  if (
    typeof riskConfig?.minLiquidityUsd === "number" &&
    opp.liquidity < riskConfig.minLiquidityUsd
  ) {
    gateReasons.push(
      `Liquidity ${formatCurrency(opp.liquidity)} below floor ${formatCurrency(riskConfig.minLiquidityUsd)}.`,
    );
  }
  if (
    typeof riskConfig?.minEdgeScore === "number" &&
    opp.edgeScore < riskConfig.minEdgeScore
  ) {
    gateReasons.push(
      `Edge score ${opp.edgeScore.toFixed(3)} below floor ${riskConfig.minEdgeScore.toFixed(3)}.`,
    );
  }
  const tradeBlocked = gateReasons.length > 0;

  const onSubmit = (data: TradeFormValues) => {
    createTrade.mutate({
      data: {
        opportunityId: opp.id,
        direction: data.direction,
        sizeUsd: data.sizeUsd,
        rationale: data.rationale,
      }
    }, {
      onSuccess: () => {
        toast({ title: "Paper Trade Executed", description: `Opened ${data.direction.toUpperCase()} position for ${formatCurrency(data.sizeUsd)}.` });
        queryClient.invalidateQueries({ queryKey: getGetOpportunityQueryKey(oppId) });
        queryClient.invalidateQueries({ queryKey: getListPaperTradesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        form.reset({ ...data, rationale: "" });
      },
      onError: (err: unknown) => {
        // Surface the server's structured `reasons` array (from the risk
        // gate) so the user sees exactly which gate fired even if the
        // client-side pre-check missed it.
        let description = "Could not open paper position.";
        const e = err as { response?: { data?: { reasons?: Array<{ message?: string }>; error?: string } }; message?: string };
        const reasons = e?.response?.data?.reasons;
        if (Array.isArray(reasons) && reasons.length > 0) {
          description = reasons.map((r) => r?.message).filter(Boolean).join(" ");
        } else if (e?.response?.data?.error) {
          description = e.response.data.error;
        } else if (e?.message) {
          description = e.message;
        }
        toast({ title: "Execution Failed", description, variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <Link href="/opportunities" className="text-muted-foreground hover:text-primary transition-colors inline-flex items-center text-sm font-medium uppercase tracking-wider">
        <ArrowLeft className="w-4 h-4 mr-2" /> Universe
      </Link>

      <div className="border-b border-border/50 pb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            <Badge variant="outline" className="uppercase tracking-wider text-xs px-2 py-1 rounded-sm border-primary/50 text-primary bg-primary/5">
              {opp.domain.replace('_', ' ')}
            </Badge>
            <Badge variant="outline" className="uppercase tracking-wider text-xs rounded-sm text-muted-foreground">
              {opp.source}
            </Badge>
          </div>
          <div className="text-xs font-mono text-muted-foreground flex items-center">
            <Activity className="w-3 h-3 mr-1" /> Updated: {formatDateTime(opp.updatedAt)}
          </div>
        </div>
        <h1 className="text-2xl md:text-3xl lg:text-4xl font-medium tracking-tight mb-2">
          {opp.question}
        </h1>
        {opp.url && (
          <a href={opp.url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center text-sm">
            View Source <ExternalLink className="w-3 h-3 ml-1" />
          </a>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Model Prob</div>
            <div className="text-3xl font-bold text-primary font-mono">{formatPercent(opp.modelProb)}</div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center">
              Conf: {formatPercent(opp.confidence)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Market Prob</div>
            <div className="text-3xl font-bold font-mono">{formatPercent(opp.marketProb)}</div>
            <div className="text-xs text-muted-foreground mt-2">
              Liq: {formatCurrency(opp.liquidity)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Absolute Edge</div>
            <div className={`text-3xl font-bold font-mono ${opp.edge > 0 ? 'text-emerald-500' : 'text-destructive'}`}>
              {opp.edge > 0 ? "+" : ""}{formatPercent(opp.edge)}
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              Score: {formatPercent(opp.edgeScore)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/50 border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Kelly Rec</div>
            <div className="text-3xl font-bold text-muted-foreground font-mono">{formatPercent(opp.kellyFraction)}</div>
            <div className="text-xs text-primary font-bold mt-2 uppercase">
              Bias: {opp.suggestedDirection}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* "What moved this prediction" — explains the edge by listing the
          ambient signals the matching layer routed to this market and how
          far they shifted modelProb. Hidden when no ambient signals were
          matched (i.e. the published edge comes purely from marketProb). */}
      {opp.appliedSignals && opp.appliedSignals.length > 0 && (
        <Card
          className="bg-card/50 border-primary/30"
          data-testid="opportunity-applied-signals"
        >
          <CardHeader className="pb-2 border-b border-border/50">
            <CardTitle className="text-sm font-bold uppercase tracking-wider flex items-center text-primary">
              <Zap className="h-4 w-4 mr-2" /> What Moved This Prediction
              <span className="ml-auto flex items-center gap-3 font-mono text-xs normal-case tracking-normal text-muted-foreground">
                <span>
                  Market{" "}
                  <span className="text-foreground">
                    {formatPercent(opp.marketProb)}
                  </span>
                </span>
                <span className="text-muted-foreground">→</span>
                <span>
                  Model{" "}
                  <span className="text-primary font-bold">
                    {formatPercent(opp.modelProb)}
                  </span>
                </span>
                {(() => {
                  const shift = opp.ambientShift ?? 0;
                  const pts = Math.abs(shift * 100);
                  const sign = shift > 0 ? "+" : shift < 0 ? "−" : "±";
                  const cls =
                    shift > 0
                      ? "text-emerald-500"
                      : shift < 0
                        ? "text-destructive"
                        : "text-muted-foreground";
                  return (
                    <Badge
                      variant="outline"
                      className={`uppercase text-[10px] tracking-wider rounded-sm border-current ${cls}`}
                      data-testid="applied-signals-shift-summary"
                    >
                      {sign}
                      {pts.toFixed(1)} pts from {opp.appliedSignals!.length} signal
                      {opp.appliedSignals!.length === 1 ? "" : "s"}
                    </Badge>
                  );
                })()}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 divide-y divide-border/30">
            {opp.appliedSignals.map((s, i) => {
              const DirIcon =
                s.direction === "up"
                  ? ArrowUpRight
                  : s.direction === "down"
                    ? ArrowDownRight
                    : Minus;
              const dirCls =
                s.direction === "up"
                  ? "text-emerald-500 border-emerald-500/40 bg-emerald-500/5"
                  : s.direction === "down"
                    ? "text-destructive border-destructive/40 bg-destructive/5"
                    : "text-muted-foreground border-muted-foreground/30 bg-muted/20";
              const dirLabel =
                s.direction === "up"
                  ? "Pushes toward YES"
                  : s.direction === "down"
                    ? "Pushes toward NO"
                    : "Neutral";
              return (
                <div
                  key={`${s.source}-${s.title}-${i}`}
                  className="flex items-start gap-3 p-3"
                  data-testid="applied-signal-row"
                >
                  <Badge
                    variant="outline"
                    className={`uppercase text-[10px] tracking-wider rounded-sm shrink-0 ${dirCls}`}
                    title={dirLabel}
                  >
                    <DirIcon className="w-3 h-3 mr-1" />
                    {s.direction}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground line-clamp-2">
                      {s.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground font-mono">
                      <span className="uppercase tracking-wider">
                        {s.source}
                      </span>
                      <span className="uppercase tracking-wider">
                        {s.kind}
                      </span>
                      <span>impact {s.impact.toFixed(2)}</span>
                      <span>weight {s.effectiveWeight.toFixed(2)}</span>
                    </div>
                    {s.keywords.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {s.keywords.map((kw) => (
                          <Badge
                            key={kw}
                            variant="outline"
                            className="text-[10px] uppercase tracking-wider rounded-sm border-border/60 text-muted-foreground"
                          >
                            {kw}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-4">
        <div className="lg:col-span-2 space-y-6">
          <div className="space-y-4">
            <h2 className="text-lg font-bold uppercase tracking-wider flex items-center text-primary">
              <Activity className="w-5 h-5 mr-2" /> Structured Rationale
            </h2>
            <div className="grid gap-4">
              <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
                <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2"></span> Observed Facts
                </div>
                <CardContent className="p-4">
                  {opp.rationale.observed.length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1 text-sm text-foreground/90">
                      {opp.rationale.observed.map((item, i) => <li key={i}>{item}</li>)}
                    </ul>
                  ) : <span className="text-sm text-muted-foreground italic">No facts observed.</span>}
                </CardContent>
              </Card>

              <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
                <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center">
                  <span className="w-2 h-2 rounded-full bg-blue-500 mr-2"></span> Inferred
                </div>
                <CardContent className="p-4">
                  {opp.rationale.inferred.length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1 text-sm text-foreground/90">
                      {opp.rationale.inferred.map((item, i) => <li key={i}>{item}</li>)}
                    </ul>
                  ) : <span className="text-sm text-muted-foreground italic">No inferences made.</span>}
                </CardContent>
              </Card>

              <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
                <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center">
                  <span className="w-2 h-2 rounded-full bg-purple-500 mr-2"></span> Speculation
                </div>
                <CardContent className="p-4">
                  {opp.rationale.speculation.length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1 text-sm text-foreground/90">
                      {opp.rationale.speculation.map((item, i) => <li key={i}>{item}</li>)}
                    </ul>
                  ) : <span className="text-sm text-muted-foreground italic">No speculations recorded.</span>}
                </CardContent>
              </Card>

              <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
                <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center">
                  <span className="w-2 h-2 rounded-full bg-amber-500 mr-2"></span> Unknowns
                </div>
                <CardContent className="p-4">
                  {opp.rationale.unknowns.length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1 text-sm text-foreground/90">
                      {opp.rationale.unknowns.map((item, i) => <li key={i}>{item}</li>)}
                    </ul>
                  ) : <span className="text-sm text-muted-foreground italic">No explicit unknowns identified.</span>}
                </CardContent>
              </Card>

              <Card className="bg-card/30 border-destructive/20 rounded-md overflow-hidden">
                <div className="bg-destructive/10 px-4 py-2 border-b border-destructive/20 text-xs font-bold uppercase tracking-wider text-destructive flex items-center">
                  <span className="w-2 h-2 rounded-full bg-destructive mr-2"></span> Risk Flags
                </div>
                <CardContent className="p-4">
                  {opp.rationale.riskFlags.length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1 text-sm text-foreground/90">
                      {opp.rationale.riskFlags.map((item, i) => <li key={i}>{item}</li>)}
                    </ul>
                  ) : <span className="text-sm text-muted-foreground italic">No major risks flagged.</span>}
                </CardContent>
              </Card>
            </div>
          </div>
          
          <Separator className="my-8" />

          <div className="space-y-4">
            <h2 className="text-lg font-bold uppercase tracking-wider flex items-center text-primary">
              <Target className="w-5 h-5 mr-2" /> Trade Plan
              {(() => {
                const a = opp.recommendedAction;
                const ActionIcon = a === "trade" ? ArrowUpRight : a === "watch" ? Eye : ShieldAlert;
                const cls =
                  a === "trade"
                    ? "border-primary/50 text-primary bg-primary/10"
                    : a === "watch"
                      ? "border-muted-foreground/30 text-muted-foreground bg-muted/30"
                      : "border-destructive/50 text-destructive bg-destructive/10";
                return (
                  <Badge variant="outline" className={`ml-3 uppercase text-[10px] rounded-sm ${cls}`}>
                    <ActionIcon className="w-3 h-3 mr-1" />
                    {a === "human_review" ? "Human Review" : a}
                  </Badge>
                );
              })()}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="bg-card/30 border-border/30">
                <CardHeader className="pb-2 border-b border-border/30">
                  <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
                    Entry Plan
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-2 text-sm font-mono">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Side</span>
                    <span className="uppercase font-bold">{opp.tradePlan.direction}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Suggested Size</span>
                    <span className="font-bold">{formatCurrency(opp.tradePlan.sizeUsd)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry Zone</span>
                    <span className="font-bold">
                      {formatPercent(opp.tradePlan.entryZone.low)}–{formatPercent(opp.tradePlan.entryZone.high)}
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-card/30 border-border/30">
                <CardHeader className="pb-2 border-b border-border/30">
                  <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
                    Cash-Out Ladder
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-1 text-sm font-mono">
                  {opp.tradePlan.cashOutLadder.map((rung, i) => (
                    <div key={i} className="flex justify-between">
                      <span className="text-muted-foreground">Target {i + 1}</span>
                      <span>
                        <span className="font-bold">{formatPercent(rung.price)}</span>
                        <span className="text-muted-foreground ml-2">
                          scale out {Math.round(rung.fraction * 100)}%
                        </span>
                      </span>
                    </div>
                  ))}
                  {opp.tradePlan.cashOutLadder.length === 0 && (
                    <span className="text-muted-foreground italic">No ladder rungs.</span>
                  )}
                </CardContent>
              </Card>
            </div>
            <Card className="bg-card/30 border-border/30">
              <CardHeader className="pb-2 border-b border-border/30">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
                  Exit Strategy
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2 text-sm">
                <p>{opp.tradePlan.exitStrategy}</p>
                {opp.tradePlan.invalidations.length > 0 && (
                  <div className="pt-2 mt-2 border-t border-border/30">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      Invalidations
                    </div>
                    <ul className="list-disc pl-5 space-y-1 text-xs text-muted-foreground">
                      {opp.tradePlan.invalidations.map((inv, i) => (
                        <li key={i}>{inv}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Separator className="my-8" />

          <div className="space-y-4">
            <h2 className="text-lg font-bold uppercase tracking-wider flex items-center">
              <Activity className="w-5 h-5 mr-2 text-muted-foreground" /> Recent Signals
            </h2>
            {opp.recentSignals.length > 0 ? (
              <div className="space-y-3">
                {opp.recentSignals.map(signal => (
                  <div key={signal.id} className="p-3 bg-secondary/20 border border-border/50 rounded text-sm">
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-bold text-foreground">{signal.title}</span>
                      <span className="text-xs font-mono text-muted-foreground">{formatDateTime(signal.observedAt)}</span>
                    </div>
                    <p className="text-muted-foreground mb-2">{signal.body}</p>
                    <div className="flex gap-3 text-xs font-mono">
                      <span className={signal.sentiment > 0 ? "text-emerald-500" : signal.sentiment < 0 ? "text-destructive" : "text-muted-foreground"}>
                        Sent: {signal.sentiment > 0 ? '+' : ''}{signal.sentiment.toFixed(2)}
                      </span>
                      <span className="text-primary">Impact: {signal.impact.toFixed(2)}</span>
                      <span className="text-muted-foreground uppercase">{signal.kind}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No linked signals in the last 24h.</p>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <Card className="bg-card border-border/50 sticky top-20">
            <CardHeader className="bg-secondary/30 border-b border-border/50 pb-4">
              <CardTitle className="text-sm uppercase tracking-wider flex items-center">
                <LineChart className="w-4 h-4 mr-2 text-primary" /> Execute Paper Trade
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {isKillSwitchEngaged ? (
                <Alert variant="destructive" className="bg-destructive/10 border-destructive/30">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  <AlertTitle className="uppercase tracking-wider font-bold">Kill Switch Active</AlertTitle>
                  <AlertDescription className="text-xs mt-1">
                    System execution is currently disabled. Return to Dashboard or Risk Settings to disarm.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-4">
                  <Alert className="bg-primary/5 border-primary/20 text-primary py-2 px-3">
                    <Info className="h-4 w-4 text-primary" />
                    <AlertDescription className="text-[10px] uppercase font-bold tracking-wider ml-2">
                      Live execution disabled. Paper only.
                    </AlertDescription>
                  </Alert>

                  {tradeBlocked && (
                    <Alert variant="destructive" className="bg-destructive/10 border-destructive/30">
                      <ShieldAlert className="h-4 w-4 shrink-0" />
                      <AlertTitle className="uppercase tracking-wider font-bold text-xs">
                        Why not trade?
                      </AlertTitle>
                      <AlertDescription className="text-xs mt-1">
                        <ul className="list-disc pl-4 space-y-0.5">
                          {gateReasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                        <div className="mt-2 text-[10px] uppercase tracking-wider opacity-70">
                          Adjust risk floors in Settings or change the size to clear these.
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                  
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                      <FormField
                        control={form.control}
                        name="direction"
                        render={({ field }) => (
                          <FormItem className="space-y-1.5">
                            <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Direction Bias</FormLabel>
                            <FormControl>
                              <RadioGroup
                                onValueChange={field.onChange}
                                defaultValue={field.value}
                                className="flex gap-2"
                              >
                                <FormItem className="flex items-center space-x-0 space-y-0 flex-1">
                                  <FormControl>
                                    <RadioGroupItem value="yes" className="sr-only" />
                                  </FormControl>
                                  <FormLabel className={`flex flex-1 cursor-pointer items-center justify-center rounded-md border-2 border-border/50 p-2 bg-background font-bold uppercase tracking-widest text-xs transition-all hover:bg-secondary ${field.value === 'yes' ? 'border-primary text-primary bg-primary/10' : ''}`}>
                                    Yes
                                  </FormLabel>
                                </FormItem>
                                <FormItem className="flex items-center space-x-0 space-y-0 flex-1">
                                  <FormControl>
                                    <RadioGroupItem value="no" className="sr-only" />
                                  </FormControl>
                                  <FormLabel className={`flex flex-1 cursor-pointer items-center justify-center rounded-md border-2 border-border/50 p-2 bg-background font-bold uppercase tracking-widest text-xs transition-all hover:bg-secondary ${field.value === 'no' ? 'border-destructive text-destructive bg-destructive/10' : ''}`}>
                                    No
                                  </FormLabel>
                                </FormItem>
                              </RadioGroup>
                            </FormControl>
                            <FormMessage className="text-[10px]" />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="sizeUsd"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
                              Size (USD)
                              <button 
                                type="button" 
                                className="text-primary hover:underline"
                                onClick={() => form.setValue("sizeUsd", recommendedSize)}
                              >
                                Kelly: {formatCurrency(recommendedSize)}
                              </button>
                            </FormLabel>
                            <FormControl>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                                <Input 
                                  type="number" 
                                  className="pl-7 bg-background font-mono h-9 text-sm" 
                                  {...field} 
                                  max={maxSize}
                                />
                              </div>
                            </FormControl>
                            <FormMessage className="text-[10px]" />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="rationale"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Trade Note (Optional)</FormLabel>
                            <FormControl>
                              <Textarea 
                                placeholder="Why are we taking this exact size?" 
                                className="bg-background text-sm min-h-[60px] resize-none" 
                                {...field} 
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />

                      <div className="pt-2 border-t border-border/30">
                        <Button 
                          type="submit" 
                          className="w-full uppercase font-bold tracking-wider" 
                          size="sm"
                          disabled={createTrade.isPending || tradeBlocked}
                        >
                          {createTrade.isPending
                            ? "Executing..."
                            : tradeBlocked
                              ? <><ShieldAlert className="w-4 h-4 mr-2" /> Blocked by Risk Gate</>
                              : <><Hand className="w-4 h-4 mr-2" /> Commit Position</>}
                        </Button>
                      </div>
                    </form>
                  </Form>
                </div>
              )}
            </CardContent>
          </Card>

          {opp.paperTrades.length > 0 && (
            <Card className="bg-card/30 border-border/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Linked Trades</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/30">
                  {opp.paperTrades.map(trade => (
                    <div key={trade.id} className="p-3 text-sm">
                      <div className="flex justify-between items-center mb-1">
                        <Badge variant={trade.status === 'open' ? 'default' : 'secondary'} className="uppercase text-[10px]">
                          {trade.status}
                        </Badge>
                        <span className="font-mono text-xs">{formatCurrency(trade.sizeUsd)} @ {trade.direction.toUpperCase()}</span>
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground font-mono mt-2">
                        <span>Entry: {formatPercent(trade.entryProb)}</span>
                        {trade.status === 'closed' && (
                          <span className={trade.pnlUsd && trade.pnlUsd > 0 ? "text-emerald-500" : "text-destructive"}>
                            P&L: {trade.pnlUsd && trade.pnlUsd > 0 ? '+' : ''}{formatCurrency(trade.pnlUsd)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
