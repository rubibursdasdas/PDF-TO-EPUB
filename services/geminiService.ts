
import { GoogleGenAI, Type, Chat, SendMessageParameters, GenerateContentResponse, Content } from "@google/genai";

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const model = 'gemini-2.5-flash';

const FINAL_PROMPT_INSTRUCTIONS = `
**Instructions:**
1.  **Analyze the Structure:** Read through all the text to understand the document's hierarchy. Identify titles, chapters, headings (h1, h2, h3), subheadings, paragraphs, lists, and other semantic elements.
2.  **Generate a Table of Contents (TOC):** Create an ordered list (<ol>) for the TOC at the very beginning of the HTML body inside a <nav> element. List all major sections (typically H1 and H2 level headings).
3.  **Create Internal Links:** Each item in the TOC must be a hyperlink pointing to the corresponding heading in the document body. To do this, assign a unique \`id\` attribute to each heading tag. The \`id\` should be a URL-friendly version of the heading text (e.g., "Chapter 1: The Beginning" becomes \`id="chapter-1-the-beginning"\`).
4.  **Embed Images:** Image placeholders are included in the text as \`[IMAGE_n]\`, where 'n' is the index of the image provided. You must replace these placeholders with \`<img>\` tags. The images are provided as base64 strings. Use data URIs for the \`src\` attribute (e.g., \`src="data:image/png;base64,..."\`). Ensure images are block elements and centered for good readability on e-readers.
5.  **Reflowable Layout:** The final HTML must be a single column and fully reflowable. Do not try to replicate the PDF's multi-column or fixed layout. Use standard semantic HTML tags (<p>, <h1>, <h2>, <ul>, <ol>, <li>, <strong>, <em>, etc.).
6.  **Clean HTML:** Provide only the complete HTML content within a valid structure, including <html>, <head>, and <body> tags. The <head> **must** contain a <title> tag with a suitable title for the document. The inline style should be minimal, ensuring good typography and readability for e-readers (e.g., serif font, appropriate line height).

**Output Format:**
Return a single JSON object with one key: "htmlContent", which contains the entire generated HTML as a string.
`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    htmlContent: {
      type: Type.STRING,
      description: "The full HTML content of the converted document."
    },
  },
  required: ["htmlContent"],
};

/**
 * Sends a message to the chat with exponential backoff for retries.
 * This makes the application resilient to API rate limiting and transient server errors.
 */
const sendMessageWithRetry = async (
  chat: Chat, 
  message: SendMessageParameters
): Promise<GenerateContentResponse> => {
  const MAX_RETRIES = 7;
  const INITIAL_DELAY_MS = 3000;
  let delay = INITIAL_DELAY_MS;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await chat.sendMessage(message);
    } catch (err: any) {
      const errorString = (typeof err === 'object' ? JSON.stringify(err) : String(err)).toLowerCase();

      // First, check for non-retriable daily quota errors.
      if (errorString.includes("daily limit") || errorString.includes("quota exceeded")) {
        console.error("Non-retriable daily quota error detected:", err);
        throw err; // Immediately re-throw to stop retries.
      }
      
      // Then, check for a wider range of other retriable errors.
      const isRetriableError = 
        errorString.includes('429') || // Rate limit
        errorString.includes('resource_exhausted') || // Rate limit
        errorString.includes('500') || // Internal server error
        errorString.includes('503') || // Service unavailable
        errorString.includes('unknown') || // Generic network/RPC error
        errorString.includes('rpc failed'); // Specific network error from user log

      if (isRetriableError && attempt < MAX_RETRIES - 1) {
        console.warn(`Retriable error detected. Retrying in ${Math.round(delay / 1000)}s... (Attempt ${attempt + 1}/${MAX_RETRIES})`, err);
        await new Promise(resolve => setTimeout(resolve, delay));
        // Exponential backoff with jitter
        delay = delay * 2 + Math.floor(Math.random() * 1000);
      } else {
        // If it's not a retriable error or the last retry, rethrow the error.
        console.error("Failed to send message after retries or due to non-retriable error:", err);
        throw err;
      }
    }
  }
  // This line should not be reachable, but is a fallback.
  throw new Error("Exceeded maximum retries for sending message.");
};


export const startEpubConversionChat = async (history?: Content[]): Promise<Chat> => {
  const systemInstruction = `You are an expert document converter. I will send you the content of a PDF in several parts or chunks. Your task is to analyze each chunk and hold it in memory. Do not generate any output until I tell you I have sent the final chunk. Your final goal will be to produce a single, well-structured, reflowable HTML file suitable for an EPUB, complete with a linked Table of Contents and embedded images based on all the content provided.`;
  
  const chat: Chat = ai.chats.create({
    model,
    config: { systemInstruction },
    history: history || [],
  });
  return chat;
};

export const sendPdfChunkToChat = async (
  chat: Chat, 
  text: string, 
  images: { mimeType: string; data: string }[],
  startPage: number,
  endPage: number
): Promise<void> => {
  const textPart = {
    text: `Here is the content for pages ${startPage}-${endPage}. Please process it and wait for the next chunk. PDF Content for this chunk is below:\n\n${text}`
  };

  const imageParts = images.map(image => ({
    inlineData: {
      mimeType: image.mimeType,
      data: image.data,
    },
  }));
  
  const message: SendMessageParameters = {
    message: [textPart, ...imageParts]
  };

  // Use the robust retry mechanism.
  await sendMessageWithRetry(chat, message);
};

export const finishEpubConversionChat = async (chat: Chat): Promise<string> => {
  const finalPrompt = `I have now sent you all the chunks of the PDF. Please generate the complete HTML document based on all the content provided so far. Follow these instructions carefully:\n\n${FINAL_PROMPT_INSTRUCTIONS}`;

  try {
    const message: SendMessageParameters = {
      message: finalPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema,
      }
    };
    
    // Use the robust retry mechanism for the final request.
    const response = await sendMessageWithRetry(chat, message);

    const jsonStr = response.text.trim();
    // The model may wrap the JSON in markdown backticks, so we clean it.
    const cleanedJsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const result = JSON.parse(cleanedJsonStr);

    if (result && result.htmlContent) {
      return result.htmlContent;
    } else {
      throw new Error("API response did not contain 'htmlContent'.");
    }
  } catch (err) {
    console.error("Error generating final HTML from chat:", err);
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred.";
    throw new Error(`Failed to convert PDF to HTML. ${errorMessage}`);
  }
};