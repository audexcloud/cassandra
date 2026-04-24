import { useState, useEffect, useRef } from "react";
import {
  useListAnthropicConversations,
  useCreateAnthropicConversation,
  useDeleteAnthropicConversation,
  useListAnthropicMessages,
  useStructuredAgentQuery,
  type StructuredAgentResponse,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListAnthropicMessagesQueryKey,
  getListAnthropicConversationsQueryKey,
} from "@workspace/api-client-react";
import {
  MessageSquare,
  Plus,
  Trash2,
  Send,
  Bot,
  User,
  TerminalSquare,
  ListTree,
  AlignLeft,
  Sparkles,
  ShieldAlert,
  Eye,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatPercent, formatCurrency } from "@/lib/format";

// Two coexisting modes:
//  - "chat": legacy SSE conversation flow (free-form prose)
//  - "structured": calls /agent/structured-query and renders schema sections
// Operators want the structured surface for analyst workflows; chat stays
// available for ad-hoc back-and-forth.
type Mode = "chat" | "structured";

export default function Agent() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("structured");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [inputStr, setInputStr] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");

  const [structuredQuery, setStructuredQuery] = useState("");
  const [structured, setStructured] = useState<StructuredAgentResponse | null>(null);
  const [structuredError, setStructuredError] = useState<string | null>(null);
  const structuredMutation = useStructuredAgentQuery();

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const { data: convos, isLoading: isLoadingConvos } = useListAnthropicConversations();
  const { data: messages, isLoading: isLoadingMessages } = useListAnthropicMessages(activeId || 0, {
    query: {
      queryKey: getListAnthropicMessagesQueryKey(activeId || 0),
      enabled: !!activeId,
    },
  });

  const createConvo = useCreateAnthropicConversation();
  const deleteConvo = useDeleteAnthropicConversation();

  useEffect(() => {
    if (mode === "chat" && convos && convos.length > 0 && !activeId) {
      setActiveId(convos[0].id);
    }
  }, [convos, activeId, mode]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamedContent, isStreaming]);

  const handleCreate = () => {
    createConvo.mutate(
      { data: { title: "New Session " + new Date().toLocaleTimeString() } },
      {
        onSuccess: (newConvo) => {
          queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
          setActiveId(newConvo.id);
        },
      },
    );
  };

  const handleDelete = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    deleteConvo.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
          if (activeId === id) setActiveId(null);
        },
      },
    );
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputStr.trim() || !activeId || isStreaming) return;

    const content = inputStr.trim();
    setInputStr("");
    setIsStreaming(true);
    setStreamedContent("");

    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = `${baseUrl}/api/anthropic/conversations/${activeId}/messages`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let doneReading = false;
      let fullText = "";
      // Rolling buffer: SSE frames can be split across network chunks.
      // We only consume up to the last newline boundary and keep the rest
      // for the next iteration so partial `data: {...}` JSON is never
      // parsed mid-frame.
      let buffer = "";

      const consumeLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const dataStr = line.slice(6).trim();
        if (!dataStr) return;
        try {
          const data = JSON.parse(dataStr);
          if (data.content) {
            fullText += data.content;
            setStreamedContent(fullText);
          }
          if (data.done) {
            doneReading = true;
          }
        } catch {
          // Server emits keep-alive frames we can safely ignore.
        }
      };

      while (!doneReading) {
        const { value, done } = await reader.read();
        if (done) {
          doneReading = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          consumeLine(line);
          nl = buffer.indexOf("\n");
        }
      }
      // Flush any trailing partial-but-complete frame on close.
      if (buffer.length > 0) consumeLine(buffer);
    } catch (err) {
      console.error("Stream failed:", err);
    } finally {
      setIsStreaming(false);
      setStreamedContent("");
      queryClient.invalidateQueries({ queryKey: getListAnthropicMessagesQueryKey(activeId) });
    }
  };

  const handleStructuredSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!structuredQuery.trim() || structuredMutation.isPending) return;
    setStructuredError(null);
    structuredMutation.mutate(
      { data: { query: structuredQuery.trim() } },
      {
        onSuccess: (resp) => setStructured(resp),
        onError: (err) =>
          setStructuredError(
            err instanceof Error ? err.message : "Structured agent call failed.",
          ),
      },
    );
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] border border-border/50 rounded-lg overflow-hidden bg-card/50">
      {/* Sidebar shows session history only in chat mode; structured mode is
          one-shot so a session list adds noise. */}
      <div className="w-64 border-r border-border/50 bg-sidebar/50 flex flex-col hidden md:flex shrink-0">
        <div className="p-4 border-b border-border/50">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-bold uppercase tracking-wider text-sm">Agent</h2>
          </div>
          <div className="grid grid-cols-2 gap-1 p-1 bg-secondary/30 rounded text-[10px] uppercase tracking-wider">
            <button
              onClick={() => setMode("structured")}
              className={`px-2 py-1.5 rounded font-bold transition-colors flex items-center justify-center gap-1 ${mode === "structured" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              <ListTree className="w-3 h-3" /> Analyst
            </button>
            <button
              onClick={() => setMode("chat")}
              className={`px-2 py-1.5 rounded font-bold transition-colors flex items-center justify-center gap-1 ${mode === "chat" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              <AlignLeft className="w-3 h-3" /> Chat
            </button>
          </div>
        </div>
        {mode === "chat" ? (
          <>
            <div className="px-4 pt-3 pb-2 flex justify-between items-center">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Sessions</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCreate}
                className="h-6 w-6 text-primary hover:text-primary hover:bg-primary/10"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {isLoadingConvos ? (
                  [1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full rounded" />)
                ) : convos?.length === 0 ? (
                  <div className="text-xs text-muted-foreground p-4 text-center">No active sessions.</div>
                ) : (
                  convos?.map((c) => (
                    <div
                      key={c.id}
                      onClick={() => setActiveId(c.id)}
                      className={`flex items-center justify-between p-2 text-sm rounded cursor-pointer group transition-colors ${activeId === c.id ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-secondary/50"}`}
                    >
                      <span className="truncate flex-1 text-xs">{c.title}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => handleDelete(e, c.id)}
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/20"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="p-4 text-[11px] text-muted-foreground space-y-3">
            <p>
              Analyst mode returns a typed JSON answer with summary, sources, evidence, parallels,
              confidence, uncertainty, next steps, watchlist, candidate markets, and a trade plan when
              applicable.
            </p>
            <p>Use chat for free-form back-and-forth.</p>
          </div>
        )}
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/50">
        <div className="h-12 border-b border-border/50 flex items-center px-4 bg-card/30">
          <TerminalSquare className="w-4 h-4 mr-2 text-primary" />
          <span className="font-bold text-sm tracking-wider uppercase">
            Agent Interface — {mode === "structured" ? "Analyst (Structured)" : "Chat"}
          </span>
        </div>

        {mode === "structured" ? (
          <>
            <div className="flex-1 overflow-y-auto p-4">
              {structuredMutation.isPending ? (
                <div className="space-y-3 max-w-3xl mx-auto">
                  <Skeleton className="h-6 w-1/2" />
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : structuredError ? (
                <div className="max-w-3xl mx-auto rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                  <div className="flex items-center font-bold uppercase tracking-wider mb-1">
                    <ShieldAlert className="w-4 h-4 mr-2" /> Agent Failure
                  </div>
                  <div>{structuredError}</div>
                </div>
              ) : structured ? (
                <div className="max-w-3xl mx-auto space-y-4 text-sm">
                  <Section icon={<Sparkles className="w-3 h-3" />} title="Summary">
                    <p className="whitespace-pre-wrap leading-relaxed">{structured.summary}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <Badge variant="outline" className="uppercase text-[10px] tracking-wider">
                        Confidence {formatPercent(structured.confidence)}
                      </Badge>
                    </div>
                  </Section>

                  {structured.evidence.length > 0 && (
                    <Section icon={<CheckCircle2 className="w-3 h-3" />} title="Evidence">
                      <ul className="space-y-1.5">
                        {structured.evidence.map((e, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <Badge
                              variant="outline"
                              className={`uppercase text-[10px] tracking-wider shrink-0 mt-0.5 ${
                                e.kind === "observed"
                                  ? "border-emerald-500/40 text-emerald-500"
                                  : e.kind === "inferred"
                                    ? "border-blue-500/40 text-blue-500"
                                    : "border-amber-500/40 text-amber-500"
                              }`}
                            >
                              {e.kind}
                            </Badge>
                            <span className="flex-1">{e.statement}</span>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}

                  {structured.sources.length > 0 && (
                    <Section title="Sources">
                      <ul className="list-disc pl-5 space-y-0.5 font-mono text-xs">
                        {structured.sources.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </Section>
                  )}

                  {structured.parallels.length > 0 && (
                    <Section title="Historical Parallels">
                      <ul className="space-y-2">
                        {structured.parallels.map((p, i) => (
                          <li key={i} className="border-l-2 border-primary/30 pl-3">
                            <div className="font-bold text-xs uppercase tracking-wider">{p.label}</div>
                            <div className="text-xs text-foreground/80 mt-0.5">{p.summary}</div>
                            {p.outcome && (
                              <div className="text-[11px] italic text-muted-foreground mt-1">
                                Outcome: {p.outcome}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}

                  {structured.uncertainty.length > 0 && (
                    <Section icon={<ShieldAlert className="w-3 h-3" />} title="Uncertainty">
                      <ul className="list-disc pl-5 space-y-0.5">
                        {structured.uncertainty.map((u, i) => <li key={i}>{u}</li>)}
                      </ul>
                    </Section>
                  )}

                  {structured.nextSteps.length > 0 && (
                    <Section title="Next Steps">
                      <ul className="list-disc pl-5 space-y-0.5">
                        {structured.nextSteps.map((n, i) => <li key={i}>{n}</li>)}
                      </ul>
                    </Section>
                  )}

                  {structured.watchlist.length > 0 && (
                    <Section icon={<Eye className="w-3 h-3" />} title="Watchlist">
                      <div className="flex flex-wrap gap-1.5">
                        {structured.watchlist.map((w, i) => (
                          <Badge
                            key={i}
                            variant="outline"
                            className="uppercase text-[10px] tracking-wider rounded-sm font-mono"
                          >
                            {w}
                          </Badge>
                        ))}
                      </div>
                    </Section>
                  )}

                  {structured.candidates.length > 0 && (
                    <Section title="Candidate Markets">
                      <ul className="space-y-2">
                        {structured.candidates.map((c, i) => (
                          <li key={i} className="rounded border border-border/40 bg-secondary/20 p-2">
                            <div className="font-mono text-xs font-bold">{c.marketKey}</div>
                            <div className="text-xs text-foreground/80 mt-1">{c.rationale}</div>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}

                  {structured.tradePlan && (
                    <Section title="Trade Plan">
                      <div className="grid grid-cols-3 gap-3 text-xs font-mono">
                        <div>
                          <div className="text-[10px] uppercase text-muted-foreground">Direction</div>
                          <div className="font-bold uppercase">{structured.tradePlan.direction}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase text-muted-foreground">Size</div>
                          <div className="font-bold">{formatCurrency(structured.tradePlan.sizeUsd)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase text-muted-foreground">Entry Zone</div>
                          <div className="font-bold">
                            {formatPercent(structured.tradePlan.entryZone.low)}–
                            {formatPercent(structured.tradePlan.entryZone.high)}
                          </div>
                        </div>
                      </div>
                      {structured.tradePlan.cashOutLadder.length > 0 && (
                        <div className="mt-3">
                          <div className="text-[10px] uppercase text-muted-foreground mb-1">
                            Cash-Out Ladder
                          </div>
                          <ul className="space-y-0.5 font-mono text-xs">
                            {structured.tradePlan.cashOutLadder.map((r, i) => (
                              <li key={i} className="flex justify-between">
                                <span>Target {i + 1}</span>
                                <span>
                                  <span className="font-bold">{formatPercent(r.price)}</span>
                                  <span className="text-muted-foreground ml-2">
                                    scale out {Math.round(r.fraction * 100)}%
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div className="mt-3 text-xs">
                        <div className="text-[10px] uppercase text-muted-foreground mb-0.5">
                          Exit Strategy
                        </div>
                        <p>{structured.tradePlan.exitStrategy}</p>
                      </div>
                      {structured.tradePlan.invalidations.length > 0 && (
                        <div className="mt-3 text-xs">
                          <div className="text-[10px] uppercase text-muted-foreground mb-0.5">
                            Invalidations
                          </div>
                          <ul className="list-disc pl-5 space-y-0.5">
                            {structured.tradePlan.invalidations.map((inv, i) => <li key={i}>{inv}</li>)}
                          </ul>
                        </div>
                      )}
                    </Section>
                  )}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                  <Bot className="w-12 h-12 mb-4" />
                  <p className="uppercase tracking-wider text-sm">
                    Ask the analyst — typed reply will appear here.
                  </p>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-border/50 bg-card/30">
              <form onSubmit={handleStructuredSend} className="max-w-3xl mx-auto flex gap-3">
                <Input
                  value={structuredQuery}
                  onChange={(e) => setStructuredQuery(e.target.value)}
                  placeholder="Ask: e.g. ‘Will the Fed cut rates in June?’"
                  disabled={structuredMutation.isPending}
                  className="flex-1 bg-background border-primary/30 font-mono focus-visible:ring-primary h-12 text-sm"
                />
                <Button
                  type="submit"
                  disabled={!structuredQuery.trim() || structuredMutation.isPending}
                  className="w-12 h-12 p-0 shrink-0 uppercase tracking-wider"
                >
                  <Send className="w-5 h-5" />
                </Button>
              </form>
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4" ref={scrollContainerRef}>
              {!activeId ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                  <MessageSquare className="w-12 h-12 mb-4" />
                  <p className="uppercase tracking-wider text-sm">Select or create a session to begin</p>
                </div>
              ) : isLoadingMessages ? (
                <div className="space-y-4">
                  <Skeleton className="h-20 w-3/4" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <div className="space-y-6 max-w-3xl mx-auto">
                  {messages?.map((msg, i) => (
                    <div
                      key={msg.id || i}
                      className={`flex gap-4 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      {msg.role !== "user" && (
                        <div className="w-8 h-8 rounded border border-primary/30 bg-primary/10 flex items-center justify-center shrink-0">
                          <Bot className="w-4 h-4 text-primary" />
                        </div>
                      )}

                      <div
                        className={`p-4 rounded-md text-sm whitespace-pre-wrap font-mono leading-relaxed max-w-[85%] ${
                          msg.role === "user"
                            ? "bg-secondary/50 border border-border/50"
                            : "bg-card border border-primary/20 text-foreground"
                        }`}
                      >
                        {msg.content}
                        <div className="text-[10px] opacity-50 mt-2 text-right">
                          {formatDateTime(msg.createdAt)}
                        </div>
                      </div>

                      {msg.role === "user" && (
                        <div className="w-8 h-8 rounded border border-border bg-secondary flex items-center justify-center shrink-0">
                          <User className="w-4 h-4 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                  ))}

                  {isStreaming && (
                    <div className="flex gap-4 justify-start">
                      <div className="w-8 h-8 rounded border border-primary/30 bg-primary/10 flex items-center justify-center shrink-0">
                        <Bot className="w-4 h-4 text-primary animate-pulse" />
                      </div>
                      <div className="p-4 rounded-md text-sm whitespace-pre-wrap font-mono leading-relaxed max-w-[85%] bg-card border border-primary/20 text-foreground">
                        {streamedContent}
                        <span className="inline-block w-2 h-4 ml-1 bg-primary animate-pulse align-middle"></span>
                      </div>
                    </div>
                  )}

                  {messages?.length === 0 && !isStreaming && (
                    <div className="text-center py-10 opacity-50">
                      <Bot className="w-10 h-10 mx-auto mb-4" />
                      <p className="text-xs uppercase tracking-wider">Agent Ready. Awaiting instructions.</p>
                    </div>
                  )}
                  <div ref={scrollRef} />
                </div>
              )}
            </div>

            <div className="p-4 border-t border-border/50 bg-card/30">
              <form onSubmit={handleSend} className="max-w-3xl mx-auto flex gap-3 relative">
                <Input
                  value={inputStr}
                  onChange={(e) => setInputStr(e.target.value)}
                  placeholder={activeId ? "Command the agent..." : "Select a session first"}
                  disabled={!activeId || isStreaming}
                  className="flex-1 bg-background border-primary/30 font-mono focus-visible:ring-primary h-12 text-sm"
                />
                <Button
                  type="submit"
                  disabled={!inputStr.trim() || !activeId || isStreaming}
                  className="w-12 h-12 p-0 shrink-0 uppercase tracking-wider"
                >
                  <Send className="w-5 h-5" />
                </Button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border/40 bg-card/40">
      <div className="px-3 py-2 border-b border-border/30 flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}
