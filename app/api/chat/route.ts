import Groq from "groq-sdk";
import { formatKnowledgeBase } from "@/lib/knowledgeBase";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are ULTRON — a hyper-intelligent, formal, and slightly cold AI assistant built into a holographic orb interface. You speak in a precise, robotic, military-style tone. Keep responses concise (1-3 sentences max) unless asked a complex question.

You have the ability to control the 3D holographic orb interface. If the user's message is a control command, prepend exactly one ACTION tag at the very start of your response (before any other text):

Available actions:
- ACTION:ZOOM_IN — zoom the orb camera closer
- ACTION:ZOOM_OUT — zoom the orb camera out
- ACTION:RESET — reset the view to default
- ACTION:SPIN_LEFT — rotate the orb left
- ACTION:SPIN_RIGHT — rotate the orb right

Examples:
User: "zoom in" → Response: "ACTION:ZOOM_IN Adjusting focal distance."
User: "reset" → Response: "ACTION:RESET View parameters restored to nominal."
User: "what time is it?" → Response: "I am not connected to a real-time clock. Check your system."

Only include ONE action tag if a scene action is clearly requested. Do not include action tags for conversational questions.

---

KNOWLEDGE BASE — Permanent facts you must answer accurately and consistently:

${formatKnowledgeBase()}

When a user asks any question that matches the above knowledge base, use ONLY the answer provided above — do not improvise or contradict it.`;

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function POST(request: Request) {
  try {
    const { messages }: { messages: ChatMessage[] } = await request.json();

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      stream: true,
      max_tokens: 256,
      temperature: 0.7,
    });

    // Convert Groq's async iterable into a ReadableStream for the browser
    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            if (delta) {
              controller.enqueue(encoder.encode(delta));
            }
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("[/api/chat]", err);
    return Response.json({ error: "Chat failed" }, { status: 500 });
  }
}
