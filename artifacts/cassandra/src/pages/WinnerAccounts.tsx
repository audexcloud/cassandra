import { Link } from "wouter";
import {
  getListWinnerAccountsQueryKey,
  useListWinnerAccounts,
  useRefreshWinnerAccounts,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  ExternalLink,
  RefreshCw,
  Trophy,
  Users,
} from "lucide-react";
import { formatPercent, formatCurrency, formatDateTime } from "@/lib/format";

function shortAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function Sparkline({
  data,
}: {
  data: Array<{ t: string; pnlUsd: number }>;
}) {
  if (data.length === 0) {
    return <div className="text-muted-foreground text-[11px]">—</div>;
  }
  const last = data[data.length - 1].pnlUsd;
  const first = data[0].pnlUsd;
  const trendUp = last >= first;
  return (
    <div className="h-8 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="pnlUsd"
            stroke={trendUp ? "rgb(16, 185, 129)" : "rgb(239, 68, 68)"}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function WinnerAccounts() {
  const { data: wallets, isLoading } = useListWinnerAccounts();
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = useRefreshWinnerAccounts({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getListWinnerAccountsQueryKey() });
        toast({
          title: "Wallets refreshed",
          description: `${result.walletsRefreshed} wallets, ${result.suggestionsCreated} new suggestions.`,
        });
      },
      onError: (err) => {
        toast({
          title: "Refresh failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Winner Accounts</h1>
          <p className="text-muted-foreground">
            High-performing prediction-market wallets we mirror.
          </p>
        </div>
        <Card className="bg-card/50">
          <CardContent className="p-4 space-y-4">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalPnl = wallets?.reduce((sum, w) => sum + (w.pnlUsd ?? 0), 0) ?? 0;
  const totalActive = wallets?.reduce((sum, w) => sum + w.activePositions, 0) ?? 0;

  return (
    <div className="space-y-6" data-testid="winner-accounts-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Winner Accounts</h1>
          <p className="text-muted-foreground max-w-2xl">
            Tracked Polymarket wallets ranked by realized P&amp;L. Open a wallet to
            see its positions and a "mirror this trade" workflow that pre-fills
            the paper-trade form with a Reasoning Summary.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          data-testid="refresh-wallets"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
          {refresh.isPending ? "Refreshing…" : "Refresh now"}
        </Button>
      </div>

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Users className="h-3 w-3" /> Tracked wallets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{wallets?.length ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Trophy className="h-3 w-3" /> Combined P&amp;L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono ${totalPnl >= 0 ? "text-emerald-500" : "text-destructive"}`}>
              {formatCurrency(totalPnl)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Live positions across wallets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{totalActive}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card/50 border-primary/20">
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase">
            Ranked by realized P&amp;L
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>Wallet</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="text-right">Hit-rate</TableHead>
                <TableHead className="text-right">Avg edge</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="text-right">Closed</TableHead>
                <TableHead>Trend</TableHead>
                <TableHead className="text-right">Synced</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wallets?.map((w) => (
                <TableRow
                  key={w.id}
                  className="group border-border/50 hover:bg-secondary/30"
                  data-testid={`wallet-row-${w.id}`}
                >
                  <TableCell className="text-center font-mono text-muted-foreground">
                    {w.rank ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/winners/${w.id}`}
                      className="hover:text-primary transition-colors flex items-center group/link"
                    >
                      <div>
                        <div className="font-medium">{w.label}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">
                          {shortAddress(w.address)}
                          <Badge
                            variant="outline"
                            className="ml-2 uppercase text-[9px] tracking-wider rounded-sm"
                          >
                            {w.source}
                          </Badge>
                        </div>
                      </div>
                      <ExternalLink className="ml-2 w-3 h-3 opacity-0 group-hover/link:opacity-100" />
                    </Link>
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono font-bold ${w.pnlUsd >= 0 ? "text-emerald-500" : "text-destructive"}`}
                  >
                    {formatCurrency(w.pnlUsd)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatPercent(w.hitRate)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatPercent(w.avgEdge)}
                  </TableCell>
                  <TableCell className="text-right font-mono">{w.activePositions}</TableCell>
                  <TableCell className="text-right font-mono">{w.closedPositions}</TableCell>
                  <TableCell>
                    <Sparkline data={w.pnlSparkline} />
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {w.lastSyncedAt ? formatDateTime(w.lastSyncedAt) : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {(!wallets || wallets.length === 0) && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                    No tracked wallets yet. Click "Refresh now" to populate the first snapshot.
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
