import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { KeyRound, ExternalLink, Copy, CheckCircle2, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ConnectorStatus = {
  name: string;
  status: string;
  note?: string | null;
};

type SetupGuide = {
  connectorName: string;
  displayName: string;
  envVar: string;
  signupUrl: string;
  signupLabel: string;
  steps: string[];
  payoff: string;
};

const GUIDES: Record<string, SetupGuide> = {
  kalshi: {
    connectorName: "kalshi",
    displayName: "Kalshi",
    envVar: "KALSHI_API_KEY",
    signupUrl: "https://kalshi.com/account/profile",
    signupLabel: "Open Kalshi profile",
    steps: [
      "Sign in to your Kalshi account at kalshi.com.",
      "Open your profile, go to the API Keys section, and create a new key.",
      "Copy the generated key value (you only see it once).",
      "In Replit, open the Secrets pane and add a new secret named KALSHI_API_KEY with that value.",
      "Come back here and the Kalshi connector will flip to OK on the next cycle.",
    ],
    payoff:
      "Once saved, Kalshi will return live quoted prices and open interest, and the connector flips from degraded to OK.",
  },
  metaculus: {
    connectorName: "metaculus",
    displayName: "Metaculus",
    envVar: "METACULUS_API_KEY",
    signupUrl: "https://www.metaculus.com/accounts/profile/",
    signupLabel: "Open Metaculus profile",
    steps: [
      "Sign in to your Metaculus account at metaculus.com.",
      "Open your profile page and scroll to the API Token section.",
      "Generate (or reveal) your personal API token and copy it.",
      "In Replit, open the Secrets pane and add a new secret named METACULUS_API_KEY with that token.",
      "Return here — the next orchestration cycle will start ingesting live community forecasts.",
    ],
    payoff:
      "Once saved, Metaculus will start populating community medians and forecaster depth on every cycle.",
  },
};

export interface ConnectorSetupCardProps {
  connectors: ConnectorStatus[];
}

export function ConnectorSetupCard({ connectors }: ConnectorSetupCardProps) {
  const { toast } = useToast();
  const [openGuide, setOpenGuide] = useState<SetupGuide | null>(null);

  const needsSetup = useMemo(() => {
    const result: Array<{ guide: SetupGuide; status: ConnectorStatus }> = [];
    for (const c of connectors) {
      const guide = GUIDES[c.name];
      if (!guide) continue;
      // Only surface the affordance while the connector is unhealthy AND its
      // note specifically points at the missing API key. The connector reports
      // the env-var name in its note when authentication is the blocker, so
      // matching on the env-var keeps the prompt from showing up if the
      // outage is something else (rate limit, schema drift, etc.).
      const note = c.note ?? "";
      if (c.status === "ok") continue;
      if (note.includes(guide.envVar)) {
        result.push({ guide, status: c });
      }
    }
    return result;
  }, [connectors]);

  if (needsSetup.length === 0) return null;

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: "Copied", description: `${value} copied to clipboard.` });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the text and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <Card
        className="bg-amber-500/5 border-amber-500/40"
        data-testid="card-connector-setup"
      >
        <CardHeader className="pb-3 border-b border-amber-500/20">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-amber-500 flex items-center">
            <KeyRound className="w-4 h-4 mr-2" />
            Finish Connector Setup
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {needsSetup.length === 1
              ? `One connector needs an API key before it can return live data.`
              : `${needsSetup.length} connectors need an API key before they can return live data.`}{" "}
            Add each secret in Replit and the next orchestration cycle will pick it up automatically.
          </p>
          <div className="space-y-2">
            {needsSetup.map(({ guide }) => (
              <div
                key={guide.connectorName}
                className="flex items-center justify-between gap-3 rounded-md border border-amber-500/20 bg-background/40 p-3"
                data-testid={`row-setup-${guide.connectorName}`}
              >
                <div className="min-w-0">
                  <div className="font-bold uppercase text-xs tracking-wider flex items-center gap-2">
                    {guide.displayName}
                    <Badge
                      variant="outline"
                      className="uppercase text-[9px] tracking-wider border-amber-500/40 text-amber-500 bg-amber-500/10"
                    >
                      Needs key
                    </Badge>
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground mt-1 truncate">
                    Secret name: {guide.envVar}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="uppercase text-[10px] tracking-wider border-amber-500/40 text-amber-500 hover:bg-amber-500/10 hover:text-amber-500 shrink-0"
                  onClick={() => setOpenGuide(guide)}
                  data-testid={`button-setup-${guide.connectorName}`}
                >
                  Setup
                  <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={openGuide !== null}
        onOpenChange={(open) => {
          if (!open) setOpenGuide(null);
        }}
      >
        {openGuide && (
          <DialogContent className="max-w-lg" data-testid="dialog-connector-setup">
            <DialogHeader>
              <DialogTitle className="uppercase tracking-wider flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-500" />
                Connect {openGuide.displayName}
              </DialogTitle>
              <DialogDescription>
                Generate a personal API token, then save it as a Replit secret named{" "}
                <span className="font-mono text-foreground">{openGuide.envVar}</span>.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <ol className="space-y-2 text-sm">
                {openGuide.steps.map((step, idx) => (
                  <li key={idx} className="flex gap-3">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center mt-0.5">
                      {idx + 1}
                    </span>
                    <span className="text-muted-foreground leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>

              <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  Secret name (click to copy)
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(openGuide.envVar)}
                  className="w-full flex items-center justify-between gap-2 font-mono text-sm text-foreground hover:text-primary transition-colors"
                  data-testid={`button-copy-${openGuide.connectorName}`}
                >
                  <span>{openGuide.envVar}</span>
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-start gap-2 text-xs text-muted-foreground rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span>{openGuide.payoff}</span>
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="outline"
                asChild
                className="uppercase text-xs tracking-wider"
              >
                <a
                  href={openGuide.signupUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`link-signup-${openGuide.connectorName}`}
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  {openGuide.signupLabel}
                </a>
              </Button>
              <Button
                onClick={() => setOpenGuide(null)}
                className="uppercase text-xs tracking-wider"
                data-testid="button-close-setup"
              >
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
