import { useListTopOpportunities } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatPercent, formatCompactNumber, formatCurrency } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, TrendingUp, Eye, ShieldAlert, ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

export default function TopOpportunities() {
  const { data: opportunities, isLoading } = useListTopOpportunities();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Top 10 Universe Edge</h1>
          <p className="text-muted-foreground">Highest absolute edge opportunities currently tracked.</p>
        </div>
        <Card className="bg-card/50">
          <CardContent className="p-0">
            <div className="p-4 space-y-4">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight uppercase">Top 10 Universe Edge</h1>
        <p className="text-muted-foreground">Highest absolute edge opportunities currently tracked.</p>
      </div>

      <Card className="bg-card/50 border-primary/20">
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase flex items-center">
            <TrendingUp className="h-4 w-4 mr-2 text-primary" />
            Ranked by Edge Score
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead className="max-w-[340px]">Question</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="text-right">Side</TableHead>
                <TableHead className="text-right">Model vs Market</TableHead>
                <TableHead className="text-right">Edge</TableHead>
                <TableHead className="text-right">Conf</TableHead>
                <TableHead className="text-right">Entry Zone</TableHead>
                <TableHead className="text-right">First Target</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {opportunities?.map((opp, index) => {
                const action = opp.recommendedAction;
                const actionMeta =
                  action === "trade"
                    ? { Icon: ArrowUpRight, cls: "border-primary/50 text-primary bg-primary/10" }
                    : action === "watch"
                      ? { Icon: Eye, cls: "border-muted-foreground/30 text-muted-foreground bg-muted/30" }
                      : { Icon: ShieldAlert, cls: "border-destructive/50 text-destructive bg-destructive/10" };
                const ActionIcon = actionMeta.Icon;
                const firstRung = opp.tradePlan.cashOutLadder[0];
                return (
                  <TableRow key={opp.id} className="group border-border/50 transition-colors hover:bg-secondary/30">
                    <TableCell className="text-center font-mono text-muted-foreground">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="uppercase tracking-wider text-[10px] rounded-sm">
                        {opp.domain.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/opportunities/${opp.id}`} className="hover:text-primary transition-colors flex items-center group/link">
                        <span className="line-clamp-2">{opp.question}</span>
                        <ExternalLink className="ml-2 w-3 h-3 opacity-0 group-hover/link:opacity-100 transition-opacity shrink-0" />
                      </Link>
                      {opp.keyReason && (
                        <div className="text-[11px] text-muted-foreground mt-1 line-clamp-1">
                          <span className="uppercase tracking-wider mr-1 opacity-60">Why:</span>
                          {opp.keyReason}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`uppercase text-[10px] tracking-wider rounded-sm ${actionMeta.cls}`}>
                        <ActionIcon className="w-3 h-3 mr-1" />
                        {action === "human_review" ? "Human Review" : action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className={`uppercase text-[10px] rounded-sm ${opp.suggestedDirection === "yes" ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}>
                        {opp.suggestedDirection}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span className="text-primary font-bold">{formatPercent(opp.modelProb)}</span>
                      <span className="text-muted-foreground mx-1">vs</span>
                      <span>{formatPercent(opp.marketProb)}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span className={opp.edge > 0 ? "text-emerald-500" : "text-destructive"}>
                        {opp.edge > 0 ? "+" : ""}{formatPercent(opp.edge)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatPercent(opp.confidence)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatPercent(opp.tradePlan.entryZone.low)}–{formatPercent(opp.tradePlan.entryZone.high)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {firstRung ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 font-mono text-xs hover:bg-secondary/50"
                            >
                              {formatPercent(firstRung.price)}{" "}
                              <span className="text-muted-foreground ml-1">
                                ({Math.round(firstRung.fraction * 100)}%)
                              </span>
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-80 p-3 text-xs space-y-3" align="end">
                            <div>
                              <div className="font-bold uppercase tracking-wider text-[10px] text-muted-foreground mb-1">
                                Cash-Out Ladder
                              </div>
                              <div className="space-y-1 font-mono">
                                {opp.tradePlan.cashOutLadder.map((rung, i) => (
                                  <div key={i} className="flex justify-between">
                                    <span>Target {i + 1}</span>
                                    <span>
                                      <span className="font-bold">{formatPercent(rung.price)}</span>
                                      <span className="text-muted-foreground ml-2">
                                        scale out {Math.round(rung.fraction * 100)}%
                                      </span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div>
                              <div className="font-bold uppercase tracking-wider text-[10px] text-muted-foreground mb-1">
                                Exit Strategy
                              </div>
                              <p className="text-foreground/80 leading-snug">
                                {opp.tradePlan.exitStrategy}
                              </p>
                            </div>
                            {opp.tradePlan.invalidations.length > 0 && (
                              <div>
                                <div className="font-bold uppercase tracking-wider text-[10px] text-muted-foreground mb-1">
                                  Invalidations
                                </div>
                                <ul className="list-disc pl-4 space-y-0.5 text-foreground/80">
                                  {opp.tradePlan.invalidations.map((inv, i) => (
                                    <li key={i}>{inv}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div className="pt-2 border-t border-border/30">
                              <Link
                                href={`/opportunities/${opp.id}`}
                                className="text-primary hover:underline text-[11px] uppercase tracking-wider"
                              >
                                Open full detail →
                              </Link>
                            </div>
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className={`uppercase text-[10px] rounded-sm ${opp.status === "active" ? "border-emerald-500/40 text-emerald-500" : "border-muted-foreground/30 text-muted-foreground"}`}>
                        {opp.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(!opportunities || opportunities.length === 0) && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-10 text-muted-foreground">
                    No high-edge opportunities found in the current universe.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
