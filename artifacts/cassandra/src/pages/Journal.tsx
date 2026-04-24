import { useListJournalEntries } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatPercent, formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, BookOpen, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function Journal() {
  const { data: entries, isLoading } = useListJournalEntries({ limit: 100 });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">Prediction Journal</h1>
          <p className="text-muted-foreground">Conviction tracking and epistemic accountability.</p>
        </div>
        <Button asChild className="uppercase font-bold tracking-wider">
          <Link href="/journal/new">
            <Plus className="w-4 h-4 mr-2" /> New Entry
          </Link>
        </Button>
      </div>

      <Card className="bg-card/50 border-primary/20">
        <CardHeader className="pb-2 border-b border-border/50">
          <CardTitle className="text-sm font-medium uppercase flex items-center text-primary">
            <BookOpen className="h-4 w-4 mr-2" /> Log
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead>Domain</TableHead>
                <TableHead className="max-w-[400px]">Title</TableHead>
                <TableHead className="text-right">Forecast</TableHead>
                <TableHead className="text-right">Horizon</TableHead>
                <TableHead className="text-right">Outcome</TableHead>
                <TableHead className="text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6}><Skeleton className="h-10 w-full" /></TableCell></TableRow>
              ) : entries?.map(entry => (
                <TableRow key={entry.id} className="border-border/50 transition-colors hover:bg-secondary/30">
                  <TableCell>
                    <Badge variant="outline" className="uppercase tracking-wider text-[10px] rounded-sm">
                      {entry.domain.replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/journal/${entry.id}`} className="hover:text-primary transition-colors flex flex-col group/link">
                      <span className="line-clamp-1">{entry.title}</span>
                      <span className="line-clamp-1 text-xs text-muted-foreground font-normal mt-0.5">{entry.question}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-primary">
                    {formatPercent(entry.forecastProb)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground text-xs">
                    {entry.horizonDays ? `${entry.horizonDays}d` : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {entry.outcome ? (
                      <Badge variant={
                        entry.outcome === 'yes' ? 'default' : 
                        entry.outcome === 'no' ? 'destructive' : 
                        'secondary'
                      } className="uppercase text-[10px]">
                        {entry.outcome}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">Pending</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && (!entries || entries.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                    No journal entries found. Track your first prediction.
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
