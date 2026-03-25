import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env["AI_INTEGRATIONS_GOOGLE_API_KEY"] ?? "";

export const GEMINI_MODEL_ID = "gemini-2.5-flash";

export const gemini = new GoogleGenerativeAI(apiKey);

export const geminiModel = gemini.getGenerativeModel({
  model: GEMINI_MODEL_ID,
});
