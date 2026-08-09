import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const audioBlob = formData.get("audio") as File | null;

    if (!audioBlob) {
      return Response.json({ error: "No audio provided" }, { status: 400 });
    }

    const transcription = await groq.audio.transcriptions.create({
      file: audioBlob,
      model: "whisper-large-v3-turbo",
      language: "en",
      response_format: "json",
    });

    return Response.json({ text: transcription.text });
  } catch (err) {
    console.error("[/api/transcribe]", err);
    return Response.json(
      { error: "Transcription failed" },
      { status: 500 },
    );
  }
}
