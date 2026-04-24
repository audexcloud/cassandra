import { useGetRandomOpportunity } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatPercent } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Shuffle, ArrowRight, Activity } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetRandomOpportunityQueryKey } from "@workspace/api-client-react";

export default function RandomOpportunity() {
  const queryClient = useQueryClient();
  const { data: opportunity, isLoading, isFetching } = useGetRandomOpportunity();

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
