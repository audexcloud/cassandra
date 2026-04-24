import { useState } from "react";
import { Link, useRoute } from "wouter";
import {
  getGetWinnerAccountQueryKey,
  getListWinnerAccountsQueryKey,
  getGetDashboardSummaryQueryKey,
  getListPaperTradesQueryKey,
  useDismissWinnerSuggestion,
  useGetWinnerAccount,
  useMirrorWinnerSuggestion,
} from "@workspace/api-client-react";
import type { MirrorSuggestion } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Trophy,
  X,
  AlertTriangle,
  TrendingUp,
} from "lucide-react";
import {
  formatCurrency,
  formatDateTime,
  formatPercent,
} from "@/lib/format";

function shortAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function ReasoningSummary({ rationale }: { rationale: MirrorSuggestion["rationale"] }) {
  // Five visually distinct sections — matches the convention used everywhere
  // else in the app. Empty buckets render as "—" rather than being hidden so
  // the structure is always recognisable.
  const sections: Array<{
    key: keyof MirrorSuggestion["rationale"];
    label: string;
    cls: string;
  }> = [
    { key: "observed", label: "Observed", cls: "border-l-4 border-emerald-500/60 bg-emerald-500/5" },
    { key: "inferred", label: "Inferred", cls: "border-l-4 border-blue-500/60 bg-blue-500/5" },
    { key: "speculation", label: "Speculation", cls: "border-l-4 border-amber-500/60 bg-amber-500/5" },
    { key: "unknowns", label: "Unknowns", cls: "border-l-4 border-purple-500/60 bg-purple-500/5" },
    { key: "riskFlags", label: "Risk flags", cls: "border-l-4 border-destructive/60 bg-destructive/5" },
  ];
  return (
    <div className="space-y-2">
      {sections.map((s) => {
        const items = rationale[s.key] ?? [];
        return (
          <div key={s.key} className={`pl-3 pr-2 py-2 rounded-sm ${s.cls}`}>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              {s.label}
            </div>
            {items.length === 0 ? (
              <div className="text-xs text-muted-foreground">—</div>
            ) : (
              <ul className="list-disc pl-4 text-xs space-y-1 mt-1">
                {items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MirrorDialog({
  suggestion,
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  suggestion: MirrorSuggestion | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (sizeUsd: number, note: string) => void;
  pending: boolean;
}) {
  const [size, setSize] = useState<string>("");
  const [note, setNote] = useState<string>("");

  if (!suggestion) return null;
  const sizeNum = Number(size || suggestion.suggestedSizeUsd);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mirror this trade</DialogTitle>
          <DialogDescription>
            Open a paper trade matching the wallet's direction. Size is capped by
            risk settings (max position USD, watch-only mode, kill switch).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground text-xs uppercase">Market</div>
              <div className="font-medium">{suggestion.question}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs uppercase">Direction</div>
              <Badge
                variant="outline"
                className={`uppercase ${suggestion.direction === "yes" ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}
              >
                {suggestion.direction}
              </Badge>
            </div>
            <div>
              <div className="text-muted-foreground text-xs uppercase">Wallet entry</div>
              <div className="font-mono">{formatPercent(suggestion.entryProb)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs uppercase">Wallet size</div>
              <div className="font-mono">{formatCurrency(suggestion.walletSizeUsd)}</div>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mirror-size">Mirror size (USD)</Label>
            <Input
              id="mirror-size"
              type="number"
              min={1}
              placeholder={String(suggestion.suggestedSizeUsd)}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              data-testid="mirror-size-input"
            />
            <p className="text-xs text-muted-foreground">
              Default: {formatCurrency(suggestion.suggestedSizeUsd)} (≈5% of wallet size, capped at $250).
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mirror-note">Note (optional)</Label>
            <Input
              id="mirror-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why are you mirroring this?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit(sizeNum, note)}
            disabled={pending || sizeNum <= 0}
            data-testid="mirror-confirm"
          >
            {pending ? "Opening…" : `Mirror at ${formatCurrency(sizeNum)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function WinnerAccountDetail() {
  const [, params] = useRoute<{ id: string }>("/winners/:id");
  const id = Number(params?.id);
  const { data: wallet, isLoading } = useGetWinnerAccount(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [mirrorTarget, setMirrorTarget] = useState<MirrorSuggestion | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetWinnerAccountQueryKey(id) });
    qc.invalidateQueries({ queryKey: getListWinnerAccountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getListPaperTradesQueryKey() });
  };

  const mirror = useMirrorWinnerSuggestion({
    mutation: {
      onSuccess: (result) => {
        invalidate();
        toast({
          title: "Mirror trade opened",
          description: `Paper trade #${result.paperTrade.id} on ${result.paperTrade.question}`,
        });
        setMirrorTarget(null);
      },
      onError: (err) => {
        toast({
          title: "Mirror failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const dismiss = useDismissWinnerSuggestion({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Suggestion dismissed" });
      },
      onError: (err) => {
        toast({
          title: "Dismiss failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  if (isLoading || !wallet) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-1/3" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const pendingSuggestions = wallet.suggestions.filter((s) => s.status === "pending");
  const actionedSuggestions = wallet.suggestions.filter((s) => s.status !== "pending");
  const snapshotData = wallet.snapshots.map((s) => ({
    ts: new Date(s.capturedAt).getTime(),
    pnlUsd: s.pnlUsd,
    label: formatDateTime(s.capturedAt),
  }));

  return (
    <div className="space-y-6" data-testid="winner-account-detail">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link
            href="/winners"
            className="text-xs text-muted-foreground uppercase tracking-wider flex items-center hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3 mr-1" /> Back to winners
          </Link>
          <h1 className="text-2xl font-bold tracking-tight uppercase mt-1 flex items-center gap-2">
            <Trophy className="h-5 w-5 text-primary" /> {wallet.label}
          </h1>
          <div className="text-xs text-muted-foreground font-mono mt-1">
            {shortAddress(wallet.address)} · {wallet.source}
            {wallet.rank ? ` · rank #${wallet.rank}` : ""}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-3xl font-bold font-mono ${wallet.pnlUsd >= 0 ? "text-emerald-500" : "text-destructive"}`}>
            {formatCurrency(wallet.pnlUsd)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Synced {wallet.lastSyncedAt ? formatDateTime(wallet.lastSyncedAt) : "—"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Hit-rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold font-mono">{formatPercent(wallet.hitRate)}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Avg edge</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold font-mono">{formatPercent(wallet.avgEdge)}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Open positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold font-mono">{wallet.activePositions}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Closed positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold font-mono">{wallet.closedPositions}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase flex items-center">
            <TrendingUp className="h-4 w-4 mr-2 text-primary" /> P&amp;L history
          </CardTitle>
        </CardHeader>
        <CardContent className="h-48">
          {snapshotData.length === 0 ? (
            <div className="text-muted-foreground text-sm">No snapshots yet — trigger a refresh.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={snapshotData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="rgb(16, 185, 129)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="rgb(16, 185, 129)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v) => formatDateTime(new Date(v).toISOString())}
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.5)" }}
                />
                <YAxis
                  tickFormatter={(v: number) => formatCurrency(v)}
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.5)" }}
                  width={70}
                />
                <RechartTooltip
                  formatter={(v: number) => formatCurrency(v)}
                  labelFormatter={(v) => formatDateTime(new Date(Number(v)).toISOString())}
                  contentStyle={{
                    background: "rgba(0,0,0,0.85)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="pnlUsd"
                  stroke="rgb(16, 185, 129)"
                  fill="url(#pnlGradient)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="suggestions" className="w-full">
        <TabsList>
          <TabsTrigger value="suggestions" data-testid="tab-suggestions">
            Mirror suggestions ({pendingSuggestions.length})
          </TabsTrigger>
          <TabsTrigger value="open" data-testid="tab-open">
            Open positions ({wallet.openPositions.length})
          </TabsTrigger>
          <TabsTrigger value="closed" data-testid="tab-closed">
            Recent closed ({wallet.recentClosedPositions.length})
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">
            Suggestion history ({actionedSuggestions.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="suggestions" className="space-y-4 mt-4">
          {pendingSuggestions.length === 0 && (
            <Card className="bg-card/50">
              <CardContent className="py-10 text-center text-muted-foreground">
                No pending mirror suggestions. New ones appear after each refresh
                cycle when wallet positions overlap with our universe.
              </CardContent>
            </Card>
          )}
          {pendingSuggestions.map((s) => (
            <Card key={s.id} className="bg-card/50 border-primary/20" data-testid={`suggestion-${s.id}`}>
              <CardHeader className="pb-2 border-b border-border/30">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <CardTitle className="text-sm flex items-center gap-2">
                      {s.opportunityId ? (
                        <Link
                          href={`/opportunities/${s.opportunityId}`}
                          className="hover:text-primary"
                        >
                          {s.question}
                          <ExternalLink className="inline h-3 w-3 ml-1" />
                        </Link>
                      ) : (
                        s.question
                      )}
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                      <span>
                        Side:{" "}
                        <Badge
                          variant="outline"
                          className={`uppercase ml-1 ${s.direction === "yes" ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}
                        >
                          {s.direction}
                        </Badge>
                      </span>
                      <span>Wallet entry: {formatPercent(s.entryProb)}</span>
                      <span>Wallet size: {formatCurrency(s.walletSizeUsd)}</span>
                      <span>Suggested mirror: {formatCurrency(s.suggestedSizeUsd)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => setMirrorTarget(s)}
                      disabled={!s.opportunityId}
                      data-testid={`mirror-${s.id}`}
                    >
                      <Check className="h-3 w-3 mr-1" /> Mirror
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => dismiss.mutate({ id: s.id })}
                      disabled={dismiss.isPending}
                      data-testid={`dismiss-${s.id}`}
                    >
                      <X className="h-3 w-3 mr-1" /> Dismiss
                    </Button>
                  </div>
                </div>
                {!s.opportunityId && (
                  <div className="mt-2 text-xs text-amber-500 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Market not yet ingested — mirror will be available after the next ingest cycle.
                  </div>
                )}
              </CardHeader>
              <CardContent className="pt-3">
                <ReasoningSummary rationale={s.rationale} />
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="open" className="mt-4">
          <Card className="bg-card/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50 hover:bg-transparent">
                    <TableHead>Market</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Entry</TableHead>
                    <TableHead className="text-right">Now</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">uPnL</TableHead>
                    <TableHead className="text-right">Opened</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallet.openPositions.map((p, i) => (
                    <TableRow key={i} className="border-border/50">
                      <TableCell className="max-w-xs">
                        {p.opportunityId ? (
                          <Link
                            href={`/opportunities/${p.opportunityId}`}
                            className="hover:text-primary"
                          >
                            <span className="line-clamp-2">{p.question}</span>
                          </Link>
                        ) : (
                          <span className="line-clamp-2">{p.question}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`uppercase ${p.direction === "yes" ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}
                        >
                          {p.direction}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatPercent(p.entryProb)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {p.currentProb == null ? "—" : formatPercent(p.currentProb)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(p.sizeUsd)}</TableCell>
                      <TableCell
                        className={`text-right font-mono ${
                          p.unrealizedPnl == null
                            ? "text-muted-foreground"
                            : p.unrealizedPnl >= 0
                              ? "text-emerald-500"
                              : "text-destructive"
                        }`}
                      >
                        {p.unrealizedPnl == null ? "—" : formatCurrency(p.unrealizedPnl)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatDateTime(p.openedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {wallet.openPositions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                        No open positions reported.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="closed" className="mt-4">
          <Card className="bg-card/50">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50 hover:bg-transparent">
                    <TableHead>Market</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Entry</TableHead>
                    <TableHead className="text-right">Exit</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">P&amp;L</TableHead>
                    <TableHead className="text-right">Closed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallet.recentClosedPositions.map((p, i) => (
                    <TableRow key={i} className="border-border/50">
                      <TableCell className="max-w-xs">
                        <span className="line-clamp-2">{p.question}</span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`uppercase ${p.direction === "yes" ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}
                        >
                          {p.direction}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatPercent(p.entryProb)}</TableCell>
                      <TableCell className="text-right font-mono">{formatPercent(p.exitProb)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(p.sizeUsd)}</TableCell>
                      <TableCell
                        className={`text-right font-mono ${p.pnlUsd >= 0 ? "text-emerald-500" : "text-destructive"}`}
                      >
                        {formatCurrency(p.pnlUsd)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatDateTime(p.closedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {wallet.recentClosedPositions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                        No recent closed positions.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-3">
          {actionedSuggestions.length === 0 ? (
            <Card className="bg-card/50">
              <CardContent className="py-10 text-center text-muted-foreground">
                No actioned suggestions yet.
              </CardContent>
            </Card>
          ) : (
            actionedSuggestions.map((s) => (
              <Card key={s.id} className="bg-card/30">
                <CardHeader className="pb-1">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm">{s.question}</CardTitle>
                    <Badge
                      variant="outline"
                      className={`uppercase ${s.status === "mirrored" ? "border-emerald-500/40 text-emerald-500" : "border-muted-foreground/30 text-muted-foreground"}`}
                    >
                      {s.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground space-x-3">
                  <span>{s.direction.toUpperCase()} @ {formatPercent(s.entryProb)}</span>
                  <span>Suggested {formatCurrency(s.suggestedSizeUsd)}</span>
                  {s.paperTradeId && <span>→ Paper trade #{s.paperTradeId}</span>}
                  <span>{formatDateTime(s.updatedAt)}</span>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>

      <MirrorDialog
        suggestion={mirrorTarget}
        open={!!mirrorTarget}
        onOpenChange={(v) => {
          if (!v) setMirrorTarget(null);
        }}
        onSubmit={(sizeUsd, note) =>
          mirrorTarget &&
          mirror.mutate({
            id: mirrorTarget.id,
            data: {
              sizeUsd,
              note: note || undefined,
            },
          })
        }
        pending={mirror.isPending}
      />
    </div>
  );
}
