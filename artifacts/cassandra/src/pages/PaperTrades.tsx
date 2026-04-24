import { useListPaperTrades, useClosePaperTrade } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink, LineChart, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { getListPaperTradesQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";

export default function PaperTrades() {
  const { data: trades, isLoading } = useListPaperTrades({ status: "all" });
  const closeTradeMutation = useClosePaperTrade();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [closingTradeId, setClosingTradeId] = useState<number | null>(null);
  const [closeNote, setCloseNote] = useState("");

  const handleCloseConfirm = () => {
    if (!closingTradeId) return;
    
    closeTradeMutation.mutate(
      { id: closingTradeId, data: { note: closeNote } },
      {
        onSuccess: () => {
          toast({
            title: "Position Closed",
            description: "Paper trade successfully closed.",
          });
          queryClient.invalidateQueries({ queryKey: getListPaperTradesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          setClosingTradeId(null);
          setCloseNote("");
        },
        onError: (err) => {
          toast({
            title: "Error",
            description: "Failed to close position.",
            variant: "destructive"
          });
        }
      }
    );
  };

  const openTrades = trades?.filter(t => t.status === 'open') || [];
  const closedTrades = trades?.filter(t => t.status === 'closed') || [];

  const totalOpenSize = openTrades.reduce((acc, t) => acc + t.sizeUsd, 0);
  const totalRealizedPnl = closedTrades.reduce((acc, t) => acc + (t.pnlUsd || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Paper Positions</h1>
          <p className="text-muted-foreground">Allocated paper capital and historical performance.</p>
        </div>
        <div className="flex gap-4">
          <div className="text-right">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Exposure</div>
            <div className="text-xl font-bold font-mono">{formatCurrency(totalOpenSize)}</div>
          </div>
          <div className="text-right pl-4 border-l border-border/50">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Realized P&L</div>
            <div className={`text-xl font-bold font-mono ${totalRealizedPnl >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>
              {totalRealizedPnl >= 0 ? '+' : ''}{formatCurrency(totalRealizedPnl)}
            </div>
          </div>
        </div>
      </div>

      <Card className="bg-card/50 border-primary/20">
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
            <LineChart className="h-4 w-4 mr-2" /> Open Positions ({openTrades.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead>Opportunity</TableHead>
                <TableHead className="text-right">Size (USD)</TableHead>
                <TableHead className="text-right">Direction</TableHead>
                <TableHead className="text-right">Entry Prob</TableHead>
                <TableHead className="text-right">Opened</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6}><Skeleton className="h-10 w-full" /></TableCell></TableRow>
              ) : openTrades.map(trade => (
                <TableRow key={trade.id} className="border-border/50 transition-colors hover:bg-secondary/30">
                  <TableCell className="font-medium">
                    <Link href={`/opportunities/${trade.opportunityId}`} className="hover:text-primary transition-colors flex items-center group/link">
                      <span className="line-clamp-1 max-w-[300px]">{trade.question}</span>
                      <ExternalLink className="ml-2 w-3 h-3 opacity-0 group-hover/link:opacity-100 transition-opacity shrink-0" />
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-foreground">
                    {formatCurrency(trade.sizeUsd)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={trade.direction === 'yes' ? 'default' : 'destructive'} className="uppercase text-[10px]">
                      {trade.direction}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatPercent(trade.entryProb)}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono text-muted-foreground">
                    {formatDateTime(trade.openedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="h-7 text-xs uppercase tracking-wider border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                      onClick={() => setClosingTradeId(trade.id)}
                    >
                      Close
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && openTrades.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                    No open paper positions.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="bg-card/30 border-border/30">
        <CardHeader className="pb-2 border-b border-border/30">
          <CardTitle className="text-sm font-medium uppercase flex items-center text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 mr-2" /> Closed Positions
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 opacity-80">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/30">
                <TableHead>Opportunity</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Entry / Exit</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5}><Skeleton className="h-10 w-full" /></TableCell></TableRow>
              ) : closedTrades.map(trade => (
                <TableRow key={trade.id} className="border-border/30">
                  <TableCell className="font-medium text-muted-foreground">
                    <Link href={`/opportunities/${trade.opportunityId}`} className="hover:text-foreground transition-colors">
                      <span className="line-clamp-1 max-w-[300px]">{trade.question}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCurrency(trade.sizeUsd)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatPercent(trade.entryProb)} → {trade.exitProb != null ? formatPercent(trade.exitProb) : '?'}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono text-muted-foreground">
                    {trade.closedAt ? formatDateTime(trade.closedAt) : 'Unknown'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold">
                    <span className={trade.pnlUsd && trade.pnlUsd > 0 ? "text-emerald-500" : "text-destructive"}>
                      {trade.pnlUsd && trade.pnlUsd > 0 ? '+' : ''}{trade.pnlUsd ? formatCurrency(trade.pnlUsd) : '$0'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && closedTrades.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                    No closed paper positions history.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!closingTradeId} onOpenChange={(open) => !open && setClosingTradeId(null)}>
        <DialogContent className="border-border bg-card">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-wider text-destructive flex items-center">
              <AlertTriangle className="w-5 h-5 mr-2" /> Close Position
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to close this paper position at the current market probability?
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="note" className="uppercase text-xs tracking-wider text-muted-foreground">Closing Note (Optional)</Label>
              <Textarea 
                id="note" 
                placeholder="Reason for closing before resolution..."
                value={closeNote}
                onChange={e => setCloseNote(e.target.value)}
                className="bg-background border-border/50 focus-visible:ring-primary"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingTradeId(null)} className="uppercase tracking-wider">Cancel</Button>
            <Button variant="destructive" onClick={handleCloseConfirm} disabled={closeTradeMutation.isPending} className="uppercase tracking-wider">
              {closeTradeMutation.isPending ? "Closing..." : "Confirm Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
