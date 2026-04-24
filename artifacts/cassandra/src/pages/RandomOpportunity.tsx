import { useGetRandomOpportunity, useGetOpportunity, getGetOpportunityQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatPercent, formatCurrency, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Shuffle, ArrowRight, Activity, ShieldAlert, Target, Eye, ArrowUpRight } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetRandomOpportunityQueryKey } from "@workspace/api-client-react";

export default function RandomOpportunity() {
  const queryClient = useQueryClient();
  const { data: opportunity, isLoading, isFetching } = useGetRandomOpportunity();

  // Random Walk needs the same depth as the detail page (rationale, signals,
  // sources, parallels) so the operator can decide on it without leaving.
  // We deliberately query for the detail of the picked opportunity rather
  // than expand the random endpoint's response; one round-trip is fine.
  const detailId = opportunity?.id ?? 0;
  const { data: detail } = useGetOpportunity(detailId, {
    query: {
      queryKey: getGetOpportunityQueryKey(detailId),
      enabled: !!opportunity?.id,
    },
  });

  const handleSpin = () => {
    queryClient.invalidateQueries({ queryKey: getGetRandomOpportunityQueryKey() });
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto mt-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Random Walk</h1>
          <p className="text-muted-foreground">Surface random opportunities to prevent domain myopia.</p>
        </div>
        <Button onClick={handleSpin} disabled={isFetching} variant="outline" className="uppercase tracking-widest text-xs font-bold border-primary text-primary hover:bg-primary/10">
          <Shuffle className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Spin Universe
        </Button>
      </div>

      {isLoading || isFetching ? (
        <Card className="bg-card/50 border-border/50">
          <CardHeader>
            <Skeleton className="h-6 w-32 mb-2" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          </CardContent>
        </Card>
      ) : opportunity ? (
        <Card className="bg-card/50 border-primary/30 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between mb-4">
              <Badge variant="outline" className="uppercase tracking-wider text-xs px-2 py-1 rounded-sm border-primary/50 text-primary bg-primary/5">
                {opportunity.domain.replace('_', ' ')}
              </Badge>
              <div className="flex items-center text-xs font-mono text-muted-foreground">
                <Activity className="w-3 h-3 mr-1" />
                {opportunity.source}
              </div>
            </div>
            <CardTitle className="text-2xl leading-tight font-medium">
              {opportunity.question}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="p-4 rounded bg-secondary/30 border border-border/50">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Model Prob</div>
                <div className="text-2xl font-bold text-primary font-mono">{formatPercent(opportunity.modelProb)}</div>
              </div>
              <div className="p-4 rounded bg-secondary/30 border border-border/50">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Market Prob</div>
                <div className="text-2xl font-bold font-mono">{formatPercent(opportunity.marketProb)}</div>
              </div>
              <div className="p-4 rounded bg-secondary/30 border border-border/50">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Edge</div>
                <div className={`text-2xl font-bold font-mono ${opportunity.edge > 0 ? 'text-emerald-500' : 'text-destructive'}`}>
                  {opportunity.edge > 0 ? "+" : ""}{formatPercent(opportunity.edge)}
                </div>
              </div>
              <div className="p-4 rounded bg-secondary/30 border border-border/50">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Kelly Rec</div>
                <div className="text-2xl font-bold text-muted-foreground font-mono">{formatPercent(opportunity.kellyFraction)}</div>
              </div>
            </div>
            {detail && (
              <div className="space-y-4">
                {(() => {
                  const a = detail.recommendedAction;
                  const ActionIcon = a === "trade" ? ArrowUpRight : a === "watch" ? Eye : ShieldAlert;
                  const cls =
                    a === "trade"
                      ? "border-primary/50 text-primary bg-primary/10"
                      : a === "watch"
                        ? "border-muted-foreground/30 text-muted-foreground bg-muted/30"
                        : "border-destructive/50 text-destructive bg-destructive/10";
                  return (
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className={`uppercase tracking-wider rounded-sm ${cls}`}>
                        <ActionIcon className="w-3 h-3 mr-1" />
                        {a === "human_review" ? "Human Review" : a}
                      </Badge>
                      <Badge variant="outline" className="uppercase tracking-wider rounded-sm">
                        Side: {detail.suggestedDirection}
                      </Badge>
                      <Badge variant="outline" className="uppercase tracking-wider rounded-sm">
                        Conf {formatPercent(detail.confidence)}
                      </Badge>
                    </div>
                  );
                })()}

                {detail.rationale.riskFlags.length > 0 && (
                  <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-xs">
                    <div className="flex items-center font-bold text-destructive uppercase tracking-wider mb-2">
                      <ShieldAlert className="w-3 h-3 mr-1" /> Risk Warning
                    </div>
                    <ul className="list-disc pl-5 space-y-0.5 text-foreground/90">
                      {detail.rationale.riskFlags.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded border border-border/40 bg-secondary/20 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold">
                      Reasoning Summary
                    </div>
                    {detail.rationale.observed.length > 0 && (
                      <div className="mb-2">
                        <div className="text-[10px] uppercase text-emerald-500 mb-1">Observed</div>
                        <ul className="list-disc pl-4 space-y-0.5 text-xs text-foreground/90">
                          {detail.rationale.observed.slice(0, 3).map((o, i) => <li key={i}>{o}</li>)}
                        </ul>
                      </div>
                    )}
                    {detail.rationale.inferred.length > 0 && (
                      <div className="mb-2">
                        <div className="text-[10px] uppercase text-blue-500 mb-1">Inferred</div>
                        <ul className="list-disc pl-4 space-y-0.5 text-xs text-foreground/90">
                          {detail.rationale.inferred.slice(0, 3).map((o, i) => <li key={i}>{o}</li>)}
                        </ul>
                      </div>
                    )}
                    {detail.rationale.unknowns.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase text-amber-500 mb-1">Unknowns</div>
                        <ul className="list-disc pl-4 space-y-0.5 text-xs text-foreground/90">
                          {detail.rationale.unknowns.slice(0, 2).map((o, i) => <li key={i}>{o}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="rounded border border-border/40 bg-secondary/20 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold flex items-center">
                      <Target className="w-3 h-3 mr-1" /> Suggested Action
                    </div>
                    <div className="space-y-1.5 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Side</span>
                        <span className="font-bold uppercase">{detail.tradePlan.direction}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Size</span>
                        <span className="font-bold">{formatCurrency(detail.tradePlan.sizeUsd)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Entry Zone</span>
                        <span className="font-bold">
                          {formatPercent(detail.tradePlan.entryZone.low)}–{formatPercent(detail.tradePlan.entryZone.high)}
                        </span>
                      </div>
                      <div className="pt-1 mt-1 border-t border-border/30 text-[11px] text-foreground/80 font-sans">
                        {detail.tradePlan.exitStrategy}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded border border-border/40 bg-secondary/10 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold">
                    Sources / Recent Signals
                  </div>
                  {detail.recentSignals.length > 0 ? (
                    <ul className="space-y-1.5 text-xs">
                      {detail.recentSignals.slice(0, 4).map((s) => (
                        <li key={s.id} className="flex justify-between gap-3">
                          <span className="line-clamp-1 flex-1">
                            <span className="font-bold">{s.title}</span>
                            <span className="text-muted-foreground ml-2 uppercase text-[10px]">
                              {s.source} · {s.kind}
                            </span>
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                            {formatDateTime(s.observedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs italic text-muted-foreground">
                      No linked signals on file.
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground mt-2 italic">
                    Historical parallel: {detail.historicalParallel ?? "none catalogued yet"}.
                  </div>
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="bg-secondary/10 border-t border-border/50 p-4 flex justify-end">
            <Link href={`/opportunities/${opportunity.id}`} className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2 uppercase tracking-wider">
              Deep Dive
              <ArrowRight className="ml-2 w-4 h-4" />
            </Link>
          </CardFooter>
        </Card>
      ) : (
        <div className="text-center p-12 bg-card/50 rounded-lg border border-border border-dashed">
          <p className="text-muted-foreground uppercase tracking-wider text-sm">Universe Exhausted</p>
        </div>
      )}
    </div>
  );
}
