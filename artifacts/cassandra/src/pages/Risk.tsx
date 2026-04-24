import { useGetRiskConfig, useUpdateRiskConfig } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, ShieldAlert, AlertCircle, Info, ShieldCheck, Settings2, Save } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getGetRiskConfigQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { useEffect } from "react";

const riskConfigSchema = z.object({
  killSwitchEngaged: z.boolean(),
  maxKellyFraction: z.coerce.number().min(0).max(1),
  maxPositionUsd: z.coerce.number().min(0),
  bankrollUsd: z.coerce.number().min(0),
});

type RiskConfigFormValues = z.infer<typeof riskConfigSchema>;

export default function Risk() {
  const { data: config, isLoading } = useGetRiskConfig();
  const updateConfig = useUpdateRiskConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<RiskConfigFormValues>({
    resolver: zodResolver(riskConfigSchema),
    defaultValues: {
      killSwitchEngaged: false,
      maxKellyFraction: 0.25,
      maxPositionUsd: 10000,
      bankrollUsd: 100000,
    }
  });

  useEffect(() => {
    if (config) {
      form.reset({
        killSwitchEngaged: config.killSwitchEngaged,
        maxKellyFraction: config.maxKellyFraction,
        maxPositionUsd: config.maxPositionUsd,
        bankrollUsd: config.bankrollUsd,
      });
    }
  }, [config, form]);

  const onSubmit = (data: RiskConfigFormValues) => {
    updateConfig.mutate({ data }, {
      onSuccess: () => {
        toast({
          title: "Risk Configuration Updated",
          description: "Global risk parameters have been saved.",
        });
        queryClient.invalidateQueries({ queryKey: getGetRiskConfigQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Failed to update risk configuration.",
          variant: "destructive"
        });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const isKillSwitchOn = form.watch("killSwitchEngaged");

  return (
    <div className="space-y-6 max-w-3xl mx-auto mt-4">
      <div className="flex items-center gap-3 border-b border-border/50 pb-4 mb-8">
        <Settings2 className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight uppercase">Risk Controls</h1>
          <p className="text-muted-foreground">Global execution constraints and paper capital settings.</p>
        </div>
      </div>

      <Alert className="bg-primary/5 border-primary/20 text-primary">
        <Info className="h-5 w-5 text-primary" />
        <AlertTitle className="uppercase tracking-wider font-bold">Paper Environment Notice</AlertTitle>
        <AlertDescription className="opacity-80">
          <strong>liveExecutionEnabled</strong> is permanently set to FALSE in this build. All execution mechanisms are routed to the paper trading subsystem.
        </AlertDescription>
      </Alert>

      <Card className={`border-2 transition-colors ${isKillSwitchOn ? 'border-destructive bg-destructive/5' : 'border-border/50 bg-card/50'}`}>
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="uppercase tracking-wider flex items-center text-lg">
            {isKillSwitchOn ? (
              <><ShieldAlert className="w-5 h-5 mr-2 text-destructive" /> System Disarmed</>
            ) : (
              <><ShieldCheck className="w-5 h-5 mr-2 text-emerald-500" /> System Armed</>
            )}
          </CardTitle>
          <CardDescription>
            The master kill switch overrides all trading activity across the terminal.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
              
              <FormField
                control={form.control}
                name="killSwitchEngaged"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border/50 p-4 shadow-sm bg-background">
                    <div className="space-y-0.5 pr-4">
                      <FormLabel className="text-base font-bold uppercase tracking-wider flex items-center">
                        Master Kill Switch
                        {field.value && <Badge variant="destructive" className="ml-3 uppercase text-[10px]">Engaged</Badge>}
                      </FormLabel>
                      <FormDescription className="text-sm">
                        When engaged, absolutely no trades (paper or otherwise) can be opened. Existing open positions can still be closed.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className={field.value ? "data-[state=checked]:bg-destructive" : ""}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid gap-6 md:grid-cols-2 pt-4">
                <FormField
                  control={form.control}
                  name="bankrollUsd"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">Total Paper Bankroll (USD)</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                          <Input type="number" className="pl-7 bg-background font-mono" {...field} />
                        </div>
                      </FormControl>
                      <FormDescription className="text-xs">
                        Theoretical capital available for Kelly sizing.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxKellyFraction"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">Max Kelly Fraction</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" max="1" min="0" className="bg-background font-mono" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Hard cap on sizing (e.g. 0.25 = quarter Kelly).
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxPositionUsd"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">Max Position Limit (USD)</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                          <Input type="number" className="pl-7 bg-background font-mono" {...field} />
                        </div>
                      </FormControl>
                      <FormDescription className="text-xs">
                        Absolute maximum dollar size for a single position, regardless of Kelly recommendation.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end pt-4 border-t border-border/30">
                <Button 
                  type="submit" 
                  size="lg"
                  disabled={updateConfig.isPending}
                  className={`uppercase tracking-wider font-bold w-full sm:w-auto ${isKillSwitchOn ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}`}
                >
                  {updateConfig.isPending ? "Saving..." : (
                    <><Save className="w-4 h-4 mr-2" /> Apply Risk Parameters</>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
