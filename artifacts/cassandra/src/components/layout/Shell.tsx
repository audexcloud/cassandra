import { Link, useLocation } from "wouter";
import { 
  Activity, 
  BarChart2, 
  BookOpen, 
  BrainCircuit, 
  Crosshair, 
  LineChart, 
  MessageSquare, 
  Radio, 
  Settings, 
  Shuffle, 
  TrendingUp,
  AlertTriangle
} from "lucide-react";
import { useGetDashboardSummary } from "@workspace/api-client-react";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: summary } = useGetDashboardSummary();

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
        <header className="md:hidden h-14 border-b border-border flex items-center px-4 sticky top-0 bg-background/95 backdrop-blur z-10">
           <BrainCircuit className="w-5 h-5 text-primary mr-2" />
           <span className="font-bold text-foreground tracking-widest uppercase">Cassandra</span>
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
