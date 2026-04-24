import { useListOpportunities } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatPercent } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, Filter } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Opportunities() {
  const [domainFilter, setDomainFilter] = useState<string>("all");
  
  const { data: opportunities, isLoading } = useListOpportunities({
    domain: domainFilter !== "all" ? (domainFilter as any) : undefined,
    limit: 100
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Universe</h1>
          <p className="text-muted-foreground">All tracked predictive opportunities.</p>
        </div>
        
        <div className="flex items-center space-x-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={domainFilter} onValueChange={setDomainFilter}>
            <SelectTrigger className="w-[180px] bg-card">
              <SelectValue placeholder="Filter by Domain" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ALL DOMAINS</SelectItem>
              <SelectItem value="prediction_market">PREDICTION MARKET</SelectItem>
              <SelectItem value="geopolitics">GEOPOLITICS</SelectItem>
              <SelectItem value="policy">POLICY</SelectItem>
              <SelectItem value="commodities">COMMODITIES</SelectItem>
              <SelectItem value="metals">METALS</SelectItem>
              <SelectItem value="macro">MACRO</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="bg-card/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead>Domain</TableHead>
                <TableHead className="max-w-[400px]">Question</TableHead>
                <TableHead className="text-right">Model</TableHead>
                <TableHead className="text-right">Market</TableHead>
                <TableHead className="text-right">Edge</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(10)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-full max-w-[300px]" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : opportunities?.map((opp) => (
                <TableRow key={opp.id} className="group border-border/50 transition-colors hover:bg-secondary/30">
                  <TableCell>
                    <Badge variant="outline" className="uppercase tracking-wider text-[10px] rounded-sm">
                      {opp.domain.replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/opportunities/${opp.id}`} className="hover:text-primary transition-colors flex items-center group/link">
                      <span className="line-clamp-1">{opp.question}</span>
                      <ExternalLink className="ml-2 w-3 h-3 opacity-0 group-hover/link:opacity-100 transition-opacity shrink-0" />
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono text-primary font-bold">
                    {formatPercent(opp.modelProb)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatPercent(opp.marketProb)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    <span className={Math.abs(opp.edge) > 0.05 ? (opp.edge > 0 ? "text-emerald-500 font-bold" : "text-destructive font-bold") : "text-muted-foreground"}>
                      {opp.edge > 0 ? "+" : ""}{formatPercent(opp.edge)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {formatPercent(opp.confidence)}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && (!opportunities || opportunities.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                    No opportunities found matching filters.
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
