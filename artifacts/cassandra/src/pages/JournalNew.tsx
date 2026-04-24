import { useCreateJournalEntry } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, BookOpen, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getListJournalEntriesQueryKey } from "@workspace/api-client-react";

const journalSchema = z.object({
  title: z.string().min(1, "Title is required"),
  domain: z.enum(["prediction_market", "geopolitics", "policy", "commodities", "metals", "macro"]),
  question: z.string().min(1, "Question is required"),
  forecastProb: z.number().min(0).max(1),
  horizonDays: z.number().min(1).optional().or(z.literal("").transform(() => undefined)),
  observedText: z.string(),
  inferredText: z.string(),
  speculationText: z.string(),
  unknownsText: z.string(),
});

type JournalFormValues = z.infer<typeof journalSchema>;

export default function JournalNew() {
  const [, setLocation] = useLocation();
  const createEntry = useCreateJournalEntry();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<JournalFormValues>({
    resolver: zodResolver(journalSchema),
    defaultValues: {
      title: "",
      domain: "macro",
      question: "",
      forecastProb: 0.5,
      horizonDays: undefined as any,
      observedText: "",
      inferredText: "",
      speculationText: "",
      unknownsText: "",
    }
  });

  const onSubmit = (data: JournalFormValues) => {
    // Convert text blocks to arrays (split by newline, remove empty)
    const toArray = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
    
    createEntry.mutate({
      data: {
        title: data.title,
        domain: data.domain,
        question: data.question,
        forecastProb: data.forecastProb,
        horizonDays: data.horizonDays ? Number(data.horizonDays) : undefined,
        observed: toArray(data.observedText),
        inferred: toArray(data.inferredText),
        speculation: toArray(data.speculationText),
        unknowns: toArray(data.unknownsText),
      }
    }, {
      onSuccess: (newEntry) => {
        toast({ title: "Journal Entry Saved", description: "Your prediction has been recorded." });
        queryClient.invalidateQueries({ queryKey: getListJournalEntriesQueryKey() });
        setLocation(`/journal/${newEntry.id}`);
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to save journal entry.", variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <div className="flex items-center gap-3">
        <Link href="/journal" className="p-2 -ml-2 rounded-full hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight uppercase flex items-center">
            <BookOpen className="w-6 h-6 mr-3 text-primary" /> New Prediction
          </h1>
          <p className="text-muted-foreground">Document conviction, assumptions, and horizons before reality unfolds.</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="border-b border-border/30 pb-4">
              <CardTitle className="uppercase tracking-wider text-sm">Core Thesis</CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">Title</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Fed Pause Dec 2024" className="bg-background" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="domain"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">Domain</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="bg-background">
                            <SelectValue placeholder="Select domain" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="prediction_market">PREDICTION MARKET</SelectItem>
                          <SelectItem value="geopolitics">GEOPOLITICS</SelectItem>
                          <SelectItem value="policy">POLICY</SelectItem>
                          <SelectItem value="commodities">COMMODITIES</SelectItem>
                          <SelectItem value="metals">METALS</SelectItem>
                          <SelectItem value="macro">MACRO</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="question"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">The Question / Resolution Criteria</FormLabel>
                    <FormControl>
                      <Textarea placeholder="What exact event will resolve this prediction? e.g. Will the FOMC target rate be 5.25-5.50% after the Dec 18 meeting?" className="bg-background min-h-20" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-end">
                <FormField
                  control={form.control}
                  name="forecastProb"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex justify-between items-center mb-4">
                        <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">Forecast Probability</FormLabel>
                        <span className="text-2xl font-bold font-mono text-primary">{(field.value * 100).toFixed(0)}%</span>
                      </div>
                      <FormControl>
                        <Slider 
                          min={0} 
                          max={1} 
                          step={0.01} 
                          value={[field.value]} 
                          onValueChange={(vals) => field.onChange(vals[0])} 
                          className="py-4"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="horizonDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="uppercase text-xs font-bold tracking-wider text-muted-foreground">Time Horizon (Days) <span className="opacity-50 font-normal normal-case">Optional</span></FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="e.g. 90" className="bg-background font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <h3 className="text-lg font-bold uppercase tracking-wider text-primary border-b border-border/50 pb-2">Epistemic Breakdown</h3>
            <p className="text-sm text-muted-foreground mb-4">One claim per line. Separate facts from inference.</p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormField
                control={form.control}
                name="observedText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="uppercase text-xs font-bold tracking-wider text-emerald-500 flex items-center">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2"></span> Observed Facts
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="- CPI printed 3.1% YoY&#10;- Oil inventories drew 4.2M bbls" className="bg-card/50 border-emerald-500/20 focus-visible:ring-emerald-500 min-h-32" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="inferredText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="uppercase text-xs font-bold tracking-wider text-blue-500 flex items-center">
                      <span className="w-2 h-2 rounded-full bg-blue-500 mr-2"></span> Logical Inference
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="- Supply tightness implies higher floor price&#10;- Core services inflation is sticky" className="bg-card/50 border-blue-500/20 focus-visible:ring-blue-500 min-h-32" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="speculationText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="uppercase text-xs font-bold tracking-wider text-purple-500 flex items-center">
                      <span className="w-2 h-2 rounded-full bg-purple-500 mr-2"></span> Speculation / Intuition
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="- Market is underpricing geopolitical escalation risk&#10;- Consensus trade feels too crowded" className="bg-card/50 border-purple-500/20 focus-visible:ring-purple-500 min-h-32" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="unknownsText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="uppercase text-xs font-bold tracking-wider text-amber-500 flex items-center">
                      <span className="w-2 h-2 rounded-full bg-amber-500 mr-2"></span> Key Unknowns / Catalysts
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="- Friday's NFP print&#10;- Direction of upcoming BOJ statement" className="bg-card/50 border-amber-500/20 focus-visible:ring-amber-500 min-h-32" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          </div>

          <div className="flex justify-end pt-6 border-t border-border/50">
            <Button 
              type="submit" 
              size="lg"
              disabled={createEntry.isPending}
              className="uppercase tracking-wider font-bold w-full md:w-auto"
            >
              {createEntry.isPending ? "Committing..." : <><Save className="w-4 h-4 mr-2" /> Commit to Journal</>}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
