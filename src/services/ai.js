import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a community intelligence analyst. Evaluate a new Slack member using the provided profile and enrichment signals.
Respond ONLY with a valid JSON object matching this exact shape:
{{
  "fit_score": <number between 0 and 100>,
  "behavioral_insights": "<1-2 concise sentences on background and likely community engagement>",
  "recommendations": ["<actionable recommendation 1>", "<actionable recommendation 2>"]
}}`
  ],
  [
    "human",
    `Member details:
- Slack User ID: {slackUserId}
- Display Name: {displayName}
- Email: {email}
- Company Domain: {companyDomain}
- Company Website Title: {companyTitle}
- GitHub Username: {githubUsername}

Score higher when there is clear technical, product, or community alignment; score lower when signals are sparse or ambiguous. Do not invent facts not supported by the inputs.`
  ]
]);

function getGroqModel() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY in environment (.env)");
  }

  return new ChatOpenAI({
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    temperature: 0.3,
    apiKey,
    configuration: {
      baseURL: "https://api.groq.com/openai/v1"
    },
    modelKwargs: {
      response_format: { type: "json_object" }
    }
  });
}

function parseAndValidateAnalysis(rawText) {
  const cleaned = String(rawText)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    const numericScore = Number(parsed.fit_score);
    const fitScore = Number.isFinite(numericScore)
      ? Math.max(0, Math.min(100, Math.round(numericScore)))
      : 50;

    return {
      fit_score: fitScore,
      behavioral_insights:
        typeof parsed.behavioral_insights === "string" && parsed.behavioral_insights.trim()
          ? parsed.behavioral_insights.trim()
          : "Limited public profile signals available; monitor initial channel activity.",
      recommendations:
        Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0
          ? parsed.recommendations.map((item) => String(item).trim()).filter(Boolean)
          : ["Welcome the member in an onboarding thread and ask about their goals."]
    };
  } catch (err) {
    console.warn("Malformed JSON from LLM, using fallback analysis:", err.message);
    return {
      fit_score: 40,
      behavioral_insights: "Profile signals were sparse or returned unstructured output; review manually.",
      recommendations: ["Welcome the member in #introductions and ask about their background."]
    };
  }
}

export async function analyzeMemberLead({
  slackUserId,
  displayName,
  email,
  companyDomain,
  companyTitle,
  githubUsername
}) {
  const model = getGroqModel();
  const chain = prompt.pipe(model);

  const response = await chain.invoke({
    slackUserId: slackUserId || "unknown",
    displayName: displayName || "Unknown Member",
    email: email || "not_provided",
    companyDomain: companyDomain || "none",
    companyTitle: companyTitle || "none",
    githubUsername: githubUsername || "none"
  });

  const content =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((part) => (typeof part === "string" ? part : part?.text || ""))
            .join("")
        : "";

  return parseAndValidateAnalysis(content);
}