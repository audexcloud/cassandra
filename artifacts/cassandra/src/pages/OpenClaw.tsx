import { useGetOpenClawStatus, useListOpenClawJobs, useRunOpenClawCycle } from "@workspace/api-client-react";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Radio, RefreshCw, Server, AlertCircle, PlaySquare, ShieldAlert, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getGetOpenClawStatusQueryKey, getListOpenClawJobsQueryKey } from "@workspace/api-client-react";

export default function OpenClaw() {
  const { data: status, isLoading: isStatusLoading } = useGetOpenClawStatus({
    query: {
      queryKey: getGetOpenClawStatusQueryKey(),
      refetchInterval: 5000, // Poll every 5s for orchestration UI
    },
  });

  const { data: jobs, isLoading: isJobsLoading } = useListOpenClawJobs(
    { limit: 50 },
    {
      query: {
        queryKey: getListOpenClawJobsQueryKey({ limit: 50 }),
        refetchInterval: 5000,
      },
    },
  );
  
  const runCycleMutation = useRunOpenClawCycle();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleRunCycle = () => {
    runCycleMutation.mutate(undefined, {
      onSuccess: () => {
        toast({
          title: "Cycle Initiated",
          description: "OpenClaw orchestration cycle manually triggered.",
        });
        queryClient.invalidateQueries({ queryKey: getGetOpenClawStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOpenClawJobsQueryKey() });
      },
      onError: () => {
        toast({
          title: "Trigger Failed",
          description: "Could not initiate orchestrator cycle.",
          variant: "destructive"
        });
      }
    });
  };

  const getStatusColor = (statusStr: string) => {
    switch (statusStr) {
      case 'ok': return 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10';
      case 'degraded': return 'text-amber-500 border-amber-500/30 bg-amber-500/10';
      case 'error': return 'text-destructive border-destructive/30 bg-destructive/10';
      case 'idle': return 'text-muted-foreground border-border bg-muted/10';
      case 'running': return 'text-primary border-primary/30 bg-primary/10 animate-pulse';
      default: return 'text-muted-foreground border-border bg-muted/10';
    }
  };

  const getJobStatusIcon = (statusStr: string) => {
    switch (statusStr) {
      case 'ok': return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
      case 'error': return <ShieldAlert className="w-4 h-4 text-destructive" />;
      case 'running': return <RefreshCw className="w-4 h-4 text-primary animate-spin" />;
      case 'pending': return <Server className="w-4 h-4 text-muted-foreground" />;
      default: return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
    }
  };

  if (isStatusLoading || !status) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase">OpenClaw Command Center</h1>
          <Skeleton className="h-4 w-64 mt-2" />
        </div>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase flex items-center">
            <Radio className={`w-6 h-6 mr-3 ${status.running ? 'text-primary animate-pulse' : 'text-muted-foreground'}`} />
            OpenClaw Orchestrator
          </h1>
          <p className="text-muted-foreground">Background data ingestion and scoring pipeline.</p>
        </div>
        
        <Button 
          onClick={handleRunCycle} 
          disabled={runCycleMutation.isPending}
          className="uppercase font-bold tracking-wider"
        >
          {status.running ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Cycle Running</>
          ) : (
            <><PlaySquare className="w-4 h-4 mr-2" /> Force Cycle Now</>
          )}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <Card className="bg-card/50 border-primary/20">
            <CardHeader className="pb-3 border-b border-border/30 bg-primary/5">
              <CardTitle className="text-sm font-medium uppercase tracking-wider text-primary">System Status</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border/30 text-sm">
                <div className="p-4 flex justify-between items-center">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs font-bold">State</span>
                  <Badge variant="outline" className={`uppercase ${status.running ? 'border-primary text-primary bg-primary/10' : 'text-muted-foreground'}`}>
                    {status.running ? 'Running' : 'Sleeping'}
                  </Badge>
                </div>
                <div className="p-4 flex justify-between items-center">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs font-bold">Last Cycle</span>
                  <span className="font-mono">{status.lastCycleAt ? formatDateTime(status.lastCycleAt) : 'Never'}</span>
                </div>
                <div className="p-4 flex justify-between items-center">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs font-bold">Next Run</span>
                  <span className="font-mono">{status.nextRunAt ? formatDateTime(status.nextRunAt) : 'Manual only'}</span>
                </div>
                <div className="p-4 flex justify-between items-center">
                  <span className="text-muted-foreground uppercase tracking-wider text-xs font-bold">Interval</span>
                  <span className="font-mono">{status.cycleIntervalSec}s</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-3 border-b border-border/30">
              <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Connectors</CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {status.connectors.map(connector => (
                <div key={connector.name} className="flex justify-between items-start">
                  <div>
                    <div className="font-bold uppercase text-xs tracking-wider mb-1">{connector.name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">Sync: {connector.lastSyncAt ? formatDateTime(connector.lastSyncAt) : 'Never'}</div>
                    {connector.note && <div className="text-xs text-destructive mt-1">{connector.note}</div>}
                  </div>
                  <Badge variant="outline" className={`uppercase text-[10px] ${getStatusColor(connector.status)}`}>
                    {connector.status}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card className="bg-card/50 border-border/50 h-full">
            <CardHeader className="pb-3 border-b border-border/30">
              <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Recent Jobs</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-border/30">
                    <TableHead className="w-10 text-center"></TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isJobsLoading ? (
                    <TableRow><TableCell colSpan={4}><Skeleton className="h-10 w-full" /></TableCell></TableRow>
                  ) : jobs?.map(job => (
                    <TableRow key={job.id} className="border-border/30 font-mono text-sm">
                      <TableCell className="text-center">
                        <div className="flex justify-center" title={job.status}>{getJobStatusIcon(job.status)}</div>
                      </TableCell>
                      <TableCell className="uppercase tracking-wider text-xs">
                        <div className="font-bold">{job.kind.replace(/_/g, ' ')}</div>
                        {job.message && <div className="text-muted-foreground truncate max-w-[250px] text-[10px] mt-1 normal-case font-sans">{job.message}</div>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {job.durationMs ? `${(job.durationMs / 1000).toFixed(2)}s` : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(job.startedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!isJobsLoading && (!jobs || jobs.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                        No recent jobs recorded.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
