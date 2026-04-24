import { Link, useLocation } from "wouter";
import {
  Activity,
  BarChart2,
  BookOpen,
  BrainCircuit,
  Crosshair,
  Eye,
  LineChart,
  MessageSquare,
  Radio,
  Settings,
  ShieldOff,
  Shuffle,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";
import {
  getGetDashboardSummaryQueryKey,
  getGetRiskConfigQueryKey,
  useGetDashboardSummary,
  useGetRiskConfig,
  useUpdateRiskConfig,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: summary } = useGetDashboardSummary();
  const { data: risk } = useGetRiskConfig();
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateRisk = useUpdateRiskConfig({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetRiskConfigQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (err) => {
        toast({
          title: "Risk update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const killEngaged = !!(risk?.killSwitchEngaged ?? summary?.killSwitchEngaged);
  const liveOff = !(risk?.liveExecutionEnabled ?? summary?.liveExecutionEnabled ?? false);

  const navItems = [
    { href: "/", label: "Dashboard", icon: BarChart2 },
    { href: "/top", label: "Top 10", icon: TrendingUp },
    { href: "/opportunities", label: "Universe", icon: Crosshair },
    { href: "/random", label: "Random", icon: Shuffle },
    { href: "/signals", label: "Signals Feed", icon: Activity },
    { href: "/paper", label: "Paper Trades", icon: LineChart },
    { href: "/journal", label: "Journal", icon: BookOpen },
    { href: "/openclaw", label: "OpenClaw", icon: Radio },
    { href: "/agent", label: "Agent", icon: MessageSquare },
  ];

  return (
    <div className="flex min-h-[100dvh] w-full bg-background font-mono text-sm selection:bg-primary selection:text-primary-foreground">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex flex-col hidden md:flex shrink-0 sticky top-0 h-screen">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <BrainCircuit className="w-5 h-5 text-primary mr-2" />
          <span className="font-bold text-foreground tracking-widest uppercase">Cassandra</span>
        </div>
        
        <div className="flex-1 overflow-y-auto py-4 flex flex-col gap-1 px-2">
          <div className="px-2 mb-2 text-xs font-semibold text-muted-foreground tracking-wider uppercase">Intelligence</div>
          {navItems.slice(0, 5).map(item => (
            <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location === item.href ? 'bg-secondary text-secondary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}>
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          ))}
          
          <div className="px-2 mt-6 mb-2 text-xs font-semibold text-muted-foreground tracking-wider uppercase">Operations</div>
          {navItems.slice(5).map(item => (
            <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location === item.href ? 'bg-secondary text-secondary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}>
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          ))}
        </div>

        {summary?.killSwitchEngaged && (
          <div className="m-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
            <div className="flex items-center text-destructive font-bold mb-1">
              <AlertTriangle className="w-4 h-4 mr-2" />
              KILL SWITCH
            </div>
            <p className="text-xs text-muted-foreground">Execution disabled</p>
          </div>
        )}

        <div className="p-4 border-t border-border mt-auto">
          <Link href="/risk" className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location === '/risk' ? 'bg-secondary text-secondary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}>
            <Settings className="w-4 h-4" />
            Risk Settings
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border flex items-center px-4 sticky top-0 bg-background/95 backdrop-blur z-10 gap-3">
          <div className="md:hidden flex items-center">
            <BrainCircuit className="w-5 h-5 text-primary mr-2" />
            <span className="font-bold text-foreground tracking-widest uppercase">Cassandra</span>
          </div>
          <div className="ml-auto flex items-center gap-4 text-xs">
            {/* Watch-only is always-on in this build (live execution permanently disabled). */}
            <div className="flex items-center gap-2 text-muted-foreground" data-testid="status-watch-only">
              <Eye className="w-3.5 h-3.5" />
              <span className="uppercase tracking-wider">Watch-only</span>
              {liveOff && (
                <Badge variant="outline" className="uppercase text-[10px] border-primary/40 text-primary">
                  ON
                </Badge>
              )}
            </div>
            {/* Header kill-switch toggle. Mirrors /risk so the operator can */}
            {/* engage from anywhere in the app. */}
            <label className="flex items-center gap-2 cursor-pointer" data-testid="header-kill-switch">
              <ShieldOff className={`w-3.5 h-3.5 ${killEngaged ? "text-destructive" : "text-muted-foreground"}`} />
              <span className={`uppercase tracking-wider ${killEngaged ? "text-destructive font-bold" : "text-muted-foreground"}`}>
                Kill Switch
              </span>
              <Switch
                checked={killEngaged}
                disabled={updateRisk.isPending}
                onCheckedChange={(v) =>
                  updateRisk.mutate({ data: { killSwitchEngaged: v } })
                }
                aria-label="Kill switch"
              />
              {killEngaged && (
                <Badge variant="destructive" className="uppercase text-[10px]">Engaged</Badge>
              )}
            </label>
          </div>
        </header>
        <div className="flex-1 p-4 md:p-8 overflow-x-hidden">
          <div className="max-w-7xl mx-auto w-full">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
