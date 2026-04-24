import { useListTopOpportunities } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatPercent, formatCompactNumber, formatCurrency } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
                <TableHead className="max-w-[400px]">Question</TableHead>
                <TableHead className="text-right">Model vs Market</TableHead>
                <TableHead className="text-right">Edge</TableHead>
                <TableHead className="text-right">Kelly Rec</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {opportunities?.map((opp, index) => (
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
                      <ExternalLink className="ml-2 w-3 h-3 opacity-0 group-hover/link:opacity-100 transition-opacity" />
                    </Link>
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
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {formatPercent(opp.kellyFraction)}
                  </TableCell>
                </TableRow>
              ))}
              {(!opportunities || opportunities.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
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
