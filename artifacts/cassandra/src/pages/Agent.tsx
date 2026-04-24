import { useState, useEffect, useRef } from "react";
import { 
  useListAnthropicConversations, 
  useCreateAnthropicConversation, 
  useGetAnthropicConversation, 
  useDeleteAnthropicConversation, 
  useListAnthropicMessages,
  AnthropicMessage,
  AnthropicConversation
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListAnthropicMessagesQueryKey, getListAnthropicConversationsQueryKey } from "@workspace/api-client-react";
import { MessageSquare, Plus, Trash2, Send, Bot, User, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";

export default function Agent() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [inputStr, setInputStr] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Queries
  const { data: convos, isLoading: isLoadingConvos } = useListAnthropicConversations();
  const { data: messages, isLoading: isLoadingMessages } = useListAnthropicMessages(activeId || 0, {
    query: { enabled: !!activeId }
  });

  // Mutations
  const createConvo = useCreateAnthropicConversation();
  const deleteConvo = useDeleteAnthropicConversation();

  // Auto-select first convo on load
  useEffect(() => {
    if (convos && convos.length > 0 && !activeId) {
      setActiveId(convos[0].id);
    }
  }, [convos, activeId]);

  // Auto-scroll to bottom when messages change or while streaming
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
        }
      }
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
        }
      }
    );
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputStr.trim() || !activeId || isStreaming) return;

    const content = inputStr.trim();
    setInputStr("");
    setIsStreaming(true);
    setStreamedContent("");

    // Optimistically update UI could be done here, but we'll rely on the stream parsing
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = `${baseUrl}/api/anthropic/conversations/${activeId}/messages`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let doneReading = false;
      let fullText = "";

      while (!doneReading) {
        const { value, done } = await reader.read();
        if (done) {
          doneReading = true;
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (!dataStr) continue;

            try {
              const data = JSON.parse(dataStr);
              if (data.content) {
                fullText += data.content;
                setStreamedContent(fullText);
              }
              if (data.done) {
                doneReading = true;
              }
            } catch (e) {
              console.error("Failed to parse SSE data:", dataStr);
            }
          }
        }
      }
    } catch (err) {
      console.error("Stream failed:", err);
    } finally {
      setIsStreaming(false);
      setStreamedContent("");
      queryClient.invalidateQueries({ queryKey: getListAnthropicMessagesQueryKey(activeId) });
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] border border-border/50 rounded-lg overflow-hidden bg-card/50">
      {/* Sidebar */}
      <div className="w-64 border-r border-border/50 bg-sidebar/50 flex flex-col hidden md:flex shrink-0">
        <div className="p-4 border-b border-border/50 flex justify-between items-center">
          <h2 className="font-bold uppercase tracking-wider text-sm">Sessions</h2>
          <Button variant="ghost" size="icon" onClick={handleCreate} className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {isLoadingConvos ? (
              [1,2,3].map(i => <Skeleton key={i} className="h-10 w-full rounded" />)
            ) : convos?.length === 0 ? (
              <div className="text-xs text-muted-foreground p-4 text-center">No active sessions.</div>
            ) : (
              convos?.map(c => (
                <div 
                  key={c.id} 
                  onClick={() => setActiveId(c.id)}
                  className={`flex items-center justify-between p-2 text-sm rounded cursor-pointer group transition-colors ${activeId === c.id ? 'bg-primary/20 text-primary font-medium' : 'text-muted-foreground hover:bg-secondary/50'}`}
                >
                  <span className="truncate flex-1 text-xs">{c.title}</span>
                  <Button variant="ghost" size="icon" onClick={(e) => handleDelete(e, c.id)} className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/20">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/50">
        <div className="h-12 border-b border-border/50 flex items-center px-4 bg-card/30">
          <TerminalSquare className="w-4 h-4 mr-2 text-primary" />
          <span className="font-bold text-sm tracking-wider uppercase">Agent Interface</span>
        </div>

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
                <div key={msg.id || i} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role !== 'user' && (
                    <div className="w-8 h-8 rounded border border-primary/30 bg-primary/10 flex items-center justify-center shrink-0">
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                  )}
                  
                  <div className={`p-4 rounded-md text-sm whitespace-pre-wrap font-mono leading-relaxed max-w-[85%] ${
                    msg.role === 'user' 
                      ? 'bg-secondary/50 border border-border/50' 
                      : 'bg-card border border-primary/20 text-foreground'
                  }`}>
                    {msg.content}
                    <div className="text-[10px] opacity-50 mt-2 text-right">
                      {formatDateTime(msg.createdAt)}
                    </div>
                  </div>

                  {msg.role === 'user' && (
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

        {/* Input Area */}
        <div className="p-4 border-t border-border/50 bg-card/30">
          <form onSubmit={handleSend} className="max-w-3xl mx-auto flex gap-3 relative">
            <Input 
              value={inputStr}
              onChange={e => setInputStr(e.target.value)}
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
      </div>
    </div>
  );
}
