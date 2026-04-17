import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export interface MeterData {
  reading: string;
  label: string;
  confidence: number;
  notes?: string;
}

export async function analyzeMeterImage(base64Image: string): Promise<MeterData> {
  const model = "gemini-3-flash-preview";
  
  const prompt = `Analyze this image of a water meter. 
Extract two specific pieces of information:
1. The current meter reading. 
   IMPORTANT RULES for reading:
   - Read ALL visible digits on the counter (both black and red dials).
   - Treat all digits as a single continuous whole number.
   - DO NOT treat red dials as fractional parts.
   - DO NOT include any decimal points.
   - Return only the full sequence of digits as a whole number.
2. Any label text or serial number visible on the meter body or face.

Return the data in JSON format.`;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image.split(',')[1] || base64Image
            }
          }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          reading: {
            type: Type.STRING,
            description: "The full sequence of digits from the meter dials. Include all digits (black and red) as a single whole number without any decimal points."
          },
          label: {
            type: Type.STRING,
            description: "Serial number, model name, or any identification text on the label."
          },
          confidence: {
            type: Type.NUMBER,
            description: "Confidence level from 0 to 1 for the extraction."
          },
          notes: {
            type: Type.STRING,
            description: "Any additional observations about the meter state (e.g., 'blurry', 'partially obscured')."
          }
        },
        required: ["reading", "label", "confidence"]
      }
    }
  });

  try {
    const text = response.text || '{}';
    return JSON.parse(text) as MeterData;
  } catch (error) {
    console.error("Failed to parse Gemini response:", error);
    throw new Error("Could not interpret the meter image. Please try again with a clearer photo.");
  }
}
