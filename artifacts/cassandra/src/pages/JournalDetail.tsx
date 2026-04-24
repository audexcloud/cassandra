import { useGetJournalEntry } from "@workspace/api-client-react";
import { Link, useParams } from "wouter";
import { formatPercent, formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, BookOpen, Clock, Target } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function JournalDetail() {
  const { id } = useParams<{ id: string }>();
  const entryId = parseInt(id || "0", 10);

  const { data: entry, isLoading, isError } = useGetJournalEntry(entryId);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !entry) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load journal entry.</AlertDescription>
        </Alert>
        <Link href="/journal" className="text-primary hover:underline inline-flex items-center text-sm">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Journal
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl mx-auto pb-12">
      <Link href="/journal" className="text-muted-foreground hover:text-primary transition-colors inline-flex items-center text-sm font-medium uppercase tracking-wider">
        <ArrowLeft className="w-4 h-4 mr-2" /> Journal
      </Link>

      <div className="border-b border-border/50 pb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2 items-center">
            <Badge variant="outline" className="uppercase tracking-wider text-xs px-2 py-1 rounded-sm border-primary/50 text-primary bg-primary/5">
              {entry.domain.replace('_', ' ')}
            </Badge>
            {entry.outcome ? (
              <Badge variant={
                entry.outcome === 'yes' ? 'default' : 
                entry.outcome === 'no' ? 'destructive' : 
                'secondary'
              } className="uppercase tracking-wider text-xs rounded-sm">
                Outcome: {entry.outcome}
              </Badge>
            ) : (
              <Badge variant="secondary" className="uppercase tracking-wider text-xs rounded-sm bg-secondary/50">
                Pending Resolution
              </Badge>
            )}
          </div>
          <div className="text-xs font-mono text-muted-foreground flex items-center">
            <Clock className="w-3 h-3 mr-1" /> {formatDateTime(entry.createdAt)}
          </div>
        </div>
        <h1 className="text-2xl md:text-4xl font-bold tracking-tight mb-3">
          {entry.title}
        </h1>
        <div className="p-4 bg-secondary/20 border border-border/50 rounded-md text-sm sm:text-base text-foreground/90">
          <span className="font-bold uppercase tracking-wider text-xs text-muted-foreground block mb-1">Question / Criteria</span>
          {entry.question}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center">
              <Target className="w-3 h-3 mr-1" /> Forecast
            </div>
            <div className="text-3xl font-bold text-primary font-mono">{formatPercent(entry.forecastProb)}</div>
          </CardContent>
        </Card>
        
        <Card className="bg-card/50 border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Horizon</div>
            <div className="text-3xl font-bold font-mono text-foreground">
              {entry.horizonDays ? `${entry.horizonDays}d` : '-'}
            </div>
          </CardContent>
        </Card>

        <Card className={`bg-card/50 border-border/50 md:col-span-2 ${entry.outcome ? 'opacity-100' : 'opacity-50'}`}>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Actual Outcome</div>
            <div className="flex items-center gap-4">
              <div className={`text-3xl font-bold font-mono ${entry.outcome === 'yes' ? 'text-emerald-500' : entry.outcome === 'no' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {entry.outcome ? entry.outcome.toUpperCase() : 'PENDING'}
              </div>
              {entry.outcomeProb != null && (
                <div className="text-sm font-mono text-muted-foreground border-l border-border pl-4">
                  Final Prob: {formatPercent(entry.outcomeProb)}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6 pt-4">
        <h2 className="text-lg font-bold uppercase tracking-wider flex items-center text-primary">
          <BookOpen className="w-5 h-5 mr-2" /> Epistemic Record
        </h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
            <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-emerald-500 flex items-center">
              <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2"></span> Observed Facts
            </div>
            <CardContent className="p-4">
              {entry.observed && entry.observed.length > 0 ? (
                <ul className="list-disc pl-5 space-y-2 text-sm text-foreground/90">
                  {entry.observed.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <span className="text-sm text-muted-foreground italic">No facts observed.</span>}
            </CardContent>
          </Card>

          <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
            <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-blue-500 flex items-center">
              <span className="w-2 h-2 rounded-full bg-blue-500 mr-2"></span> Inferred
            </div>
            <CardContent className="p-4">
              {entry.inferred && entry.inferred.length > 0 ? (
                <ul className="list-disc pl-5 space-y-2 text-sm text-foreground/90">
                  {entry.inferred.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <span className="text-sm text-muted-foreground italic">No inferences recorded.</span>}
            </CardContent>
          </Card>

          <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
            <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-purple-500 flex items-center">
              <span className="w-2 h-2 rounded-full bg-purple-500 mr-2"></span> Speculation
            </div>
            <CardContent className="p-4">
              {entry.speculation && entry.speculation.length > 0 ? (
                <ul className="list-disc pl-5 space-y-2 text-sm text-foreground/90">
                  {entry.speculation.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <span className="text-sm text-muted-foreground italic">No speculation recorded.</span>}
            </CardContent>
          </Card>

          <Card className="bg-card/30 border-border/30 rounded-md overflow-hidden">
            <div className="bg-muted/50 px-4 py-2 border-b border-border/30 text-xs font-bold uppercase tracking-wider text-amber-500 flex items-center">
              <span className="w-2 h-2 rounded-full bg-amber-500 mr-2"></span> Unknowns / Catalysts
            </div>
            <CardContent className="p-4">
              {entry.unknowns && entry.unknowns.length > 0 ? (
                <ul className="list-disc pl-5 space-y-2 text-sm text-foreground/90">
                  {entry.unknowns.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <span className="text-sm text-muted-foreground italic">No unknowns recorded.</span>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
