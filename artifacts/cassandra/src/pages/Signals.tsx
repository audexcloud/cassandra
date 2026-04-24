import { useListSignals, Domain } from "@workspace/api-client-react";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Filter, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";

export default function Signals() {
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");

  const { data: signals, isLoading } = useListSignals({
    domain: domainFilter !== "all" ? (domainFilter as Domain) : undefined,
    kind: kindFilter !== "all" ? kindFilter : undefined,
    limit: 100
  });

  const getSentimentIcon = (sentiment: number) => {
    if (sentiment > 0.2) return <TrendingUp className="w-4 h-4 text-emerald-500" />;
    if (sentiment < -0.2) return <TrendingDown className="w-4 h-4 text-destructive" />;
    return <Minus className="w-4 h-4 text-muted-foreground" />;
  };

  const getImpactColor = (impact: number) => {
    if (impact >= 0.8) return "bg-primary text-primary-foreground";
    if (impact >= 0.5) return "bg-primary/20 text-primary border border-primary/30";
    return "bg-secondary text-secondary-foreground";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Live Signals</h1>
          <p className="text-muted-foreground">Real-time intelligence feed and event impact.</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground mr-1" />
          <Select value={domainFilter} onValueChange={setDomainFilter}>
            <SelectTrigger className="w-[160px] bg-card h-8 text-xs">
              <SelectValue placeholder="Domain" />
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
          
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="w-[160px] bg-card h-8 text-xs">
              <SelectValue placeholder="Event Kind" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ALL KINDS</SelectItem>
              <SelectItem value="price_move">PRICE MOVE</SelectItem>
              <SelectItem value="news">NEWS</SelectItem>
              <SelectItem value="policy_release">POLICY RELEASE</SelectItem>
              <SelectItem value="options_skew">OPTIONS SKEW</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-4 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border/50 before:to-transparent">
        {isLoading ? (
          [...Array(6)].map((_, i) => (
            <div key={i} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
              <div className="flex items-center justify-center w-10 h-10 rounded-full border border-border bg-card shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-sm z-10">
                <Skeleton className="w-4 h-4 rounded-full" />
              </div>
              <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 rounded border border-border/50 bg-card/50 shadow-sm">
                <Skeleton className="h-4 w-1/3 mb-2" />
                <Skeleton className="h-4 w-full mb-1" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ))
        ) : signals?.map((signal) => (
          <div key={signal.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
            {/* Timeline dot */}
            <div className="flex items-center justify-center w-10 h-10 rounded-full border border-border/50 bg-card shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-sm z-10 text-muted-foreground group-hover:text-primary group-hover:border-primary/50 transition-colors">
              {getSentimentIcon(signal.sentiment)}
            </div>
            
            {/* Card */}
            <Card className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] bg-card/50 border-border/50 hover:bg-card/80 transition-colors">
              <CardContent className="p-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="uppercase tracking-wider text-[10px] rounded-sm bg-background">
                      {signal.domain.replace('_', ' ')}
                    </Badge>
                    <Badge variant="secondary" className="uppercase tracking-wider text-[10px] rounded-sm">
                      {signal.kind}
                    </Badge>
                  </div>
                  <time className="text-xs font-mono text-muted-foreground shrink-0 ml-4">
                    {formatDateTime(signal.observedAt)}
                  </time>
                </div>
                
                <h3 className="font-bold text-foreground mb-1 leading-tight">{signal.title}</h3>
                <p className="text-sm text-muted-foreground mb-3 line-clamp-3">{signal.body}</p>
                
                <div className="flex items-center justify-between mt-auto pt-3 border-t border-border/30">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] uppercase text-muted-foreground tracking-wider">Impact</span>
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-sm font-bold ${getImpactColor(signal.impact)}`}>
                        {signal.impact.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] uppercase text-muted-foreground tracking-wider">Sent</span>
                      <span className={`text-xs font-mono font-bold ${signal.sentiment > 0 ? "text-emerald-500" : signal.sentiment < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                        {signal.sentiment > 0 ? '+' : ''}{signal.sentiment.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  
                  {signal.opportunityId && (
                    <Link href={`/opportunities/${signal.opportunityId}`} className="text-xs font-medium text-primary hover:underline flex items-center">
                      View Opp <Activity className="w-3 h-3 ml-1" />
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        ))}
        {!isLoading && (!signals || signals.length === 0) && (
          <div className="text-center py-20 text-muted-foreground bg-card/30 rounded-lg border border-border border-dashed z-10 relative">
            No signals match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}
