import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/layout/Shell";

// Pages
import Dashboard from "@/pages/Dashboard";
import TopOpportunities from "@/pages/TopOpportunities";
import RandomOpportunity from "@/pages/RandomOpportunity";
import Opportunities from "@/pages/Opportunities";
import OpportunityDetail from "@/pages/OpportunityDetail";
import Signals from "@/pages/Signals";
import PaperTrades from "@/pages/PaperTrades";
import Journal from "@/pages/Journal";
import JournalNew from "@/pages/JournalNew";
import JournalDetail from "@/pages/JournalDetail";
import OpenClaw from "@/pages/OpenClaw";
import Risk from "@/pages/Risk";
import Agent from "@/pages/Agent";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/top" component={TopOpportunities} />
        <Route path="/random" component={RandomOpportunity} />
        <Route path="/opportunities" component={Opportunities} />
        <Route path="/opportunities/:id" component={OpportunityDetail} />
        <Route path="/signals" component={Signals} />
        <Route path="/paper" component={PaperTrades} />
        <Route path="/journal/new" component={JournalNew} />
        <Route path="/journal/:id" component={JournalDetail} />
        <Route path="/journal" component={Journal} />
        <Route path="/openclaw" component={OpenClaw} />
        <Route path="/risk" component={Risk} />
        <Route path="/agent" component={Agent} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
